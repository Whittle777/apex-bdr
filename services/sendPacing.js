/**
 * sendPacing — PURE pacing logic for the outbound send queue. No DB, no IO,
 * no clock/env reads inside the decision function, so it is fully
 * unit-testable with an injected clock + rng. services/sendQueueWorker.js
 * wraps these with the Prisma/Graph side effects.
 */

// Hard safety ceiling: no daily cap (env default OR a per-day SendPolicy row OR
// a per-call override) may ever exceed this, so a typo like 1500 can't blast
// the mailbox. Itself overridable via SEND_HARD_CAP_CEILING for ops, but that's
// a deliberate, separate knob — the everyday cap env can't quietly cross it.
const DEFAULT_HARD_CAP_CEILING = 300;

// Rolling 7-day send ceiling — the real deliverability guard. Independent of
// the daily cap: at any instant, the trailing 7 days of paced sends may not
// exceed this. Default 5000/week; itself bounded by a weekly hard ceiling so a
// typo can't blow the limit wide open.
const DEFAULT_WEEKLY_CAP = 5000;
const DEFAULT_WEEKLY_HARD_CEILING = 10000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Clamp any requested cap into [0, ceiling]. Non-numeric/negative → 0.
function clampCap(cap, ceiling = DEFAULT_HARD_CAP_CEILING) {
  const n = Number(cap);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.floor(n), ceiling);
}

/**
 * The cap the worker actually enforces for a user/day. Per-day SendPolicy.cap
 * (written by the Cowork daily task from Send Health) is authoritative and wins
 * over the env default; either way the result is clamped to the hard ceiling.
 * PURE — no DB/clock.
 */
function effectiveCap({ policyCap, defaultCap, ceiling = DEFAULT_HARD_CAP_CEILING } = {}) {
  const base = policyCap != null ? policyCap : defaultCap;
  return clampCap(base, ceiling);
}

// Config (env-driven, tunable on Railway without redeploy). Read here so the
// route and worker share one source of defaults.
function getConfig() {
  const num = (v, d) => (v != null && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);
  const hardCapCeiling = num(process.env.SEND_HARD_CAP_CEILING, DEFAULT_HARD_CAP_CEILING);
  const weeklyHardCeiling = num(process.env.SEND_WEEKLY_HARD_CEILING, DEFAULT_WEEKLY_HARD_CEILING);
  // Accept the spec name DAILY_SEND_CAP as an alias for SEND_DEFAULT_DAILY_CAP;
  // the former wins if both are set. Clamped so an env typo can't exceed the ceiling.
  const rawDefaultCap = num(process.env.DAILY_SEND_CAP, num(process.env.SEND_DEFAULT_DAILY_CAP, 150));
  const rawWeeklyCap = num(process.env.WEEKLY_SEND_CAP, DEFAULT_WEEKLY_CAP);
  return {
    enabled: process.env.SEND_QUEUE_ENABLED !== '0', // default ON; set 0 to disable
    tz: process.env.SEND_TIMEZONE || 'America/Los_Angeles',
    windowStartHour: num(process.env.SEND_WINDOW_START_HOUR, 8),
    windowEndHour: num(process.env.SEND_WINDOW_END_HOUR, 17),
    paceMinMs: num(process.env.SEND_PACE_MIN_MS, 60000), // 1 min
    paceMaxMs: num(process.env.SEND_PACE_MAX_MS, 120000), // 2 min
    jitterMs: num(process.env.SEND_JITTER_MS, 30000), // ±30 s
    hardCapCeiling,
    defaultDailyCap: clampCap(rawDefaultCap, hardCapCeiling),
    weeklyHardCeiling,
    weeklyCap: clampCap(rawWeeklyCap, weeklyHardCeiling),
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
 * @returns {{ action: 'send'|'wait'|'window-closed'|'cap-reached'|'weekly-cap-reached'|'aborted'|'idle',
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
  sentThisWeekCount = 0,
  weeklyCap = Infinity, // absent → no weekly limit (keeps old callers unchanged)
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

  // Rolling 7-day ceiling is the hard deliverability guard — checked before the
  // daily cap so a high daily number can never breach the weekly budget.
  if (sentThisWeekCount >= weeklyCap) return { action: 'weekly-cap-reached' };

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
  DEFAULT_HARD_CAP_CEILING,
  DEFAULT_WEEKLY_CAP,
  DEFAULT_WEEKLY_HARD_CEILING,
  WEEK_MS,
  clampCap,
  effectiveCap,
  getConfig,
  localDateString,
  localHour,
  computeInterval,
  pickNextDecision,
};
