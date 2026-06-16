/**
 * Pacing logic tests for the outbound send queue. Pure — no DB, no network.
 * Uses a mock clock + seeded rng so the cadence is deterministic.
 *
 * Asserts the behavior the throttling spec requires:
 *  - window: only sends inside 8am–5pm PT
 *  - pace:   ~3–4 min spacing with ±30s jitter
 *  - cap:    stops at the daily cap
 *  - gate:   abort halts the day entirely
 */
const {
  pickNextDecision, computeInterval, localHour, localDateString,
  clampCap, effectiveCap, resolvePace, getConfig, DEFAULT_HARD_CAP_CEILING,
  PACE_FLOOR_SECONDS, PACE_CEILING_SECONDS,
} = require('../services/sendPacing');

const TZ = 'America/Los_Angeles';
const PACE = { paceMinMs: 30000, paceMaxMs: 90000 }; // uniform 30–90s

// Deterministic PRNG (mulberry32) so spacing is reproducible.
function seededRng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const queue = (n) =>
  Array.from({ length: n }, (_, i) => ({ id: i + 1, createdAt: new Date(2026, 5, 10, 9, 0, i).toISOString(), scheduledFor: null }));

const baseArgs = (overrides = {}) => ({
  tz: TZ,
  windowStartHour: 8,
  windowEndHour: 17,
  nextEligibleAt: null,
  sentTodayCount: 0,
  dailyCap: 150,
  gate: 'proceed',
  queuedItems: queue(3),
  ...PACE,
  rng: seededRng(42),
  ...overrides,
});

describe('send pacing — pickNextDecision', () => {
  // June → PDT (UTC-7). 16:00Z = 09:00 PT (in window).
  const inWindow = new Date('2026-06-10T16:00:00Z');

  test('PT hour conversion is correct (sanity)', () => {
    expect(localHour(new Date('2026-06-10T16:00:00Z'), TZ)).toBe(9); // 9am PDT
    expect(localHour(new Date('2026-06-10T14:00:00Z'), TZ)).toBe(7); // 7am PDT (before window)
    expect(localHour(new Date('2026-06-11T01:00:00Z'), TZ)).toBe(18); // 6pm PDT (after window)
    expect(localDateString(new Date('2026-06-11T01:00:00Z'), TZ)).toBe('2026-06-10'); // still the 10th in PT
  });

  test('window-closed before 8am PT', () => {
    const d = pickNextDecision(baseArgs({ now: new Date('2026-06-10T14:00:00Z') })); // 7am PT
    expect(d.action).toBe('window-closed');
  });

  test('window-closed at/after 5pm PT', () => {
    const d = pickNextDecision(baseArgs({ now: new Date('2026-06-11T00:00:00Z') })); // 5pm PT
    expect(d.action).toBe('window-closed');
  });

  test('aborted when gate=abort, even in-window with queue', () => {
    const d = pickNextDecision(baseArgs({ now: inWindow, gate: 'abort' }));
    expect(d.action).toBe('aborted');
  });

  test('cap-reached when sentTodayCount >= dailyCap', () => {
    const d = pickNextDecision(baseArgs({ now: inWindow, sentTodayCount: 50, dailyCap: 50 }));
    expect(d.action).toBe('cap-reached');
  });

  test('idle when nothing queued', () => {
    const d = pickNextDecision(baseArgs({ now: inWindow, queuedItems: [] }));
    expect(d.action).toBe('idle');
  });

  test('wait when pace has not elapsed (nextEligibleAt in future)', () => {
    const d = pickNextDecision(baseArgs({ now: inWindow, nextEligibleAt: new Date(inWindow.getTime() + 120000) }));
    expect(d.action).toBe('wait');
  });

  test('send picks the OLDEST eligible item and schedules the next 30–90s out', () => {
    const d = pickNextDecision(baseArgs({ now: inWindow }));
    expect(d.action).toBe('send');
    expect(d.item.id).toBe(1); // oldest
    const gap = d.nextEligibleAt.getTime() - inWindow.getTime();
    expect(gap).toBeGreaterThanOrEqual(PACE.paceMinMs); // >= 30s
    expect(gap).toBeLessThanOrEqual(PACE.paceMaxMs); // <= 90s
  });

  test('future-dated scheduledFor item is not eligible yet', () => {
    const future = [{ id: 1, createdAt: inWindow.toISOString(), scheduledFor: new Date(inWindow.getTime() + 3600000).toISOString() }];
    const d = pickNextDecision(baseArgs({ now: inWindow, queuedItems: future }));
    expect(d.action).toBe('idle');
  });

  test('computeInterval is uniform within [paceMinMs, paceMaxMs]', () => {
    const lo = computeInterval({ ...PACE, rng: () => 0 });
    const hi = computeInterval({ ...PACE, rng: () => 0.999999 });
    expect(lo).toBe(PACE.paceMinMs); // 30000
    expect(hi).toBeLessThanOrEqual(PACE.paceMaxMs); // <= 90000
    expect(hi).toBeGreaterThan(PACE.paceMinMs);
  });

  test('computeInterval is random across samples and always within bounds', () => {
    const rng = seededRng(11);
    const samples = Array.from({ length: 200 }, () => computeInterval({ ...PACE, rng }));
    for (const s of samples) {
      expect(s).toBeGreaterThanOrEqual(PACE.paceMinMs);
      expect(s).toBeLessThanOrEqual(PACE.paceMaxMs);
    }
    expect(new Set(samples).size).toBeGreaterThan(50); // not robotic / fixed
  });
});

