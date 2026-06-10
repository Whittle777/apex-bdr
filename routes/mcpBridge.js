/**
 * MCP bridge — endpoints the local Claude Desktop / Cowork MCP server calls
 * to send mail through this app's existing Microsoft 365 integration. No new
 * Outlook auth path; this wraps the already-trusted send pipeline.
 *
 * Two send modes:
 *   - Immediate:  POST /send-email, POST /reply-email — fire now, return the
 *                 result (incl. messageId via poll-with-backoff). For ad-hoc
 *                 one-off sends.
 *   - Paced:      POST /enqueue-email — enqueue into OutboundQueue; the
 *                 sendQueueWorker drains it at a human pace inside the send
 *                 window, under the day's cap, honoring the gate. For batches.
 *
 * The Graph send/reply core lives in services/bridgeMailer.js so the routes
 * and the worker share one implementation.
 *
 * Auth: Bearer per-user token (apexbdr_…) or the legacy shared
 * MCP_BRIDGE_TOKEN. Mounted at /api/mcp, completely additive.
 */
const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const prisma = require('../services/database');
const { getMicrosoftAccessToken } = require('../services/sequenceMailer');
const { sendEmailViaGraph, sendReplyViaGraph } = require('../services/bridgeMailer');
const { localDateString, getConfig } = require('../services/sendPacing');

// Loose RFC 5322-ish check — good enough to catch obvious typos.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ok = (s) => typeof s === 'string' && s.trim().length > 0;
const isEmail = (s) => ok(s) && EMAIL_RE.test(s.trim());

const hashToken = (plain) => crypto.createHash('sha256').update(plain).digest('hex');
const isApexUserToken = (s) => typeof s === 'string' && s.startsWith('apexbdr_');

