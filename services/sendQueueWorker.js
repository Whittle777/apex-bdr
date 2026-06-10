/**
 * sendQueueWorker — drains the OutboundQueue at a human pace.
 *
 * Why: the MCP bridge used to send synchronously on every tool call, so a
 * batch left the mailbox in a burst — a top deliverability/spam trigger.
 * This worker (run by node-cron every minute) sends at most ONE queued
 * message per user per eligible tick, spaced 3–4 min ± jitter, only inside
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
const { getConfig, localDateString, localHour, computeInterval, pickNextDecision } = require('./sendPacing');

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
    const dailyCap = policy?.dailyCap ?? cfg.defaultDailyCap;
    const gate = policy?.gate ?? 'proceed';
    const sentTodayCount = await countSentToday(userId, now, cfg);

    const decision = pickNextDecision({
      now,
      tz: cfg.tz,
      windowStartHour: cfg.windowStartHour,
      windowEndHour: cfg.windowEndHour,
      nextEligibleAt: policy?.nextEligibleAt || null,
      sentTodayCount,
      dailyCap,
      gate,
      queuedItems: items,
      paceMinMs: cfg.paceMinMs,
      paceMaxMs: cfg.paceMaxMs,
      jitterMs: cfg.jitterMs,
    });

    if (decision.action !== 'send') continue;
    const item = decision.item;

    // Claim the item so a concurrent tick won't double-send.
    const claim = await prisma.outboundQueue.updateMany({
      where: { id: item.id, status: 'queued' },
      data: { status: 'sending', attempts: { increment: 1 } },
    });
    if (claim.count === 0) continue; // someone else grabbed it

    try {
      const token = await getMicrosoftAccessToken(userId);
      const result = item.inReplyToMessageId
        ? await sendReplyViaGraph({
            accessToken: token.accessToken,
            inReplyToMessageId: item.inReplyToMessageId,
            body: item.body,
            cc: item.cc,
            bcc: item.bcc,
            replyAll: item.replyAll,
            includeOriginalBody: item.includeOriginalBody,
          })
        : await sendEmailViaGraph({
            accessToken: token.accessToken,
            to: item.to,
            subject: item.subject,
            body: item.body,
            cc: item.cc,
            bcc: item.bcc,
          });

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
      // Failed: requeue for retry up to 3 attempts, else mark failed.
      const failStatus = item.attempts + 1 >= 3 ? 'failed' : 'queued';
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
  drainQueue,
};
