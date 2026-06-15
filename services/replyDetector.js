/**
 * replyDetector.js
 *
 * Polls inboxes for replies to sequence emails and classifies them:
 *   ooo           → OOO auto-reply — pause enrollment until return date
 *   genuine_reply → Real human reply — stop sequence, surface for SDR
 *   unsubscribe   → Opt-out request — opt out prospect entirely
 *   bounce        → Delivery failure — log, do not advance
 *   unknown       → Could not classify — log only
 *
 * Transport priority:
 *   1. Microsoft Graph API  (if 'microsoft' IntegrationCredential exists)
 *   2. Gmail IMAP           (if 'google' IntegrationCredential exists)
 *
 * Cron: runs every 10 minutes from index.js
 */

const axios = require('axios');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const {
  pauseForOoo,
  markReplied,
  optOutProspect,
} = require('./enrollmentService');

const prisma = require('./database');
// In-memory last-check timestamps (survives only for the process lifetime — fine for dev)
const lastCheckTimes = { microsoft: null, google: null };

// ─── OOO Detection Patterns ──────────────────────────────────────────────────

const OOO_SUBJECT_PATTERNS = [
  /out of office/i,
  /automatic\s+reply/i,
  /auto.?reply/i,
  /autoreply/i,
  /away from (the )?office/i,
  /on vacation/i,
  /on leave/i,
  /holiday\s+(auto|notice|message)/i,
  /vacation\s+(auto|notice|reply)/i,
  /i am (currently\s+)?away/i,
];

