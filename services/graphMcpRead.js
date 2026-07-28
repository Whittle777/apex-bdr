/**
 * graphMcpRead.js — READ-ONLY Microsoft Graph helpers for the two MCP read
 * endpoints (GET /api/mcp/list-sent, GET /api/mcp/list-inbox). Consumed by the
 * headless workbook automation via outlook_client.py.
 *
 * These functions ONLY read (Mail.Read); they never send or mutate anything.
 * Token comes from the caller (services/sequenceMailer.getMicrosoftAccessToken,
 * which is Mail.Send + Mail.Read scoped). Shapes match APEX_READ_ENDPOINTS_SPEC.md.
 */
const axios = require('axios');

const GRAPH = 'https://graph.microsoft.com/v1.0';
const PAGE_SIZE = 100;
const MAX_PAGES = 25; // hard ceiling: 2500 items — bounds paging so a huge window can't loop forever

function isInternal(addr) {
  return String(addr || '').trim().toLowerCase().endsWith('@c3.ai');
}

/** Follow @odata.nextLink pages (up to MAX_PAGES), accumulating `.value`. */
async function pagedGet(firstUrl, headers) {
  const items = [];
  let url = firstUrl;
  for (let page = 0; page < MAX_PAGES && url; page++) {
    const resp = await axios.get(url, { headers, timeout: 20000 });
    const val = resp.data?.value || [];
    items.push(...val);
    url = resp.data?.['@odata.nextLink'] || null;
  }
  return items;
}

/**
 * Henry's Sent Items for the last `days` calendar days (default 4, cap 14).
 * One object per message that has a real internet Message-ID AND at least one
 * external (non-@c3.ai) recipient. Reconcile feed → build_sent_map().
 */
async function listSentItems({ accessToken, days = 4 }) {
  const d = Math.min(Math.max(parseInt(days, 10) || 4, 1), 14);
  const sinceIso = new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();
  const filter = encodeURIComponent(`sentDateTime ge ${sinceIso}`);
  const url =
    `${GRAPH}/me/mailFolders/sentitems/messages` +
    `?$top=${PAGE_SIZE}&$orderby=sentDateTime desc` +
    `&$select=internetMessageId,conversationId,subject,sentDateTime,toRecipients` +
    `&$filter=${filter}`;
  const raw = await pagedGet(url, { Authorization: `Bearer ${accessToken}` });

  const items = [];
  for (const m of raw) {
    if (!m.internetMessageId) continue; // Message-ID is REQUIRED — omit otherwise
    const ext = (m.toRecipients || [])
      .map((r) => (r.emailAddress?.address || '').toLowerCase())
      .find((a) => a && !isInternal(a));
    if (!ext) continue; // all-@c3.ai internal/calendar noise — skip
    items.push({
      recipient: ext,
      internetMessageId: m.internetMessageId,
      conversationId: m.conversationId || '',
      subject: m.subject || '',
      sentDate: String(m.sentDateTime || '').slice(0, 10),
    });
  }
  return items;
}

/**
 * Henry's Inbox for the last `hours` hours (default 26, cap 168). One object per
 * message. `body` is the FULL plain-text body (Prefer: text) — the NDR/bounce
 * classifier scans it for the failed prospect address, so a preview won't do.
 */
async function listInboxItems({ accessToken, hours = 26, folder = 'inbox' }) {
  const h = Math.min(Math.max(parseInt(hours, 10) || 26, 1), 168);
  // Allowlist the well-known mail folders we read. Junk is where Microsoft/
  // postmaster NDR (bounce) reports frequently land, so the bounce classifier
  // must be able to scan it — not just the Inbox.
  const FOLDERS = { inbox: 'inbox', junkemail: 'junkemail', junk: 'junkemail',
                    deleteditems: 'deleteditems', deleted: 'deleteditems', archive: 'archive' };
  const key = String(folder || 'inbox').toLowerCase();
  const sinceIso = new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
  const filter = encodeURIComponent(`receivedDateTime ge ${sinceIso}`);
  // folder=all reads the mailbox-wide /me/messages collection, which spans EVERY
  // folder including custom folders an inbox rule may have filed NDRs into (the
  // named-folder reads miss those). Otherwise read the one well-known folder.
  const base = key === 'all'
    ? `${GRAPH}/me/messages`
    : `${GRAPH}/me/mailFolders/${FOLDERS[key] || 'inbox'}/messages`;
  const url =
    `${base}` +
    `?$top=${PAGE_SIZE}&$orderby=receivedDateTime desc` +
    `&$select=subject,body,from,receivedDateTime,internetMessageId,webLink` +
    `&$filter=${filter}`;
  // Prefer plain text so `body.content` is text, not HTML.
  const raw = await pagedGet(url, {
    Authorization: `Bearer ${accessToken}`,
    Prefer: 'outlook.body-content-type="text"',
  });

  return raw.map((m) => ({
    sender: (m.from?.emailAddress?.address || '').toLowerCase(),
    subject: m.subject || '',
    body: m.body?.content || '',
    receivedDateTime: m.receivedDateTime || '',
    internetMessageId: m.internetMessageId || '',
    webLink: m.webLink || '',
  }));
}

module.exports = { listSentItems, listInboxItems };
