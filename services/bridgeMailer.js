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

/**
 * Send a true RFC 5322 threaded reply via /me/messages/{id}/reply(All),
 * optionally quoting the original, then poll Sent Items for the new ids.
 * Throws GraphError (with httpStatus) on resolve-miss / send failure.
 */
async function sendReplyViaGraph({
  accessToken, inReplyToMessageId, body, cc, bcc,
  replyAll = false, includeOriginalBody = true, debug = GRAPH_DEBUG,
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

  // Optionally fetch the original to manually quote it (Graph's /reply with
  // a message.body override does not auto-append the original).
  let originalQuoteHtml = '';
  let originalSubject = null;
  let originalConversationId = null;
  if (includeOriginalBody) {
    try {
      const orig = await axios.get(
        `${GRAPH}/me/messages/${encodeURIComponent(graphMessageId)}?$select=subject,from,sentDateTime,conversationId,body`,
        { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 10000 }
      );
      const m = orig.data || {};
      originalSubject = m.subject;
      originalConversationId = m.conversationId;
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
      console.warn(`[bridgeMailer] couldn't fetch original for quoting: ${err.message}`);
    }
  }

  const finalBodyHtml = buildHtmlBody(body) + originalQuoteHtml;
  const message = {
    body: { contentType: 'HTML', content: finalBodyHtml },
    ...(cc ? { ccRecipients: [{ emailAddress: { address: cc } }] } : {}),
    ...(bcc ? { bccRecipients: [{ emailAddress: { address: bcc } }] } : {}),
  };
  const endpoint = `${GRAPH}/me/messages/${encodeURIComponent(graphMessageId)}/${replyAll ? 'replyAll' : 'reply'}`;
  const sinceIso = new Date(Date.now() - 60 * 1000).toISOString();

  try {
    const resp = await axios.post(endpoint, { message }, {
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, timeout: 15000,
    });
    dumpGraph(`POST ${replyAll ? 'replyAll' : 'reply'}`, resp.status, resp.headers, resp.data);
  } catch (err) {
    const status = err.response?.status;
    const graphErr = err.response?.data?.error;
    const detail = graphErr?.message || graphErr?.code || err.message;
    dumpGraph(`POST ${replyAll ? 'replyAll' : 'reply'} (error)`, status, err.response?.headers, err.response?.data);
    throw new GraphError(`Microsoft Graph rejected the reply (status ${status || '?'}): ${detail}`, { httpStatus: 502 });
  }

  // Reply subject is "Re: <original>"; for replyAll the To line is unknown,
  // so match on subject only and take the most recent.
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

  return {
    graphMessageId,
    messageId: found?.id || null,
    internetMessageId: found?.internetMessageId || null,
    // conversationId is reliable even on a poll miss — the reply inherits
    // the original's conversation, which we fetched above.
    conversationId: found?.conversationId || originalConversationId || null,
    includedOriginalBody: !!includeOriginalBody && !!originalQuoteHtml,
    captured: !!found?.id,
    lookupError,
    elapsedMs: Date.now() - startedAt,
  };
}

module.exports = {
  GraphError,
  buildHtmlBody,
  resolveGraphMessageId,
  sendEmailViaGraph,
  sendReplyViaGraph,
};
