/**
 * sendGate — server-side port of the workbook's send_gate.py + seq_engine
 * enforce_henry_signature. PURE (no DB/env/clock), unit-testable, mirroring
 * services/enqueueBatch.js's style.
 *
 * WHY: the agent-side Python gate only protects a send if the session
 * remembers to run it — twice a batch went out rep-signed because a send path
 * walked around it, and the workbook incidents of 2026-06/07 all trace to
 * client-side steps being skipped. Enforcing the same rules HERE, inside the
 * enqueue paths, makes the bypass impossible: every item that reaches the
 * queue is checked unconditionally, whatever wrote it.
 *
 * Two rule families, applied per path (see routes/mcpBridge.js wiring):
 *  - RECIPIENT COMPLIANCE (always hard, every path incl. the worker's final
 *    pre-send check): DNC / bounced recipient, suppressed domain — DB-backed
 *    lists loaded by services/gateLists.js. Held domains stay in
 *    enqueueBatch.js's blocked-domain check (static floor ∪ DB entries).
 *  - CONTENT RULES (paced prospect paths only — enqueue-email/enqueue-batch;
 *    controlled by SEND_CONTENT_GATE=on|shadow|off): Henry signature
 *    enforcement (auto-rewrite rep signoffs, reject the unrewritable),
 *    em-dash ban, banned/restricted proof-customer names, booking links
 *    before step 4, off-spec CTAs, internal @c3.ai recipients.
 *
 * Immediate paths (send-email / reply-email) get recipient compliance +
 * signature enforcement only: they carry Henry-approved conversational mail
 * (replies to interested prospects legitimately contain booking links,
 * em dashes, named customers), so the cold-email content rules do not apply.
 *
 * Source of truth for the rule set: "Claude access"/send_gate.py — keep the
 * two in sync deliberately (rule changes land in both, same as the
 * RECONCILE_APEX_CONTRACT discipline).
 */

const REP_FIRST_NAMES = ['Sai', 'Wayman', 'Cole', 'Vikas', 'Douglass'];
const REP_FULL_NAMES = ['Sai Konda', 'Wayman Leung', 'Cole McConnell', 'Vikas Shah', 'Douglass Jordan'];

const EM_DASH = '—';

// Banned proof-customer names (doctrine): never in a cold-email body.
// Case-sensitive word match, same as the Python gate.
const BANNED_PROOF = ['Caterpillar', 'Tyson', 'Skyworks'];

// Customers describable only generically in WRITTEN cold email (nameable
// verbally on calls). Case-insensitive, same as the Python gate. Names the
// Reference Library marks "Named" (Nucor, Shell, Georgia-Pacific, …) must NOT
// be added here — they are approved in writing by design.
const WRITTEN_RESTRICTED_NAMES = ['Cargill', 'Johnson Controls', 'Goodyear'];

// Scheduler/booking URLs: verbal-only ask through step 3; links allowed step 4+.
const BOOKING_LINK_RE = /bookwithme|outlook\.office\.com|calendly\.com|meetings?\.hubspot|chilipiper/i;

// CTA must be 30 minutes (master sequence skill); 15/20-minute and "quick chat" are banned.
const BANNED_CTA_RE = /\b(15|20)[\s-]*minute|quick chat|pick your brain|worth (15|20)\b/i;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Rewrite any rep signoff to "Henry"; report when a rep name survives in a
 * signoff position (caller must reject — never send it).
 *
 * Faithful port of seq_engine.enforce_henry_signature:
 *  1. strip rep coverage lines ("I cover/lead … at C3 AI");
 *  2. rep full names anywhere → "Henry";
 *  3. "Thanks,/Regards,/Best,/Cheers, <sep> <RepFirst>" → "…Henry", and
 *     ">RepFirst<" signoff tokens → ">Henry<";
 *  4. verify the SIGNOFF specifically (last ~3 visible lines) — a rep name
 *     still there is an error, not body context;
 *  5. ensure a Henry signoff exists at all.
 *
 * @returns {{ body: string, changed: boolean, error: string|null }}
 *          On error, `body` is the ORIGINAL body (never a half-rewrite).
 */
