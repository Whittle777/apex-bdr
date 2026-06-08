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
import { runSendEmail, runReplyToEmail } from './index.js';

const argv = process.argv.slice(2);
const mode = argv[0] === 'reply' ? 'reply' : 'send';

if (mode === 'send') {
  // send <to> <subject> <body> [cc] [bcc]
  // OR (legacy) <to> <subject> <body> [cc] [bcc]
  const args = argv[0] === 'send' ? argv.slice(1) : argv;
  const [to, subject, body, cc, bcc] = args;
  if (!to || !subject || !body) {
    console.error('Usage:');
    console.error('  node test-local.js [send] <to> <subject> <body> [cc] [bcc]');
    console.error('  node test-local.js reply <inReplyToMessageId> <body> [cc] [bcc] [--replyAll] [--noQuote]');
    process.exit(2);
  }
  const result = await runSendEmail({ to, subject, body, cc, bcc });
  console.log(`\nRESULT (${result.isError ? 'error' : 'ok'}):`);
  console.log(result.text);
  process.exit(result.isError ? 1 : 0);
} else {
  // reply <inReplyToMessageId> <body> [cc] [bcc] [--replyAll] [--noQuote]
  const rest = argv.slice(1);
  const flags = new Set(rest.filter(a => a.startsWith('--')));
  const positional = rest.filter(a => !a.startsWith('--'));
  const [inReplyToMessageId, body, cc, bcc] = positional;
  if (!inReplyToMessageId || !body) {
    console.error('Usage: node test-local.js reply <inReplyToMessageId> <body> [cc] [bcc] [--replyAll] [--noQuote]');
    process.exit(2);
  }
  const result = await runReplyToEmail({
    inReplyToMessageId,
    body,
    cc,
    bcc,
    replyAll: flags.has('--replyAll'),
    includeOriginalBody: !flags.has('--noQuote'),
  });
  console.log(`\nRESULT (${result.isError ? 'error' : 'ok'}):`);
  console.log(result.text);
  process.exit(result.isError ? 1 : 0);
}