describe('send pacing — full-day simulation', () => {
  // Drive the decision loop with a mock clock: enqueue 5, advance time to each
  // scheduled send, collect the actual send instants, assert spacing + window.
  test('enqueue 5 → 30–90s random spacing, all in-window', () => {
    const rng = seededRng(7);
    let now = new Date('2026-06-10T17:00:00Z'); // 10:00 PT
    let nextEligibleAt = null;
    let items = queue(5);
    const sendTimes = [];

    for (let tick = 0; tick < 1000 && items.length > 0; tick++) {
      const d = pickNextDecision({
        now, tz: TZ, windowStartHour: 8, windowEndHour: 17,
        nextEligibleAt, sentTodayCount: sendTimes.length, dailyCap: 150,
        gate: 'proceed', queuedItems: items, ...PACE, rng,
      });
      if (d.action === 'send') {
        sendTimes.push(now);
        items = items.filter((it) => it.id !== d.item.id);
        nextEligibleAt = d.nextEligibleAt;
        now = new Date(d.nextEligibleAt.getTime()); // jump to next eligible moment
      } else if (d.action === 'wait') {
        now = new Date(d.nextEligibleAt.getTime());
      } else {
        break; // window-closed/cap/idle/aborted
      }
    }

    expect(sendTimes.length).toBe(5);
    // All sends inside 8–17 PT.
    for (const t of sendTimes) {
      const h = localHour(t, TZ);
      expect(h).toBeGreaterThanOrEqual(8);
      expect(h).toBeLessThan(17);
    }
    // Consecutive gaps within [30s, 90s], and not all identical (random).
    const gaps = sendTimes.slice(1).map((t, i) => t.getTime() - sendTimes[i].getTime());
    for (const g of gaps) {
      expect(g).toBeGreaterThanOrEqual(PACE.paceMinMs);
      expect(g).toBeLessThanOrEqual(PACE.paceMaxMs);
    }
    expect(new Set(gaps).size).toBeGreaterThan(1); // random produced variation
  });

  test('cap halts the batch partway through', () => {
    const rng = seededRng(7);
    let now = new Date('2026-06-10T17:00:00Z');
    let nextEligibleAt = null;
    let items = queue(5);
    let sent = 0;
    let lastAction = null;

    for (let tick = 0; tick < 1000 && items.length > 0; tick++) {
      const d = pickNextDecision({
        now, tz: TZ, windowStartHour: 8, windowEndHour: 17,
        nextEligibleAt, sentTodayCount: sent, dailyCap: 2, // cap at 2
        gate: 'proceed', queuedItems: items, ...PACE, rng,
      });
      lastAction = d.action;
      if (d.action === 'send') {
        sent += 1;
        items = items.filter((it) => it.id !== d.item.id);
        nextEligibleAt = d.nextEligibleAt;
        now = new Date(d.nextEligibleAt.getTime());
      } else break;
    }

    expect(sent).toBe(2);
    expect(lastAction).toBe('cap-reached');
    expect(items.length).toBe(3); // remainder stays queued
  });
});

