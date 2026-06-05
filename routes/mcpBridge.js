/**
 * MCP bridge — single endpoint the local Claude Desktop MCP server calls
 * to send ad-hoc emails through this app's existing Microsoft 365
 * integration. No new Outlook auth path; this just wraps the
 * already-trusted send pipeline so Claude Desktop can reach it without
 * touching Outlook directly.
 *
 * Auth: Bearer <MCP_BRIDGE_TOKEN>. When the env var is missing, the
 * endpoint refuses with 503 — the feature is off by default.
 *
 * No public-facing changes to the rest of the app: this is a separate
 * route file mounted at /api/mcp, completely additive.
 */
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const router = express.Router();

const prisma = require('../services/database');
const { getMicrosoftAccessToken, linkify } = require('../services/sequenceMailer');

// Loose RFC 5322-ish check — good enough to catch obvious typos. We
// don't try to be a full RFC parser.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ok = (s) => typeof s === 'string' && s.trim().length > 0;
const isEmail = (s) => ok(s) && EMAIL_RE.test(s.trim());

const hashToken = (plain) => crypto.createHash('sha256').update(plain).digest('hex');
const isApexUserToken = (s) => typeof s === 'string' && s.startsWith('apexbdr_');

// Auth middleware. Two accepted forms:
//   (a) Per-user token  — Bearer apexbdr_…  → identifies the user; the
//       bridge will use THIS user's Microsoft account by default.
//   (b) Legacy shared token — Bearer <MCP_BRIDGE_TOKEN env value>  →
//       single-account mode; bridge picks the first connected Microsoft
//       credential. Backward-compatible with the original setup.
//
// At least one of the two must be configured. If neither MCP_BRIDGE_TOKEN
// is set NOR any User has an mcpTokenHash, the endpoint is effectively
// off (503).
async function requireBridgeAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!provided) {
    return res.status(401).json({ ok: false, error: 'Missing Authorization: Bearer <token>' });
  }

  // (a) Per-user token path
  if (isApexUserToken(provided)) {
    try {
      const hash = hashToken(provided);
      const user = await prisma.user.findFirst({ where: { mcpTokenHash: hash } });
      if (user) {
        req.mcpUser = user;
        return next();
      }
    } catch (err) {
      console.error('[mcpBridge] user-token lookup failed:', err.message);
      return res.status(500).json({ ok: false, error: 'Token lookup failed' });
    }
    return res.status(401).json({ ok: false, error: 'Invalid per-user MCP token' });
  }

  // (b) Legacy shared token path
  const expected = process.env.MCP_BRIDGE_TOKEN;
  if (!expected) {
    return res.status(503).json({
      ok: false,
      error: 'MCP bridge disabled. Either generate a per-user token in Integrations or set MCP_BRIDGE_TOKEN on the server.',
    });
  }
  if (provided !== expected) {
    return res.status(401).json({ ok: false, error: 'Invalid bridge token' });
  }
  next();
}

// GET /api/mcp/health — unauth'd liveness so the MCP server can confirm
// the bridge is reachable before relaying a tool call.
router.get('/health', (req, res) => {
  res.json({
    ok: true,
    bridgeEnabled: !!process.env.MCP_BRIDGE_TOKEN,
  });
});

