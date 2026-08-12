/**
 * queueTracking.js
 *
 * Open/click recorders for bridge/queue sends (OutboundQueue rows),
 * mirroring enrollmentService.recordOpen/recordClick for sequence
 * emails. Keyed by the item's trackingId. Engagement never touches the
 * queue status machine (queued|paused|sending|sent|failed|cancelled) —
 * it only fills openedAt/clickedAt/clickCount on an already-sent row.
 */

const prisma = require('./database');

// A hit bearing a valid HMAC over the trackingId can only originate from
// an email that was actually built and dispatched, so the recorders
// accept rows still mid-flight: 'sending' covers the window while the
// worker polls Sent Items after Graph has already delivered (Apple Mail
// prefetches pixels within seconds), and 'queued' covers a requeue after
// a crash between delivery and the sent-update.
const RECORDABLE = ['queued', 'sending', 'sent'];

/** Record an open on a dispatched queue item. Returns the row or null. */
async function recordQueueOpen(trackingId) {
  const item = await prisma.outboundQueue.findFirst({
    where: { trackingId, status: { in: RECORDABLE } },
  });
  if (!item) return null;
  if (item.openedAt) return item; // first open wins; proxies re-fetch pixels
  return prisma.outboundQueue.update({
    where: { id: item.id },
    data: { openedAt: new Date() },
  });
}

/**
 * Record a link click on a sent queue item. A click implies the email
 * was opened, so openedAt is backfilled too. Returns the row or null.
 */
async function recordQueueClick(trackingId) {
  const item = await prisma.outboundQueue.findFirst({
    where: { trackingId, status: { in: RECORDABLE } },
  });
  if (!item) return null;
  return prisma.outboundQueue.update({
    where: { id: item.id },
    data: {
      openedAt: item.openedAt || new Date(),
      clickedAt: item.clickedAt || new Date(),
      clickCount: { increment: 1 },
    },
  });
}

module.exports = { recordQueueOpen, recordQueueClick };