const OOO_BODY_PATTERNS = [
  /i (am|'m) (currently\s+)?(out of (the )?office|away|on vacation|on leave)/i,
  /will (return|be back|respond|reply) (on|after|from)/i,
  /i will be (out|away|unavailable|unreachable)/i,
  /thank you for (your )?(email|message)[.\s]+i (am|'m) (currently\s+)?(out|away)/i,
];

const UNSUBSCRIBE_PATTERNS = [
  /unsubscribe/i,
  /stop\s+(emailing|contacting|messaging)\s+me/i,
  /remove\s+me\s+from/i,
  /opt[\s-]?out/i,
  /do not\s+(contact|email|reach out)/i,
  /please\s+(remove|take me off)/i,
  /not\s+interested/i,
];

const BOUNCE_SUBJECT_PATTERNS = [
  /undeliverable/i,
  /delivery\s+(failure|failed|status\s+notification)/i,
  /mail\s+(delivery\s+failed|returned)/i,
  /failure\s+notice/i,
  /returned\s+mail/i,
];

// ─── Return Date Extraction ───────────────────────────────────────────────────

const MONTH_NAMES = [
  'january','february','march','april','may','june',
  'july','august','september','october','november','december',
  'jan','feb','mar','apr','jun','jul','aug','sep','oct','nov','dec',
];

/**
 * Try to extract the OOO return date from the email body.
 * Returns a Date or null if nothing parseable is found.
 */
function extractReturnDate(body) {
  if (!body) return null;

  const text = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

  // ISO-like: 2025-04-15 or 15/04/2025 or 04/15/2025
  const isoMatch = text.match(/\b(\d{4}[-\/]\d{2}[-\/]\d{2})\b/);
  if (isoMatch) {
    const d = new Date(isoMatch[1]);
    if (!isNaN(d)) return d;
  }

  const slashMatch = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
  if (slashMatch) {
    const [, a, b, y] = slashMatch;
    // Assume MM/DD/YYYY (US) — if month > 12, treat as DD/MM
    const month = parseInt(a) > 12 ? parseInt(b) - 1 : parseInt(a) - 1;
    const day = parseInt(a) > 12 ? parseInt(a) : parseInt(b);
    const year = y.length === 2 ? 2000 + parseInt(y) : parseInt(y);
    const d = new Date(year, month, day);
    if (!isNaN(d)) return d;
  }

  // Month-name patterns: "April 15", "15th April", "April 15th, 2025"
  const monthPattern = new RegExp(
    `(${MONTH_NAMES.join('|')})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s*(\\d{4})?` +
    `|(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_NAMES.join('|')}),?\\s*(\\d{4})?`,
    'i'
  );
  const monthMatch = text.match(monthPattern);
  if (monthMatch) {
    try {
      const raw = monthMatch[0].replace(/(\d+)(st|nd|rd|th)/i, '$1');
      const d = new Date(raw);
      if (!isNaN(d.getTime())) {
        // If no year was mentioned, use current or next year
        if (!monthMatch[3] && !monthMatch[6]) {
          const now = new Date();
          if (d < now) d.setFullYear(now.getFullYear() + 1);
          else d.setFullYear(now.getFullYear());
        }
        return d;
      }
    } catch (_) {}
  }

  return null;
}

// ─── Reply Classification ─────────────────────────────────────────────────────

/**
 * Classify an incoming email as ooo | genuine_reply | bounce | unsubscribe | unknown.
 * Returns { type, returnDate? }
 */
function classifyReply(subject, body) {
  const subj = subject || '';
  const text = body || '';

  // Bounce: check subject only (bounce headers are very standardised)
  if (BOUNCE_SUBJECT_PATTERNS.some(p => p.test(subj))) {
    return { type: 'bounce' };
  }

  // Unsubscribe: checked before OOO so explicit opt-outs are never silently paused
  if (UNSUBSCRIBE_PATTERNS.some(p => p.test(subj) || p.test(text))) {
    return { type: 'unsubscribe' };
  }

  // OOO: subject match is strong signal; body match is secondary
  const oooSubject = OOO_SUBJECT_PATTERNS.some(p => p.test(subj));
  const oooBody = OOO_BODY_PATTERNS.some(p => p.test(text));
  if (oooSubject || oooBody) {
    const returnDate = extractReturnDate(text);
    return { type: 'ooo', returnDate };
  }

  // Non-empty, non-automated message → genuine reply
  if (text.trim().length > 0) {
    return { type: 'genuine_reply' };
  }

  return { type: 'unknown' };
}

// ─── Reply Processing ─────────────────────────────────────────────────────────

/**
 * Handle a detected reply: log it to ReplyActivity and take the appropriate action.
 * emailActivity: the EmailActivity record that was replied to.
 */
async function processReply({ emailActivity, fromEmail, subject, body, receivedAt, externalMessageId }) {
  const { enrollmentId, prospectId, enrollment } = emailActivity;

  // Deduplication: skip if we've already processed this exact reply message
  if (externalMessageId) {
    const existing = await prisma.replyActivity.findFirst({
      where: { externalMessageId },
    });
    if (existing) return null;
  }

  const classification = classifyReply(subject, body);

  // Prospect-centric enforcement: verify the sender is the known prospect.
  // Bounces are exempt — they originate from mail servers, not the prospect.
  if (classification.type !== 'bounce') {
    const prospectEmail = (emailActivity.prospect?.email || '').toLowerCase();
    const senderEmail = (fromEmail || '').toLowerCase();
    if (prospectEmail && senderEmail && senderEmail !== prospectEmail) {
      console.log(
        `[Reply Detector] Dropping non-prospect message — sender ${fromEmail} ≠ prospect ${emailActivity.prospect.email}. ` +
        `(enrollment ${enrollmentId})`
      );
      return null;
    }
  }

  // Truncate for storage
  const bodySnippet = (body || '').replace(/<[^>]*>/g, ' ').trim().substring(0, 500);

  const replyActivity = await prisma.replyActivity.create({
    data: {
      prospectId,
      enrollmentId,
      sequenceId: enrollment.sequenceId,
      fromEmail: fromEmail || '',
      subject: (subject || '').substring(0, 255),
      bodySnippet,
      classification: classification.type,
      oooReturnDate: classification.returnDate || null,
      externalMessageId: externalMessageId || null,
      receivedAt,
      processedAt: new Date(),
    },
  });

  console.log(
    `[Reply Detector] ${classification.type.toUpperCase()} from ${fromEmail} ` +
    `(prospect ${prospectId}, enroll ${enrollmentId})`
  );

  // Take action
  try {
    if (classification.type === 'ooo') {
      await pauseForOoo(enrollment.sequenceId, prospectId, classification.returnDate || null);
      console.log(
        `[Reply Detector] Paused enrollment ${enrollmentId} for OOO. ` +
        `Resume: ${classification.returnDate ? classification.returnDate.toDateString() : '7-day default'}`
      );
    } else if (classification.type === 'genuine_reply') {
      await markReplied(enrollment.sequenceId, prospectId);
    } else if (classification.type === 'unsubscribe') {
      await optOutProspect(enrollment.sequenceId, prospectId);
    } else if (classification.type === 'bounce') {
      await prisma.sequenceEnrollment.update({
        where: { id: enrollmentId },
        data: { status: 'paused', pausedAt: new Date(), pausedReason: 'hard_bounce', nextStepDue: null },
      });
      await prisma.prospect.update({
        where: { id: prospectId },
        data: { status: 'Bounced' },
      });
      console.warn(`[Reply Detector] Hard bounce — paused enrollment ${enrollmentId}, flagged prospect ${prospectId}`);
    }
    // unknown: log only, no enrollment change
  } catch (err) {
    console.error(`[Reply Detector] Action failed for enrollment ${enrollmentId}:`, err.message);
  }

  return replyActivity;
}

// ─── Microsoft Graph Polling ──────────────────────────────────────────────────

// Single-tenant: scope the token endpoint to our Entra tenant via
// MICROSOFT_TENANT_ID (matches routes/microsoftOAuth.js); 'common' only as a
// local-dev fallback when the env var is unset.
const MS_TENANT = process.env.MICROSOFT_TENANT_ID || 'common';

async function refreshGraphToken(cred) {
  // App credential comes from env (single source of truth) — not from the DB
  // row, which no longer stores the secret. cred.clientId is the non-secret app
  // id; prefer env but fall back to the row for older data.
  const params = new URLSearchParams({
    client_id: process.env.MICROSOFT_CLIENT_ID || cred.clientId,
    client_secret: process.env.MICROSOFT_CLIENT_SECRET,
    refresh_token: cred.refreshToken,
    grant_type: 'refresh_token',
    scope: 'https://graph.microsoft.com/Mail.Read offline_access',
  });
  const res = await axios.post(
    `https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0/token`,
    params.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  // Persist new refresh token if rotated
  if (res.data.refresh_token && res.data.refresh_token !== cred.refreshToken) {
    await prisma.integrationCredential.update({
      where: { id: cred.id },
      data: { refreshToken: res.data.refresh_token },
    });
  }
  return res.data.access_token;
}

async function detectRepliesViaGraph(cred) {
  let accessToken;
  try {
    accessToken = await refreshGraphToken(cred);
  } catch (err) {
    console.error('[Reply Detector] Graph token refresh failed:', err.response?.data?.error_description || err.message);
    return;
  }

  const since = lastCheckTimes.microsoft
    ? lastCheckTimes.microsoft.toISOString()
    : new Date(Date.now() - 30 * 60 * 1000).toISOString(); // first run: 30 min lookback

  lastCheckTimes.microsoft = new Date();

  let messages = [];
  try {
    const filterParam = encodeURIComponent(`receivedDateTime ge ${since}`);
    const selectParam = 'id,subject,body,from,receivedDateTime,internetMessageId,internetMessageHeaders';
    const res = await axios.get(
      `https://graph.microsoft.com/v1.0/me/messages?$filter=${filterParam}&$select=${selectParam}&$top=50`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    messages = res.data.value || [];
  } catch (err) {
    if (err.response?.status === 403) {
      console.warn('[Reply Detector] Graph Mail.Read permission not granted — user needs to re-connect Microsoft integration with updated scopes.');
    } else {
      console.error('[Reply Detector] Graph inbox fetch failed:', err.response?.data || err.message);
    }
    return;
  }

  let processed = 0;
  for (const msg of messages) {
    // Extract In-Reply-To header
    const headers = msg.internetMessageHeaders || [];
    const inReplyToHeader = headers.find(h => h.name?.toLowerCase() === 'in-reply-to');
    const inReplyTo = inReplyToHeader?.value?.trim();
    if (!inReplyTo) continue;

    // Look up the original sent email
    const emailActivity = await prisma.emailActivity.findFirst({
      where: { externalMessageId: inReplyTo },
      include: {
        enrollment: { include: { sequence: true } },
        prospect: true,
      },
    });
    if (!emailActivity) continue;
    // Only process active or paused enrollments (don't re-process completed/replied)
    if (!['active', 'paused'].includes(emailActivity.enrollment.status)) continue;

    const body = msg.body?.content || '';
    const subject = msg.subject || '';
    const fromEmail = msg.from?.emailAddress?.address || '';
    const receivedAt = new Date(msg.receivedDateTime);
    const replyMessageId = msg.internetMessageId || null;

    await processReply({ emailActivity, fromEmail, subject, body, receivedAt, externalMessageId: replyMessageId });
    processed++;
  }

  if (processed > 0) {
    console.log(`[Reply Detector] Graph: processed ${processed} replies`);
  }
}

// ─── Gmail IMAP Polling ───────────────────────────────────────────────────────

async function detectRepliesViaIMAP(cred) {
  const since = lastCheckTimes.google
    ? lastCheckTimes.google
    : new Date(Date.now() - 30 * 60 * 1000);

  lastCheckTimes.google = new Date();

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: {
      user: cred.clientId,   // gmail address
      pass: cred.clientSecret, // app password
    },
    logger: false,
    tls: { rejectUnauthorized: false },
  });

  try {
    await client.connect();
  } catch (err) {
    console.error('[Reply Detector] IMAP connect failed:', err.message);
    return;
  }

  let processed = 0;
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uids = await client.search({ since });
      if (!uids || uids.length === 0) return;

      for await (const msg of client.fetch(uids, { source: true })) {
        let parsed;
        try {
          parsed = await simpleParser(msg.source);
        } catch (_) { continue; }

        const inReplyTo = (parsed.inReplyTo || '').trim();
        if (!inReplyTo) continue;

        const emailActivity = await prisma.emailActivity.findFirst({
          where: { externalMessageId: inReplyTo },
          include: {
            enrollment: { include: { sequence: true } },
            prospect: true,
          },
        });
        if (!emailActivity) continue;
        if (!['active', 'paused'].includes(emailActivity.enrollment.status)) continue;

        const fromEmail = parsed.from?.value?.[0]?.address || '';
        const subject = parsed.subject || '';
        const body = parsed.text || parsed.textAsHtml || '';
        const receivedAt = parsed.date || new Date();
        const replyMessageId = parsed.messageId || null;

        await processReply({ emailActivity, fromEmail, subject, body, receivedAt, externalMessageId: replyMessageId });
        processed++;
      }
    } finally {
      lock.release();
    }
  } catch (err) {
    console.error('[Reply Detector] IMAP fetch error:', err.message);
  } finally {
    try { await client.logout(); } catch (_) {}
  }

  if (processed > 0) {
    console.log(`[Reply Detector] IMAP: processed ${processed} replies`);
  }
}