function enforceHenrySignature(body) {
  if (body == null || body === '') return { body, changed: false, error: null };
  const orig = String(body);
  let b = orig;

  b = b.replace(/\s*I (?:cover|lead)[^.<\n]*?at C3 AI\.?/g, '');
  for (const full of REP_FULL_NAMES) b = b.split(full).join('Henry');
  for (const rf of REP_FIRST_NAMES) {
    b = b.replace(
      new RegExp(`(Thanks,|Regards,|Best,|Cheers,)(\\s*(?:<br\\s*/?>|\\n|\\r\\n)\\s*)${rf}\\b`, 'g'),
      `$1$2Henry`
    );
    b = b.replace(new RegExp(`>\\s*${rf}\\s*<`, 'g'), '>Henry<');
  }

  const plain = b.replace(/<[^>]+>/g, '\n');
  const lastLines = plain.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-3);
  const tail = lastLines.join(' ');
  for (const rf of REP_FIRST_NAMES) {
    const inTail = new RegExp(`(Thanks|Regards|Best|Cheers|Sincerely)\\b,?\\s+${rf}\\b`).test(tail);
    const isFinalLine = lastLines.length > 0 &&
      new RegExp(`^${rf}(\\s+\\w+)?$`).test(lastLines[lastLines.length - 1]);
    if (inTail || isFinalLine) {
      return { body: orig, changed: false, error: `rep name '${rf}' in signoff position after rewrite` };
    }
  }

  if (!b.includes('Henry')) {
    b = b.replace(/\s+$/, '') + (b.includes('</p>') ? '<p>Thanks,<br>Henry</p>' : '\n\nThanks,\nHenry');
  }
  return { body: b, changed: b !== orig, error: null };
}

/**
 * Recipient-compliance reasons for one address against the DB-backed lists
 * (Sets of lowercased values; see services/gateLists.js). Empty array = clear.
 */
function recipientBlockReasons(to, { dncEmails, bouncedEmails, suppressedDomains } = {}) {
  const reasons = [];
  const e = (typeof to === 'string' ? to : '').trim().toLowerCase();
  if (!e) return reasons;
  const dom = e.split('@')[1] || '';
  if (dncEmails instanceof Set && dncEmails.has(e)) reasons.push('DNC_RECIPIENT');
  if (bouncedEmails instanceof Set && bouncedEmails.has(e)) reasons.push('BOUNCED_RECIPIENT');
  if (suppressedDomains instanceof Set && dom && suppressedDomains.has(dom)) {
    reasons.push(`SUPPRESSED_DOMAIN (${dom})`);
  }
  return reasons;
}

/**
 * Cold-email content-rule reasons for one item. `step` comes from the item's
 * meta ({step,lane,rep}); a missing/invalid step is treated as step 1 — the
 * strictest case — same as the Python gate.
 */
function contentReasons({ to, subject, body, step } = {}) {
  const reasons = [];
  const s = String(subject || '');
  const b = String(body || '');

  if ((typeof to === 'string' ? to : '').trim().toLowerCase().endsWith('@c3.ai')) {
    reasons.push('INTERNAL_RECIPIENT (@c3.ai is never a prospect send)');
  }
  if (s.includes(EM_DASH) || b.includes(EM_DASH)) reasons.push('EM_DASH (banned in cold email)');
  for (const name of BANNED_PROOF) {
    if (new RegExp(`\\b${escapeRe(name)}\\b`).test(b)) reasons.push(`BANNED_PROOF ('${name}' in body)`);
  }
  for (const name of WRITTEN_RESTRICTED_NAMES) {
    if (new RegExp(`\\b${escapeRe(name)}\\b`, 'i').test(b)) {
      reasons.push(`RESTRICTED_NAME ('${name}' — anonymize in written email; nameable on calls only)`);
    }
  }
  const st = Number.isFinite(Number(step)) && Number(step) > 0 ? Number(step) : 1;
  if (st < 4 && BOOKING_LINK_RE.test(b)) {
    reasons.push('BOOKING_LINK (steps 1-3 are a verbal ask; links allowed from step 4)');
  }
  if (BANNED_CTA_RE.test(b) || BANNED_CTA_RE.test(s)) {
    reasons.push("OFFSPEC_CTA (use 30 minutes; '15/20 minute' and 'quick chat' are banned)");
  }
  return reasons;
}

module.exports = {
  REP_FIRST_NAMES,
  REP_FULL_NAMES,
  EM_DASH,
  BANNED_PROOF,
  WRITTEN_RESTRICTED_NAMES,
  BOOKING_LINK_RE,
  BANNED_CTA_RE,
  enforceHenrySignature,
  recipientBlockReasons,
  contentReasons,
};
