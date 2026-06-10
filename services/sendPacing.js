/**
 * sendPacing — PURE pacing logic for the outbound send queue. No DB, no IO,
 * no clock/env reads inside the decision function, so it is fully
 * unit-testable with an injected clock + rng. services/sendQueueWorker.js
 * wraps these with the Prisma/Graph side effects.
 */

// Config (env-driven, tunable on Railway without redeploy). Read here so the
// route and worker share one source of defaults.
function getConfig() {
  const num = (v, d) => (v != null && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);
  return {
    enabled: process.env.SEND_QUEUE_ENABLED !== '0', // default ON; set 0 to disable
    tz: process.env.SEND_TIMEZONE || 'America/Los_Angeles',
    windowStartHour: num(process.env.SEND_WINDOW_START_HOUR, 8),
    windowEndHour: num(process.env.SEND_WINDOW_END_HOUR, 17),
    paceMinMs: num(process.env.SEND_PACE_MIN_MS, 180000), // 3 min
    paceMaxMs: num(process.env.SEND_PACE_MAX_MS, 240000), // 4 min
    jitterMs: num(process.env.SEND_JITTER_MS, 30000), // ±30 s
    defaultDailyCap: num(process.env.SEND_DEFAULT_DAILY_CAP, 150),
  };
}

// ── Timezone helpers (Intl — no extra dependency) ─────────────────────────
function localDateString(date, tz) {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}
function localHour(date, tz) {
  const h = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hour12: false }).format(date);
  return parseInt(h, 10) % 24; // some envs render midnight as '24'
}

/**
 * Interval (ms) until the next send: a random pick in [paceMinMs, paceMaxMs]
 * plus ±jitterMs, floored at 0.
 */
function computeInterval({ paceMinMs, paceMaxMs, jitterMs, rng = Math.random }) {
  const span = Math.max(0, paceMaxMs - paceMinMs);
  const base = paceMinMs + Math.floor(rng() * (span + 1));
  const jitter = Math.round((rng() * 2 - 1) * jitterMs);
  return Math.max(0, base + jitter);
}

/**
 * PURE decision: given current state, decide whether to send one item now
 * and, if so, when the NEXT becomes eligible.
 *
 * @returns {{ action: 'send'|'wait'|'window-closed'|'cap-reached'|'aborted'|'idle',
 *             item?: object, nextEligibleAt?: Date }}
 */
function pickNextDecision({
  now,
  tz,
  windowStartHour,
  windowEndHour,
  nextEligibleAt,
  sentTodayCount,
  dailyCap,
  gate,
  queuedItems,
  paceMinMs,
  paceMaxMs,
  jitterMs,
  rng = Math.random,
}) {
  if (gate === 'abort') return { action: 'aborted' };

  const hour = localHour(now, tz);
  if (hour < windowStartHour || hour >= windowEndHour) return { action: 'window-closed' };

  if (sentTodayCount >= dailyCap) return { action: 'cap-reached' };

  // Only items whose earliest-eligible time has arrived, oldest first.
  const eligible = (queuedItems || [])
    .filter((it) => !it.scheduledFor || new Date(it.scheduledFor).getTime() <= now.getTime())
    .sort((a, b) => {
      const ax = new Date(a.scheduledFor || a.createdAt).getTime();
      const bx = new Date(b.scheduledFor || b.createdAt).getTime();
      return ax - bx || a.id - b.id;
    });
  if (eligible.length === 0) return { action: 'idle' };

  if (nextEligibleAt && now.getTime() < new Date(nextEligibleAt).getTime()) {
    return { action: 'wait', nextEligibleAt: new Date(nextEligibleAt) };
  }

  const interval = computeInterval({ paceMinMs, paceMaxMs, jitterMs, rng });
  return { action: 'send', item: eligible[0], nextEligibleAt: new Date(now.getTime() + interval) };
}

module.exports = {
  getConfig,
  localDateString,
  localHour,
  computeInterval,
  pickNextDecision,
};
