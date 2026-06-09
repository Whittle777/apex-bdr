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
async function callBridge(path, params) {
  if (!BRIDGE_TOKEN) {
    return {
      ok: false,
      error: 'MCP_BRIDGE_TOKEN is not set on this MCP server process. Configure it in claude_desktop_config.json.',
    };
  }
  const url = `${BRIDGE_URL}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${BRIDGE_TOKEN}`,
      },
      body: JSON.stringify(params),
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
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params || {};
  let outcome;
  if (name === 'send_email') {
    outcome = await runSendEmail(args || {});
  } else if (name === 'reply_to_email') {
    outcome = await runReplyToEmail(args || {});
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
