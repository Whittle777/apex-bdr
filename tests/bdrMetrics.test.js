/**
 * Unit tests for the PURE Bdr* shadow aggregator (services/bdrMetrics.js).
 * The real fidelity guarantee is the offline differential against metrics.py
 * (28 fields, 0 diffs on the 2026-07-17 snapshot — see PHASE2 runbook);
 * these cases pin the aggregation behaviors so refactors can't drift.
 */
const { computeBdrMetrics } = require('../services/bdrMetrics');

const rep = (over) => ({
  email: 'a@x.com', sendKey: 'k1', isGroupRep: true, isInet: true, msgid: '<m1@x>',
  step: 1, effectiveStep: 1, repDate: '2026-07-14', laneBucket: 'lane1',
  pid: 'P1', rep: 'Henry', account: 'Acme', ...over,
});

describe('computeBdrMetrics', () => {
  test('counts distinct sends by representative rows, raw by all rows', () => {
    const sentRows = [
      rep({}),
      { ...rep({}), isGroupRep: false, isInet: false, msgid: 'AAMk1' }, // EWS twin, same sendKey
      rep({ sendKey: 'k2', msgid: '<m2@x>', email: 'b@x.com', pid: 'P2', step: 2, effectiveStep: 2 }),
    ];
    const m = computeBdrMetrics({ sentRows, weeks: {} });
    expect(m.sent_total_alltime).toBe(2);
    expect(m.raw_sent_rows).toBe(3);
    expect(m.distinct_internet_msgids).toBe(2);
    expect(m.double_logged_prospects).toBe(1); // a@x.com: 2 rows, 1 key
    expect(m.sent_by_step).toEqual({ 1: 1, 2: 1 });
    expect(m.sent_by_step_effective).toEqual({ step_1: 1, step_2: 1 });
  });

  test('week bucketing uses supplied bounds inclusively', () => {
    const sentRows = [
      rep({ repDate: '2026-07-13' }),
      rep({ sendKey: 'k2', msgid: '<m2@x>', email: 'b@x.com', repDate: '2026-07-17' }),
      rep({ sendKey: 'k3', msgid: '<m3@x>', email: 'c@x.com', repDate: '2026-07-10' }),
      rep({ sendKey: 'k4', msgid: '<m4@x>', email: 'd@x.com', repDate: null }),
    ];
    const m = computeBdrMetrics({
      sentRows,
      weeks: { monday: '2026-07-13', friday: '2026-07-17', lastMonday: '2026-07-06', lastFriday: '2026-07-10' },
    });
    expect(m.sent_this_calendar_week).toBe(2);
    expect(m.sent_last_calendar_week).toBe(1);
  });

  test('duplicate step-1 openers detected per email across distinct sends', () => {
    const sentRows = [
      rep({}),
      rep({ sendKey: 'k9', msgid: '<m9@x>' }), // same email, second distinct step-1
    ];
    const m = computeBdrMetrics({ sentRows, weeks: {} });
    expect(m.recipients_with_two_step1_sends).toBe(1);
  });

  test('true_step prefers email-keyed sends, falls back to pid; capped at 7', () => {
    const sentRows = [];
    for (let i = 1; i <= 9; i++) sentRows.push(rep({ sendKey: `k${i}`, msgid: `<m${i}@x>` }));
    const m = computeBdrMetrics({
      sentRows,
      seqRows: [
        { pid: 'P1', replyStatus: 'NONE' },      // maps to a@x.com → 9 sends → capped 7
        { pid: 'P2', replyStatus: 'REPLIED_POS' }, // no email mapping, no pid sends → 0
      ],
      prospects: [{ pid: 'P1', email: 'a@x.com' }],
      weeks: {},
    });
    expect(m.true_step_distribution).toEqual({ 7: 1, 0: 1 });
    expect(m.enrolled_gross).toBe(2);
    expect(m.enrolled_active).toBe(2); // REPLIED_* is active (frozen ≠ inactive bucket)
    expect(m.replies).toBe(1);
  });

  test('reply-status buckets and inactive set', () => {
    const m = computeBdrMetrics({
      seqRows: [
        { pid: 'P1', replyStatus: 'NONE' },
        { pid: 'P2', replyStatus: 'held' },   // normalized upper
        { pid: 'P3', replyStatus: null },     // null → NONE
        { pid: 'P4', replyStatus: 'BOUNCED' },
      ],
      weeks: {},
    });
    expect(m.enrolled_active).toBe(2);
    expect(m.held).toBe(1);
    expect(m.bounced_seq_state).toBe(1);
    expect(m.seq_reply_status_counts).toEqual({ NONE: 2, HELD: 1, BOUNCED: 1 });
  });
});
