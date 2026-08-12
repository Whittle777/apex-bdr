#!/usr/bin/env node
/**
 * apex-bdr local MCP server
 *
 * Exposes a single tool — send_email — that Claude Desktop can call to
 * send an email through the apex-bdr app's existing Microsoft 365
 * integration. This process talks to the app over loopback HTTP using a
 * shared bridge token. Claude Desktop never touches Outlook directly,
 * and no Microsoft credentials live in this process.
 *
 * Transport: stdio. Register in claude_desktop_config.json (see README).
 *
 * Required env vars:
 *   MCP_BRIDGE_URL    — base URL of the running apex-bdr server
 *                       (e.g. http://localhost:3000). Defaults to that.
 *   MCP_BRIDGE_TOKEN  — shared secret. Must match the value the app
 *                       has in its own MCP_BRIDGE_TOKEN env var.
 *
 * Human-in-the-loop: there is no auto-approve here. Claude Desktop's
 * per-tool-call confirmation prompt is the only thing that fires the
 * send. This server just hands the request to the app when called.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'node:fs';

const BRIDGE_URL   = (process.env.MCP_BRIDGE_URL   || 'http://localhost:3000').replace(/\/+$/, '');
const BRIDGE_TOKEN = process.env.MCP_BRIDGE_TOKEN  || '';
const REQUEST_TIMEOUT_MS = parseInt(process.env.MCP_REQUEST_TIMEOUT_MS || '15000', 10);

// All logs go to stderr — MCP stdio uses stdout for JSON-RPC traffic, so
// anything else printed there would corrupt the protocol.
const log  = (...args) => console.error('[apex-bdr-mcp]', ...args);
const warn = (...args) => console.error('[apex-bdr-mcp][warn]', ...args);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ok = (s) => typeof s === 'string' && s.trim().length > 0;
const isEmail = (s) => ok(s) && EMAIL_RE.test(s.trim());

/**
 * Call an apex-bdr bridge endpoint. Pure HTTP — no Microsoft/Graph state
 * lives in this process. AbortController gives us a hard timeout
 * independent of the OS TCP settings.
 */
async function callBridge(path, params, method = 'POST') {
  if (!BRIDGE_TOKEN) {
    return {
      ok: false,
      error: 'MCP_BRIDGE_TOKEN is not set on this MCP server process. Configure it in claude_desktop_config.json.',
    };
  }
  let url = `${BRIDGE_URL}${path}`;
  const isGet = method === 'GET';
  if (isGet && params && Object.keys(params).length) {
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(params).filter(([, v]) => v != null))
    ).toString();
    if (qs) url += `?${qs}`;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${BRIDGE_TOKEN}`,
      },
      ...(isGet ? {} : { body: JSON.stringify(params) }),
      signal: controller.signal,
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return {
        ok: false,
        error: data?.error || `Bridge returned HTTP ${resp.status}`,
        httpStatus: resp.status,
      };
    }
    return data;
  } catch (err) {
    if (err.name === 'AbortError') {
      return { ok: false, error: `Request to ${url} timed out after ${REQUEST_TIMEOUT_MS}ms` };
    }
    return { ok: false, error: `Network error calling ${url}: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The single tool handler. Validates inputs, calls the bridge, formats a
 * clear text result string for Claude. Returns isError on failure so
 * Claude treats it as a tool error rather than a successful send.
 */
export async function runSendEmail({ to, subject, body, cc, bcc, from }) {
  const errors = [];
  if (!isEmail(to))            errors.push('"to" must be a valid email address');
  if (!ok(subject))            errors.push('"subject" is required and must be non-empty');
  if (!ok(body))               errors.push('"body" is required and must be non-empty');
  if (cc   && !isEmail(cc))    errors.push('"cc" must be a valid email address if provided');
  if (bcc  && !isEmail(bcc))   errors.push('"bcc" must be a valid email address if provided');
  if (from && !isEmail(from))  errors.push('"from" must be a valid email address if provided');
  if (errors.length > 0) {
    return { isError: true, text: `❌ Input validation failed:\n - ${errors.join('\n - ')}` };
  }

  log(`send_email: → ${to}, subject="${subject.slice(0, 80)}"${from ? `, from=${from}` : ''}`);
  const result = await callBridge('/api/mcp/send-email', { to, subject, body, cc, bcc, from });
  if (result.ok) {
    const lines = [
      '✅ Sent.',
      `   from:       ${result.from}`,
      `   to:         ${result.to}`,
      ...(result.cc  ? [`   cc:         ${result.cc}`]  : []),
      ...(result.bcc ? [`   bcc:        ${result.bcc}`] : []),
      `   subject:    ${result.subject}`,
      ...(result.messageId         ? [`   messageId:  ${result.messageId}`]         : []),
      ...(result.internetMessageId ? [`   inetMsgId:  ${result.internetMessageId}`] : []),
      ...(result.conversationId    ? [`   convoId:    ${result.conversationId}`]    : []),
      `   latency:    ${result.elapsedMs}ms`,
      ...(result.messageId
        ? ['', 'To send a threaded reply later, pass the messageId above as inReplyToMessageId to reply_to_email.']
        : []),
      ...(result.warning ? ['', `⚠️  ${result.warning}`] : []),
    ];
    return { isError: false, text: lines.join('\n') };
  }
  warn('send failed:', result.error);
  return {
    isError: true,
    text: `❌ Send failed: ${result.error}${result.httpStatus ? ` (HTTP ${result.httpStatus})` : ''}`,
  };
}

/**
 * Threaded reply. Calls /api/mcp/reply-email on the bridge, which sends
 * via Graph's /me/messages/{id}/reply (or /replyAll) so In-Reply-To and
 * References are set correctly and the new message inherits the original
 * conversationId.
 */
