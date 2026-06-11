/**
 * Unit tests for the pure queue-management helpers (services/queueOps.js).
 * No DB — covers selector building, action→status transitions, and the
 * update field allow-list.
 */
const {
  ALLOWED_UPDATE_FIELDS,
  buildSelectorWhere,
  actionStatuses,
  targetStatus,
  partitionUpdate,
} = require('../services/queueOps');

describe('buildSelectorWhere', () => {
  test('trackingId → exact match', () => {
    const r = buildSelectorWhere({ trackingId: 'q_abc' });
    expect(r).toEqual({ where: { trackingId: 'q_abc' }, kind: 'trackingId', value: 'q_abc' });
  });

  test('batchId → exact match', () => {
    expect(buildSelectorWhere({ batchId: 'b1' }).where).toEqual({ batchId: 'b1' });
  });

  test('recipient → case-insensitive equals', () => {
    expect(buildSelectorWhere({ recipient: 'Joel@AMD.com' }).where).toEqual({
      to: { equals: 'Joel@AMD.com', mode: 'insensitive' },
    });
  });

  test('domain → case-insensitive endsWith @domain, normalizing leading @', () => {
    expect(buildSelectorWhere({ domain: 'amd.com' }).where).toEqual({
      to: { endsWith: '@amd.com', mode: 'insensitive' },
    });
    // Leading @ accepted and normalized.
    const r = buildSelectorWhere({ domain: '@amd.com' });
    expect(r.where).toEqual({ to: { endsWith: '@amd.com', mode: 'insensitive' } });
    expect(r.value).toBe('amd.com');
  });

  test('throws when no selector given', () => {
    expect(() => buildSelectorWhere({})).toThrow(/selector is required/i);
    expect(() => buildSelectorWhere({ trackingId: '   ' })).toThrow(/selector is required/i);
  });

  test('throws when more than one selector given', () => {
    expect(() => buildSelectorWhere({ trackingId: 'q', domain: 'amd.com' })).toThrow(/exactly one/i);
  });
});

describe('actionStatuses / targetStatus', () => {
  test('cancel acts on queued + paused, → cancelled', () => {
    expect(actionStatuses('cancel')).toEqual(['queued', 'paused']);
    expect(targetStatus('cancel')).toBe('cancelled');
  });
  test('pause acts on queued only, → paused', () => {
    expect(actionStatuses('pause')).toEqual(['queued']);
    expect(targetStatus('pause')).toBe('paused');
  });
  test('resume acts on paused only, → queued', () => {
    expect(actionStatuses('resume')).toEqual(['paused']);
    expect(targetStatus('resume')).toBe('queued');
  });
  test('unknown action throws', () => {
    expect(() => actionStatuses('nuke')).toThrow(/unknown action/i);
  });
});

describe('partitionUpdate', () => {
  test('keeps allowed fields, ignores trackingId, rejects the rest', () => {
    const { data, rejected } = partitionUpdate({
      trackingId: 'q_1',
      subject: 'New subject',
      body: 'Hi',
      scheduledFor: '2026-06-12T17:00:00Z',
      replyAll: true,
      to: 'someone-else@evil.com', // must be rejected (identity change)
      status: 'sent', // must be rejected (control field)
      inReplyToMessageId: 'AAMk', // must be rejected
    });
    expect(data).toEqual({
      subject: 'New subject',
      body: 'Hi',
      scheduledFor: '2026-06-12T17:00:00Z',
      replyAll: true,
    });
    expect(rejected.sort()).toEqual(['inReplyToMessageId', 'status', 'to']);
  });

  test('all allowed fields are recognized', () => {
    const body = Object.fromEntries(ALLOWED_UPDATE_FIELDS.map((f) => [f, 'x']));
    const { data, rejected } = partitionUpdate({ trackingId: 'q', ...body });
    expect(Object.keys(data).sort()).toEqual([...ALLOWED_UPDATE_FIELDS].sort());
    expect(rejected).toEqual([]);
  });

  test('recipient changes are blocked (to is not allowed)', () => {
    expect(ALLOWED_UPDATE_FIELDS).not.toContain('to');
    expect(ALLOWED_UPDATE_FIELDS).not.toContain('inReplyToMessageId');
  });
});
