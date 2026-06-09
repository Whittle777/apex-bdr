#!/usr/bin/env node
/**
 * Sent-Items message-id recovery / backfill utility.
 *
 * Why this exists
 * ---------------
 * `POST /me/sendMail` returns no message id, and before the poll-with-
 * backoff fix the bridge captured the id on only ~1 in 24 sends. Those
 * emails still went out and still live in the sender's Sent Items, so
 * their ids are recoverable after the fact. This script looks each one up
 * by recipient + subject + approximate send time and prints the recovered
 * `messageId`, `internetMessageId`, and `conversationId` — enough to thread
 * a follow-up via reply_to_email (which accepts either id).
 *
 * It reuses the app's existing Microsoft token refresh (Mail.Read scope),
 * so no new permission is required.
 *
 * Usage
 * -----
 *   node scripts/recoverSentIds.js --items <file.json> [options]
 *
 * Options:
 *   --items <path>     JSON file: an array of { recipient, subject, approxSendTime }.
 *                      approxSendTime is an ISO timestamp (optional; defaults to now).
 *   --user <id>        User id whose Microsoft credential to use (default: first connected).
 *   --mailbox <email>  Pick the connected Microsoft account by email instead of --user.
 *   --window <minutes> Search window on each side of approxSendTime (default: 30).
 *   --json             Print machine-readable JSON only (no table).
 *   --debug            Dump raw Graph responses to stderr.
 *
 * Example (backfill the 2026-06-09 batch):
 *   node scripts/recoverSentIds.js --items today-batch.json --mailbox henry.whittle@c3.ai
 *
 * today-batch.json:
 *   [
 *     { "recipient": "jane@acme.com", "subject": "Quick question, Jane",
 *       "approxSendTime": "2026-06-09T14:03:00Z" },
 *     ...
 *   ]
 */
const fs = require('fs');
const path = require('path');

const prisma = require('../services/database');
const { getMicrosoftAccessToken } = require('../services/sequenceMailer');
const { recoverSentMessageIds } = require('../services/graphSentLookup');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--debug') args.debug = true;
    else if (a.startsWith('--')) {
      args[a.slice(2)] = argv[i + 1];
      i++;
    }
  }
  return args;
}

async function resolveUserId({ user, mailbox }) {
  if (user) return parseInt(user, 10);
  const where = { provider: 'microsoft', ...(mailbox ? { email: mailbox } : {}) };
  const cred = await prisma.integrationCredential.findFirst({ where, orderBy: { id: 'asc' } });
  if (!cred) {
    throw new Error(
      mailbox
        ? `No connected Microsoft credential found for mailbox "${mailbox}".`
        : 'No connected Microsoft credential found. Connect Microsoft in Integrations first, or pass --user/--mailbox.'
    );
  }
  return cred.userId;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.items) {
    console.error('Missing --items <file.json>. See header of this file for usage.');
    process.exit(2);
  }
  const itemsPath = path.resolve(process.cwd(), args.items);
  let items;
  try {
    items = JSON.parse(fs.readFileSync(itemsPath, 'utf8'));
  } catch (err) {
    console.error(`Could not read/parse --items file "${itemsPath}": ${err.message}`);
    process.exit(2);
  }
  if (!Array.isArray(items) || items.length === 0) {
    console.error('--items file must contain a non-empty JSON array of { recipient, subject, approxSendTime }.');
    process.exit(2);
  }

  const windowMinutes = args.window ? parseInt(args.window, 10) : 30;

  const userId = await resolveUserId(args);
  const { accessToken, fromEmail } = await getMicrosoftAccessToken(userId);
  if (!args.json) console.error(`Recovering ${items.length} message(s) from ${fromEmail}'s Sent Items…\n`);

  const results = await recoverSentMessageIds({
    accessToken,
    items,
    windowMinutes,
    debug: !!args.debug,
  });

  const foundCount = results.filter((r) => r.found).length;

  if (args.json) {
    // stdout = a BARE LIST of result objects, so `> recovered.json` is
    // directly consumable by downstream tooling (e.g. _backfill_messageids.py
    // does `for r in json.load(...)`). The run summary goes to stderr so it
    // never contaminates the captured JSON.
    console.log(JSON.stringify(results, null, 2));
    console.error(`[recoverSentIds] mailbox=${fromEmail} found=${foundCount}/${results.length}`);
  } else {
    for (const r of results) {
      if (r.found) {
        console.log(`✅ ${r.recipient}  —  "${r.subject}"`);
        console.log(`     messageId:         ${r.messageId}`);
        console.log(`     internetMessageId: ${r.internetMessageId}`);
        console.log(`     conversationId:    ${r.conversationId}`);
        console.log(`     sentDateTime:      ${r.sentDateTime}`);
      } else {
        console.log(`❌ ${r.recipient}  —  "${r.subject}"  (not found${r.error ? `: ${r.error}` : ''})`);
      }
      console.log('');
    }
    console.error(`Recovered ${foundCount}/${results.length}.`);
  }

  await prisma.$disconnect().catch(() => {});
  process.exit(foundCount === results.length ? 0 : 1);
}

main().catch(async (err) => {
  console.error(`recoverSentIds failed: ${err.message}`);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