export async function runReplyToEmail({ inReplyToMessageId, body, to, from, cc, bcc, replyAll, includeOriginalBody }) {
  const errors = [];
  if (!ok(inReplyToMessageId)) errors.push('"inReplyToMessageId" is required (the messageId returned by send_email, or the original\'s internetMessageId)');
  if (!ok(body))               errors.push('"body" is required and must be non-empty');
  if (to   && !isEmail(to))    errors.push('"to" must be a valid email address if provided');
  if (cc   && !isEmail(cc))    errors.push('"cc" must be a valid email address if provided');
  if (bcc  && !isEmail(bcc))   errors.push('"bcc" must be a valid email address if provided');
  if (from && !isEmail(from))  errors.push('"from" must be a valid email address if provided');
  if (errors.length > 0) {
    return { isError: true, text: `❌ Input validation failed:\n - ${errors.join('\n - ')}` };
  }

  log(`reply_to_email: → to=${to || '(fallback)'}, inReplyTo=${inReplyToMessageId.slice(0, 40)}…, replyAll=${!!replyAll}, includeOriginal=${includeOriginalBody !== false}`);
  const result = await callBridge('/api/mcp/reply-email', {
    inReplyToMessageId,
    body,
    to,
    from,
    cc,
    bcc,
    replyAll: !!replyAll,
    includeOriginalBody: includeOriginalBody !== false, // default true
  });
  if (result.ok) {
    const lines = [
      `✅ Threaded reply sent${result.replyAll ? ' (replyAll)' : ''}.`,
      `   from:           ${result.from}`,
      ...(result.to ? [`   to:             ${result.to}`] : []),
      `   inReplyTo:      ${result.inReplyToMessageId}`,
      ...(result.cc  ? [`   cc:             ${result.cc}`]  : []),
      ...(result.bcc ? [`   bcc:            ${result.bcc}`] : []),
      ...(result.messageId         ? [`   newMessageId:   ${result.messageId}`]         : []),
      ...(result.internetMessageId ? [`   newInetMsgId:   ${result.internetMessageId}`] : []),
      ...(result.conversationId    ? [`   convoId:        ${result.conversationId}`]    : []),
      `   includedQuote:  ${result.includedOriginalBody ? 'yes' : 'no'}`,
      `   latency:        ${result.elapsedMs}ms`,
      ...(result.warning ? ['', `⚠️  ${result.warning}`] : []),
    ];
    return { isError: false, text: lines.join('\n') };
  }
  warn('reply failed:', result.error);
  return {
    isError: true,
    text: `❌ Reply failed: ${result.error}${result.httpStatus ? ` (HTTP ${result.httpStatus})` : ''}`,
  };
}

/**
 * Enqueue an email for PACED sending. Unlike send_email, this does not send
 * immediately — it adds the message to the connector's send queue, which
 * drains at a human pace (a random 30–90s between sends) inside the send window and under
 * the day's cap. Use for batches so the mailbox doesn't burst-send. Optional
 * inReplyToMessageId makes it a paced threaded reply.
 */
export async function runEnqueueEmail({
  to, subject, body, cc, bcc, from,
  inReplyToMessageId, replyAll, includeOriginalBody,
  batchId, scheduledFor, dailyCap, gate, clientRef, meta,
}) {
  const isReply = ok(inReplyToMessageId);
  const errors = [];
  if (isReply) {
    if (!ok(body)) errors.push('"body" is required');
  } else {
    if (!isEmail(to)) errors.push('"to" must be a valid email address');
    if (!ok(subject)) errors.push('"subject" is required and must be non-empty');
    if (!ok(body)) errors.push('"body" is required and must be non-empty');
  }
  if (cc && !isEmail(cc)) errors.push('"cc" must be a valid email if provided');
  if (bcc && !isEmail(bcc)) errors.push('"bcc" must be a valid email if provided');
  if (from && !isEmail(from)) errors.push('"from" must be a valid email if provided');
  if (gate != null && !['proceed', 'warning', 'abort'].includes(gate)) errors.push('"gate" must be proceed | warning | abort');
  if (errors.length > 0) {
    return { isError: true, text: `❌ Input validation failed:\n - ${errors.join('\n - ')}` };
  }

  log(`enqueue_email: → ${isReply ? `reply ${inReplyToMessageId.slice(0, 30)}…` : to}, batch=${batchId || '-'}`);
  const result = await callBridge('/api/mcp/enqueue-email', {
    to, subject, body, cc, bcc, from,
    inReplyToMessageId, replyAll: !!replyAll, includeOriginalBody: includeOriginalBody !== false,
    batchId, scheduledFor, dailyCap, gate, clientRef, meta,
  });
  if (result.ok) {
    const lines = [
      '🕒 Queued (paced send — not sent immediately).',
      `   trackingId:     ${result.trackingId}`,
      `   from:           ${result.from}`,
      ...(result.to ? [`   to:             ${result.to}`] : []),
      ...(result.isReply ? ['   type:           threaded reply'] : []),
      ...(result.batchId ? [`   batch:          ${result.batchId}`] : []),
      `   queuePosition:  ${result.queuePosition}`,
      ...(result.estimatedSendAt ? [`   est. send:      ${result.estimatedSendAt} (approx)`] : []),
      '',
      'The worker paces sends inside the send window under the day\'s cap; gate=abort halts the day.',
      'Poll status with check_email_queue (by batchId or trackingId) to get the messageId once sent.',
    ];
    return { isError: false, text: lines.join('\n') };
  }
  warn('enqueue failed:', result.error);
  return {
    isError: true,
    text: `❌ Enqueue failed: ${result.error}${result.httpStatus ? ` (HTTP ${result.httpStatus})` : ''}`,
  };
}

/**
 * Read a Cowork spool file into a BatchItem[]. Accepts either a JSON array or
 * line-delimited JSON (NDJSON), one record per line. The spool lives on the
 * machine running THIS MCP server (same place the drafting agents wrote it),
 * which is why the read happens here, not on the bridge — the app server (e.g.
 * Railway) has no access to that file.
 */
