/**
 * queueOps — PURE helpers for OutboundQueue management (cancel / pause /
 * resume / alter). No DB, no IO, so they're fully unit-testable. The bridge
 * routes (routes/mcpBridge.js) wrap these with Prisma calls.
 */

// Fields a caller may edit on a still-queued/paused item. Deliberately
// EXCLUDES `to` and `inReplyToMessageId` (identity — cancel + re-enqueue
// instead) and any control fields (status, userId, dailyCap, gate, …).
const ALLOWED_UPDATE_FIELDS = ['subject', 'body', 'cc', 'bcc', 'scheduledFor', 'replyAll', 'includeOriginalBody'];

/**
 * Build a Prisma `where` fragment from exactly one selector.
 * @returns {{ where: object, kind: string, value: string }}
 * @throws if zero or more than one selector is provided.
 */
function buildSelectorWhere({ trackingId, batchId, recipient, domain } = {}) {
  const provided = [
    ['trackingId', trackingId],
    ['batchId', batchId],
    ['recipient', recipient],
    ['domain', domain],
  ].filter(([, v]) => typeof v === 'string' && v.trim().length > 0);

  if (provided.length === 0) {
    throw new Error('A selector is required: one of trackingId, batchId, recipient, domain.');
  }
  if (provided.length > 1) {
    throw new Error(`Provide exactly one selector, got ${provided.length}: ${provided.map(([k]) => k).join(', ')}.`);
  }

  const [kind, raw] = provided[0];
  const value = raw.trim();
  switch (kind) {
    case 'trackingId':
      return { where: { trackingId: value }, kind, value };
    case 'batchId':
      return { where: { batchId: value }, kind, value };
    case 'recipient':
      return { where: { to: { equals: value, mode: 'insensitive' } }, kind, value };
    case 'domain': {
      const d = value.replace(/^@/, ''); // accept "amd.com" or "@amd.com"
      return { where: { to: { endsWith: `@${d}`, mode: 'insensitive' } }, kind, value: d };
    }
    default:
      throw new Error(`Unknown selector "${kind}".`);
  }
}

/**
 * Statuses an action may legally transition FROM. The worker only ever
 * drains `queued`, so pausing a `queued` item removes it from sending, and
 * resuming returns it. Cancel is terminal and never touches sending/sent.
 */
function actionStatuses(action) {
  switch (action) {
    case 'cancel': return ['queued', 'paused'];
    case 'pause': return ['queued'];
    case 'resume': return ['paused'];
    default: throw new Error(`Unknown action "${action}". Use cancel | pause | resume.`);
  }
}

/** The new status an action moves an item TO. */
function targetStatus(action) {
  return { cancel: 'cancelled', pause: 'paused', resume: 'queued' }[action];
}

/**
 * Split an update body into the allowed data and any rejected (disallowed)
 * keys present. `trackingId` is the selector, not an editable field, so it's
 * ignored here (neither allowed-data nor rejected).
 */
function partitionUpdate(body = {}) {
  const data = {};
  const rejected = [];
  for (const [k, v] of Object.entries(body)) {
    if (k === 'trackingId') continue;
    if (ALLOWED_UPDATE_FIELDS.includes(k)) data[k] = v;
    else rejected.push(k);
  }
  return { data, rejected };
}

module.exports = {
  ALLOWED_UPDATE_FIELDS,
  buildSelectorWhere,
  actionStatuses,
  targetStatus,
  partitionUpdate,
};
