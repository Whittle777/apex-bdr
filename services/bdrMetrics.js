/**
 * bdrMetrics — PURE aggregation over the Bdr* shadow tables, mirroring the
 * workbook's metrics.py field-for-field (Phase 2 shadow comparison).
 *
 * The RULES (send_dedup collapse, group representative, effective-step
 * inference, lane bucketing) are computed at EXPORT time by the same Python
 * code metrics.py runs — this module only aggregates the precomputed columns,
 * so the two sides cannot diverge on a rule, only on data.
 *
 * Inputs are plain row arrays (no Prisma/IO here) so the whole computation is
 * unit-testable offline against an exporter snapshot — the shadow comparison
 * runs BEFORE deploy, not only after.
 */

const INACTIVE_REPLY = new Set(['DNC', 'BOUNCED', 'DISQUALIFIED', 'HELD', 'PAUSED-DNC']);
const REPLIED_STATES = new Set(['REPLIED_POS', 'REPLIED_NEU', 'REPLIED_NEG']);
const MAX_STEP = 7;

const inc = (obj, key, by = 1) => { obj[key] = (obj[key] || 0) + by; };

/**
 * @param sentRows  BdrEmailLog rows where sendKey != null (the confirmed-send rows)
 * @param statusRows BdrEmailLog rows where emailId != null → [{sendStatus}]
 * @param seqRows   BdrSequenceState rows → [{pid, replyStatus}]
 * @param prospects BdrProspect rows → [{pid, email}]
 * @param weeks     { monday, friday, lastMonday, lastFriday } ISO date strings (from the caller,
 *                  so week bounds are supplied — not re-derived — during comparison)
 */
function computeBdrMetrics({ sentRows = [], statusRows = [], seqRows = [], prospects = [], weeks = {} }) {
  const { monday, friday, lastMonday, lastFriday } = weeks;
  const reps = sentRows.filter((r) => r.isGroupRep);

  // ── send counts ──────────────────────────────────────────────────────────
  const distinctInet = new Set(sentRows.filter((r) => r.isInet).map((r) => r.msgid)).size;
  const sentBySt = {};
  const sentByStepEff = {};
  const sentByStepEffThisWeek = {};
  const sentByStepEffLastWeek = {};
  const sentByLane = {};
  const sentByRep = {};
  const sentByAccount = {};
  let sentThisWeek = 0;
  let sentLastWeek = 0;
  for (const r of reps) {
    inc(sentBySt, r.step != null ? String(r.step) : 'unknown');
    if (r.effectiveStep != null) inc(sentByStepEff, `step_${r.effectiveStep}`);
    if (r.laneBucket) inc(sentByLane, r.laneBucket);
    inc(sentByRep, r.rep || '(unknown)');
    inc(sentByAccount, r.account || '(unknown)');
    const d = r.repDate; // ISO date string; lexicographic compare is date compare
    if (d && monday && friday && d >= monday && d <= friday) {
      sentThisWeek += 1;
      if (r.effectiveStep != null) inc(sentByStepEffThisWeek, `step_${r.effectiveStep}`);
    } else if (d && lastMonday && lastFriday && d >= lastMonday && d <= lastFriday) {
      sentLastWeek += 1;
      if (r.effectiveStep != null) inc(sentByStepEffLastWeek, `step_${r.effectiveStep}`);
    }
  }

  // ── double-log + duplicate-opener detection (same shapes as metrics.py) ──
  const rawByEmail = {};
  const keysByEmail = {}; // email → Set(sendKey)
  for (const r of sentRows) {
    if (!r.email) continue;
    inc(rawByEmail, r.email);
    (keysByEmail[r.email] = keysByEmail[r.email] || new Set()).add(r.sendKey);
  }
  const doubleLogged = Object.keys(rawByEmail)
    .filter((e) => rawByEmail[e] > keysByEmail[e].size).length;

  const step1KeysByEmail = {};
  const keysByPid = {}; // representative's pid → Set(sendKey), same as metrics all_sends_by_pid
  for (const r of reps) {
    if (r.email && r.step === 1) (step1KeysByEmail[r.email] = step1KeysByEmail[r.email] || new Set()).add(r.sendKey);
    if (r.pid) (keysByPid[r.pid] = keysByPid[r.pid] || new Set()).add(r.sendKey);
  }
  const twoStep1 = Object.values(step1KeysByEmail).filter((ks) => ks.size > 1).length;

  // ── Email Log status buckets (rows with an Email ID, like metrics.py) ────
  const elStatus = {};
  for (const r of statusRows) {
    inc(elStatus, String(r.sendStatus || '').trim().toUpperCase() || '(blank)');
  }

  // ── Sequence State pass ──────────────────────────────────────────────────
  const pidEmail = {};
  for (const p of prospects) if (p.pid && p.email) pidEmail[p.pid] = p.email;

  const enrolledPids = new Set();
  const seqReply = {};
  let enrolledActive = 0;
  const trueStepDist = {};
  for (const r of seqRows) {
    if (!r.pid) continue;
    enrolledPids.add(r.pid);
    const rs = String(r.replyStatus || 'NONE').trim().toUpperCase();
    inc(seqReply, rs);
    if (!INACTIVE_REPLY.has(rs)) enrolledActive += 1;
    const em = pidEmail[r.pid] || '';
    const n = em ? (keysByEmail[em] ? keysByEmail[em].size : 0)
                 : (keysByPid[r.pid] ? keysByPid[r.pid].size : 0);
    inc(trueStepDist, String(Math.min(n, MAX_STEP)));
  }
  let replies = 0;
  for (const s of REPLIED_STATES) replies += seqReply[s] || 0;

  return {
    sent_total_alltime: reps.length,
    distinct_internet_msgids: distinctInet,
    raw_sent_rows: sentRows.length,
    double_logged_prospects: doubleLogged,
    recipients_with_two_step1_sends: twoStep1,
    sent_this_calendar_week: sentThisWeek,
    sent_last_calendar_week: sentLastWeek,
    sent_by_step: sentBySt,
    sent_by_step_effective: sortKeys(sentByStepEff),
    sent_by_step_effective_this_week: sortKeys(sentByStepEffThisWeek),
    sent_by_step_effective_last_week: sortKeys(sentByStepEffLastWeek),
    sent_by_rep: sentByRep,
    sent_by_account: sentByAccount,
    sent_by_lane: sentByLane,
    enrolled_gross: enrolledPids.size,
    enrolled_active: enrolledActive,
    true_step_distribution: trueStepDist,
    true_funnel_deduped: trueStepDist,
    queued: elStatus['QUEUED'] || 0,
    drafted: elStatus['DRAFTED'] || 0,
    bounced_email_log: elStatus['BOUNCED'] || 0,
    email_log_status_counts: elStatus,
    dnc: seqReply['DNC'] || 0,
    held: seqReply['HELD'] || 0,
    bounced_seq_state: seqReply['BOUNCED'] || 0,
    disqualified: seqReply['DISQUALIFIED'] || 0,
    paused_dnc: seqReply['PAUSED-DNC'] || 0,
    replies,
    seq_reply_status_counts: seqReply,
  };
}

function sortKeys(obj) {
  const out = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k];
  return out;
}

module.exports = { computeBdrMetrics, INACTIVE_REPLY, REPLIED_STATES };
