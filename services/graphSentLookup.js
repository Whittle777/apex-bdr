/**
 * Sent-Items lookup helpers for Microsoft Graph.
 *
 * Why this exists
 * ---------------
 * Graph's `POST /me/sendMail` returns `202 Accepted` with an EMPTY body —
 * it never returns the created message or its id. To recover the Graph
 * message id / internetMessageId / conversationId (needed so a later
 * `reply_to_email` can thread off the original), we have to read the
 * message back from Sent Items.
 *
 * The original bug: the bridge queried Sent Items exactly ONCE, the
 * instant sendMail returned. Right after a 202 the message is usually not
 * yet indexed in Sent Items, so that single query almost always missed —
 * giving the observed ~1-in-24 capture rate. It occasionally hit only when
 * indexing happened to be unusually fast.
 *
 * The fix here keeps the existing `Mail.Send` + `Mail.Read` scopes (no new
 * Graph permission, no IT re-approval) and instead replaces the single
 * shot with a bounded poll-with-backoff: query Sent Items a handful of
 * times over ~8-10s until the just-sent message shows up. Indexing lag is
 * normally 1-3s, so a few retries closes almost all of the gap.
 *
 * Everything is dependency-injectable (`http`, `sleep`) so the polling
 * behaviour can be unit-tested without real network or real timers.
 */
const axiosDefault = require('axios');

const GRAPH = 'https://graph.microsoft.com/v1.0';

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One Sent-Items query. Filters by exact subject + a sentDateTime window
 * (and optional upper bound) and asks Graph for the fields we need to
 * thread a reply later.
 */
async function querySentItems({ accessToken, sinceIso, untilIso, subject, top = 15, http = axiosDefault, debug = false }) {
  const escSubject = (subject || '').replace(/'/g, "''");
  let filter = `sentDateTime ge ${sinceIso} and subject eq '${escSubject}'`;
  if (untilIso) filter += ` and sentDateTime le ${untilIso}`;
  const url =
    `${GRAPH}/me/mailFolders/sentitems/messages` +
    `?$top=${top}&$orderby=sentDateTime desc` +
    `&$select=id,internetMessageId,conversationId,subject,sentDateTime,toRecipients` +
    `&$filter=${encodeURIComponent(filter)}`;
  const resp = await http.get(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 10000,
  });
  if (debug) {
    // Raw response dump for diagnosing capture failures. Goes to stderr.
    console.error(`[graphSentLookup][raw] GET sentitems → status=${resp.status}`);
    console.error('[graphSentLookup][raw] body=', JSON.stringify(resp.data || {}, null, 2).slice(0, 4000));
  }
  return resp.data?.value || [];
}

/** Pick the candidate addressed to `toEmail` (case-insensitive). */
function matchByRecipient(candidates, toEmail) {
  if (!toEmail) return candidates[0] || null;
  const want = toEmail.toLowerCase();
  return (
    candidates.find((m) =>
      (m.toRecipients || []).some((r) => r.emailAddress?.address?.toLowerCase() === want)
    ) || null
  );
}

/**
 * Poll Sent Items until the just-sent message is found or attempts run out.
 *
 * @returns {Promise<{ message: object|null, attempts: number, lastError: string|null,
 *                     matchedBy: 'recipient'|'newest'|null }>}
 *
 * Timing: with the defaults (5 attempts, 500ms base, 3500ms cap) the worst
 * case adds ~500+1000+2000+3500 = ~7s of sleeps plus query time — kept
 * comfortably under the MCP client's 15s request timeout. A hit on the
 * first or second attempt returns in well under 2s, matching the original
 * happy-path latency.
 *
 * `fallbackToNewest` (2026-07-23): when a recipient is supplied we require an EXACT recipient
 * match, because two same-subject sends can be in flight at once — that is what caused apex to
 * hand one internetMessageId to two prospects (see bridgeMailer's reply path). But the reply path
 * also has to detect a MISDIRECTED send, one that Graph delivered to the mailbox owner instead of
 * the prospect, and such a message can never match the intended recipient. So with this flag set
 * we keep polling for an exact match and, only if none ever appears, return the newest
 * same-subject candidate tagged `matchedBy: 'newest'` so the caller can run its misdirection
 * check. Never treat a 'newest' result as a confirmed capture without checking `matchedBy`.
 */
