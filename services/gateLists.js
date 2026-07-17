/**
 * gateLists — loads the DB-backed send blocklists (SendBlocklistEntry) into
 * the Set shape services/sendGate.js consumes, with a short in-memory cache so
 * enqueue calls don't re-scan the table.
 *
 * Failure stance: FAIL OPEN with a loud warning. If the table is unreadable
 * (migration not applied yet, transient DB error) the enqueue paths still run
 * with the static held-domain floor in services/enqueueBatch.js — sending is
 * never bricked by a blocklist infra error, but the warning makes the gap
 * visible instead of silent.
 */
const prisma = require('./database');

const KINDS = ['held_domain', 'suppressed_domain', 'dnc_email', 'bounced_email'];
const CACHE_TTL_MS = 60 * 1000;

const emptyLists = () => ({
  heldDomains: new Set(),
  suppressedDomains: new Set(),
  dncEmails: new Set(),
  bouncedEmails: new Set(),
});

let cache = { at: 0, lists: null };

async function getGateLists({ force = false } = {}) {
  if (!force && cache.lists && Date.now() - cache.at < CACHE_TTL_MS) return cache.lists;
  const lists = emptyLists();
  try {
    const rows = await prisma.sendBlocklistEntry.findMany({
      where: { active: true },
      select: { kind: true, value: true },
    });
    for (const r of rows) {
      const v = String(r.value || '').trim().toLowerCase();
      if (!v) continue;
      if (r.kind === 'held_domain') lists.heldDomains.add(v);
      else if (r.kind === 'suppressed_domain') lists.suppressedDomains.add(v);
      else if (r.kind === 'dnc_email') lists.dncEmails.add(v);
      else if (r.kind === 'bounced_email') lists.bouncedEmails.add(v);
    }
    cache = { at: Date.now(), lists };
  } catch (err) {
    console.warn(`[gateLists] blocklist load FAILED (failing open to static held-domain floor): ${err.message}`);
  }
  return lists;
}

function invalidateGateLists() {
  cache = { at: 0, lists: null };
}

module.exports = { KINDS, getGateLists, invalidateGateLists };