// Auth middleware. (a) per-user token apexbdr_… identifies the user and uses
// THAT user's Microsoft account; (b) legacy shared MCP_BRIDGE_TOKEN picks the
// first connected Microsoft credential. If neither is configured → 503.
async function requireBridgeAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!provided) {
    return res.status(401).json({ ok: false, error: 'Missing Authorization: Bearer <token>' });
  }

  if (isApexUserToken(provided)) {
    try {
      const user = await prisma.user.findFirst({ where: { mcpTokenHash: hashToken(provided) } });
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

// Resolve the sending Microsoft credential. Per-user token → that user;
// shared token → `from` if given, else first connected. Returns cred|null.
async function resolveCred(req, from) {
  if (req.mcpUser) {
    return prisma.integrationCredential.findUnique({
      where: { provider_userId: { provider: 'microsoft', userId: req.mcpUser.id } },
    });
  }
  return prisma.integrationCredential.findFirst({
    where: { provider: 'microsoft', ...(from ? { email: from } : {}) },
    orderBy: { id: 'asc' },
  });
}
function credError(req, from) {
  if (req.mcpUser) return `User ${req.mcpUser.email} has not connected a Microsoft 365 account yet. Sign in with Microsoft in Integrations first.`;
  if (from) return `No Microsoft 365 credential found for "${from}"`;
  return 'No Microsoft 365 account is connected. Open the app and sign in with Microsoft first.';
}

const CAPTURE_WARNING =
  'Email was sent, but its messageId could not be read back from Sent Items in time (Graph indexing lag). ' +
  'Threading a reply may require recovering the id later via scripts/recoverSentIds.js.';

// GET /api/mcp/health — unauth'd liveness.
router.get('/health', (req, res) => {
  res.json({ ok: true, bridgeEnabled: !!process.env.MCP_BRIDGE_TOKEN });
});

// POST /api/mcp/send-email — immediate one-off send. Body: { to, subject, body, cc?, bcc?, from? }
router.post('/send-email', requireBridgeAuth, async (req, res) => {
  const { to, subject, body, cc, bcc, from } = req.body || {};

  if (!isEmail(to)) return res.status(400).json({ ok: false, error: '"to" must be a valid email' });
  if (!ok(subject)) return res.status(400).json({ ok: false, error: '"subject" is required' });
  if (!ok(body)) return res.status(400).json({ ok: false, error: '"body" is required' });
  if (cc && !isEmail(cc)) return res.status(400).json({ ok: false, error: '"cc" must be a valid email' });
  if (bcc && !isEmail(bcc)) return res.status(400).json({ ok: false, error: '"bcc" must be a valid email' });
  if (from && !isEmail(from)) return res.status(400).json({ ok: false, error: '"from" must be a valid email' });

  let cred;
  try {
    cred = await resolveCred(req, from);
  } catch (err) {
    return res.status(500).json({ ok: false, error: `Credential lookup failed: ${err.message}` });
  }
  if (!cred) return res.status(412).json({ ok: false, error: credError(req, from) });

  let token;
  try {
    token = await getMicrosoftAccessToken(cred.userId);
  } catch (err) {
    return res.status(502).json({ ok: false, error: `Microsoft token refresh failed: ${err.message}` });
  }

  try {
    const r = await sendEmailViaGraph({ accessToken: token.accessToken, to, subject, body, cc, bcc });
    console.log(`[mcpBridge] sent ${cred.email} → ${to} ("${subject}") in ${r.elapsedMs}ms — messageId ${r.captured ? 'captured' : 'NOT captured'}`);
    return res.json({
      ok: true,
      status: 'sent',
      from: cred.email,
      to,
      cc: cc || null,
      bcc: bcc || null,
      subject,
      messageId: r.messageId,
      internetMessageId: r.internetMessageId,
      conversationId: r.conversationId,
      ...(r.captured ? {} : { warning: CAPTURE_WARNING + (r.lookupError ? ` Lookup error: ${r.lookupError}` : '') }),
      elapsedMs: r.elapsedMs,
    });
  } catch (err) {
    return res.status(err.httpStatus || 502).json({ ok: false, error: err.message });
  }
});

// POST /api/mcp/reply-email — immediate threaded reply.
// Body: { inReplyToMessageId, body, from?, cc?, bcc?, replyAll?, includeOriginalBody? }
router.post('/reply-email', requireBridgeAuth, async (req, res) => {
  const { inReplyToMessageId, body, from, cc, bcc, replyAll = false, includeOriginalBody = true } = req.body || {};

  if (!ok(inReplyToMessageId)) return res.status(400).json({ ok: false, error: '"inReplyToMessageId" is required' });
  if (!ok(body)) return res.status(400).json({ ok: false, error: '"body" is required' });
  if (cc && !isEmail(cc)) return res.status(400).json({ ok: false, error: '"cc" must be a valid email' });
  if (bcc && !isEmail(bcc)) return res.status(400).json({ ok: false, error: '"bcc" must be a valid email' });
  if (from && !isEmail(from)) return res.status(400).json({ ok: false, error: '"from" must be a valid email' });

  let cred;
  try {
    cred = await resolveCred(req, from);
  } catch (err) {
    return res.status(500).json({ ok: false, error: `Credential lookup failed: ${err.message}` });
  }
  if (!cred) return res.status(412).json({ ok: false, error: credError(req, from) });

  let token;
  try {
    token = await getMicrosoftAccessToken(cred.userId);
  } catch (err) {
    return res.status(502).json({ ok: false, error: `Microsoft token refresh failed: ${err.message}` });
  }

  try {
    const r = await sendReplyViaGraph({
      accessToken: token.accessToken,
      inReplyToMessageId,
      body,
      cc,
      bcc,
      replyAll: !!replyAll,
      includeOriginalBody: includeOriginalBody !== false,
    });
    console.log(`[mcpBridge] ${replyAll ? 'replyAll' : 'reply'} ${cred.email} → ${r.graphMessageId} in ${r.elapsedMs}ms — newMessageId ${r.captured ? 'captured' : 'NOT captured'}`);
    return res.json({
      ok: true,
      status: 'sent',
      threaded: true,
      from: cred.email,
      inReplyToMessageId: r.graphMessageId,
      replyAll: !!replyAll,
      includedOriginalBody: r.includedOriginalBody,
      messageId: r.messageId,
      internetMessageId: r.internetMessageId,
      conversationId: r.conversationId,
      ...(r.captured ? {} : { warning: 'Reply was sent and threaded correctly, but the new messageId could not be read back from Sent Items in time. ' + (r.lookupError ? `Lookup error: ${r.lookupError}` : '') }),
      elapsedMs: r.elapsedMs,
    });
  } catch (err) {
    return res.status(err.httpStatus || 502).json({ ok: false, error: err.message });
  }
});

// POST /api/mcp/enqueue-email — paced send. Enqueues into OutboundQueue; the
// worker drains at the configured pace/window/cap. Use for batches.
// Body: { to, subject, body, cc?, bcc?, from?,
//         inReplyToMessageId?, replyAll?, includeOriginalBody?,   // paced reply
//         batchId?, scheduledFor?,                                // grouping / future-date
//         dailyCap?, gate? }                                      // day policy (from Cowork/Send Health)
router.post('/enqueue-email', requireBridgeAuth, async (req, res) => {
  const {
    to, subject, body, cc, bcc, from,
    inReplyToMessageId, replyAll = false, includeOriginalBody = true,
    batchId, scheduledFor, dailyCap, gate,
  } = req.body || {};

  const isReply = ok(inReplyToMessageId);
  if (isReply) {
    if (!ok(body)) return res.status(400).json({ ok: false, error: '"body" is required' });
  } else {
    if (!isEmail(to)) return res.status(400).json({ ok: false, error: '"to" must be a valid email' });
    if (!ok(subject)) return res.status(400).json({ ok: false, error: '"subject" is required' });
    if (!ok(body)) return res.status(400).json({ ok: false, error: '"body" is required' });
  }
  if (cc && !isEmail(cc)) return res.status(400).json({ ok: false, error: '"cc" must be a valid email' });
  if (bcc && !isEmail(bcc)) return res.status(400).json({ ok: false, error: '"bcc" must be a valid email' });
  if (from && !isEmail(from)) return res.status(400).json({ ok: false, error: '"from" must be a valid email' });
  if (gate != null && !['proceed', 'warning', 'abort'].includes(gate)) {
    return res.status(400).json({ ok: false, error: '"gate" must be one of: proceed | warning | abort' });
  }
  if (dailyCap != null && (!Number.isInteger(dailyCap) || dailyCap < 0)) {
    return res.status(400).json({ ok: false, error: '"dailyCap" must be a non-negative integer' });
  }
  let scheduledForDate = null;
  if (scheduledFor != null) {
    scheduledForDate = new Date(scheduledFor);
    if (Number.isNaN(scheduledForDate.getTime())) return res.status(400).json({ ok: false, error: '"scheduledFor" must be an ISO date' });
  }

  let cred;
  try {
    cred = await resolveCred(req, from);
  } catch (err) {
    return res.status(500).json({ ok: false, error: `Credential lookup failed: ${err.message}` });
  }
  if (!cred) return res.status(412).json({ ok: false, error: credError(req, from) });

  const cfg = getConfig();
  const localDate = localDateString(new Date(), cfg.tz);

  try {
    // Upsert today's policy from the cap/gate the caller (Cowork) computed
    // from Send Health. Last-write-wins across a batch.
    if (dailyCap != null || gate != null) {
      await prisma.sendPolicy.upsert({
        where: { userId_localDate: { userId: cred.userId, localDate } },
        update: { ...(dailyCap != null ? { dailyCap } : {}), ...(gate != null ? { gate } : {}) },
        create: { userId: cred.userId, localDate, dailyCap: dailyCap ?? cfg.defaultDailyCap, gate: gate ?? 'proceed' },
      });
    }

    const trackingId = `q_${crypto.randomUUID()}`;
    const row = await prisma.outboundQueue.create({
      data: {
        userId: cred.userId,
        trackingId,
        to: to || '',
        subject: subject || '',
        body: body || '',
        cc: cc || null,
        bcc: bcc || null,
        inReplyToMessageId: inReplyToMessageId || null,
        replyAll: !!replyAll,
        includeOriginalBody: includeOriginalBody !== false,
        batchId: batchId || null,
        scheduledFor: scheduledForDate,
      },
    });

    const queuePosition = await prisma.outboundQueue.count({ where: { userId: cred.userId, status: 'queued' } });
    const policy = await prisma.sendPolicy.findUnique({ where: { userId_localDate: { userId: cred.userId, localDate } } }).catch(() => null);
    const avgPace = (cfg.paceMinMs + cfg.paceMaxMs) / 2;
    const base = Math.max(Date.now(), policy?.nextEligibleAt ? new Date(policy.nextEligibleAt).getTime() : Date.now(), scheduledForDate ? scheduledForDate.getTime() : 0);
    const estimatedSendAt = new Date(base + (queuePosition - 1) * avgPace); // rough — ignores window rollover

    return res.json({
      ok: true,
      status: 'queued',
      trackingId,
      id: row.id,
      from: cred.email,
      to: to || null,
      isReply,
      batchId: batchId || null,
      queuePosition,
      estimatedSendAt: estimatedSendAt.toISOString(),
      note: 'Queued. The worker paces sends within the send window under the day\'s cap; gate=abort halts the day. Poll GET /api/mcp/queue?batchId=… for status + messageId.',
    });
  } catch (err) {
    console.error('[mcpBridge] enqueue failed:', err.message);
    return res.status(500).json({ ok: false, error: `Enqueue failed: ${err.message}` });
  }
});

// GET /api/mcp/queue?batchId=&status=&date= — list queue items (for reconciliation).
router.get('/queue', requireBridgeAuth, async (req, res) => {
  const { batchId, status } = req.query || {};
  const where = {
    ...(req.mcpUser ? { userId: req.mcpUser.id } : {}),
    ...(batchId ? { batchId: String(batchId) } : {}),
    ...(status ? { status: String(status) } : {}),
  };
  try {
    const items = await prisma.outboundQueue.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      select: {
        trackingId: true, to: true, subject: true, status: true, batchId: true,
        inReplyToMessageId: true, scheduledFor: true, sentAt: true,
        messageId: true, internetMessageId: true, conversationId: true,
        attempts: true, failureReason: true, createdAt: true,
      },
    });
    const counts = items.reduce((acc, it) => ((acc[it.status] = (acc[it.status] || 0) + 1), acc), {});
    return res.json({ ok: true, total: items.length, counts, items });
  } catch (err) {
    return res.status(500).json({ ok: false, error: `Queue lookup failed: ${err.message}` });
  }
});