describe('send pacing — cap clamping + effective cap', () => {
  test('clampCap bounds to [0, ceiling] and floors', () => {
    expect(clampCap(150)).toBe(150);
    expect(clampCap(150.9)).toBe(150);
    expect(clampCap(99999)).toBe(DEFAULT_HARD_CAP_CEILING); // typo can't blast the mailbox
    expect(clampCap(-5)).toBe(0);
    expect(clampCap('not a number')).toBe(0);
    expect(clampCap(500, 300)).toBe(300);
  });

  test('effectiveCap: per-day policy wins over the env default, both clamped', () => {
    // Per-day policy authoritative (the spec decision): policy cap wins.
    expect(effectiveCap({ policyCap: 122, defaultCap: 150 })).toBe(122);
    // No policy row → fall back to the env default.
    expect(effectiveCap({ policyCap: null, defaultCap: 150 })).toBe(150);
    expect(effectiveCap({ policyCap: undefined, defaultCap: 150 })).toBe(150);
    // A policy of 0 (deliberate halt-low) is honored, not treated as "unset".
    expect(effectiveCap({ policyCap: 0, defaultCap: 150 })).toBe(0);
    // Even a bad policy row can't exceed the ceiling.
    expect(effectiveCap({ policyCap: 5000, defaultCap: 150, ceiling: 300 })).toBe(300);
  });
});

describe('send pacing — rolling weekly cap', () => {
  const inWindow = new Date('2026-06-10T16:00:00Z'); // 9am PDT, in window

  test('weekly-cap-reached when sentThisWeekCount >= weeklyCap, before daily cap', () => {
    const d = pickNextDecision(baseArgs({
      now: inWindow, sentTodayCount: 0, dailyCap: 150,
      sentThisWeekCount: 5000, weeklyCap: 5000,
    }));
    expect(d.action).toBe('weekly-cap-reached');
  });

  test('weekly cap takes precedence over an available daily allowance', () => {
    // Daily allows (0/150) but the week is full → still blocked.
    const d = pickNextDecision(baseArgs({
      now: inWindow, sentTodayCount: 0, dailyCap: 150,
      sentThisWeekCount: 5001, weeklyCap: 5000,
    }));
    expect(d.action).toBe('weekly-cap-reached');
  });

  test('under the weekly cap → still sends (daily cap governs)', () => {
    const d = pickNextDecision(baseArgs({
      now: inWindow, sentTodayCount: 0, dailyCap: 150,
      sentThisWeekCount: 4999, weeklyCap: 5000,
    }));
    expect(d.action).toBe('send');
  });

  test('absent weekly args (old callers) → no weekly limit applied', () => {
    const d = pickNextDecision(baseArgs({ now: inWindow, sentThisWeekCount: 99999 }));
    // weeklyCap defaults to Infinity, so a huge weekly count is irrelevant.
    expect(d.action).toBe('send');
  });
});