function loadSpoolFile(spoolPath) {
  const raw = readFileSync(spoolPath, 'utf8').trim();
  if (!raw) return [];
  if (raw[0] === '[') {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) throw new Error('spool JSON must be an array of items');
    return arr;
  }
  return raw.split(/\r?\n/).filter((l) => l.trim()).map((line, i) => {
    try { return JSON.parse(line); }
    catch (e) { throw new Error(`spool line ${i + 1} is not valid JSON: ${e.message}`); }
  });
}

/**
 * Enqueue MANY messages in ONE call (one approval prompt, one reconcilable
 * result, retry-safe). Either pass items[] inline or a spoolPath to a JSON
 * array / NDJSON file. The bridge dedups per recipient, replays on
 * idempotencyKey, and returns a per-item accepted/skipped/rejected report with
 * trackingIds and echoed clientRefs. Pacing is unchanged — a big batch still
 * drains slowly over the send window(s).
 */
export async function runEnqueueBatch({
  items, spoolPath, batchId, idempotencyKey, gate, dailyCap, from, defaultScheduledFor, dedupeScope,
}) {
  let batchItems = items;
  if (ok(spoolPath)) {
    try {
      batchItems = loadSpoolFile(spoolPath);
    } catch (e) {
      return { isError: true, text: `❌ Could not read spool file "${spoolPath}": ${e.message}` };
    }
  }
  if (!Array.isArray(batchItems) || batchItems.length === 0) {
    return { isError: true, text: '❌ Provide "items" (a non-empty array) or "spoolPath" to a JSON-array / NDJSON file of items.' };
  }
  if (gate != null && !['proceed', 'warning', 'abort'].includes(gate)) {
    return { isError: true, text: '❌ "gate" must be proceed | warning | abort' };
  }

  log(`enqueue_batch: ${batchItems.length} item(s)${ok(spoolPath) ? ` from ${spoolPath}` : ''}, batch=${batchId || '(auto)'}${idempotencyKey ? `, key=${idempotencyKey}` : ''}`);
  const result = await callBridge('/api/mcp/enqueue-batch', {
    items: batchItems, batchId, idempotencyKey, gate, dailyCap, from, defaultScheduledFor, dedupeScope,
  });
  if (!result.ok) {
    warn('enqueue_batch failed:', result.error);
    return { isError: true, text: `❌ Batch enqueue failed: ${result.error}${result.httpStatus ? ` (HTTP ${result.httpStatus})` : ''}` };
  }

  const c = result.counts || {};
  const all = result.items || [];
  const rejected = all.filter((i) => i.status === 'rejected');
  const skipped = all.filter((i) => i.status === 'skipped_duplicate');
  const fmt = (i) => `   • ${i.clientRef ? `[${i.clientRef}] ` : ''}${i.to || '(reply)'}${i.reason ? ` — ${i.reason}` : ''}`;
  const lines = [
    result.replayed
      ? '↩️  Replayed — this idempotencyKey was already processed; no new items were queued.'
      : '📥 Batch enqueued (paced send — items drain over the send window, not now).',
    `   batchId:   ${result.batchId}`,
    `   accepted:  ${c.accepted || 0}`,
    `   skipped:   ${c.skippedDuplicate || 0} (already queued/sent or duplicate in batch)`,
    `   rejected:  ${c.rejected || 0}`,
  ];
  if (rejected.length) {
    lines.push('', `Rejected (${rejected.length}) — surface these to the user:`, ...rejected.slice(0, 50).map(fmt));
    if (rejected.length > 50) lines.push(`   …and ${rejected.length - 50} more`);
  }
  if (skipped.length) {
    lines.push('', `Skipped as duplicate (${skipped.length}):`, ...skipped.slice(0, 25).map(fmt));
    if (skipped.length > 25) lines.push(`   …and ${skipped.length - 25} more`);
  }
  lines.push('', `Poll with check_email_queue (batchId="${result.batchId}") to get per-item status + messageId once sent.`);
  return { isError: false, text: lines.join('\n') };
}

/**
 * Check the paced send queue — by batchId (a whole batch) or trackingId (one
 * item). Returns each item's status and, once sent, its messageId /
 * internetMessageId / conversationId so the caller can reconcile.
 */
