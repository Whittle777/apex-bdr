/**
 * sendQueueWorker — drains the OutboundQueue at a human pace.
 *
 * Why: the MCP bridge used to send synchronously on every tool call, so a
 * batch left the mailbox in a burst — a top deliverability/spam trigger.
 * This worker (run by node-cron every minute) sends at most ONE queued
 * message per user per eligible tick, spaced a uniform-random 30–90s (env-
 * configurable) apart, only inside
 * the 8am–5pm PT window, never exceeding the day's cap, and not at all if
 * the day is gated `abort` (Send Health CRITICAL). Cap + gate are supplied
 * by the Cowork daily task at enqueue time (the connector can't read the
 * Send Health workbook) and stored per user/day in SendPolicy.
 *
 * Because state lives in Postgres and pacing is driven by SendPolicy
 * .nextEligibleAt, the cadence survives restarts — no long-lived in-process
 * timer.
 *
 * The decision logic is the pure function `pickNextDecision` (no clock/env
 * reads), so it is fully unit-testable with an injected clock + rng.
 */
const prisma = require('./database');
const { getMicrosoftAccessToken } = require('./sequenceMailer');
const { sendEmailViaGraph, sendReplyViaGraph } = require('./bridgeMailer');
const { resolveAttachmentRefs } = require('./emailAssets');
const { getConfig, localDateString, localHour, computeInterval, pickNextDecision, effectiveCap, WEEK_MS } = require('./sendPacing');
const { getBlockedDomains, domainIsBlocked, domainOf } = require('./enqueueBatch');
const { recipientBlockReasons } = require('./sendGate');
const { adjustGreetingForSendTime } = require('./greetingAdjust');
const { getGateLists } = require('./gateLists');

/**
 * Count messages already sent today (in the send tz) for a user. Low daily
 * volume (cap ≤150), so we fetch the recent sent rows and bucket by PT date
 * in JS — avoids fragile UTC↔PT midnight math in the DB query.
 */
async function countSentToday(userId, now, cfg) {
  const todayLocal = localDateString(now, cfg.tz);
  const coarseStart = new Date(now.getTime() - 48 * 3600 * 1000); // generous lower bound
  const recent = await prisma.outboundQueue.findMany({
    where: { userId, status: 'sent', sentAt: { gte: coarseStart } },
    select: { sentAt: true },
  });
  return recent.filter((r) => r.sentAt && localDateString(r.sentAt, cfg.tz) === todayLocal).length;
}

/**
 * Count messages sent in the trailing 7 days for a user — the rolling weekly
 * budget. A simple `sentAt >= now - 7d` lookback (no tz bucketing needed; it's
 * a span, not a calendar week), so the guarantee is "no more than weeklyCap in
 * any 7-day window," not "resets Monday."
 */
async function countSentThisWeek(userId, now) {
  const weekStart = new Date(now.getTime() - WEEK_MS);
  return prisma.outboundQueue.count({
    where: { userId, status: 'sent', sentAt: { gte: weekStart } },
  });
}

/**
 * Summarize the live send policy for one user/day — the numbers the agent
 * needs to tell "stopped because cap" from "stalled". Mirrors exactly what
 * drainQueue enforces: effective cap (per-day policy ?? env default, clamped),
 * sends used today, remaining, gate, and whether the window is currently open.
 */
async function getSendPolicyStatus(userId, now = new Date()) {
  const cfg = getConfig();
  const localDate = localDateString(now, cfg.tz);
  const policy = await prisma.sendPolicy
    .findUnique({ where: { userId_localDate: { userId, localDate } } })
    .catch(() => null);
  const cap = effectiveCap({ policyCap: policy?.dailyCap, defaultCap: cfg.defaultDailyCap, ceiling: cfg.hardCapCeiling });
  const gate = policy?.gate ?? 'proceed';
  const sentToday = await countSentToday(userId, now, cfg);
  const sentThisWeek = await countSentThisWeek(userId, now);
  const hour = localHour(now, cfg.tz);
  return {
    cap,
    sentToday,
    remainingToday: Math.max(0, cap - sentToday),
    weeklyCap: cfg.weeklyCap,
    sentThisWeek,
    remainingThisWeek: Math.max(0, cfg.weeklyCap - sentThisWeek),
    gate,
    windowOpen: hour >= cfg.windowStartHour && hour < cfg.windowEndHour,
    tz: cfg.tz,
    windowStartHour: cfg.windowStartHour,
    windowEndHour: cfg.windowEndHour,
    paceMinSeconds: cfg.paceMinSeconds,
    paceMaxSeconds: cfg.paceMaxSeconds,
    hardCapCeiling: cfg.hardCapCeiling,
    localDate,
    nextEligibleAt: policy?.nextEligibleAt || null,
  };
}

