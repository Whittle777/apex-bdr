/**
 * enqueueBatch — PURE validation / dedup / decision logic for enqueue_batch.
 *
 * No DB, no IO, no clock/env reads inside the decision functions, so they are
 * fully unit-testable (mirrors services/queueOps.js + services/sendPacing.js).
 * routes/mcpBridge.js wraps these with the Prisma queries (existing-queue
 * lookup, idempotency receipt, row persistence).
 *
 * Design (from the enqueue_batch spec):
 *  - The agent is never the dedup/idempotency layer — all of it lives here +
 *    in the route, not the prompt.
 *  - Reject loudly, never guess: a malformed/blocked record becomes a
 *    `rejected` decision with a reason, never a silent drop.
 *  - One call → one decision per item: accepted | skipped_duplicate | rejected.
 *  - Pacing is untouched: this only decides WHAT enters the queue.
 */

// Loose RFC 5322-ish check — same shape used across the bridge.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ok = (s) => typeof s === 'string' && s.trim().length > 0;
const isEmail = (s) => ok(s) && EMAIL_RE.test(s.trim());
const normalizeEmail = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '');
const domainOf = (email) => normalizeEmail(email).split('@')[1] || '';

// Hard ceiling so a runaway loop can't submit a million items in one call.
const MAX_BATCH_SIZE = 1000;

// Replay window for idempotencyKey receipts. A retry inside this window returns
// the stored result; an older key is treated as a fresh batch (per-recipient
// dedup still protects against duplicates).
const REPLAY_WINDOW_MS = 48 * 60 * 60 * 1000;

// Dedup scope → the queue statuses that count as "already present" and should
// block a re-enqueue. cancelled/failed never block (those are meant to be
// re-sent). See spec §3.
const DEDUPE_STATES = {
  'queue+sent': ['queued', 'paused', 'sending', 'sent'],
  queue: ['queued', 'paused', 'sending'],
  none: [],
};
const DEFAULT_DEDUPE_SCOPE = 'queue+sent';
function dedupeStatesFor(scope) {
  return DEDUPE_STATES[scope] || DEDUPE_STATES[DEFAULT_DEDUPE_SCOPE];
}

/**
 * Server-side blocked-domain list — the REAL compliance guarantee, enforced
 * here (not in any agent prompt). Any send path that reaches enqueue is checked
 * unconditionally, so a raw spool / one-off / future script can't leak to a held
 * domain even if it never called an agent-side gate.
 *
 * Seeded from the current held set; aliases of the same company are listed
 * individually (amat.com == appliedmaterials.com; wdc.com == westerndigital.com)
 * so each is blocked. Extend at runtime via BLOCKED_SEND_DOMAINS (comma-
 * separated, no redeploy/code edit) — keep this in sync with the agent-side
 * HELD_DOMAINS from one source. Items to a blocked domain are `rejected` with
 * reason "BLOCKED_DOMAIN".
 */
const DEFAULT_BLOCKED_DOMAINS = [
  'amd.com',
  'onsemi.com',
  'wdc.com', 'westerndigital.com',          // alias pair
  'appliedmaterials.com', 'amat.com',       // alias pair
  'firstsolar.com',
];
function getBlockedDomains(env = process.env) {
  const extra = (env.BLOCKED_SEND_DOMAINS || '')
    .split(',')
    .map((d) => normalizeDomain(d))
    .filter(Boolean);
  return new Set([...DEFAULT_BLOCKED_DOMAINS.map(normalizeDomain), ...extra]);
}

/** Normalize a domain: strip a leading "@", lowercase, drop a trailing dot. */
function normalizeDomain(d) {
  return (typeof d === 'string' ? d : '').trim().toLowerCase().replace(/^@/, '').replace(/\.$/, '');
}

/**
 * True if `domain` is blocked — matching the registrable domain so SUBDOMAINS
 * are caught too (mail.amat.com → amat.com). Checks the full domain and each
 * parent suffix (excluding the bare TLD) against the blocked set.
 */
function domainIsBlocked(domain, blockedSet) {
  const d = normalizeDomain(domain);
  if (!d || !(blockedSet instanceof Set) || blockedSet.size === 0) return false;
  const labels = d.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    if (blockedSet.has(labels.slice(i).join('.'))) return true;
  }
  return false;
}

/**
 * Dedup key for an item/row. Cold sends dedup on the normalized recipient;
 * threaded replies dedup on (recipient, inReplyToMessageId) so a reply never
 * collides with a prior cold send to the same person.
 */
function dedupeKey({ isReply, normTo, inReplyToMessageId }) {
  return isReply
    ? `r|${normTo}|${(inReplyToMessageId || '').trim()}`
    : `c|${normTo}`;
}

/** Build a dedupe key from a persisted OutboundQueue row. */
function rowDedupeKey(row) {
  const isReply = ok(row.inReplyToMessageId);
  return dedupeKey({ isReply, normTo: normalizeEmail(row.to), inReplyToMessageId: row.inReplyToMessageId });
}