export async function runCheckEmailQueue({ batchId, trackingId, status, recipient, domain, format }) {
  // format:"json" returns the bridge's COMPLETE response as JSON — every item
  // (no 50-row cap), every field (clientRef, meta, step, internetMessageId,
  // graphItemId, sentAt, …). This is the reconcile/dedup-gate path: the text
  // format is a human summary and MUST NOT be parsed for those.
  if (format === 'json' && !trackingId) {
    const r = await callBridge('/api/mcp/queue', { batchId, status, recipient, domain }, 'GET');
    if (!r.ok) return { isError: true, text: `❌ ${r.error}${r.httpStatus ? ` (HTTP ${r.httpStatus})` : ''}` };
    return { isError: false, text: JSON.stringify({ total: r.total, counts: r.counts, policy: r.policy, items: r.items }) };
  }
  if (format === 'json' && trackingId) {
    const r = await callBridge(`/api/mcp/queue/${encodeURIComponent(trackingId)}`, null, 'GET');
    if (!r.ok) return { isError: true, text: `❌ ${r.error}${r.httpStatus ? ` (HTTP ${r.httpStatus})` : ''}` };
    return { isError: false, text: JSON.stringify(r.item || {}) };
  }
  if (trackingId) {
    const r = await callBridge(`/api/mcp/queue/${encodeURIComponent(trackingId)}`, null, 'GET');
    if (!r.ok) return { isError: true, text: `❌ ${r.error}${r.httpStatus ? ` (HTTP ${r.httpStatus})` : ''}` };
    const it = r.item || {};
    const inet = it.internetMessageId != null ? it.internetMessageId : (it.status === 'sent' ? 'null (not captured)' : null);
    return {
      isError: false,
      text: [
        `Queue item ${trackingId}:`,
        `   status:       ${it.status}`,
        ...(it.to ? [`   to:           ${it.to}`] : []),
        ...(it.clientRef ? [`   clientRef:    ${it.clientRef}`] : []),
        ...(inet != null ? [`   internetMsgId:${inet}   ← RFC 5322 dedupe key`] : []),
        ...(it.graphItemId ? [`   graphItemId:  ${it.graphItemId}   ← EWS item-id (internal)`] : []),
        ...(it.conversationId ? [`   convoId:      ${it.conversationId}`] : []),
        ...(it.meta != null ? [`   meta:         ${JSON.stringify(it.meta)}`] : []),
        ...(it.failureReason ? [`   note:         ${it.failureReason}`] : []),
      ].join('\n'),
    };
  }

  const r = await callBridge('/api/mcp/queue', { batchId, status, recipient, domain }, 'GET');
  if (!r.ok) return { isError: true, text: `❌ ${r.error}${r.httpStatus ? ` (HTTP ${r.httpStatus})` : ''}` };
  const counts = Object.entries(r.counts || {}).map(([k, v]) => `${k}=${v}`).join(' ') || '(none)';
  const scope = batchId ? ` (batch ${batchId})` : domain ? ` (@${String(domain).replace(/^@/, '')})` : recipient ? ` (${recipient})` : '';
  const p = r.policy;
  const policyLine = p
    ? `Send policy today (${p.localDate}): cap=${p.cap} sentToday=${p.sentToday} remainingToday=${p.remainingToday}` +
      (p.weeklyCap != null ? ` | weeklyCap=${p.weeklyCap} sentThisWeek=${p.sentThisWeek} remainingThisWeek=${p.remainingThisWeek} (rolling 7d)` : '') +
      (p.paceMinSeconds != null ? ` | pace=${p.paceMinSeconds}–${p.paceMaxSeconds}s` : '') +
      ` | gate=${p.gate} window=${p.windowOpen ? 'OPEN' : 'CLOSED'} (${p.windowStartHour}:00–${p.windowEndHour}:00 ${p.tz}).` +
      (p.gate === 'abort'
        ? ' ⛔ gate=abort — sending halted for the day.'
        : p.remainingThisWeek === 0
          ? ' ⛔ weekly cap reached — paused until the rolling 7-day total drops below the cap.'
          : p.remainingToday === 0
            ? ' ⚠️ daily cap reached — remaining items carry to the next window/day.'
            : '')
    : null;
  const lines = [
    `Queue${scope}: ${r.total} item(s) — ${counts}`,
    ...(policyLine ? [policyLine] : []),
    ...r.items.slice(0, 50).map((it) => {
      const ref = it.clientRef ? ` ref=${it.clientRef}` : '';
      // internetMessageId is the dedupe key — shown distinctly, never collapsed
      // into the EWS item-id; explicit "null" for a sent item that lacks one.
      const inet = it.internetMessageId
        ? ` inet=${it.internetMessageId}`
        : (it.status === 'sent' ? ' inet=null' : '');
      const graph = it.graphItemId ? ` graph=${it.graphItemId.slice(0, 18)}…` : '';
      const metaStr = it.meta != null ? ` meta=${JSON.stringify(it.meta)}` : '';
      return `   ${it.status.padEnd(9)} ${it.to || it.inReplyToMessageId || ''}${ref}${inet}${graph}${metaStr}`;
    }),
    ...(r.items.length > 50 ? [`   …and ${r.items.length - 50} more`] : []),
  ];
  return { isError: false, text: lines.join('\n') };
}

/**
 * Read the day's send policy for the caller's inbox: the effective daily cap,
 * how many sends have been used today, how many remain, the gate, and whether
 * the send window is currently open. Use this to tell "stopped because cap"
 * from "stalled" before assuming the queue is stuck.
 */
export async function runGetSendPolicy() {
  const r = await callBridge('/api/mcp/send-policy', null, 'GET');
  if (!r.ok) return { isError: true, text: `❌ ${r.error}${r.httpStatus ? ` (HTTP ${r.httpStatus})` : ''}` };
  const lines = [
    `Send policy for ${r.from} (${r.localDate}):`,
    `   cap (daily):       ${r.cap}`,
    `   sentToday:         ${r.sentToday}`,
    `   remainingToday:    ${r.remainingToday}`,
    ...(r.weeklyCap != null ? [
      `   weeklyCap (7d):    ${r.weeklyCap}`,
      `   sentThisWeek:      ${r.sentThisWeek}`,
      `   remainingThisWeek: ${r.remainingThisWeek}`,
    ] : []),
    `   gate:              ${r.gate}`,
    `   window:            ${r.windowOpen ? 'OPEN' : 'CLOSED'} (${r.windowStartHour}:00–${r.windowEndHour}:00 ${r.tz})`,
    ...(r.paceMinSeconds != null ? [`   pace:              ${r.paceMinSeconds}–${r.paceMaxSeconds}s random between sends`] : []),
    `   hardCeiling:       ${r.hardCapCeiling}`,
    ...(r.gate === 'abort'
      ? ['', '⛔ gate=abort — sending is halted for the day (Send Health CRITICAL).']
      : r.remainingThisWeek === 0
        ? ['', '⛔ Rolling 7-day weekly cap reached — sending is paused until the trailing-7-day total drops below the cap. This is the cap, not a stall.']
        : r.remainingToday === 0
          ? ['', '⚠️  Daily cap reached — queued items carry to the next window/day. This is the cap, not a stall.']
          : []),
  ];
  return { isError: false, text: lines.join('\n') };
}

/**
 * Read open/click engagement stats for sequence emails: sent/opened/clicked
 * counts plus openRate/clickRate, optionally grouped by sequence/step/day.
 */
