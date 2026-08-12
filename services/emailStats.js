/**
 * emailStats.js
 *
 * Shared open/click-rate aggregation over EmailActivity. One source of
 * truth consumed by:
 *   - GET /email-activities/stats           (AnalyticsDashboard)
 *   - GET /api/mcp/email-stats              (get_email_stats MCP tool)
 *   - POST /orchestration/nlq               (Dashboard chat CRM snapshot)
 *
 * Status semantics: a row's status moves 'sent' → 'opened' when the
 * tracking pixel fires, so "delivered" always means status IN
 * ('sent','opened'). Clicks live in clickedAt/clickCount and imply an
 * open (recordClick backfills openedAt).
 *
 * All counts are anchored on sentAt (the send cohort): "of the emails
 * sent in this window, how many were opened / clicked", which keeps the
 * rates internally consistent. failed/draftPending/approved anchor on
 * createdAt since they have no sentAt.
 */

const prisma = require('./database');
const { getConfig, localDateString } = require('./sendPacing');

const rate = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0);

const GROUP_BYS = ['sequence', 'step', 'day'];

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Offset (ms) between `tz` wall-clock time and UTC at a given instant.
 * Standard Intl technique; accurate except within an hour of a DST flip.
 */
function tzOffsetMs(instant, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(instant).map(p => [p.type, p.value])
  );
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
  // Intl drops milliseconds — compare against the seconds-aligned instant
  // or sub-second inputs skew the offset by up to 2s.
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The UTC instant of the given tz-local wall-clock time. */
function zonedInstant(isoLocalAsUtc) {
  const guess = new Date(isoLocalAsUtc);
  return new Date(guess.getTime() - tzOffsetMs(guess, getConfig().tz));
}

/**
 * Parse a since/until query value into a Date. Date-only strings
 * (YYYY-MM-DD) are interpreted in the configured send timezone — start
 * of that local day for since, END of it for until — so "to=2026-08-10"
 * includes everything the day-grouping would bucket under 2026-08-10.
 * Full timestamps pass straight through to new Date().
 */
function parseSinceParam(raw) {
  if (!raw) return undefined;
  return DATE_ONLY.test(raw) ? zonedInstant(`${raw}T00:00:00.000Z`) : new Date(raw);
}
function parseUntilParam(raw) {
  if (!raw) return undefined;
  return DATE_ONLY.test(raw) ? zonedInstant(`${raw}T23:59:59.999Z`) : new Date(raw);
}

function tally(rows) {
  const sent = rows.length;
  const opened = rows.filter(r => r.status === 'opened' || r.openedAt).length;
  const clicked = rows.filter(r => r.clickedAt).length;
  const totalClicks = rows.reduce((n, r) => n + (r.clickCount || 0), 0);
  return {
    sent,
    opened,
    clicked,
    totalClicks,
    openRate: rate(opened, sent),
    clickRate: rate(clicked, sent),
    clickToOpenRate: rate(clicked, opened),
  };
}

// Day buckets use the configured send timezone (same convention as
// sendQueueWorker's daily-cap accounting), NOT UTC — otherwise every
// evening PT send lands in the following day's bucket.
const dayKey = (d) => localDateString(new Date(d), getConfig().tz);

function groupKeyFor(groupBy, row) {
  if (groupBy === 'sequence') {
    const seq = row.sequenceStep?.sequence;
    return seq ? { key: `sequence-${seq.id}`, label: seq.name, sequenceId: seq.id } : null;
  }
  if (groupBy === 'step') {
    const step = row.sequenceStep;
    if (!step) return null;
    return {
      key: `step-${step.id}`,
      label: `${step.sequence?.name || 'Unknown sequence'} — Step ${step.order}${step.subject ? `: ${step.subject}` : ''}`,
      sequenceId: step.sequence?.id ?? null,
      stepId: step.id,
      stepOrder: step.order,
    };
  }
  // 'day' — bucket by the row's anchor date (sentAt for delivered rows,
  // createdAt for failed ones).
  const anchor = row.sentAt || row.createdAt;
  return anchor ? { key: dayKey(anchor), label: dayKey(anchor) } : null;
}

/**
 * @param {object} opts
 * @param {number}  [opts.sequenceId] restrict to one sequence
 * @param {Date}    [opts.since]      sentAt lower bound (default: epoch)
 * @param {Date}    [opts.until]      sentAt upper bound (default: now)
 * @param {string}  [opts.groupBy]    'sequence' | 'step' | 'day' — adds a groups[] breakdown
 */
