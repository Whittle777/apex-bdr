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
 * Call the apex-bdr send-email bridge endpoint. Pure HTTP — no
 * Microsoft/Graph state lives in this process. AbortController gives us
 * a hard timeout independent of the OS TCP settings.
 */
async function callBridge(params) {
  if (!BRIDGE_TOKEN) {
    return {
      ok: false,
      error: 'MCP_BRIDGE_TOKEN is not set on this MCP server process. Configure it in claude_desktop_config.json.',
    };
  }
  const url = `${BRIDGE_URL}/api/mcp/send-email`;
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
  const result = await callBridge({ to, subject, body, cc, bcc, from });
  if (result.ok) {
    const lines = [
      '✅ Sent.',
      `   from:    ${result.from}`,
      `   to:      ${result.to}`,
      ...(result.cc  ? [`   cc:      ${result.cc}`]  : []),
      ...(result.bcc ? [`   bcc:     ${result.bcc}`] : []),
      `   subject: ${result.subject}`,
      `   latency: ${result.elapsedMs}ms`,
    ];
    return { isError: false, text: lines.join('\n') };
  }
  warn('send failed:', result.error);
  return {
    isError: true,
    text: `❌ Send failed: ${result.error}${result.httpStatus ? ` (HTTP ${result.httpStatus})` : ''}`,
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
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params || {};
  if (name !== 'send_email') {
    return {
      isError: true,
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
    };
  }
  const { isError, text } = await runSendEmail(args || {});
  return {
    isError,
    content: [{ type: 'text', text }],
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