export async function runGetEmailStats({ sequenceId, from, to, groupBy } = {}) {
  const r = await callBridge('/api/mcp/email-stats', { sequenceId, from, to, groupBy }, 'GET');
  if (!r.ok) return { isError: true, text: `❌ ${r.error}${r.httpStatus ? ` (HTTP ${r.httpStatus})` : ''}` };
  const pct = (v) => `${v}%`;
  const lines = [
    `Email engagement ${r.since.slice(0, 10)} → ${r.until.slice(0, 10)}${r.sequenceId ? ` (sequence ${r.sequenceId})` : ' (all sequences)'}:`,
    `   sent:    ${r.sent}`,
    `   opened:  ${r.opened} (${pct(r.openRate)})`,
    `   clicked: ${r.clicked} (${pct(r.clickRate)})${r.totalClicks > r.clicked ? ` — ${r.totalClicks} total clicks` : ''}`,
    `   failed:  ${r.failed}`,
    ...(r.draftPending ? [`   awaiting review: ${r.draftPending}`] : []),
    ...(r.approved ? [`   approved (will send): ${r.approved}`] : []),
  ];
  if (Array.isArray(r.groups) && r.groups.length) {
    lines.push('', `By ${r.groupBy}:`);
    for (const g of r.groups) {
      lines.push(
        `   ${g.label} — sent ${g.sent}, opened ${g.opened} (${pct(g.openRate)}), clicked ${g.clicked} (${pct(g.clickRate)})${g.failed ? `, failed ${g.failed}` : ''}`
      );
    }
  }
  lines.push('', 'Note: opens are inflated by mail-client image prefetch (Apple Mail, Gmail proxy) — treat clicks as the reliable signal.');
  return { isError: false, text: lines.join('\n') };
}

/**
 * Cancel / pause / resume queued items by trackingId, batchId, recipient, or
 * domain. cancel is terminal; pause is a reversible hold (resume to release).
 */
export async function runManageQueuedEmail({ action, trackingId, batchId, recipient, domain }) {
  if (!['cancel', 'pause', 'resume'].includes(action)) {
    return { isError: true, text: '❌ "action" must be cancel | pause | resume' };
  }
  const sels = [['trackingId', trackingId], ['batchId', batchId], ['recipient', recipient], ['domain', domain]].filter(([, v]) => ok(v));
  if (sels.length !== 1) {
    return { isError: true, text: `❌ Provide exactly one selector (trackingId, batchId, recipient, or domain) — got ${sels.length}.` };
  }

  log(`manage_queued_email: ${action} by ${sels[0][0]}=${sels[0][1]}`);
  const result = await callBridge('/api/mcp/queue/manage', { action, trackingId, batchId, recipient, domain });
  if (result.ok) {
    const lines = [
      `✅ ${action} — ${result.count} item(s) affected${result.skipped?.length ? `, ${result.skipped.length} skipped` : ''}.`,
      `   selector:  ${result.selector.kind}=${result.selector.value}`,
      ...result.affected.slice(0, 50).map((a) => `   • ${a.trackingId}  ${a.to || ''}  ${a.fromStatus}→${a.toStatus}`),
      ...(result.skipped?.length
        ? ['', 'Skipped (not in an actionable status — e.g. already sent):', ...result.skipped.slice(0, 50).map((s) => `   • ${s.trackingId}  ${s.to || ''}  status=${s.status}`)]
        : []),
    ];
    return { isError: false, text: lines.join('\n') };
  }
  warn('manage failed:', result.error);
  return { isError: true, text: `❌ ${action} failed: ${result.error}${result.httpStatus ? ` (HTTP ${result.httpStatus})` : ''}` };
}

/**
 * Alter a still-queued/paused item's content or timing. Recipient and
 * threading are NOT editable (cancel + re-enqueue to change those).
 */
export async function runUpdateQueuedEmail({ trackingId, subject, body, cc, bcc, scheduledFor, replyAll, includeOriginalBody }) {
  if (!ok(trackingId)) return { isError: true, text: '❌ "trackingId" is required' };
  const payload = { trackingId };
  if (subject !== undefined) payload.subject = subject;
  if (body !== undefined) payload.body = body;
  if (cc !== undefined) payload.cc = cc;
  if (bcc !== undefined) payload.bcc = bcc;
  if (scheduledFor !== undefined) payload.scheduledFor = scheduledFor;
  if (replyAll !== undefined) payload.replyAll = replyAll;
  if (includeOriginalBody !== undefined) payload.includeOriginalBody = includeOriginalBody;
  if (Object.keys(payload).length === 1) {
    return { isError: true, text: '❌ Provide at least one field to change (subject, body, cc, bcc, scheduledFor, replyAll, includeOriginalBody).' };
  }

  log(`update_queued_email: ${trackingId} fields=${Object.keys(payload).filter((k) => k !== 'trackingId').join(',')}`);
  const result = await callBridge('/api/mcp/queue/update', payload, 'PATCH');
  if (result.ok) {
    return {
      isError: false,
      text: [
        `✅ Updated ${trackingId} (changed: ${result.changed.join(', ')}).`,
        `   to:        ${result.item.to}`,
        `   subject:   ${result.item.subject}`,
        `   status:    ${result.item.status}`,
        ...(result.item.scheduledFor ? [`   sendAfter: ${result.item.scheduledFor}`] : []),
      ].join('\n'),
    };
  }
  warn('update failed:', result.error);
  return { isError: true, text: `❌ Update failed: ${result.error}${result.httpStatus ? ` (HTTP ${result.httpStatus})` : ''}` };
}