// ─── OOO Auto-Resumer ─────────────────────────────────────────────────────────

/**
 * Resume any OOO-paused enrollments whose resumeAt date has passed.
 * Called by the same cron as reply detection.
 */
async function resumeOooEnrollments() {
  const due = await prisma.sequenceEnrollment.findMany({
    where: {
      status: 'paused',
      pausedReason: 'ooo',
      resumeAt: { lte: new Date() },
    },
    include: {
      sequence: { include: { steps: { orderBy: { order: 'asc' } } } },
    },
  });

  for (const enrollment of due) {
    const nextStep = enrollment.sequence.steps.find(s => s.order > enrollment.currentStepOrder);

    if (!nextStep) {
      // No more steps — mark complete
      await prisma.sequenceEnrollment.update({
        where: { id: enrollment.id },
        data: {
          status: 'completed',
          completedAt: new Date(),
          pausedAt: null,
          pausedReason: null,
          resumeAt: null,
          nextStepDue: null,
        },
      });
      console.log(`[OOO Resumer] Enrollment ${enrollment.id} completed (no more steps after OOO resume)`);
    } else {
      // Resume — next step is due immediately (same step retried due to currentStepOrder decrement in pauseForOoo)
      await prisma.sequenceEnrollment.update({
        where: { id: enrollment.id },
        data: {
          status: 'active',
          pausedAt: null,
          pausedReason: null,
          resumeAt: null,
          nextStepDue: new Date(),
        },
      });
      console.log(`[OOO Resumer] Resumed enrollment ${enrollment.id} — step ${nextStep.order} now due`);
    }
  }

  return due.length;
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

/**
 * Detect replies + resume OOO enrollments.
 * Called by cron every 10 minutes.
 */
async function runReplyDetection() {
  // Resume any OOO enrollments whose return date has arrived
  const resumed = await resumeOooEnrollments();
  if (resumed > 0) {
    console.log(`[OOO Resumer] Resumed ${resumed} OOO-paused enrollments`);
  }

  // Detect new replies
  const [microsoftCred, googleCred] = await Promise.all([
    prisma.integrationCredential.findFirst({ where: { provider: 'microsoft' } }),
    prisma.integrationCredential.findFirst({ where: { provider: 'google' } }),
  ]);

  if (microsoftCred?.refreshToken) {
    await detectRepliesViaGraph(microsoftCred);
  } else if (googleCred?.clientId && googleCred?.clientSecret) {
    await detectRepliesViaIMAP(googleCred);
  }
  // If neither integration is configured, silently skip
}

module.exports = {
  runReplyDetection,
  resumeOooEnrollments,
  classifyReply,
  extractReturnDate,
};