async function pollSentMessage({
  accessToken,
  toEmail,
  subject,
  sinceIso,
  http = axiosDefault,
  sleep = defaultSleep,
  attempts = 5,
  baseDelayMs = 500,
  maxDelayMs = 3500,
  fallbackToNewest = false,
  debug = false,
}) {
  const since = sinceIso || new Date(Date.now() - 5 * 60 * 1000).toISOString();
  let lastError = null;
  let newest = null;   // most recent same-subject candidate seen, for the fallback
  for (let i = 0; i < attempts; i++) {
    if (i > 0) {
      const delay = Math.min(baseDelayMs * 2 ** (i - 1), maxDelayMs);
      await sleep(delay);
    }
    try {
      const candidates = await querySentItems({ accessToken, sinceIso: since, subject, http, debug });
      const match = matchByRecipient(candidates, toEmail);
      if (match) return { message: match, attempts: i + 1, lastError: null, matchedBy: 'recipient' };
      if (fallbackToNewest && !newest && candidates.length) newest = candidates[0];
      if (debug) console.error(`[graphSentLookup] attempt ${i + 1}/${attempts}: not indexed yet`);
    } catch (err) {
      lastError = err.message;
      if (debug) console.error(`[graphSentLookup] attempt ${i + 1}/${attempts} query failed: ${err.message}`);
    }
  }
  if (fallbackToNewest && newest) {
    if (debug) console.error('[graphSentLookup] no recipient match; returning newest same-subject candidate for the misdirection check');
    return { message: newest, attempts, lastError, matchedBy: 'newest' };
  }
  return { message: null, attempts, lastError, matchedBy: null };
}

/**
 * Backfill / recovery: given a sender mailbox access token and a list of
 * already-sent messages described loosely ({ recipient, subject,
 * approxSendTime }), look each one up in Sent Items and return its ids.
 *
 * These are historical sends that are already indexed, so no backoff is
 * needed — a single query per item, bounded to a time window around the
 * approximate send time to avoid colliding with newer same-subject sends.
 *
 * @returns {Promise<Array<{ recipient, subject, approxSendTime, found,
 *   messageId, internetMessageId, conversationId, sentDateTime, error }>>}
 */
async function recoverSentMessageIds({ accessToken, items, http = axiosDefault, windowMinutes = 30, debug = false }) {
  const results = [];
  for (const item of items || []) {
    const { recipient, subject, approxSendTime } = item || {};
    const center = approxSendTime ? new Date(approxSendTime) : new Date();
    const sinceIso = new Date(center.getTime() - windowMinutes * 60_000).toISOString();
    const untilIso = new Date(center.getTime() + windowMinutes * 60_000).toISOString();
    let match = null;
    let error = null;
    try {
      const candidates = await querySentItems({ accessToken, sinceIso, untilIso, subject, top: 25, http, debug });
      match = matchByRecipient(candidates, recipient);
    } catch (err) {
      error = err.response?.data?.error?.message || err.message;
    }
    results.push({
      recipient: recipient || null,
      subject: subject || null,
      approxSendTime: approxSendTime || null,
      found: !!match,
      messageId: match?.id || null,
      internetMessageId: match?.internetMessageId || null,
      conversationId: match?.conversationId || null,
      sentDateTime: match?.sentDateTime || null,
      error,
    });
  }
  return results;
}

module.exports = {
  GRAPH,
  querySentItems,
  matchByRecipient,
  pollSentMessage,
  recoverSentMessageIds,
};