// ──────────────────────────────────────────────────────────────────────
// MCP wiring
// ──────────────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'apex-bdr-bridge', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'send_email',
      description: [
        'Send an email through the apex-bdr app, which routes it through the',
        "user's connected Microsoft 365 (Outlook) account. The app handles auth;",
        'this tool just describes the message.',
        '',
        'Useful when the user asks Claude to email someone on their behalf and',
        'the desktop client should hand off to the local app rather than touch',
        'Outlook directly.',
        '',
        'IMPORTANT: The user must approve each call via the Claude Desktop',
        'permission prompt before this fires. There is no auto-approve.',
        '',
        'Returns a messageId you can later pass to reply_to_email to send a',
        'true RFC 5322 threaded follow-up.',
      ].join('\n'),
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          to:      { type: 'string', description: 'Recipient email address (required).' },
          subject: { type: 'string', description: 'Subject line (required, non-empty).' },
          body:    { type: 'string', description: 'Email body. Plain text OR HTML. Bare URLs and markdown [label](url) become clickable links.' },
          cc:      { type: 'string', description: 'Optional CC address.' },
          bcc:     { type: 'string', description: 'Optional BCC address.' },
          from:    { type: 'string', description: 'Optional. Pick a specific connected Microsoft account (must match a stored credential email). Defaults to the first connected account.' },
        },
        required: ['to', 'subject', 'body'],
      },
    },
    {
      name: 'reply_to_email',
      description: [
        'Send a true RFC 5322 threaded reply to an existing email through the',
        'apex-bdr app. The reply threads under the original (In-Reply-To /',
        'References / conversationId) so recipient clients (Outlook, Gmail, Apple',
        'Mail) group it with the original.',
        '',
        'CRITICAL — set "to" to the person who should RECEIVE the reply (the',
        'prospect). For a sequence follow-up, the parent is the message YOU sent to',
        'the prospect; you are replying so the PROSPECT gets it. Always pass',
        '`to=<prospect email>`. (Without it, the reply falls back to the parent\'s',
        "To line; it is never sent back to the parent's sender.)",
        '',
        'Use this for sequence steps 2-N when you want the follow-up to chain',
        "under the first send. The original message must have been sent or",
        "received in this mailbox so it's visible to Graph.",
        '',
        'IMPORTANT: The user must approve each call via the Claude Desktop',
        'permission prompt before this fires. There is no auto-approve.',
      ].join('\n'),
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          inReplyToMessageId: {
            type: 'string',
            description: 'The Graph message ID of the message being replied to (long opaque string returned by send_email as `messageId`). RFC 5322 internetMessageId values (containing "@", often wrapped in <…>) are also accepted and resolved automatically.',
          },
          body: {
            type: 'string',
            description: 'The reply body. Plain text OR HTML. Bare URLs and markdown [label](url) become clickable. Do NOT include a quoted-original block manually — when includeOriginalBody is true (default) the bridge fetches the original and appends it for you.',
          },
          to: {
            type: 'string',
            description: 'STRONGLY RECOMMENDED. The recipient of the reply — the prospect (the person to follow up with). This overrides Microsoft Graph\'s default of replying to the parent message\'s sender, which for a message you sent would loop the reply back to your own mailbox. Omit only if you deliberately want the parent\'s To line.',
          },
          from: {
            type: 'string',
            description: 'Optional. Pick a specific connected Microsoft account. Defaults to the first connected account. Ignored when authed via a per-user token (in that mode the token IS the identity).',
          },
          cc:       { type: 'string', description: 'Optional CC address (added on top of any CC inherited via replyAll).' },
          bcc:      { type: 'string', description: 'Optional BCC address.' },
          replyAll: {
            type: 'boolean',
            description: 'If true, also CCs the original\'s other recipients (To + CC, minus your own mailbox). The primary recipient is always `to`. Default false.',
          },
          includeOriginalBody: {
            type: 'boolean',
            description: 'If true (default), the original message body is appended below the new content with a standard quote block. If false, only the new body is sent (clean follow-up without history).',
          },
        },
        required: ['inReplyToMessageId', 'body'],
      },
    },
    {
      name: 'enqueue_email',
      description: [
        'Enqueue an email for PACED sending through the apex-bdr app (Outlook).',
        'Unlike send_email, this does NOT send immediately — it adds the message',
        'to a server-side queue that drains at a human pace (a random 30–90s',
        'between sends), only inside the send window (8am–5pm PT), and never beyond',
        "the day's cap. Use this for BATCHES so the mailbox doesn't burst-send",
        '(bursting is a top deliverability/spam trigger).',
        '',
        'Set inReplyToMessageId to enqueue a paced threaded reply instead of a new',
        'send. Pass dailyCap and gate (computed from Send Health) to set the day\'s',
        'policy: gate="abort" (CRITICAL) halts the whole day; cap limits volume.',
        '',
        'Returns a trackingId. Poll check_email_queue (by batchId or trackingId) to',
        'get each message\'s status and messageId once it actually sends.',
      ].join('\n'),
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          to: { type: 'string', description: 'Recipient email (required for a new send; omit for a reply).' },
          subject: { type: 'string', description: 'Subject (required for a new send).' },
          body: { type: 'string', description: 'Email body. Plain text OR HTML; bare URLs and markdown links become clickable.' },
          cc: { type: 'string', description: 'Optional CC address.' },
          bcc: { type: 'string', description: 'Optional BCC address.' },
          from: { type: 'string', description: 'Optional. Pick a connected Microsoft account. Ignored under a per-user token.' },
          inReplyToMessageId: { type: 'string', description: 'If set, this is a paced threaded reply to that message (Graph id or internetMessageId).' },
          replyAll: { type: 'boolean', description: 'Reply to all (only when inReplyToMessageId is set). Default false.' },
          includeOriginalBody: { type: 'boolean', description: 'Quote the original below the reply (only for replies). Default true.' },
          batchId: { type: 'string', description: 'Group this send with the rest of today\'s batch (for status polling/reconciliation).' },
          scheduledFor: { type: 'string', description: 'Optional ISO timestamp — earliest time this may send (still subject to pacing/window/cap).' },
          dailyCap: { type: 'integer', description: 'Max messages to send today for this inbox (from Send Health Daily Cap). Sets the day\'s policy.' },
          gate: { type: 'string', enum: ['proceed', 'warning', 'abort'], description: 'Day gate from Send Health Status. abort=halt the day (CRITICAL); warning/proceed=send (cap encodes WARNING).' },
          clientRef: { type: 'string', description: 'Your key (e.g. Prospect ID "P0214"). Persisted and returned on every check_email_queue status read so you can join the sent email back to your row.' },
          meta: { type: 'object', description: 'Opaque metadata stored and returned verbatim (e.g. {"step":2,"lane":1,"rep":"Sai Konda"}). The connector never inspects it — use it to carry sequence step / lane / variant.' },
        },
        required: ['body'],
      },
    },
    {
      name: 'enqueue_batch',
      description: [
        'Enqueue MANY emails for PACED sending in ONE call — use this for any',
        'batch >1 instead of calling enqueue_email N times. One tool call = one',
        'approval prompt (not N), and the server owns dedup, partial-failure, and',
        'retry-safety so the agent never has to.',
        '',
        'Pass items[] inline, OR a spoolPath to a JSON-array / NDJSON file of',
        'items (read locally by this MCP server — ideal for large batches so you',
        "don't inline hundreds of bodies into the prompt).",
        '',
        'Behavior:',
        '- Dedup per recipient (default scope queue+sent) so re-running never',
        '  double-sends; cancelled/failed items do NOT block a resend.',
        '- idempotencyKey makes the whole call replay-safe: a retry with the same',
        '  key returns the SAME result and queues nothing new. Pass a stable key',
        '  per logical batch (e.g. "bdr_20260616_full_v1").',
        '- gate="abort" (Send Health CRITICAL) rejects the ENTIRE batch.',
        '- One bad record (missing body, bad email, blocked domain) is returned as',
        '  rejected with a reason and never blocks the valid ones.',
        '',
        'Returns counts + a per-item report (accepted/skipped_duplicate/rejected)',
        'with trackingId and your echoed clientRef, plus a batchId. Pacing is',
        'unchanged — a big batch still drains slowly over the send window(s).',
      ].join('\n'),
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          items: {
            type: 'array',
            description: 'The messages to queue (1..1000). Omit if using spoolPath.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                to: { type: 'string', description: 'Recipient email (required for a new send; optional for a reply).' },
                subject: { type: 'string', description: 'Subject (required for a new send).' },
                body: { type: 'string', description: 'Body, plain text or HTML (required).' },
                cc: { type: 'string', description: 'Optional CC.' },
                bcc: { type: 'string', description: 'Optional BCC.' },
                inReplyToMessageId: { type: 'string', description: 'If set, a paced threaded reply (then to/subject optional).' },
                replyAll: { type: 'boolean', description: 'Reply to all (reply items only).' },
                includeOriginalBody: { type: 'boolean', description: 'Quote the original (reply items only). Default true.' },
                scheduledFor: { type: 'string', description: 'Per-item ISO override of defaultScheduledFor.' },
                clientRef: { type: 'string', description: 'Your key (e.g. Prospect ID "P0214"). Echoed in the result AND persisted on the row, so check_email_queue returns it on the sent record (days later) for a (clientRef, internetMessageId) join — no fuzzy recipient/subject matching.' },
                meta: { type: 'object', description: 'Opaque metadata stored and returned verbatim on the sent record (e.g. {"step":2,"lane":1}). The connector never inspects it — carries sequence step / lane / variant / any future dimension.' },
              },
              required: ['body'],
            },
          },
          spoolPath: { type: 'string', description: 'Path (on this MCP server\'s machine) to a JSON-array or NDJSON spool file of items. Alternative to inline items.' },
          batchId: { type: 'string', description: 'Group id for the whole batch (for polling/reconciliation). Server mints one if omitted.' },
          idempotencyKey: { type: 'string', description: 'STRONGLY recommended. Stable key per logical batch; a retry with the same key replays the stored result and queues nothing new.' },
          gate: { type: 'string', enum: ['proceed', 'warning', 'abort'], description: 'Day gate from Send Health. abort=reject the whole batch; warning/proceed=accept (cap encodes WARNING).' },
          dailyCap: { type: 'integer', description: 'Day cap for this inbox (from Send Health). Sets the day policy.' },
          from: { type: 'string', description: 'Optional connected Microsoft account. Ignored under a per-user token.' },
          defaultScheduledFor: { type: 'string', description: 'ISO timestamp — earliest any item may send (per-item scheduledFor overrides). Still paced/windowed.' },
          dedupeScope: { type: 'string', enum: ['queue', 'queue+sent', 'none'], description: 'Dedup scope. queue+sent (default) skips recipients already queued/paused/sending/sent; queue allows re-sending to someone already sent (e.g. sequence step 2); none disables dedup (dangerous).' },
        },
      },
    },
    {
      name: 'check_email_queue',
      description: [
        'Check the paced send queue. Pass batchId to see a whole batch, or',
        'trackingId for one item. Each item reports its status (queued/sending/',
        'sent/failed/cancelled) plus, for reconciliation:',
        '- internetMessageId — the RFC 5322 <…@…> Message-ID, the STABLE dedupe key',
        '  (what recipient headers and Re: replies reference). Use THIS to dedupe,',
        '  not graphItemId. Shown as null if it could not be captured.',
        '- graphItemId — the EWS/Graph item-id (internal handle); distinct from the',
        '  internetMessageId, never a substitute for it.',
        '- clientRef — your key (e.g. P0214), echoed on every read so you can join',
        '  on (clientRef, internetMessageId) with no fuzzy matching.',
        '- meta — the opaque blob you sent (e.g. {"step":2,"lane":1}), verbatim.',
        '- conversationId — for threading follow-ups.',
        '',
        "When listing (not a single trackingId), the response also reports the day's",
        'send policy — cap, sentToday, remainingToday, gate, window open/closed — so',
        'you can tell "stopped because the daily cap was hit" from "stalled". For',
        'just the policy without the item list, use get_send_policy.',
      ].join('\n'),
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          batchId: { type: 'string', description: 'Show all items in this batch.' },
          trackingId: { type: 'string', description: 'Show a single item by its tracking id.' },
          status: { type: 'string', description: 'Optional filter: queued | paused | sending | sent | failed | cancelled.' },
          recipient: { type: 'string', description: 'Show items addressed to this exact email.' },
          domain: { type: 'string', description: 'Show items to this recipient domain, e.g. "amd.com".' },
          format: { type: 'string', description: 'Output format: "text" (default, human summary, first 50 items) or "json" (complete machine-readable listing — EVERY item and field, no truncation). ALWAYS use "json" for reconciliation or pre-send dedup checks.' },
        },
      },
    },
    {
      name: 'get_send_policy',
      description: [
        "Read the day's outbound send policy for the connected inbox WITHOUT",
        'listing the queue. Returns the effective daily cap, how many sends have',
        'been used today (sentToday), how many remain (remainingToday), the gate',
        '(proceed/warning/abort), and whether the send window is currently open.',
        '',
        'Use this to distinguish "the worker stopped because it hit the daily cap"',
        'from "the queue is stalled" — if remainingToday is 0 (or gate=abort), the',
        'remaining queued items are waiting for the next window/day by design, not',
        'stuck. The cap is set per-day from Send Health; raise it by re-enqueuing',
        "with a higher dailyCap (bounded by the server's hard ceiling).",
      ].join('\n'),
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
    },
    {
      name: 'manage_queued_email',
      description: [
        'Cancel, pause, or resume queued sends. Acts on exactly ONE selector:',
        'trackingId (one item), batchId (a whole batch), recipient (one address),',
        'or domain (e.g. "amd.com" — everything to that domain).',
        '',
        '- cancel: terminal. queued/paused → cancelled. Never touches an item that',
        '  is already sending or sent (those are reported as skipped).',
        '- pause:  reversible hold. queued → paused; the worker skips paused items.',
        '- resume: paused → queued; the worker resumes pacing it.',
        '',
        'Use this to stop outreach (e.g. pause or cancel everything to a domain).',
        'Returns which items were affected and which were skipped.',
      ].join('\n'),
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['cancel', 'pause', 'resume'], description: 'cancel (terminal) | pause (reversible) | resume.' },
          trackingId: { type: 'string', description: 'Target a single item.' },
          batchId: { type: 'string', description: 'Target a whole batch.' },
          recipient: { type: 'string', description: 'Target one exact recipient email.' },
          domain: { type: 'string', description: 'Target a recipient domain, e.g. "amd.com".' },
        },
        required: ['action'],
      },
    },
    {
      name: 'update_queued_email',
      description: [
        'Alter a still-queued (or paused) item\'s content or timing before it',
        'sends. Identify it by trackingId. You can change subject, body, cc, bcc,',
        'scheduledFor (earliest send time), replyAll, includeOriginalBody.',
        '',
        'You CANNOT change the recipient or which message a reply threads onto —',
        'to change those, cancel the item and enqueue a new one. Fails if the item',
        'has already sent / is sending / was cancelled.',
      ].join('\n'),
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          trackingId: { type: 'string', description: 'The item to edit (required).' },
          subject: { type: 'string', description: 'New subject (ignored for replies, which use "Re: …").' },
          body: { type: 'string', description: 'New body. Plain text or HTML.' },
          cc: { type: 'string', description: 'New CC address; empty string clears it.' },
          bcc: { type: 'string', description: 'New BCC address; empty string clears it.' },
          scheduledFor: { type: 'string', description: 'ISO timestamp — earliest time this may send (still subject to pacing/window/cap).' },
          replyAll: { type: 'boolean', description: 'For reply items: reply to all.' },
          includeOriginalBody: { type: 'boolean', description: 'For reply items: quote the original.' },
        },
        required: ['trackingId'],
      },
    },
    {
      name: 'get_email_stats',
      description: [
        'Read open/click engagement stats for sequence emails (tracking-pixel +',
        'click-redirect data): sent, opened, clicked counts plus openRate and',
        'clickRate percentages over an optional send-date window.',
        '',
        'Optionally add a breakdown with groupBy=sequence (compare sequences),',
        'groupBy=step (find which step earns the clicks), or groupBy=day (trend',
        'over time). Filter to one sequence with sequenceId. Dates are ISO',
        '(YYYY-MM-DD or full timestamps); omit both to cover all time.',
        '',
        'Read-only. Rates are cohort-based: of the emails SENT in the window,',
        'the share opened/clicked. Opens are inflated by mail-client image',
        'proxies; treat clicks as the trustworthy engagement signal.',
      ].join('\n'),
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sequenceId: { type: 'string', description: 'Restrict to one sequence id.' },
          from: { type: 'string', description: 'ISO date lower bound on send time.' },
          to: { type: 'string', description: 'ISO date upper bound on send time.' },
          groupBy: { type: 'string', enum: ['sequence', 'step', 'day'], description: 'Add a per-sequence / per-step / per-day breakdown.' },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params || {};
  let outcome;
  if (name === 'send_email') {
    outcome = await runSendEmail(args || {});
  } else if (name === 'reply_to_email') {
    outcome = await runReplyToEmail(args || {});
  } else if (name === 'enqueue_email') {
    outcome = await runEnqueueEmail(args || {});
  } else if (name === 'enqueue_batch') {
    outcome = await runEnqueueBatch(args || {});
  } else if (name === 'check_email_queue') {
    outcome = await runCheckEmailQueue(args || {});
  } else if (name === 'get_send_policy') {
    outcome = await runGetSendPolicy(args || {});
  } else if (name === 'manage_queued_email') {
    outcome = await runManageQueuedEmail(args || {});
  } else if (name === 'update_queued_email') {
    outcome = await runUpdateQueuedEmail(args || {});
  } else if (name === 'get_email_stats') {
    outcome = await runGetEmailStats(args || {});
  } else {
    return {
      isError: true,
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
    };
  }
  return {
    isError: outcome.isError,
    content: [{ type: 'text', text: outcome.text }],
  };
});

// ──────────────────────────────────────────────────────────────────────
// Boot
// ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!BRIDGE_TOKEN) {
    warn('MCP_BRIDGE_TOKEN is not set — every send_email call will fail until you set it.');
  }
  log(`bridge target: ${BRIDGE_URL}`);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('listening on stdio.');
}

// Only auto-start when invoked directly (not when imported by test-local.js).
const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('index.js');
if (isMain) {
  main().catch((err) => {
    console.error('[apex-bdr-mcp] fatal:', err);
    process.exit(1);
  });
}