// POST /api/mcp/send-email
// Body: { to, subject, body, cc?, bcc?, from? }
// Returns 200 { ok: true, ... } on success, 4xx/5xx { ok: false, error } otherwise.
router.post('/send-email', requireBridgeAuth, async (req, res) => {
  const startedAt = Date.now();
  const { to, subject, body, cc, bcc, from } = req.body || {};

  // ── Validate ────────────────────────────────────────────────────────────
  if (!isEmail(to))   return res.status(400).json({ ok: false, error: '"to" must be a valid email' });
  if (!ok(subject))   return res.status(400).json({ ok: false, error: '"subject" is required' });
  if (!ok(body))      return res.status(400).json({ ok: false, error: '"body" is required' });
  if (cc  && !isEmail(cc))  return res.status(400).json({ ok: false, error: '"cc" must be a valid email' });
  if (bcc && !isEmail(bcc)) return res.status(400).json({ ok: false, error: '"bcc" must be a valid email' });
  if (from && !isEmail(from)) return res.status(400).json({ ok: false, error: '"from" must be a valid email' });

  // ── Pick the sending account ────────────────────────────────────────────
  // Priority:
  //   1. If a per-user token authed this call → use THAT user's Microsoft
  //      credential. Each teammate sends from their own Outlook. The
  //      `from` arg is ignored in this mode to prevent impersonation.
  //   2. Else (legacy shared-token path): use `from` if provided to pick
  //      a specific account; otherwise the first connected one.
  let cred;
  try {
    if (req.mcpUser) {
      cred = await prisma.integrationCredential.findUnique({
        where: { provider_userId: { provider: 'microsoft', userId: req.mcpUser.id } },
      });
    } else {
      cred = await prisma.integrationCredential.findFirst({
        where: { provider: 'microsoft', ...(from ? { email: from } : {}) },
        orderBy: { id: 'asc' },
      });
    }
  } catch (err) {
    console.error('[mcpBridge] credential lookup failed:', err.message);
    return res.status(500).json({ ok: false, error: `Credential lookup failed: ${err.message}` });
  }
  if (!cred) {
    return res.status(412).json({
      ok: false,
      error: req.mcpUser
        ? `User ${req.mcpUser.email} has not connected a Microsoft 365 account yet. Sign in with Microsoft in Integrations first.`
        : from
        ? `No Microsoft 365 credential found for "${from}"`
        : 'No Microsoft 365 account is connected. Open the app and sign in with Microsoft first.',
    });
  }

  // ── Refresh access token ────────────────────────────────────────────────
  let token;
  try {
    token = await getMicrosoftAccessToken(cred.userId);
  } catch (err) {
    console.error('[mcpBridge] token refresh failed:', err.message);
    return res.status(502).json({ ok: false, error: `Microsoft token refresh failed: ${err.message}` });
  }

  // ── Format body ─────────────────────────────────────────────────────────
  // Linkify markdown / bare URLs. Plain-text bodies get \n → <br/>; HTML
  // bodies are passed through. Same heuristic the sequence mailer uses.
  const linkedBody = linkify(body);
  const HTML_TAG = /<(p|div|br|ul|ol|li|strong|b|em|i|u|a|span|h[1-6])\b/i;
  const htmlBody = HTML_TAG.test(linkedBody)
    ? linkedBody
    : linkedBody.replace(/\n/g, '<br/>');

  // ── Build and send ──────────────────────────────────────────────────────
  const message = {
    subject,
    body: { contentType: 'HTML', content: htmlBody },
    toRecipients:  [{ emailAddress: { address: to } }],
    ...(cc  ? { ccRecipients:  [{ emailAddress: { address: cc } }]  } : {}),
    ...(bcc ? { bccRecipients: [{ emailAddress: { address: bcc } }] } : {}),
  };

  try {
    await axios.post(
      'https://graph.microsoft.com/v1.0/me/sendMail',
      { message, saveToSentItems: true },
      {
        headers: { Authorization: `Bearer ${token.accessToken}`, 'Content-Type': 'application/json' },
        timeout: 15000,
      }
    );
  } catch (err) {
    const status = err.response?.status;
    const graphErr = err.response?.data?.error;
    const detail = graphErr?.message || graphErr?.code || err.message;
    console.error(`[mcpBridge] /me/sendMail failed (${status || '?'}): ${detail}`);
    return res.status(502).json({
      ok: false,
      error: `Microsoft Graph rejected the send (status ${status || '?'}): ${detail}`,
    });
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(`[mcpBridge] sent ${cred.email} → ${to} ("${subject}") in ${elapsedMs}ms`);
  return res.json({
    ok: true,
    status: 'sent',
    from: cred.email,
    to,
    cc: cc || null,
    bcc: bcc || null,
    subject,
    elapsedMs,
  });
});

module.exports = router;