// GET /api/mcp/queue/:trackingId — single item status.
router.get('/queue/:trackingId', requireBridgeAuth, async (req, res) => {
  try {
    const item = await prisma.outboundQueue.findUnique({ where: { trackingId: req.params.trackingId } });
    if (!item || (req.mcpUser && item.userId !== req.mcpUser.id)) {
      return res.status(404).json({ ok: false, error: 'No queue item with that trackingId' });
    }
    return res.json({ ok: true, item });
  } catch (err) {
    return res.status(500).json({ ok: false, error: `Queue lookup failed: ${err.message}` });
  }
});

// PATCH /api/mcp/queue/:trackingId/cancel — cancel a still-queued item.
router.patch('/queue/:trackingId/cancel', requireBridgeAuth, async (req, res) => {
  try {
    const item = await prisma.outboundQueue.findUnique({ where: { trackingId: req.params.trackingId } });
    if (!item || (req.mcpUser && item.userId !== req.mcpUser.id)) {
      return res.status(404).json({ ok: false, error: 'No queue item with that trackingId' });
    }
    if (item.status !== 'queued') {
      return res.status(409).json({ ok: false, error: `Cannot cancel an item in status "${item.status}"` });
    }
    await prisma.outboundQueue.update({ where: { trackingId: req.params.trackingId }, data: { status: 'cancelled' } });
    return res.json({ ok: true, status: 'cancelled', trackingId: req.params.trackingId });
  } catch (err) {
    return res.status(500).json({ ok: false, error: `Cancel failed: ${err.message}` });
  }
});

module.exports = router;