async function getEmailStats({ sequenceId, since, until, groupBy } = {}) {
  since = since || new Date(0);
  until = until || new Date();
  sequenceId = sequenceId ? parseInt(sequenceId, 10) : null;
  if (sequenceId !== null && Number.isNaN(sequenceId)) {
    throw new Error('sequenceId must be a number');
  }
  if (groupBy && !GROUP_BYS.includes(groupBy)) {
    throw new Error(`groupBy must be one of: ${GROUP_BYS.join(', ')}`);
  }

  const seqFilter = sequenceId ? { enrollment: { sequenceId } } : {};
  const stepInclude = {
    sequenceStep: {
      select: {
        id: true,
        order: true,
        subject: true,
        sequence: { select: { id: true, name: true } },
      },
    },
  };

  const [delivered, failedRows, draftPending, approved] = await Promise.all([
    prisma.emailActivity.findMany({
      where: {
        ...seqFilter,
        status: { in: ['sent', 'opened'] },
        sentAt: { gte: since, lte: until },
      },
      select: {
        status: true,
        sentAt: true,
        openedAt: true,
        clickedAt: true,
        clickCount: true,
        ...stepInclude,
      },
    }),
    prisma.emailActivity.findMany({
      where: {
        ...seqFilter,
        status: 'failed',
        createdAt: { gte: since, lte: until },
      },
      select: { createdAt: true, sentAt: true, ...stepInclude },
    }),
    prisma.emailActivity.count({
      where: { ...seqFilter, status: 'draft_pending', createdAt: { gte: since, lte: until } },
    }),
    prisma.emailActivity.count({
      where: { ...seqFilter, status: 'approved', createdAt: { gte: since, lte: until } },
    }),
  ]);

  const totals = tally(delivered);
  const failed = failedRows.length;

  const result = {
    since: since.toISOString(),
    until: until.toISOString(),
    sequenceId,
    ...totals,
    failed,
    draftPending,
    approved,
    // Total "delivered or attempted" — useful as the headline number
    totalAttempts: totals.sent + failed,
  };

  if (groupBy) {
    const buckets = new Map();
    const bucketFor = (meta) => {
      if (!buckets.has(meta.key)) buckets.set(meta.key, { meta, delivered: [], failed: 0 });
      return buckets.get(meta.key);
    };
    for (const row of delivered) {
      const meta = groupKeyFor(groupBy, row);
      if (meta) bucketFor(meta).delivered.push(row);
    }
    for (const row of failedRows) {
      const meta = groupKeyFor(groupBy, row);
      if (meta) bucketFor(meta).failed += 1;
    }

    result.groupBy = groupBy;
    result.groups = [...buckets.values()]
      .map(b => ({ ...b.meta, ...tally(b.delivered), failed: b.failed }))
      .sort((a, b) => {
        if (groupBy === 'day') return a.key.localeCompare(b.key);
        if (groupBy === 'step') {
          return (a.sequenceId ?? 0) - (b.sequenceId ?? 0) || (a.stepOrder ?? 0) - (b.stepOrder ?? 0);
        }
        return b.sent - a.sent; // sequences: busiest first
      });
  }

  return result;
}

/**
 * Open/click engagement for bridge/queue sends (OutboundQueue) — the
 * cohort get_email_stats' sequence numbers deliberately exclude, since
 * queue sends create no EmailActivity rows. Same cohort semantics:
 * counts anchor on sentAt within [since, until]. Pass userId to scope
 * to one sending account (the bridge does); omit it for app-wide
 * aggregates (the NLQ snapshot does).
 */
async function getQueueEngagementStats({ userId, since, until } = {}) {
  since = since || new Date(0);
  until = until || new Date();
  const rows = await prisma.outboundQueue.findMany({
    where: {
      ...(userId ? { userId } : {}),
      status: 'sent',
      sentAt: { gte: since, lte: until },
    },
    select: { status: true, sentAt: true, openedAt: true, clickedAt: true, clickCount: true },
  });
  return {
    since: since.toISOString(),
    until: until.toISOString(),
    ...tally(rows),
  };
}

module.exports = { getEmailStats, getQueueEngagementStats, parseSinceParam, parseUntilParam };
