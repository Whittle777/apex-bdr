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
const { getSendPolicyStatus } = require('../services/sendQueueWorker');
const { buildSelectorWhere, actionStatuses, targetStatus, partitionUpdate } = require('../services/queueOps');
const {
  MAX_BATCH_SIZE, REPLAY_WINDOW_MS, DEFAULT_DEDUPE_SCOPE,
  getBlockedDomains, dedupeStatesFor, rowDedupeKey,
  validateItem, decideBatch, countDecisions,
} = require('../services/enqueueBatch');

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

// Assemble a BatchResult from PURE decisions + the trackingIds minted for the
// accepted rows. clientRef is echoed back only when the caller supplied it.
function assembleBatchResult(batchId, decisions, trackingByIndex) {
  return {
    batchId,
    counts: countDecisions(decisions),
    items: decisions.map((d) => ({
      ...(d.clientRef != null ? { clientRef: d.clientRef } : {}),
      to: d.to,
      status: d.status,
      ...(d.status === 'accepted' && trackingByIndex[d.index] ? { trackingId: trackingByIndex[d.index] } : {}),
      ...(d.reason ? { reason: d.reason } : {}),
    })),
  };
}

// Persist the BatchResult under the caller's idempotencyKey so a retry replays
// it instead of re-queuing. Best-effort: a store failure doesn't fail the batch
// (per-recipient dedup is the real double-send guard).
async function storeBatchReceipt(idempotencyKey, userId, batchId, result) {
  if (!idempotencyKey) return;
  try {
    await prisma.batchReceipt.upsert({
      where: { idempotencyKey },
      update: { result: JSON.stringify(result), batchId },
      create: { idempotencyKey, userId, batchId, result: JSON.stringify(result) },
    });
  } catch (err) {
    console.warn('[mcpBridge] batch receipt store failed:', err.message);
  }
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
// Body: { inReplyToMessageId, body, to?, from?, cc?, bcc?, replyAll?, includeOriginalBody? }
// `to` = the recipient the reply must go to (the prospect). It OVERRIDES Graph's
// reply-to-sender default; omit only to fall back to the parent's To line minus self.
router.post('/reply-email', requireBridgeAuth, async (req, res) => {
  const { inReplyToMessageId, body, to, from, cc, bcc, replyAll = false, includeOriginalBody = true } = req.body || {};

  if (!ok(inReplyToMessageId)) return res.status(400).json({ ok: false, error: '"inReplyToMessageId" is required' });
  if (!ok(body)) return res.status(400).json({ ok: false, error: '"body" is required' });
  if (to && !isEmail(to)) return res.status(400).json({ ok: false, error: '"to" must be a valid email' });
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
      to,
      inReplyToMessageId,
      body,
      cc,
      bcc,
      replyAll: !!replyAll,
      includeOriginalBody: includeOriginalBody !== false,
      selfEmail: cred.email,
    });
    // Sent to ourselves instead of the prospect — report loudly, do not claim success.
    if (r.misdirected) {
      return res.status(502).json({
        ok: false,
        error: `Reply was delivered to the sending mailbox (${cred.email}), not "${r.to}". Microsoft Graph did not honor the recipient override. No further replies should be sent until this is resolved.`,
        misdirected: true,
      });
    }
    console.log(`[mcpBridge] reply ${cred.email} → ${r.to} (thread ${r.graphMessageId}) in ${r.elapsedMs}ms — newMessageId ${r.captured ? 'captured' : 'NOT captured'}`);
    return res.json({
      ok: true,
      status: 'sent',
      threaded: true,
      from: cred.email,
      to: r.to,
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
  // Shared per-item validation (the SAME routine enqueue_batch loops) + the
  // server-side blocklist, so single and batch sends can never diverge on what
  // they accept (spec §8).
  const v = validateItem({ to, subject, body, cc, bcc, inReplyToMessageId, scheduledFor }, { blockedDomains: getBlockedDomains() });
  if (!v.valid) {
    const code = v.reason === 'blocked domain' ? 422 : 400;
    return res.status(code).json({ ok: false, status: 'rejected', reason: v.reason, error: `Rejected: ${v.reason}` });
  }
  if (from && !isEmail(from)) return res.status(400).json({ ok: false, error: '"from" must be a valid email' });
  if (gate != null && !['proceed', 'warning', 'abort'].includes(gate)) {
    return res.status(400).json({ ok: false, error: '"gate" must be one of: proceed | warning | abort' });
  }
  if (dailyCap != null && (!Number.isInteger(dailyCap) || dailyCap < 0)) {
    return res.status(400).json({ ok: false, error: '"dailyCap" must be a non-negative integer' });
  }
  if (dailyCap != null && dailyCap > getConfig().hardCapCeiling) {
    return res.status(400).json({ ok: false, error: `"dailyCap" (${dailyCap}) exceeds the hard safety ceiling of ${getConfig().hardCapCeiling}. Raise SEND_HARD_CAP_CEILING if this is intentional.` });
  }
  const scheduledForDate = v.scheduledForMs != null ? new Date(v.scheduledForMs) : null;

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

    // gate=abort (Send Health CRITICAL) halts the day — record the gate but
    // queue nothing. Matches enqueue_batch, which rejects the whole batch.
    if (gate === 'abort') {
      return res.status(409).json({
        ok: false, status: 'rejected', reason: 'gate=abort',
        error: 'gate=abort — sending is halted for today (Send Health CRITICAL). Nothing was queued.',
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

// POST /api/mcp/enqueue-batch — enqueue MANY messages in ONE call. One approval
// prompt, one reconcilable result, no double-sends on retry. Loops the same
// validate + persist path as /enqueue-email; adds server-side dedup, batch
// self-dedup, idempotency replay, and a per-item accepted/skipped/rejected
// report. Pacing/window/cap are unchanged — this only decides what enters the
// queue. Body: { items[], batchId?, idempotencyKey?, gate?, dailyCap?, from?,
//                defaultScheduledFor?, dedupeScope? }
router.post('/enqueue-batch', requireBridgeAuth, async (req, res) => {
  const {
    items, batchId: batchIdIn, idempotencyKey, gate, dailyCap, from,
    defaultScheduledFor, dedupeScope = DEFAULT_DEDUPE_SCOPE,
  } = req.body || {};

  // ── Top-level validation (whole-call shape) ──────────────────────────────
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ ok: false, error: '"items" must be a non-empty array' });
  }
  if (items.length > MAX_BATCH_SIZE) {
    return res.status(400).json({ ok: false, error: `Batch too large: ${items.length} items (max ${MAX_BATCH_SIZE}).` });
  }
  if (gate != null && !['proceed', 'warning', 'abort'].includes(gate)) {
    return res.status(400).json({ ok: false, error: '"gate" must be one of: proceed | warning | abort' });
  }
  if (dailyCap != null && (!Number.isInteger(dailyCap) || dailyCap < 0)) {
    return res.status(400).json({ ok: false, error: '"dailyCap" must be a non-negative integer' });
  }
  if (dailyCap != null && dailyCap > getConfig().hardCapCeiling) {
    return res.status(400).json({ ok: false, error: `"dailyCap" (${dailyCap}) exceeds the hard safety ceiling of ${getConfig().hardCapCeiling}. Raise SEND_HARD_CAP_CEILING if this is intentional.` });
  }
  if (!['queue', 'queue+sent', 'none'].includes(dedupeScope)) {
    return res.status(400).json({ ok: false, error: '"dedupeScope" must be one of: queue | queue+sent | none' });
  }
  if (from && !isEmail(from)) {
    return res.status(400).json({ ok: false, error: '"from" must be a valid email' });
  }
  let defaultScheduledForDate = null;
  if (defaultScheduledFor != null) {
    defaultScheduledForDate = new Date(defaultScheduledFor);
    if (Number.isNaN(defaultScheduledForDate.getTime())) {
      return res.status(400).json({ ok: false, error: '"defaultScheduledFor" must be an ISO date' });
    }
  }

  let cred;
  try {
    cred = await resolveCred(req, from);
  } catch (err) {
    return res.status(500).json({ ok: false, error: `Credential lookup failed: ${err.message}` });
  }
  if (!cred) return res.status(412).json({ ok: false, error: credError(req, from) });

  // ── Idempotency replay: same key within the window → return stored result ─
  if (ok(idempotencyKey)) {
    try {
      const receipt = await prisma.batchReceipt.findUnique({ where: { idempotencyKey } });
      if (receipt && receipt.userId === cred.userId &&
          (Date.now() - new Date(receipt.createdAt).getTime()) < REPLAY_WINDOW_MS) {
        return res.json({ ok: true, replayed: true, ...JSON.parse(receipt.result) });
      }
    } catch (err) {
      console.warn('[mcpBridge] idempotency lookup failed (processing fresh):', err.message);
    }
  }

  const cfg = getConfig();
  const localDate = localDateString(new Date(), cfg.tz);
  const batchId = ok(batchIdIn) ? String(batchIdIn) : `b_${crypto.randomUUID()}`;
  const blockedDomains = getBlockedDomains();

  try {
    // Record today's policy (cap/gate from Send Health), same as single-send.
    if (dailyCap != null || gate != null) {
      await prisma.sendPolicy.upsert({
        where: { userId_localDate: { userId: cred.userId, localDate } },
        update: { ...(dailyCap != null ? { dailyCap } : {}), ...(gate != null ? { gate } : {}) },
        create: { userId: cred.userId, localDate, dailyCap: dailyCap ?? cfg.defaultDailyCap, gate: gate ?? 'proceed' },
      });
    }

    // gate=abort → reject the WHOLE batch, accept none. Still returns a full
    // per-item report so the agent can surface it.
    if (gate === 'abort') {
      const { decisions } = decideBatch({ items, existingKeys: new Set(), blockedDomains, dedupeScope, gate });
      const result = assembleBatchResult(batchId, decisions, {});
      await storeBatchReceipt(idempotencyKey, cred.userId, batchId, result);
      console.log(`[mcpBridge] enqueue_batch ${batchId} (user ${cred.userId}) gate=abort — rejected all ${items.length}`);
      return res.json({ ok: true, ...result });
    }

    // Build the set of dedupe keys already present in the queue for this user
    // under the scoped statuses, so decideBatch can flag duplicates.
    const states = dedupeStatesFor(dedupeScope);
    let existingKeys = new Set();
    if (states.length) {
      const rows = await prisma.outboundQueue.findMany({
        where: { userId: cred.userId, status: { in: states } },
        select: { to: true, inReplyToMessageId: true },
      });
      existingKeys = new Set(rows.map(rowDedupeKey));
    }

    const { decisions } = decideBatch({ items, existingKeys, blockedDomains, dedupeScope, gate });

    // Persist accepted items one-by-one (so a mid-batch crash leaves the
    // already-persisted rows queued; an idempotencyKey replay finishes the rest
    // without re-queuing them).
    const trackingByIndex = {};
    for (const d of decisions) {
      if (d.status !== 'accepted') continue;
      const item = items[d.index];
      const trackingId = `q_${crypto.randomUUID()}`;
      const scheduledForDate = d.scheduledForMs != null ? new Date(d.scheduledForMs) : defaultScheduledForDate;
      await prisma.outboundQueue.create({
        data: {
          userId: cred.userId,
          trackingId,
          to: item.to || '',
          subject: item.subject || '',
          body: item.body || '',
          cc: item.cc || null,
          bcc: item.bcc || null,
          inReplyToMessageId: item.inReplyToMessageId || null,
          replyAll: !!item.replyAll,
          includeOriginalBody: item.includeOriginalBody !== false,
          batchId,
          scheduledFor: scheduledForDate || null,
        },
      });
      trackingByIndex[d.index] = trackingId;
    }

    const result = assembleBatchResult(batchId, decisions, trackingByIndex);
    await storeBatchReceipt(idempotencyKey, cred.userId, batchId, result);
    console.log(`[mcpBridge] enqueue_batch ${batchId} (user ${cred.userId}${ok(idempotencyKey) ? `, key ${idempotencyKey}` : ''}): accepted=${result.counts.accepted} skipped=${result.counts.skippedDuplicate} rejected=${result.counts.rejected}`);
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[mcpBridge] enqueue_batch failed:', err.message);
    return res.status(500).json({ ok: false, error: `Enqueue batch failed: ${err.message}` });
  }
});

// GET /api/mcp/queue?batchId=&status=&date= — list queue items (for reconciliation).
router.get('/queue', requireBridgeAuth, async (req, res) => {
  const { batchId, status, recipient, domain } = req.query || {};
  const where = {
    ...(req.mcpUser ? { userId: req.mcpUser.id } : {}),
    ...(batchId ? { batchId: String(batchId) } : {}),
    ...(status ? { status: String(status) } : {}),
    ...(recipient ? { to: { equals: String(recipient), mode: 'insensitive' } } : {}),
    ...(domain ? { to: { endsWith: `@${String(domain).replace(/^@/, '')}`, mode: 'insensitive' } } : {}),
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

    // Surface the day's send policy so "stopped because cap" is never invisible
    // again. Resolve the policy user: per-user token → that user; shared token →
    // first connected Microsoft account (best-effort, never fails the listing).
    let policy = null;
    try {
      const cred = await resolveCred(req);
      if (cred) policy = await getSendPolicyStatus(cred.userId);
    } catch (err) {
      console.warn('[mcpBridge] send-policy lookup for queue failed:', err.message);
    }

    return res.json({ ok: true, total: items.length, counts, policy, items });
  } catch (err) {
    return res.status(500).json({ ok: false, error: `Queue lookup failed: ${err.message}` });
  }
});

// GET /api/mcp/send-policy — the day's effective send policy for the caller's
// inbox: cap, sentToday, remainingToday, gate, and whether the window is open.
// Lets the agent read the cap directly without inspecting the queue.
router.get('/send-policy', requireBridgeAuth, async (req, res) => {
  try {
    const cred = await resolveCred(req);
    if (!cred) return res.status(412).json({ ok: false, error: credError(req) });
    const policy = await getSendPolicyStatus(cred.userId);
    return res.json({ ok: true, from: cred.email, ...policy });
  } catch (err) {
    return res.status(500).json({ ok: false, error: `Send-policy lookup failed: ${err.message}` });
  }
});

// POST /api/mcp/queue/manage — cancel | pause | resume one item, a batch, a
// recipient, or a whole domain. Defined before /queue/:trackingId.
// Body: { action: 'cancel'|'pause'|'resume', trackingId?|batchId?|recipient?|domain? }
//   cancel: queued|paused → cancelled (terminal; never touches sending/sent)
//   pause:  queued → paused (worker skips it)
//   resume: paused → queued
router.post('/queue/manage', requireBridgeAuth, async (req, res) => {
  const { action, trackingId, batchId, recipient, domain } = req.body || {};
  if (!['cancel', 'pause', 'resume'].includes(action)) {
    return res.status(400).json({ ok: false, error: '"action" must be one of: cancel | pause | resume' });
  }
  let sel;
  try {
    sel = buildSelectorWhere({ trackingId, batchId, recipient, domain });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }

  const scoped = { ...sel.where, ...(req.mcpUser ? { userId: req.mcpUser.id } : {}) };
  const eligible = actionStatuses(action);
  const newStatus = targetStatus(action);

  try {
    // Fetch ALL selector matches (any status) so we can report what was
    // skipped (e.g. already sent) rather than silently no-op.
    const all = await prisma.outboundQueue.findMany({
      where: scoped,
      select: { id: true, trackingId: true, to: true, status: true, batchId: true },
      orderBy: { createdAt: 'asc' },
    });
    const actionable = all.filter((i) => eligible.includes(i.status));
    const skipped = all
      .filter((i) => !eligible.includes(i.status))
      .map((i) => ({ trackingId: i.trackingId, to: i.to, status: i.status }));

    if (actionable.length) {
      await prisma.outboundQueue.updateMany({
        where: { id: { in: actionable.map((i) => i.id) } },
        data: {
          status: newStatus,
          ...(action === 'cancel' ? { failureReason: `cancelled via MCP ${new Date().toISOString()}` } : {}),
        },
      });
    }

    console.log(`[mcpBridge] queue ${action} by ${sel.kind}=${sel.value}: ${actionable.length} affected, ${skipped.length} skipped`);
    return res.json({
      ok: true,
      action,
      selector: { kind: sel.kind, value: sel.value },
      count: actionable.length,
      affected: actionable.map((i) => ({ trackingId: i.trackingId, to: i.to, fromStatus: i.status, toStatus: newStatus })),
      skipped,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: `Queue ${action} failed: ${err.message}` });
  }
});

// PATCH /api/mcp/queue/update — alter content/timing of a still-queued/paused
// item. Single item (by trackingId). Recipient/threading are NOT editable.
// Body: { trackingId, subject?, body?, cc?, bcc?, scheduledFor?, replyAll?, includeOriginalBody? }
router.patch('/queue/update', requireBridgeAuth, async (req, res) => {
  const { trackingId } = req.body || {};
  if (!ok(trackingId)) return res.status(400).json({ ok: false, error: '"trackingId" is required' });

  const { data, rejected } = partitionUpdate(req.body || {});
  if (rejected.length) {
    return res.status(400).json({
      ok: false,
      error: `These fields cannot be altered: ${rejected.join(', ')}. Allowed: subject, body, cc, bcc, scheduledFor, replyAll, includeOriginalBody. To change the recipient, cancel and re-enqueue.`,
    });
  }
  if (Object.keys(data).length === 0) {
    return res.status(400).json({ ok: false, error: 'No editable fields provided.' });
  }
  if (data.cc != null && data.cc !== '' && !isEmail(data.cc)) return res.status(400).json({ ok: false, error: '"cc" must be a valid email' });
  if (data.bcc != null && data.bcc !== '' && !isEmail(data.bcc)) return res.status(400).json({ ok: false, error: '"bcc" must be a valid email' });
  if ('scheduledFor' in data && data.scheduledFor != null) {
    const d = new Date(data.scheduledFor);
    if (Number.isNaN(d.getTime())) return res.status(400).json({ ok: false, error: '"scheduledFor" must be an ISO date' });
    data.scheduledFor = d;
  }
  if ('replyAll' in data) data.replyAll = !!data.replyAll;
  if ('includeOriginalBody' in data) data.includeOriginalBody = !!data.includeOriginalBody;
  if (data.cc === '') data.cc = null; // empty string clears
  if (data.bcc === '') data.bcc = null;

  try {
    const item = await prisma.outboundQueue.findUnique({ where: { trackingId } });
    if (!item || (req.mcpUser && item.userId !== req.mcpUser.id)) {
      return res.status(404).json({ ok: false, error: 'No queue item with that trackingId' });
    }
    if (!['queued', 'paused'].includes(item.status)) {
      return res.status(409).json({ ok: false, error: `Cannot alter an item in status "${item.status}" — only queued or paused items are editable.` });
    }
    const updated = await prisma.outboundQueue.update({ where: { trackingId }, data });
    return res.json({
      ok: true,
      status: 'updated',
      trackingId,
      changed: Object.keys(data),
      item: {
        trackingId: updated.trackingId,
        to: updated.to,
        subject: updated.subject,
        status: updated.status,
        cc: updated.cc,
        bcc: updated.bcc,
        scheduledFor: updated.scheduledFor,
        replyAll: updated.replyAll,
        includeOriginalBody: updated.includeOriginalBody,
      },
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: `Update failed: ${err.message}` });
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
