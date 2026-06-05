#!/usr/bin/env node
/**
 * Quick local test for the apex-bdr MCP server's send_email tool.
 *
 * Reuses the same code path Claude Desktop would invoke (runSendEmail)
 * but skips the stdio JSON-RPC layer — so you can verify the bridge
 * round-trip end to end without needing Claude Desktop running.
 *
 * Usage:
 *   MCP_BRIDGE_URL=http://localhost:3000 \
 *   MCP_BRIDGE_TOKEN=<secret> \
 *   node test-local.js <to> <subject> <body> [cc] [bcc]
 *
 * Example:
 *   MCP_BRIDGE_TOKEN=abc123 node test-local.js you@c3.ai "Bridge test" "Hello."
 */
import { runSendEmail } from './index.js';

const [to, subject, body, cc, bcc] = process.argv.slice(2);

if (!to || !subject || !body) {
  console.error('Usage: node test-local.js <to> <subject> <body> [cc] [bcc]');
  process.exit(2);
}

const result = await runSendEmail({ to, subject, body, cc, bcc });
console.log(`\nRESULT (${result.isError ? 'error' : 'ok'}):`);
console.log(result.text);
process.exit(result.isError ? 1 : 0);
