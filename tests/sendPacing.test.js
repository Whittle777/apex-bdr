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
const { pickNextDecision, computeInterval, localHour, localDateString } = require('../services/sendPacing');

const TZ = 'America/Los_Angeles';
const PACE = { paceMinMs: 180000, paceMaxMs: 240000, jitterMs: 30000 }; // 3–4 min ±30s

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

  test('send picks the OLDEST eligible item and schedules the next ~3–4min out', () => {
    const d = pickNextDecision(baseArgs({ now: inWindow }));
    expect(d.action).toBe('send');
    expect(d.item.id).toBe(1); // oldest
    const gap = d.nextEligibleAt.getTime() - inWindow.getTime();
    expect(gap).toBeGreaterThanOrEqual(PACE.paceMinMs - PACE.jitterMs); // >= 2.5 min
    expect(gap).toBeLessThanOrEqual(PACE.paceMaxMs + PACE.jitterMs + 1); // <= 4.5 min
  });

  test('future-dated scheduledFor item is not eligible yet', () => {
    const future = [{ id: 1, createdAt: inWindow.toISOString(), scheduledFor: new Date(inWindow.getTime() + 3600000).toISOString() }];
    const d = pickNextDecision(baseArgs({ now: inWindow, queuedItems: future }));
    expect(d.action).toBe('idle');
  });

  test('computeInterval stays within [pace-jitter, pace+jitter]', () => {
    const lo = computeInterval({ ...PACE, rng: () => 0 });
    const hi = computeInterval({ ...PACE, rng: () => 0.999999 });
    expect(lo).toBe(PACE.paceMinMs - PACE.jitterMs); // 150000
    expect(hi).toBeLessThanOrEqual(PACE.paceMaxMs + PACE.jitterMs + 1); // ~270000
  });
});

describe('send pacing — full-day simulation', () => {
  // Drive the decision loop with a mock clock: enqueue 5, advance time to each
  // scheduled send, collect the actual send instants, assert spacing + window.
  test('enqueue 5 → ~3–4min spacing + jitter, all in-window', () => {
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
    // Consecutive gaps within [2.5min, 4.5min], and not all identical (jitter).
    const gaps = sendTimes.slice(1).map((t, i) => t.getTime() - sendTimes[i].getTime());
    for (const g of gaps) {
      expect(g).toBeGreaterThanOrEqual(PACE.paceMinMs - PACE.jitterMs);
      expect(g).toBeLessThanOrEqual(PACE.paceMaxMs + PACE.jitterMs + 1);
    }
    expect(new Set(gaps).size).toBeGreaterThan(1); // jitter produced variation
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
