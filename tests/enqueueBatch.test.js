/**
 * Unit tests for the PURE enqueue_batch core (services/enqueueBatch.js).
 * Mirrors the queueOps/sendPacing test style — no DB, no IO. The Prisma
 * wrapping (idempotency receipt, persistence) lives in routes/mcpBridge.js.
 */
const {
  validateItem,
  decideBatch,
  countDecisions,
  dedupeKey,
  getBlockedDomains,
} = require('../services/enqueueBatch');

const blocked = new Set(['appliedmaterials.com']);

describe('validateItem', () => {
  test('rejects missing body', () => {
    expect(validateItem({ to: 'a@x.com', subject: 'Hi' }, { blockedDomains: blocked }))
      .toMatchObject({ valid: false, reason: 'missing body' });
  });
  test('rejects missing subject on a new send', () => {
    expect(validateItem({ to: 'a@x.com', body: 'b' }, { blockedDomains: blocked }))
      .toMatchObject({ valid: false, reason: 'missing subject' });
  });
  test('rejects invalid recipient', () => {
    expect(validateItem({ to: 'not-an-email', subject: 's', body: 'b' }, { blockedDomains: blocked }))
      .toMatchObject({ valid: false, reason: 'invalid recipient' });
  });
  test('rejects blocked domain', () => {
    expect(validateItem({ to: 'guess@appliedmaterials.com', subject: 's', body: 'b' }, { blockedDomains: blocked }))
      .toMatchObject({ valid: false, reason: 'blocked domain' });
  });
  test('rejects invalid scheduledFor', () => {
    expect(validateItem({ to: 'a@x.com', subject: 's', body: 'b', scheduledFor: 'soon' }, { blockedDomains: blocked }))
      .toMatchObject({ valid: false, reason: 'invalid scheduledFor' });
  });
  test('accepts a valid cold send', () => {
    expect(validateItem({ to: 'A@X.com', subject: 's', body: 'b' }, { blockedDomains: blocked }))
      .toMatchObject({ valid: true, isReply: false, normTo: 'a@x.com' });
  });
  test('accepts a reply without to/subject', () => {
    expect(validateItem({ inReplyToMessageId: 'MID', body: 'b' }, { blockedDomains: blocked }))
      .toMatchObject({ valid: true, isReply: true });
  });
});

describe('decideBatch — spec §8 scenario', () => {
  // 5 items: 3 valid new, 1 empty body (rejected), 1 already-queued (skipped).
  const items = [
    { to: 'new1@x.com', subject: 's', body: 'b', clientRef: 'P1' },
    { to: 'new2@x.com', subject: 's', body: 'b', clientRef: 'P2' },
    { to: 'dup@x.com', subject: 's', body: 'b', clientRef: 'P3' },   // already queued
    { to: 'new3@x.com', subject: 's', body: '', clientRef: 'P4' },   // empty body → rejected
    { to: 'new4@x.com', subject: 's', body: 'b', clientRef: 'P5' },
  ];
  const existingKeys = new Set([dedupeKey({ isReply: false, normTo: 'dup@x.com' })]);

  test('counts: 3 accepted, 1 skipped_duplicate, 1 rejected', () => {
    const { decisions } = decideBatch({ items, existingKeys, blockedDomains: blocked, dedupeScope: 'queue+sent' });
    expect(countDecisions(decisions)).toEqual({ accepted: 3, skippedDuplicate: 1, rejected: 1 });
  });

  test('per-item statuses + echoed clientRef', () => {
    const { decisions } = decideBatch({ items, existingKeys, blockedDomains: blocked, dedupeScope: 'queue+sent' });
    expect(decisions.map((d) => [d.clientRef, d.status])).toEqual([
      ['P1', 'accepted'],
      ['P2', 'accepted'],
      ['P3', 'skipped_duplicate'],
      ['P4', 'rejected'],
      ['P5', 'accepted'],
    ]);
    expect(decisions[3].reason).toBe('missing body');
  });

  test('deterministic — same inputs produce identical decisions (replay-safe)', () => {
    const a = decideBatch({ items, existingKeys, blockedDomains: blocked });
    const b = decideBatch({ items, existingKeys, blockedDomains: blocked });
    expect(a).toEqual(b);
  });
});

describe('decideBatch — dedup behavior', () => {
  test('self-dedup within a batch: first wins, rest skipped', () => {
    const items = [
      { to: 'same@x.com', subject: 's', body: 'b' },
      { to: 'SAME@x.com', subject: 's', body: 'b' },
    ];
    const { decisions } = decideBatch({ items, existingKeys: new Set(), blockedDomains: blocked });
    expect(decisions.map((d) => d.status)).toEqual(['accepted', 'skipped_duplicate']);
    expect(decisions[1].reason).toBe('duplicate within batch');
  });

  test('dedupeScope "none" disables dedup against existing queue', () => {
    const items = [{ to: 'dup@x.com', subject: 's', body: 'b' }];
    const existingKeys = new Set([dedupeKey({ isReply: false, normTo: 'dup@x.com' })]);
    const { decisions } = decideBatch({ items, existingKeys, blockedDomains: blocked, dedupeScope: 'none' });
    expect(decisions[0].status).toBe('accepted');
  });

  test('a reply does not collide with a prior cold send to the same person', () => {
    const items = [{ inReplyToMessageId: 'MID', to: 'dup@x.com', body: 'b' }];
    const existingKeys = new Set([dedupeKey({ isReply: false, normTo: 'dup@x.com' })]); // cold send present
    const { decisions } = decideBatch({ items, existingKeys, blockedDomains: blocked });
    expect(decisions[0].status).toBe('accepted');
  });
});

describe('decideBatch — gate=abort', () => {
  test('rejects the entire batch, accepts none', () => {
    const items = [
      { to: 'a@x.com', subject: 's', body: 'b' },
      { to: 'b@x.com', subject: 's', body: 'b' },
    ];
    const { decisions } = decideBatch({ items, existingKeys: new Set(), blockedDomains: blocked, gate: 'abort' });
    expect(countDecisions(decisions)).toEqual({ accepted: 0, skippedDuplicate: 0, rejected: 2 });
    expect(decisions.every((d) => d.reason === 'gate=abort')).toBe(true);
  });
});

describe('getBlockedDomains', () => {
  test('merges defaults with BLOCKED_SEND_DOMAINS env', () => {
    const set = getBlockedDomains({ BLOCKED_SEND_DOMAINS: 'amd.com, @evil.test' });
    expect(set.has('appliedmaterials.com')).toBe(true);
    expect(set.has('amd.com')).toBe(true);
    expect(set.has('evil.test')).toBe(true);
  });
});
