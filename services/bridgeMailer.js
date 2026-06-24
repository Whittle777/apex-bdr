/**
 * bridgeMailer — the shared Microsoft Graph send/reply core for the MCP
 * bridge. Extracted from routes/mcpBridge.js so that BOTH the synchronous
 * route handlers (send_email / reply_to_email) AND the paced send-queue
 * worker (services/sendQueueWorker.js) use one implementation. This keeps
 * the messageId poll-with-backoff fix (services/graphSentLookup.js) in a
 * single place.
 *
 * These functions are credential-agnostic: callers resolve the Microsoft
 * credential + access token themselves (routes use req.mcpUser/from; the
 * worker uses the queue row's userId) and pass `accessToken` in. This
 * module only talks to Graph.
 *
 * Hard failures throw a GraphError carrying { httpStatus, code } so callers
 * can map to an HTTP status or a queue failure. A successful send that
 * merely fails the id read-back does NOT throw — it returns captured:false
 * plus a warning, mirroring the existing route behavior.
 */
const axios = require('axios');
const { linkify } = require('./sequenceMailer');
const { pollSentMessage } = require('./graphSentLookup');

const GRAPH = 'https://graph.microsoft.com/v1.0';
const HTML_TAG = /<(p|div|br|ul|ol|li|strong|b|em|i|u|a|span|h[1-6])\b/i;

const GRAPH_DEBUG = process.env.MCP_DEBUG_GRAPH === '1';
function dumpGraph(label, status, headers, body) {
  if (!GRAPH_DEBUG) return;
  console.error(`[bridgeMailer][raw] ${label} → status=${status ?? '?'}`);
  if (headers) console.error(`[bridgeMailer][raw] ${label} headers=`, JSON.stringify(headers));
  console.error(`[bridgeMailer][raw] ${label} body=`, JSON.stringify(body ?? null, null, 2)?.slice(0, 4000));
}

