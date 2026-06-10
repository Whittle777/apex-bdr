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
export async function runReplyToEmail({ inReplyToMessageId, body, from, cc, bcc, replyAll, includeOriginalBody }) {
  const errors = [];
  if (!ok(inReplyToMessageId)) errors.push('"inReplyToMessageId" is required (the messageId returned by send_email, or the original\'s internetMessageId)');
  if (!ok(body))               errors.push('"body" is required and must be non-empty');
  if (cc   && !isEmail(cc))    errors.push('"cc" must be a valid email address if provided');
  if (bcc  && !isEmail(bcc))   errors.push('"bcc" must be a valid email address if provided');
  if (from && !isEmail(from))  errors.push('"from" must be a valid email address if provided');
  if (errors.length > 0) {
    return { isError: true, text: `❌ Input validation failed:\n - ${errors.join('\n - ')}` };
  }

  log(`reply_to_email: → inReplyTo=${inReplyToMessageId.slice(0, 40)}…, replyAll=${!!replyAll}, includeOriginal=${includeOriginalBody !== false}`);
  const result = await callBridge('/api/mcp/reply-email', {
    inReplyToMessageId,
    body,
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
 * drains at a human pace (every few minutes) inside the send window and under
 * the day's cap. Use for batches so the mailbox doesn't burst-send. Optional
 * inReplyToMessageId makes it a paced threaded reply.
 */
export async function runEnqueueEmail({
  to, subject, body, cc, bcc, from,
  inReplyToMessageId, replyAll, includeOriginalBody,
  batchId, scheduledFor, dailyCap, gate,
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
    batchId, scheduledFor, dailyCap, gate,
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
 * Check the paced send queue — by batchId (a whole batch) or trackingId (one
 * item). Returns each item's status and, once sent, its messageId /
 * internetMessageId / conversationId so the caller can reconcile.
 */
export async function runCheckEmailQueue({ batchId, trackingId, status }) {
  if (trackingId) {
    const r = await callBridge(`/api/mcp/queue/${encodeURIComponent(trackingId)}`, null, 'GET');
    if (!r.ok) return { isError: true, text: `❌ ${r.error}${r.httpStatus ? ` (HTTP ${r.httpStatus})` : ''}` };
    const it = r.item || {};
    return {
      isError: false,
      text: [
        `Queue item ${trackingId}:`,
        `   status:     ${it.status}`,
        ...(it.to ? [`   to:         ${it.to}`] : []),
        ...(it.messageId ? [`   messageId:  ${it.messageId}`] : []),
        ...(it.internetMessageId ? [`   inetMsgId:  ${it.internetMessageId}`] : []),
        ...(it.conversationId ? [`   convoId:    ${it.conversationId}`] : []),
        ...(it.failureReason ? [`   note:       ${it.failureReason}`] : []),
      ].join('\n'),
    };
  }

  const r = await callBridge('/api/mcp/queue', { batchId, status }, 'GET');
  if (!r.ok) return { isError: true, text: `❌ ${r.error}${r.httpStatus ? ` (HTTP ${r.httpStatus})` : ''}` };
  const counts = Object.entries(r.counts || {}).map(([k, v]) => `${k}=${v}`).join(' ') || '(none)';
  const lines = [
    `Queue${batchId ? ` (batch ${batchId})` : ''}: ${r.total} item(s) — ${counts}`,
    ...r.items.slice(0, 50).map((it) => {
      const id = it.messageId ? ` msgId=${it.messageId.slice(0, 24)}…` : '';
      return `   ${it.status.padEnd(9)} ${it.to || it.inReplyToMessageId || ''}${id}`;
    }),
    ...(r.items.length > 50 ? [`   …and ${r.items.length - 50} more`] : []),
  ];
  return { isError: false, text: lines.join('\n') };
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
        'apex-bdr app. The reply lands in the same Outlook conversation as the',
        'original — In-Reply-To and References headers are set automatically by',
        "Microsoft Graph, and conversationId is preserved. Recipient mail clients",
        '(Outlook, Gmail, Apple Mail) thread it under the original.',
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
          from: {
            type: 'string',
            description: 'Optional. Pick a specific connected Microsoft account. Defaults to the first connected account. Ignored when authed via a per-user token (in that mode the token IS the identity).',
          },
          cc:       { type: 'string', description: 'Optional CC address (added on top of any CC inherited via replyAll).' },
          bcc:      { type: 'string', description: 'Optional BCC address.' },
          replyAll: {
            type: 'boolean',
            description: 'If true, replies to all recipients of the original (To + CC). If false (default), replies only to the original sender.',
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
        'to a server-side queue that drains at a human pace (every few minutes),',
        'only inside the send window (8am–5pm PT), with jitter, and never beyond',
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
        },
        required: ['body'],
      },
    },
    {
      name: 'check_email_queue',
      description: [
        'Check the paced send queue. Pass batchId to see a whole batch, or',
        'trackingId for one item. Returns each item\'s status (queued/sending/sent/',
        'failed/cancelled) and, once sent, its messageId / internetMessageId /',
        'conversationId so you can reconcile (e.g. write the Email Log / Send',
        'Health) and thread follow-ups.',
      ].join('\n'),
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          batchId: { type: 'string', description: 'Show all items in this batch.' },
          trackingId: { type: 'string', description: 'Show a single item by its tracking id.' },
          status: { type: 'string', description: 'Optional filter: queued | sending | sent | failed | cancelled.' },
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
  } else if (name === 'check_email_queue') {
    outcome = await runCheckEmailQueue(args || {});
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
