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

  // Best-effort: read the just-sent message back from Sent Items so we
  // can return its Graph message ID + internetMessageId + conversationId.
  // Callers (e.g. reply_to_email) need the Graph ID to thread follow-ups.
  // Sent Items can lag the Graph index by ~1-2s, so we don't fail the
  // send if the lookup misses.
  let lookedUp = null;
  try {
    lookedUp = await lookupSentMessage(token.accessToken, to, subject);
  } catch (err) {
    console.warn(`[mcpBridge] sent ok but Sent Items lookup failed: ${err.message}`);
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
    messageId:         lookedUp?.id || null,
    internetMessageId: lookedUp?.internetMessageId || null,
    conversationId:    lookedUp?.conversationId || null,
    elapsedMs,
  });
});

/**
 * Read the just-sent message back from Sent Items by recipient + subject
 * + recency. Used to capture the Graph message ID so subsequent
 * reply_to_email calls can thread off it. Lookup is best-effort; if it
 * misses, the send is still successful and we return null.
 */
async function lookupSentMessage(accessToken, toEmail, subject) {
  const sinceIso = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const escSubject = (subject || '').replace(/'/g, "''");
  const res = await axios.get(
    `https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages` +
    `?$top=10&$orderby=sentDateTime desc` +
    `&$select=id,internetMessageId,conversationId,subject,sentDateTime,toRecipients` +
    `&$filter=sentDateTime ge ${sinceIso} and subject eq '${escSubject}'`,
    { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 10000 }
  );
  const candidates = res.data?.value || [];
  return candidates.find(m =>
    (m.toRecipients || []).some(r => r.emailAddress?.address?.toLowerCase() === toEmail.toLowerCase())
  ) || null;
}

/**
 * Resolve a Graph message ID. Accepts:
 *   - Graph resource ID (long opaque string, the usual format), returned as-is
 *   - RFC 5322 internetMessageId (contains "@", often wrapped in <…>), looked
 *     up via $filter against the user's mail
 * Returns null if no match is found.
 */
async function resolveGraphMessageId(accessToken, inReplyTo) {
  if (!inReplyTo) return null;
  // Internet Message-IDs are RFC 5322 — contain @ and often wrapped in <…>.
  // Graph resource IDs are base64-ish and don't contain @.
  if (inReplyTo.includes('@')) {
    const esc = inReplyTo.replace(/'/g, "''");
    const res = await axios.get(
      `https://graph.microsoft.com/v1.0/me/messages?$top=1&$select=id&$filter=internetMessageId eq '${esc}'`,
      { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 10000 }
    );
    return res.data?.value?.[0]?.id || null;
  }
  // Otherwise treat as Graph ID and confirm by HEAD-ish GET.
  try {
    const res = await axios.get(
      `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(inReplyTo)}?$select=id`,
      { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 10000 }
    );
    return res.data?.id || null;
  } catch {
    return null;
  }
}

// POST /api/mcp/reply-email
// True RFC 5322 threaded reply. Uses the Graph /reply (or /replyAll)
// endpoint with message.body override, so threading + In-Reply-To +
// References + conversationId are all handled by Graph. No Mail.ReadWrite
// needed; works with the existing Mail.Send + Mail.Read scopes.
//
// Body: {
//   inReplyToMessageId: string,   // Graph message ID or RFC 5322 Message-ID
//   body: string,
//   from?: string,                // ignored when authed via per-user token
//   cc?: string,
//   bcc?: string,
//   replyAll?: boolean,           // default false
//   includeOriginalBody?: boolean // default true; appends original below new content
// }
router.post('/reply-email', requireBridgeAuth, async (req, res) => {
  const startedAt = Date.now();
  const {
    inReplyToMessageId, body, from, cc, bcc,
    replyAll = false, includeOriginalBody = true,
  } = req.body || {};

  // ── Validate ────────────────────────────────────────────────────────────
  if (!ok(inReplyToMessageId)) return res.status(400).json({ ok: false, error: '"inReplyToMessageId" is required' });
  if (!ok(body))               return res.status(400).json({ ok: false, error: '"body" is required' });
  if (cc  && !isEmail(cc))     return res.status(400).json({ ok: false, error: '"cc" must be a valid email' });
  if (bcc && !isEmail(bcc))    return res.status(400).json({ ok: false, error: '"bcc" must be a valid email' });
  if (from && !isEmail(from))  return res.status(400).json({ ok: false, error: '"from" must be a valid email' });

  // ── Pick the sending account (same rules as /send-email) ────────────────
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
        ? `User ${req.mcpUser.email} has not connected a Microsoft 365 account yet.`
        : 'No Microsoft 365 account is connected.',
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

  // ── Resolve to a Graph message ID ───────────────────────────────────────
  let graphMessageId;
  try {
    graphMessageId = await resolveGraphMessageId(token.accessToken, inReplyToMessageId);
  } catch (err) {
    return res.status(502).json({ ok: false, error: `Failed to resolve inReplyToMessageId: ${err.message}` });
  }
  if (!graphMessageId) {
    return res.status(404).json({
      ok: false,
      error: `Could not find a message matching "${inReplyToMessageId}" in this mailbox. Pass the Graph message ID returned by send_email, or the original message's internetMessageId.`,
    });
  }

  // ── Optionally fetch original for quoting ───────────────────────────────
  // When includeOriginalBody=true (default), we manually prepend the new
  // content above the original. Graph's /reply with message.body override
  // does NOT auto-append the original — only the `comment` flow does, and
  // that's text-only. Doing it manually keeps full HTML control.
  let originalQuoteHtml = '';
  let originalSubject = null;
  let originalConversationId = null;
  if (includeOriginalBody) {
    try {
      const orig = await axios.get(
        `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(graphMessageId)}` +
        `?$select=subject,from,sentDateTime,conversationId,body`,
        { headers: { Authorization: `Bearer ${token.accessToken}` }, timeout: 10000 }
      );
      const m = orig.data || {};
      originalSubject = m.subject;
      originalConversationId = m.conversationId;
      const senderName  = m.from?.emailAddress?.name    || m.from?.emailAddress?.address || 'sender';
      const senderEmail = m.from?.emailAddress?.address || '';
      const sentAt = m.sentDateTime ? new Date(m.sentDateTime).toLocaleString() : '';
      const origBodyHtml = m.body?.contentType?.toLowerCase() === 'html'
        ? (m.body?.content || '')
        : `<pre style="font-family: inherit; white-space: pre-wrap;">${(m.body?.content || '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</pre>`;
      originalQuoteHtml =
        `<br><br>` +
        `<div style="border-left: 2px solid #ccc; padding-left: 12px; color: #666;">` +
        `<div style="font-size: 0.85em; margin-bottom: 6px;">On ${sentAt}, ${senderName}${senderEmail ? ` &lt;${senderEmail}&gt;` : ''} wrote:</div>` +
        origBodyHtml +
        `</div>`;
    } catch (err) {
      // Non-fatal — we'll send without quoting, log the reason.
      console.warn(`[mcpBridge] couldn't fetch original for quoting: ${err.message}`);
    }
  }

  // ── Build the reply body ────────────────────────────────────────────────
  const linkedBody = linkify(body);
  const HTML_TAG = /<(p|div|br|ul|ol|li|strong|b|em|i|u|a|span|h[1-6])\b/i;
  const newBodyHtml = HTML_TAG.test(linkedBody) ? linkedBody : linkedBody.replace(/\n/g, '<br/>');
  const finalBodyHtml = newBodyHtml + originalQuoteHtml;

  // ── Build the message override + send via /reply or /replyAll ───────────
  const message = {
    body: { contentType: 'HTML', content: finalBodyHtml },
    ...(cc  ? { ccRecipients:  [{ emailAddress: { address: cc } }]  } : {}),
    ...(bcc ? { bccRecipients: [{ emailAddress: { address: bcc } }] } : {}),
  };
  const endpoint = replyAll
    ? `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(graphMessageId)}/replyAll`
    : `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(graphMessageId)}/reply`;

  try {
    await axios.post(endpoint, { message }, {
      headers: { Authorization: `Bearer ${token.accessToken}`, 'Content-Type': 'application/json' },
      timeout: 15000,
    });
  } catch (err) {
    const status = err.response?.status;
    const graphErr = err.response?.data?.error;
    const detail = graphErr?.message || graphErr?.code || err.message;
    console.error(`[mcpBridge] /reply failed (${status || '?'}): ${detail}`);
    return res.status(502).json({
      ok: false,
      error: `Microsoft Graph rejected the reply (status ${status || '?'}): ${detail}`,
    });
  }

  // Best-effort lookup of the new sent message so we can return its ID
  // for further chaining (e.g. reply to a reply).
  let lookedUp = null;
  try {
    // Reply subjects are "Re: <original>" — Outlook adds the prefix.
    const replySubject = originalSubject
      ? (originalSubject.toLowerCase().startsWith('re:') ? originalSubject : `Re: ${originalSubject}`)
      : null;
    if (replySubject) {
      // For replyAll we don't know exactly who'll be on the To line,
      // so skip the toEmail filter — pick the most recent matching subject.
      const sinceIso = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const esc = replySubject.replace(/'/g, "''");
      const res2 = await axios.get(
        `https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages` +
        `?$top=5&$orderby=sentDateTime desc` +
        `&$select=id,internetMessageId,conversationId,sentDateTime` +
        `&$filter=sentDateTime ge ${sinceIso} and subject eq '${esc}'`,
        { headers: { Authorization: `Bearer ${token.accessToken}` }, timeout: 10000 }
      );
      lookedUp = (res2.data?.value || [])[0] || null;
    }
  } catch (err) {
    console.warn(`[mcpBridge] reply sent ok but Sent Items lookup failed: ${err.message}`);
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(`[mcpBridge] ${replyAll ? 'replyAll' : 'reply'} ${cred.email} → message ${graphMessageId} in ${elapsedMs}ms`);
  return res.json({
    ok: true,
    status: 'sent',
    threaded: true,
    from: cred.email,
    inReplyToMessageId: graphMessageId,
    replyAll: !!replyAll,
    includedOriginalBody: !!includeOriginalBody && !!originalQuoteHtml,
    messageId:         lookedUp?.id || null,
    internetMessageId: lookedUp?.internetMessageId || null,
    conversationId:    lookedUp?.conversationId || originalConversationId || null,
    elapsedMs,
  });
});

module.exports = router;