describe('send pacing — resolvePace (interval config + clamps)', () => {
  test('defaults to 30–90s', () => {
    const p = resolvePace({});
    expect(p.paceMinSeconds).toBe(30);
    expect(p.paceMaxSeconds).toBe(90);
    expect(p.paceMinMs).toBe(30000);
    expect(p.paceMaxMs).toBe(90000);
  });

  test('honors valid env values', () => {
    const p = resolvePace({ PACE_MIN_SECONDS: '45', PACE_MAX_SECONDS: '90' });
    expect(p.paceMinSeconds).toBe(45);
    expect(p.paceMaxSeconds).toBe(90);
  });

  test('clamps a too-low PACE_MIN to the hard floor', () => {
    const p = resolvePace({ PACE_MIN_SECONDS: '1', PACE_MAX_SECONDS: '90' });
    expect(p.paceMinSeconds).toBe(PACE_FLOOR_SECONDS); // 10
  });

  test('accepts a 10–15s pace (at/above the floor)', () => {
    const p = resolvePace({ PACE_MIN_SECONDS: '10', PACE_MAX_SECONDS: '15' });
    expect(p.paceMinSeconds).toBe(10);
    expect(p.paceMaxSeconds).toBe(15);
    expect(p.paceMinMs).toBe(10000);
    expect(p.paceMaxMs).toBe(15000);
  });

  test('clamps a too-high PACE_MAX to the 600s ceiling', () => {
    const p = resolvePace({ PACE_MIN_SECONDS: '30', PACE_MAX_SECONDS: '99999' });
    expect(p.paceMaxSeconds).toBe(PACE_CEILING_SECONDS); // 600
  });

  test('swaps a reversed pair (min > max) instead of erroring', () => {
    const p = resolvePace({ PACE_MIN_SECONDS: '90', PACE_MAX_SECONDS: '30' });
    expect(p.paceMinSeconds).toBe(30);
    expect(p.paceMaxSeconds).toBe(90);
  });

  test('getConfig surfaces pace bounds', () => {
    const cfg = getConfig();
    expect(cfg.paceMinSeconds).toBeGreaterThanOrEqual(PACE_FLOOR_SECONDS);
    expect(cfg.paceMaxSeconds).toBeLessThanOrEqual(PACE_CEILING_SECONDS);
    expect(cfg.paceMinMs).toBe(cfg.paceMinSeconds * 1000);
  });
});

describe('send pacing — getConfig env wiring', () => {
  const ENV_KEYS = ['DAILY_SEND_CAP', 'SEND_DEFAULT_DAILY_CAP', 'SEND_HARD_CAP_CEILING', 'WEEKLY_SEND_CAP', 'SEND_WEEKLY_HARD_CEILING', 'PACE_MIN_SECONDS', 'PACE_MAX_SECONDS'];
  let saved;
  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test('defaults: cap 150, ceiling 300', () => {
    const cfg = getConfig();
    expect(cfg.defaultDailyCap).toBe(150);
    expect(cfg.hardCapCeiling).toBe(DEFAULT_HARD_CAP_CEILING);
  });

  test('SEND_DEFAULT_DAILY_CAP is honored', () => {
    process.env.SEND_DEFAULT_DAILY_CAP = '125';
    expect(getConfig().defaultDailyCap).toBe(125);
  });

  test('DAILY_SEND_CAP alias wins over SEND_DEFAULT_DAILY_CAP', () => {
    process.env.SEND_DEFAULT_DAILY_CAP = '125';
    process.env.DAILY_SEND_CAP = '150';
    expect(getConfig().defaultDailyCap).toBe(150);
  });

  test('an over-ceiling env cap is clamped to the ceiling', () => {
    process.env.DAILY_SEND_CAP = '5000';
    expect(getConfig().defaultDailyCap).toBe(DEFAULT_HARD_CAP_CEILING);
  });

  test('SEND_HARD_CAP_CEILING raises the ceiling deliberately', () => {
    process.env.SEND_HARD_CAP_CEILING = '400';
    process.env.DAILY_SEND_CAP = '380';
    const cfg = getConfig();
    expect(cfg.hardCapCeiling).toBe(400);
    expect(cfg.defaultDailyCap).toBe(380);
  });

  test('weekly cap defaults to 5000, clamped to its own ceiling', () => {
    const cfg = getConfig();
    expect(cfg.weeklyCap).toBe(5000);
    expect(cfg.weeklyHardCeiling).toBe(10000);
  });

  test('WEEKLY_SEND_CAP is honored; a typo is clamped to the weekly ceiling', () => {
    process.env.WEEKLY_SEND_CAP = '3000';
    expect(getConfig().weeklyCap).toBe(3000);
    process.env.WEEKLY_SEND_CAP = '999999';
    expect(getConfig().weeklyCap).toBe(10000); // clamped
  });
});