/**
 * Validate one BatchItem. PURE. Returns the parsed shape on success or a
 * rejection reason. `blockedDomains` is a Set of lowercased domains.
 *
 * @returns {{ valid: true, isReply: boolean, normTo: string, scheduledForMs: number|null }
 *          | { valid: false, reason: string }}
 */
function validateItem(item, { blockedDomains } = {}) {
  if (!item || typeof item !== 'object') return { valid: false, reason: 'item is not an object' };

  const isReply = ok(item.inReplyToMessageId);
  if (!ok(item.body)) return { valid: false, reason: 'missing body' };

  if (!isReply) {
    if (!isEmail(item.to)) return { valid: false, reason: 'invalid recipient' };
    if (!ok(item.subject)) return { valid: false, reason: 'missing subject' };
  } else if (item.to != null && item.to !== '' && !isEmail(item.to)) {
    // `to` is optional on a reply, but if present it must be valid.
    return { valid: false, reason: 'invalid recipient' };
  }

  if (item.cc != null && item.cc !== '' && !isEmail(item.cc)) return { valid: false, reason: 'invalid cc' };
  if (item.bcc != null && item.bcc !== '' && !isEmail(item.bcc)) return { valid: false, reason: 'invalid bcc' };

  const normTo = normalizeEmail(item.to);
  if (normTo && domainIsBlocked(domainOf(normTo), blockedDomains)) {
    return { valid: false, reason: 'BLOCKED_DOMAIN' };
  }

  let scheduledForMs = null;
  if (item.scheduledFor != null) {
    const t = new Date(item.scheduledFor).getTime();
    if (Number.isNaN(t)) return { valid: false, reason: 'invalid scheduledFor' };
    scheduledForMs = t;
  }

  return { valid: true, isReply, normTo, scheduledForMs };
}

/**
 * Decide every item in the batch. PURE — no DB. The route supplies
 * `existingKeys` (a Set of dedupeKeys already present in the queue under the
 * relevant statuses) so this function stays clock/IO-free and testable.
 *
 * Rules:
 *  - gate === 'abort'  → every item rejected with reason "gate=abort", none accepted.
 *  - invalid item      → rejected with the specific reason (never blocks the rest).
 *  - already in queue   → skipped_duplicate ("already queued" / "already sent").
 *  - duplicate within   → skipped_duplicate ("duplicate within batch") for all but the first.
 *  - otherwise          → accepted.
 *
 * Rejected items do NOT consume a dedupe slot; the first VALID occurrence of a
 * key wins and is accepted, later valid duplicates are skipped.
 *
 * @returns {{ decisions: Array<{index:number, clientRef?:string, to:string,
 *           status:'accepted'|'skipped_duplicate'|'rejected', reason?:string,
 *           isReply?:boolean }> }}
 */
function decideBatch({ items, existingKeys, blockedDomains, dedupeScope = DEFAULT_DEDUPE_SCOPE, gate } = {}) {
  const list = Array.isArray(items) ? items : [];
  const existing = existingKeys instanceof Set ? existingKeys : new Set(existingKeys || []);
  const dedupOn = dedupeStatesFor(dedupeScope).length > 0; // 'none' disables dedup
  const sentBlocks = dedupeStatesFor(dedupeScope).includes('sent');
  const seenInBatch = new Set();

  const decisions = list.map((item, index) => {
    const base = { index, clientRef: item && item.clientRef, to: (item && item.to) || '' };

    if (gate === 'abort') {
      return { ...base, status: 'rejected', reason: 'gate=abort' };
    }

    const v = validateItem(item, { blockedDomains });
    if (!v.valid) {
      return { ...base, status: 'rejected', reason: v.reason };
    }

    const key = dedupeKey(v);

    if (dedupOn && existing.has(key)) {
      return { ...base, status: 'skipped_duplicate', reason: sentBlocks ? 'already queued or sent' : 'already queued', isReply: v.isReply };
    }
    if (seenInBatch.has(key)) {
      return { ...base, status: 'skipped_duplicate', reason: 'duplicate within batch', isReply: v.isReply };
    }
    seenInBatch.add(key);
    return { ...base, status: 'accepted', isReply: v.isReply, scheduledForMs: v.scheduledForMs };
  });

  return { decisions };
}

/** Tally a decisions array into the BatchResult.counts shape. */
function countDecisions(decisions) {
  return decisions.reduce(
    (acc, d) => {
      if (d.status === 'accepted') acc.accepted += 1;
      else if (d.status === 'skipped_duplicate') acc.skippedDuplicate += 1;
      else acc.rejected += 1;
      return acc;
    },
    { accepted: 0, skippedDuplicate: 0, rejected: 0 }
  );
}

module.exports = {
  EMAIL_RE,
  MAX_BATCH_SIZE,
  REPLAY_WINDOW_MS,
  DEFAULT_DEDUPE_SCOPE,
  DEDUPE_STATES,
  ok,
  isEmail,
  normalizeEmail,
  domainOf,
  normalizeDomain,
  domainIsBlocked,
  dedupeStatesFor,
  getBlockedDomains,
  dedupeKey,
  rowDedupeKey,
  validateItem,
  decideBatch,
  countDecisions,
};