class GraphError extends Error {
  constructor(message, { httpStatus = 502, code = 'graph_error' } = {}) {
    super(message);
    this.name = 'GraphError';
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

/**
 * Linkify markdown / bare URLs, then ensure HTML. Plain-text bodies get
 * \n → <br/>; bodies that already contain block/inline HTML pass through.
 * Same heuristic the sequence mailer and the original route used.
 */
function buildHtmlBody(body) {
  const linked = linkify(body);
  return HTML_TAG.test(linked) ? linked : linked.replace(/\n/g, '<br/>');
}

/**
 * Send a brand-new email via POST /me/sendMail, then poll Sent Items to
 * recover the Graph messageId / internetMessageId / conversationId.
 * Returns { messageId, internetMessageId, conversationId, captured,
 * lookupError, elapsedMs }. Throws GraphError if the send itself fails.
 */
async function sendEmailViaGraph({ accessToken, to, subject, body, cc, bcc, debug = GRAPH_DEBUG }) {
  const startedAt = Date.now();
  const htmlBody = buildHtmlBody(body);
  const message = {
    subject,
    body: { contentType: 'HTML', content: htmlBody },
    toRecipients: [{ emailAddress: { address: to } }],
    ...(cc ? { ccRecipients: [{ emailAddress: { address: cc } }] } : {}),
    ...(bcc ? { bccRecipients: [{ emailAddress: { address: bcc } }] } : {}),
  };

  // Lookup window opens just before the send so the poll's
  // `sentDateTime ge sinceIso` filter can't exclude this message.
  const sinceIso = new Date(Date.now() - 60 * 1000).toISOString();

  try {
    const resp = await axios.post(
      `${GRAPH}/me/sendMail`,
      { message, saveToSentItems: true },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    // 202 Accepted, empty body — no id here; that's why we poll below.
    dumpGraph('POST /me/sendMail', resp.status, resp.headers, resp.data);
  } catch (err) {
    const status = err.response?.status;
    const graphErr = err.response?.data?.error;
    const detail = graphErr?.message || graphErr?.code || err.message;
    dumpGraph('POST /me/sendMail (error)', status, err.response?.headers, err.response?.data);
    throw new GraphError(`Microsoft Graph rejected the send (status ${status || '?'}): ${detail}`, { httpStatus: 502 });
  }

  let found = null;
  let lookupError = null;
  try {
    const r = await pollSentMessage({ accessToken, toEmail: to, subject, sinceIso, debug });
    found = r.message;
    lookupError = r.lastError;
    if (debug) console.error(`[bridgeMailer] send poll: ${found ? 'hit' : 'miss'} after ${r.attempts} attempt(s)`);
  } catch (err) {
    lookupError = err.message;
  }

  return {
    messageId: found?.id || null,
    internetMessageId: found?.internetMessageId || null,
    conversationId: found?.conversationId || null,
    captured: !!found?.id,
    lookupError,
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * Resolve an inbound id to a Graph message ID. Accepts a Graph resource ID
 * (returned as-is after a confirming GET) or an RFC 5322 internetMessageId
 * (contains "@"; looked up via $filter). Returns null if not found.
 */
async function resolveGraphMessageId(accessToken, inReplyTo) {
  if (!inReplyTo) return null;
  if (inReplyTo.includes('@')) {
    const esc = inReplyTo.replace(/'/g, "''");
    const res = await axios.get(
      `${GRAPH}/me/messages?$top=1&$select=id&$filter=internetMessageId eq '${esc}'`,
      { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 10000 }
    );
    return res.data?.value?.[0]?.id || null;
  }
  try {
    const res = await axios.get(
      `${GRAPH}/me/messages/${encodeURIComponent(inReplyTo)}?$select=id`,
      { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 10000 }
    );
    return res.data?.id || null;
  } catch {
    return null;
  }
}

const normAddr = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '');
const addressesOf = (recipients) =>
  (recipients || []).map((r) => normAddr(r?.emailAddress?.address)).filter(Boolean);

/**
 * Send a threaded reply via /me/messages/{id}/reply, addressed to the CALLER'S
 * explicit recipient (the prospect) — NOT the parent message's sender.
 *
 * Why this matters (2026-06-17 production bug): Graph's reply action
 * auto-populates recipients from the original message. When the parent is one
 * the mailbox SENT (e.g. sequence step 1, sent by us to the prospect), that
 * "original recipient" logic resolves to the mailbox owner, so every reply
 * (step 2/4) looped back to us instead of the prospect. The fix: pass an
 * explicit `toRecipients` in the reply `message` body to OVERRIDE the
 * auto-fill. We stay on /reply (not createReply+patch+send) because the IT-
 * approved scope is Mail.Send + Mail.Read only — no Mail.ReadWrite for drafts.
 *
 * Guards: refuse to send if the resolved recipient is empty or is the sending
 * mailbox (loud loop-guard, pre-send), and verify the actually-sent recipient
 * post-send so a misfire can never again be silent.
 *
 * Throws GraphError (with httpStatus) on resolve-miss / loop-guard / send failure.
 */
async function sendReplyViaGraph({
  accessToken, to, inReplyToMessageId, body, cc, bcc,
  replyAll = false, includeOriginalBody = true, selfEmail, debug = GRAPH_DEBUG,
}) {
  const startedAt = Date.now();

  let graphMessageId;
  try {
    graphMessageId = await resolveGraphMessageId(accessToken, inReplyToMessageId);
  } catch (err) {
    throw new GraphError(`Failed to resolve inReplyToMessageId: ${err.message}`, { httpStatus: 502 });
  }
  if (!graphMessageId) {
    throw new GraphError(
      `Could not find a message matching "${inReplyToMessageId}" in this mailbox. Pass the Graph message ID returned by send_email, or the original's internetMessageId.`,
      { httpStatus: 404, code: 'not_found' }
    );
  }

  // Fetch the parent: needed for the quoted original, the "Re:" subject,
  // conversationId, and (for the no-explicit-`to` fallback / replyAll) its
  // recipient list. Always read it — recipient resolution depends on it.
  let original = {};
  try {
    const orig = await axios.get(
      `${GRAPH}/me/messages/${encodeURIComponent(graphMessageId)}?$select=subject,from,toRecipients,ccRecipients,sentDateTime,conversationId,internetMessageId,body`,
      { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 10000 }
    );
    original = orig.data || {};
  } catch (err) {
    throw new GraphError(`Failed to read the parent message for the reply: ${err.message}`, { httpStatus: 502 });
  }
  const originalSubject = original.subject || null;
  const originalConversationId = original.conversationId || null;

  // ── Resolve the recipient — the crux of the fix ────────────────────────────
  // NEVER derive the recipient from the parent's SENDER. Use the caller's
  // explicit `to`; only if absent, fall back to the parent's To line minus the
  // mailbox owner (never the sender).
  const selfSet = new Set([normAddr(selfEmail), normAddr(original.from?.emailAddress?.address)].filter(Boolean));
  const explicitTo = normAddr(to);
  let toAddrs = explicitTo
    ? [explicitTo]
    : addressesOf(original.toRecipients).filter((a) => !selfSet.has(a));
  toAddrs = [...new Set(toAddrs)].filter(Boolean);

  // Loud loop-guard: a reply with no external recipient — or one addressed only
  // to the sending mailbox — must NOT send. (This is the 2026-06-17 failure mode.)
  if (toAddrs.length === 0 || toAddrs.every((a) => selfSet.has(a))) {
    throw new GraphError(
      'Reply would loop back to the sending mailbox (no external recipient resolved). Pass an explicit prospect "to".',
      { httpStatus: 422, code: 'reply_loop_guard' }
    );
  }

  // cc: caller cc + (replyAll → parent To/Cc minus self minus our recipients).
  const ccSet = new Set(cc ? [normAddr(cc)] : []);
  if (replyAll) {
    for (const a of [...addressesOf(original.toRecipients), ...addressesOf(original.ccRecipients)]) {
      if (a && !selfSet.has(a) && !toAddrs.includes(a)) ccSet.add(a);
    }
  }
  const ccAddrs = [...ccSet].filter((a) => !toAddrs.includes(a));
  const bccAddrs = bcc ? [normAddr(bcc)] : [];

  // Manually quote the original (Graph's /reply with a body override does not
  // auto-append it).
  let originalQuoteHtml = '';
  if (includeOriginalBody) {
    try {
      const m = original;
      const senderName = m.from?.emailAddress?.name || m.from?.emailAddress?.address || 'sender';
      const senderEmail = m.from?.emailAddress?.address || '';
      const sentAt = m.sentDateTime ? new Date(m.sentDateTime).toLocaleString() : '';
      const origBodyHtml = m.body?.contentType?.toLowerCase() === 'html'
        ? (m.body?.content || '')
        : `<pre style="font-family: inherit; white-space: pre-wrap;">${(m.body?.content || '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</pre>`;
      originalQuoteHtml =
        `<br><br><div style="border-left: 2px solid #ccc; padding-left: 12px; color: #666;">` +
        `<div style="font-size: 0.85em; margin-bottom: 6px;">On ${sentAt}, ${senderName}${senderEmail ? ` &lt;${senderEmail}&gt;` : ''} wrote:</div>` +
        origBodyHtml + `</div>`;
    } catch (err) {
      console.warn(`[bridgeMailer] couldn't build quoted original: ${err.message}`);
    }
  }

  const finalBodyHtml = buildHtmlBody(body) + originalQuoteHtml;
  // The explicit toRecipients OVERRIDES Graph's sender-derived auto-fill. This
  // is the line that fixes the misdirected-reply bug.
  const message = {
    toRecipients: toAddrs.map((a) => ({ emailAddress: { address: a } })),
    ...(ccAddrs.length ? { ccRecipients: ccAddrs.map((a) => ({ emailAddress: { address: a } })) } : {}),
    ...(bccAddrs.length ? { bccRecipients: bccAddrs.map((a) => ({ emailAddress: { address: a } })) } : {}),
    body: { contentType: 'HTML', content: finalBodyHtml },
  };
  // Always /reply (single) — we set recipients explicitly, so /replyAll's
  // auto-expansion (which could re-introduce self) is neither needed nor wanted.
  const endpoint = `${GRAPH}/me/messages/${encodeURIComponent(graphMessageId)}/reply`;
  const sinceIso = new Date(Date.now() - 60 * 1000).toISOString();

  try {
    const resp = await axios.post(endpoint, { message }, {
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, timeout: 15000,
    });
    dumpGraph('POST reply', resp.status, resp.headers, resp.data);
  } catch (err) {
    const status = err.response?.status;
    const graphErr = err.response?.data?.error;
    const detail = graphErr?.message || graphErr?.code || err.message;
    dumpGraph('POST reply (error)', status, err.response?.headers, err.response?.data);
    throw new GraphError(`Microsoft Graph rejected the reply (status ${status || '?'}): ${detail}`, { httpStatus: 502 });
  }

  // Poll Sent Items by subject; the most-recent same-subject reply is ours.
  // We also read its toRecipients to VERIFY it went to the prospect, not us.
  let found = null;
  let lookupError = null;
  const replySubject = originalSubject
    ? (originalSubject.toLowerCase().startsWith('re:') ? originalSubject : `Re: ${originalSubject}`)
    : null;
  if (replySubject) {
    try {
      const r = await pollSentMessage({ accessToken, toEmail: undefined, subject: replySubject, sinceIso, debug });
      found = r.message;
      lookupError = r.lastError;
      if (debug) console.error(`[bridgeMailer] reply poll: ${found ? 'hit' : 'miss'} after ${r.attempts} attempt(s)`);
    } catch (err) {
      lookupError = err.message;
    }
  }

  // Post-send verification: if the message we just sent landed at the mailbox
  // owner (Graph ignored the override), surface it LOUDLY instead of silently
  // reporting success — callers treat misdirected as a terminal failure.
  const sentToAddrs = found ? addressesOf(found.toRecipients) : [];
  const misdirected = sentToAddrs.length > 0 && sentToAddrs.every((a) => selfSet.has(a));
  if (misdirected) {
    console.error(`[bridgeMailer] REPLY MISDIRECTED — sent to ${sentToAddrs.join(', ')} (the sending mailbox), not the intended ${toAddrs.join(', ')}. Graph did not honor the recipient override.`);
  }

  return {
    graphMessageId,
    messageId: found?.id || null,
    internetMessageId: found?.internetMessageId || null,
    // conversationId is reliable even on a poll miss — the reply inherits the
    // original's conversation, which we fetched above.
    conversationId: found?.conversationId || originalConversationId || null,
    to: toAddrs[0],
    misdirected,
    includedOriginalBody: !!includeOriginalBody && !!originalQuoteHtml,
    captured: !!found?.id,
    lookupError,
    elapsedMs: Date.now() - startedAt,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Read-only Graph helpers — power the bridge's list-sent / list-inbox
// endpoints (headless reconcile + reply scan). Scope: Mail.Read. These never
// send or mutate; they only page GET /me/mailFolders/{folder}/messages.
// ──────────────────────────────────────────────────────────────────────

// Sent Items can be high-volume (this mailbox sends 200–750/day), so the
// date-bounded window must page in FULL — a fixed row ceiling would silently
// drop the oldest sends and make reconcile miss them. We page until
// @odata.nextLink is exhausted, with a high safety ceiling (page size × maxPages)
// and a `truncated` flag if that ceiling is ever hit. Inbox is low-volume.
const SENT_PAGE_SIZE = 500;   // Graph allows up to 1000 for messages
const SENT_MAX_PAGES = 40;    // ceiling ≈ 20,000 rows (14d × ~750/day ≈ 10.5k)
const INBOX_PAGE_SIZE = 50;
const INBOX_MAX_PAGES = 10;   // ceiling ≈ 500 rows — ample for a 26h inbox window

/**
 * GET a Graph collection, following @odata.nextLink up to maxPages. nextLink is
 * an absolute URL, so we re-attach only the Authorization (and any Prefer)
 * header on each hop. Returns { value, truncated } — truncated is true iff we
 * stopped because we hit maxPages while Graph still had a next page (the caller
 * must NOT treat a truncated set as complete). Throws GraphError on any non-2xx.
 */
async function graphGetAll({ accessToken, url, headers = {}, maxPages }) {
  const out = [];
  let next = url;
  let pages = 0;
  let truncated = false;
  while (next) {
    if (pages >= maxPages) { truncated = true; break; }
    try {
      const resp = await axios.get(next, {
        headers: { Authorization: `Bearer ${accessToken}`, ...headers },
        timeout: 20000,
      });
      if (Array.isArray(resp.data?.value)) out.push(...resp.data.value);
      next = resp.data?.['@odata.nextLink'] || null;
    } catch (err) {
      const status = err.response?.status;
      const graphErr = err.response?.data?.error;
      const detail = graphErr?.message || graphErr?.code || err.message;
      dumpGraph('GET (read) error', status, err.response?.headers, err.response?.data);
      throw new GraphError(`Microsoft Graph read failed (status ${status || '?'}): ${detail}`, {
        httpStatus: status === 403 ? 403 : 502,
      });
    }
    pages += 1;
  }
  return { value: out, truncated };
}

/**
 * List Sent Items sent at/after sinceIso, paging the full date-bounded window.
 * Selects only the fields the reconcile feed needs (recipient + Message-ID +
 * date + conversation). Newest first. Returns { value, truncated }.
 */
async function listSentMessages({ accessToken, sinceIso, maxPages = SENT_MAX_PAGES }) {
  const select = 'internetMessageId,conversationId,subject,sentDateTime,toRecipients';
  const url =
    `${GRAPH}/me/mailFolders/sentitems/messages` +
    `?$filter=${encodeURIComponent(`sentDateTime ge ${sinceIso}`)}` +
    `&$orderby=${encodeURIComponent('sentDateTime desc')}` +
    `&$top=${SENT_PAGE_SIZE}&$select=${select}`;
  return graphGetAll({ accessToken, url, maxPages });
}

/**
 * List Inbox messages received at/after sinceIso. The `Prefer:
 * outlook.body-content-type="text"` header makes body.content the FULL
 * plain-text body (not HTML, not a preview) — the negative-path classifier
 * scans it for the failed prospect address inside NDRs. Returns { value, truncated }.
 */
async function listInboxMessages({ accessToken, sinceIso, maxPages = INBOX_MAX_PAGES }) {
  const select = 'id,from,subject,body,bodyPreview,receivedDateTime,internetMessageId,webLink';
  const url =
    `${GRAPH}/me/mailFolders/inbox/messages` +
    `?$filter=${encodeURIComponent(`receivedDateTime ge ${sinceIso}`)}` +
    `&$orderby=${encodeURIComponent('receivedDateTime desc')}` +
    `&$top=${INBOX_PAGE_SIZE}&$select=${select}`;
  return graphGetAll({
    accessToken,
    url,
    headers: { Prefer: 'outlook.body-content-type="text"' },
    maxPages,
  });
}

/**
 * Best-effort: pull the original failed-recipient address out of an NDR/bounce
 * body using the standard DSN headers (RFC 3464). Returns a lowercased address
 * or null. Exact when present — makes bounce resolution unambiguous instead of
 * fuzzy body-scanning. Conservative: only matches the canonical DSN markers.
 */
function extractFailedRecipient(text) {
  if (typeof text !== 'string' || !text) return null;
  const patterns = [
    /Final-Recipient:\s*rfc822;\s*([^\s<>;,]+@[^\s<>;,]+)/i,
    /Original-Recipient:\s*rfc822;\s*([^\s<>;,]+@[^\s<>;,]+)/i,
    /X-Failed-Recipients:\s*([^\s<>;,]+@[^\s<>;,]+)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[1].trim().toLowerCase();
  }
  return null;
}

/**
 * Looser failed-recipient extraction for text we ALREADY know is an NDR (the
 * decoded attachment / delivery report). Catches provider phrasings that lack
 * the formal DSN headers — chiefly Google's "wasn't delivered to <addr>". NOT
 * safe to run on arbitrary mail (would false-positive on ordinary prose), so it
 * is only ever applied to confirmed-NDR attachment text.
 */
function extractFailedRecipientLoose(ndrText) {
  if (typeof ndrText !== 'string' || !ndrText) return null;
  const patterns = [
    /(?:wasn't|was not|couldn't be|could not be|hasn't been) delivered to\s*\**\s*<?([^\s<>;,]+@[^\s<>;,]+)>?/i,
    /message to\s+<?([^\s<>;,]+@[^\s<>;,]+)>?\s+(?:couldn't|could not|wasn't|was not)/i,
    /^To:\s*.*?<?([^\s<>;,]+@[^\s<>;,]+)>?\s*$/im, // original recipient in the bounced rfc822 headers
  ];
  for (const re of patterns) {
    const m = ndrText.match(re);
    if (m) return m[1].trim().toLowerCase();
  }
  return null;
}

// Is this inbound message a bounce / non-delivery report? Used to gate the
// (more expensive) attachment fetch to only the messages that need it.
function looksLikeNdr({ sender, subject }) {
  const s = (sender || '').toLowerCase();
  const subj = (subject || '').toLowerCase();
  return (
    /mailer-daemon|postmaster|microsoftexchange329e71ec|mail delivery (subsystem|system)/.test(s) ||
    /delivery status notification|undeliverable|delivery (has )?failed|returned mail|mail delivery failed|address not found/.test(subj)
  );
}

/**
 * Pull the decoded text out of an NDR's attachments — the DSN report
 * (message/delivery-status, carrying Final-Recipient) and the bounced original
 * (message/rfc822, carrying the original To:). Google relays these as
 * fileAttachments (base64 contentBytes); Exchange may use an itemAttachment
 * (embedded message, fetched via $expand). Best-effort: any failure returns ''.
 */
async function fetchNdrText({ accessToken, messageId }) {
  const texts = [];
  try {
    const resp = await axios.get(
      `${GRAPH}/me/messages/${encodeURIComponent(messageId)}/attachments`,
      { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 15000 }
    );
    for (const a of resp.data?.value || []) {
      const type = (a['@odata.type'] || '').toLowerCase();
      if (type.includes('fileattachment') && a.contentBytes) {
        try { texts.push(Buffer.from(a.contentBytes, 'base64').toString('utf8')); } catch { /* skip */ }
      } else if (type.includes('itemattachment')) {
        try {
          const ir = await axios.get(
            `${GRAPH}/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(a.id)}?$expand=microsoft.graph.itemattachment/item`,
            { headers: { Authorization: `Bearer ${accessToken}`, Prefer: 'outlook.body-content-type="text"' }, timeout: 15000 }
          );
          const item = ir.data?.item;
          if (item) {
            const tos = (item.toRecipients || []).map((r) => r?.emailAddress?.address).filter(Boolean).join(', ');
            texts.push([item.subject, tos ? `To: ${tos}` : '', item.body?.content].filter(Boolean).join('\n'));
          }
        } catch { /* skip this attachment */ }
      }
    }
  } catch (err) {
    if (GRAPH_DEBUG) console.error(`[bridgeMailer] NDR attachment fetch failed for ${messageId}: ${err.message}`);
  }
  return texts.join('\n\n');
}

/**
 * Resolve the failed-recipient address for an inbound message. Tries the body
 * first (cheap — some NDRs inline the DSN); for messages that look like a bounce
 * but whose body lacks it (e.g. Google NDRs, where the body is just the EXTERNAL
 * banner and the real report is in attachments), fetches and parses the
 * attachments. Returns { failedRecipient, ndrText } — ndrText is the decoded
 * delivery report (empty unless attachments were read), so the caller can append
 * it to the body for the workbook's body-scan path too.
 */
async function resolveFailedRecipient({ accessToken, message }) {
  const sender = message.from?.emailAddress?.address || '';
  const subject = message.subject || '';
  const bodyText = message.body?.content || message.bodyPreview || '';

  const fromBody = extractFailedRecipient(bodyText);
  if (fromBody) return { failedRecipient: fromBody, ndrText: '' };
  if (!message.id || !looksLikeNdr({ sender, subject })) return { failedRecipient: null, ndrText: '' };

  const ndrText = await fetchNdrText({ accessToken, messageId: message.id });
  const failedRecipient = extractFailedRecipient(ndrText) || extractFailedRecipientLoose(ndrText);
  return { failedRecipient, ndrText };
}

module.exports = {
  GraphError,
  buildHtmlBody,
  resolveGraphMessageId,
  sendEmailViaGraph,
  sendReplyViaGraph,
  listSentMessages,
  listInboxMessages,
  extractFailedRecipient,
  resolveFailedRecipient,
};