/**
 * Drain entry point — called by the cron tick. Sends at most one message
 * per user per invocation, honoring window / pace / cap / gate.
 */
async function drainQueue({ now = new Date() } = {}) {
  const cfg = getConfig();
  if (!cfg.enabled) return { skipped: 'disabled' };

  // Reclaim items stuck in 'sending' (e.g. a crash mid-send) back to queued.
  const staleCutoff = new Date(now.getTime() - 10 * 60 * 1000);
  await prisma.outboundQueue
    .updateMany({ where: { status: 'sending', createdAt: { lt: staleCutoff } }, data: { status: 'queued' } })
    .catch(() => {});

  const queued = await prisma.outboundQueue.findMany({
    where: { status: 'queued' },
    orderBy: { createdAt: 'asc' },
  });
  if (queued.length === 0) return { sent: 0, users: 0 };

  // Group queued items by sending user.
  const byUser = new Map();
  for (const it of queued) {
    if (!byUser.has(it.userId)) byUser.set(it.userId, []);
    byUser.get(it.userId).push(it);
  }

  let sent = 0;
  for (const [userId, items] of byUser) {
    const localDate = localDateString(now, cfg.tz);
    const policy = await prisma.sendPolicy.findUnique({ where: { userId_localDate: { userId, localDate } } }).catch(() => null);
    // Per-day policy cap (from Cowork/Send Health) is authoritative and wins
    // over the env default; effectiveCap also clamps it to the hard ceiling so
    // even a bad policy row can't exceed the safety limit.
    const dailyCap = effectiveCap({ policyCap: policy?.dailyCap, defaultCap: cfg.defaultDailyCap, ceiling: cfg.hardCapCeiling });
    const gate = policy?.gate ?? 'proceed';
    const sentTodayCount = await countSentToday(userId, now, cfg);
    const sentThisWeekCount = await countSentThisWeek(userId, now);

    const decision = pickNextDecision({
      now,
      tz: cfg.tz,
      windowStartHour: cfg.windowStartHour,
      windowEndHour: cfg.windowEndHour,
      nextEligibleAt: policy?.nextEligibleAt || null,
      sentTodayCount,
      dailyCap,
      sentThisWeekCount,
      weeklyCap: cfg.weeklyCap,
      gate,
      queuedItems: items,
      paceMinMs: cfg.paceMinMs,
      paceMaxMs: cfg.paceMaxMs,
    });

    if (decision.action !== 'send') continue;
    const item = decision.item;

    // Claim the item so a concurrent tick won't double-send.
    const claim = await prisma.outboundQueue.updateMany({
      where: { id: item.id, status: 'queued' },
      data: { status: 'sending', attempts: { increment: 1 } },
    });
    if (claim.count === 0) continue; // someone else grabbed it

    // Final pre-send compliance check: a recipient DNC'd/bounced/held AFTER
    // enqueue must not be sent to. Terminal cancel, never retried.
    const gateLists = await getGateLists();
    const preSendReasons = [
      ...(item.to && domainIsBlocked(domainOf(item.to), new Set([...getBlockedDomains(), ...gateLists.heldDomains]))
        ? [`BLOCKED_DOMAIN (${domainOf(item.to)})`] : []),
      ...recipientBlockReasons(item.to, gateLists),
    ];
    if (preSendReasons.length) {
      await prisma.outboundQueue.update({
        where: { id: item.id },
        data: { status: 'cancelled', failureReason: `blocked at send time: ${preSendReasons.join('; ')}` },
      }).catch(() => {});
      console.warn(`[sendQueueWorker] queue#${item.id} (user ${userId}) CANCELLED before send → ${item.to}: ${preSendReasons.join('; ')}`);
      continue;
    }

    try {
      const token = await getMicrosoftAccessToken(userId);
      // Time-based greetings ("Good morning") are drafted hours before the paced queue
      // actually dispatches — recompute against the real send clock and the recipient's
      // tz offset (meta.recipientTzOffsetHours, relative to the send tz) so the greeting
      // matches the moment the email lands. Bodies without one pass through unchanged.
      let tzOffset = 0;
      try { tzOffset = Number(JSON.parse(item.meta || '{}').recipientTzOffsetHours) || 0; } catch (_) { /* opaque meta */ }
      const bodyToSend = adjustGreetingForSendTime(item.body, localHour(new Date(), cfg.tz), tzOffset);

      // Resolve inline-image attachments (new-send path only). A missing/unknown
      // asset is a terminal config error — fail the row loudly rather than send an
      // imageless email with a dangling <img src="cid:…">.
      let resolvedAttachments = [];
      if (!item.inReplyToMessageId && item.attachments) {
        let refs = null;
        try { refs = JSON.parse(item.attachments); } catch (_) { refs = null; }
        try {
          resolvedAttachments = await resolveAttachmentRefs(refs);
        } catch (aerr) {
          await prisma.outboundQueue.update({
            where: { id: item.id },
            data: { status: 'failed', failureReason: `attachment resolve failed (not retried): ${aerr.message}` },
          }).catch(() => {});
          console.error(`[sendQueueWorker] queue#${item.id} (user ${userId}) attachment resolve FAILED → ${item.to}: ${aerr.message} — marked failed, NOT sent imageless`);
          continue;
        }
      }

      const result = item.inReplyToMessageId
        ? await sendReplyViaGraph({
            accessToken: token.accessToken,
            to: item.to, // the prospect — reply must go here, NOT the parent's sender
            inReplyToMessageId: item.inReplyToMessageId,
            body: bodyToSend,
            cc: item.cc,
            bcc: item.bcc,
            replyAll: item.replyAll,
            includeOriginalBody: item.includeOriginalBody,
            selfEmail: token.fromEmail, // loop-guard: never deliver a reply back to ourselves
          })
        : await sendEmailViaGraph({
            accessToken: token.accessToken,
            to: item.to,
            subject: item.subject,
            body: bodyToSend,
            cc: item.cc,
            bcc: item.bcc,
            attachments: resolvedAttachments,
          });

      // A reply that landed back at the sending mailbox is a TERMINAL failure —
      // do not record it as sent and do not retry (retry would just re-misfire).
      if (result.misdirected) {
        await prisma.outboundQueue.update({
          where: { id: item.id },
          data: { status: 'failed', failureReason: 'reply misdirected to sending mailbox (Graph ignored recipient override) — halted, not retried' },
        }).catch(() => {});
        console.error(`[sendQueueWorker] queue#${item.id} (user ${userId}) REPLY MISDIRECTED to self — marked failed, NOT retried. Investigate before resuming replies.`);
        continue;
      }

      await prisma.outboundQueue.update({
        where: { id: item.id },
        data: {
          status: 'sent',
          sentAt: new Date(),
          messageId: result.messageId,
          internetMessageId: result.internetMessageId,
          conversationId: result.conversationId,
          failureReason: result.captured ? null : (result.lookupError ? `messageId not captured: ${result.lookupError}` : 'messageId not captured (indexing lag)'),
        },
      });

      // Advance the pacing cursor for this user/day.
      await prisma.sendPolicy.upsert({
        where: { userId_localDate: { userId, localDate } },
        update: { nextEligibleAt: decision.nextEligibleAt },
        create: { userId, localDate, dailyCap, gate, nextEligibleAt: decision.nextEligibleAt },
      });

      sent += 1;
      console.log(`[sendQueueWorker] sent queue#${item.id} (user ${userId}) → ${item.to || item.inReplyToMessageId} — messageId ${result.captured ? 'captured' : 'NOT captured'}`);
    } catch (err) {
      // The loop-guard (no external recipient) is a permanent config problem —
      // retrying can't fix it, so fail terminally instead of churning 3 attempts.
      const terminal = err.code === 'reply_loop_guard';
      const failStatus = terminal || item.attempts + 1 >= 3 ? 'failed' : 'queued';
      await prisma.outboundQueue.update({
        where: { id: item.id },
        data: { status: failStatus, failureReason: err.message },
      }).catch(() => {});
      console.error(`[sendQueueWorker] send failed for queue#${item.id} (attempt ${item.attempts + 1}): ${err.message} → ${failStatus}`);
    }
  }

  return { sent, users: byUser.size };
}

module.exports = {
  getConfig,
  localDateString,
  localHour,
  computeInterval,
  pickNextDecision,
  countSentToday,
  countSentThisWeek,
  getSendPolicyStatus,
  drainQueue,
};
