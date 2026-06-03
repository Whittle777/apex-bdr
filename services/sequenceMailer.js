/**
 * sequenceMailer.js
 *
 * Lightweight email sender for sequence steps.
 * Uses SMTP (Gmail App Password or any SMTP provider) — no Kafka/SQS required.
 *
 * Gmail setup (one-time):
 *   1. Enable 2FA on your Google account
 *   2. Go to myaccount.google.com/apppasswords
 *   3. Generate an App Password for "Mail"
 *   4. Set in .env:
 *        SMTP_HOST=smtp.gmail.com
 *        SMTP_PORT=587
 *        SMTP_SECURE=false
 *        SMTP_USER=you@gmail.com
 *        SMTP_PASS=xxxx xxxx xxxx xxxx   (16-char app password)
 *        EMAIL_FROM_NAME="Henry from Apex"
 */

const nodemailer = require('nodemailer');
const axios = require('axios');
const crypto = require('crypto');
const { getDueEnrollments, recordStepSent } = require('./enrollmentService');
const { personalize } = require('./emailPersonalizer');
const hitlRouter = require('../routes/hitl');

const prisma = require('./database');
/**
 * Get a fresh Microsoft Graph access token for a user.
 * Uses the stored refresh token + shared Azure app credentials from env vars.
 */
async function getMicrosoftAccessToken(userId) {
  const cred = await prisma.integrationCredential.findUnique({
    where: { provider_userId: { provider: 'microsoft', userId } },
  });
  if (!cred?.refreshToken) {
    throw new Error(`User ${userId} has no Microsoft credential — they must sign in again.`);
  }
  const params = new URLSearchParams({
    client_id:     process.env.MICROSOFT_CLIENT_ID,
    client_secret: process.env.MICROSOFT_CLIENT_SECRET,
    refresh_token: cred.refreshToken,
    grant_type:    'refresh_token',
    // Mail.Read is required to read back the Outlook-generated Message-ID
    // from Sent Items after each send (for reply tracking).
    scope:         'https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.Read offline_access',
  });
  const res = await axios.post(
    'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    params.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  // Persist the new refresh token if Microsoft rotated it
  if (res.data.refresh_token && res.data.refresh_token !== cred.refreshToken) {
    await prisma.integrationCredential.update({
      where: { provider_userId: { provider: 'microsoft', userId } },
      data: { refreshToken: res.data.refresh_token },
    });
  }
  return { accessToken: res.data.access_token, fromEmail: cred.email };
}

/**
 * Send an email via Microsoft Graph API (POST /me/sendMail).
 * Returns a generated Message-ID for reply tracking.
 */
async function sendViaGraph(accessToken, fromEmail, toEmail, subject, htmlBody) {
  // NOTE: Microsoft Graph requires custom internetMessageHeaders names to
  // start with "x-". Standard headers like Message-ID and List-Unsubscribe
  // cause a 400. We omit them here and instead read Outlook's
  // auto-generated Message-ID back from Sent Items below — that's what
  // reply tracking (In-Reply-To matching) keys off of.
  try {
    await axios.post(
      'https://graph.microsoft.com/v1.0/me/sendMail',
      {
        message: {
          subject,
          body: { contentType: 'HTML', content: htmlBody },
          toRecipients: [{ emailAddress: { address: toEmail } }],
        },
        saveToSentItems: true,
      },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const status = err.response?.status;
    const graphErr = err.response?.data?.error;
    const detail = graphErr?.message || graphErr?.code || JSON.stringify(err.response?.data || {}).slice(0, 200);
    const enriched = new Error(
      `Graph /me/sendMail returned ${status || '?'}: ${detail || err.message}`
    );
    enriched.status = status;
    enriched.graphError = graphErr;
    throw enriched;
  }

  // Best-effort: fetch the just-sent message from Sent Items to capture
  // Outlook's Message-ID so reply detection can match In-Reply-To later.
  // Filter narrowly by subject + recipient + recency to avoid race
  // conditions when multiple sends happen back-to-back.
  try {
    const sinceIso = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const escSubject = subject.replace(/'/g, "''");
    const res = await axios.get(
      `https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages` +
      `?$top=5&$orderby=sentDateTime desc` +
      `&$select=internetMessageId,subject,sentDateTime,toRecipients` +
      `&$filter=sentDateTime ge ${sinceIso} and subject eq '${escSubject}'`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const candidates = res.data?.value || [];
    const match = candidates.find(m =>
      (m.toRecipients || []).some(r => r.emailAddress?.address?.toLowerCase() === toEmail.toLowerCase())
    );
    return match?.internetMessageId || null;
  } catch (lookupErr) {
    // Lookup failure is non-fatal — the email was sent. Reply tracking
    // for this message just degrades.
    console.warn(`[Graph] Sent ok but couldn't read back internetMessageId: ${lookupErr.message}`);
    return null;
  }
}

/**
 * Find the most recent sent EmailActivity for an enrollment and return its
 * stored externalMessageId (the RFC 5322 internetMessageId Outlook gave us
 * at send time). Used as the "reply to this" anchor for threaded follow-up
 * steps. Returns null when no prior sent email exists.
 */
async function findPriorInternetMessageId(enrollmentId) {
  if (!enrollmentId) return null;
  const prior = await prisma.emailActivity.findFirst({
    where: { enrollmentId, status: 'sent', externalMessageId: { not: null } },
    orderBy: { sentAt: 'desc' },
    select: { externalMessageId: true },
  });
  return prior?.externalMessageId || null;
}

/**
 * Send as a reply to a previous email — keeps the conversation threaded
 * in Outlook (same "Re: ..." conversation, indented reply quote auto-
 * generated by Graph). Resolves our stored internetMessageId to Graph's
 * resource ID first, then POSTs /messages/{id}/reply with our HTML body
 * overriding the auto-generated reply text.
 *
 * Falls back to throwing if the original message can't be found — caller
 * should handle by sending a fresh email or letting the SMTP path try.
 */
async function sendReplyViaGraph(accessToken, originalInternetMessageId, toEmail, htmlBody) {
  if (!originalInternetMessageId) throw new Error('No prior internetMessageId to reply to');

  // 1. Resolve Graph resource id from the RFC 5322 Message-ID.
  let graphMessageId;
  try {
    const escId = originalInternetMessageId.replace(/'/g, "''");
    const lookup = await axios.get(
      `https://graph.microsoft.com/v1.0/me/messages` +
      `?$top=1&$select=id&$filter=internetMessageId eq '${escId}'`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    graphMessageId = lookup.data?.value?.[0]?.id;
    if (!graphMessageId) throw new Error(`No Outlook message with internetMessageId ${originalInternetMessageId}`);
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message;
    throw new Error(`Graph message lookup failed: ${detail}`);
  }

  // 2. POST /reply with our body overriding the auto-generated reply.
  try {
    await axios.post(
      `https://graph.microsoft.com/v1.0/me/messages/${graphMessageId}/reply`,
      {
        message: {
          body: { contentType: 'HTML', content: htmlBody },
          toRecipients: [{ emailAddress: { address: toEmail } }],
        },
      },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const status = err.response?.status;
    const graphErr = err.response?.data?.error;
    const detail = graphErr?.message || graphErr?.code || err.message;
    const enriched = new Error(`Graph /reply returned ${status || '?'}: ${detail}`);
    enriched.status = status;
    enriched.graphError = graphErr;
    throw enriched;
  }

  // 3. Best-effort: read back the newly-sent message from Sent Items so we
  //    can capture its internetMessageId for future reply-tracking.
  try {
    const sinceIso = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const res = await axios.get(
      `https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages` +
      `?$top=5&$orderby=sentDateTime desc` +
      `&$select=internetMessageId,toRecipients,sentDateTime` +
      `&$filter=sentDateTime ge ${sinceIso}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const candidates = res.data?.value || [];
    const match = candidates.find(m =>
      (m.toRecipients || []).some(r => r.emailAddress?.address?.toLowerCase() === toEmail.toLowerCase())
    );
    return match?.internetMessageId || null;
  } catch {
    return null;
  }
}

/**
 * Build SMTP transport for Google App Password fallback.
 * Priority: SMTP_USER env var → 'google' credential in DB.
 */
async function createSmtpTransport(userId) {
  let user = process.env.SMTP_USER;
  let pass = process.env.SMTP_PASS;
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = parseInt(process.env.SMTP_PORT || '587');

  if (!user && userId) {
    const cred = await prisma.integrationCredential.findUnique({
      where: { provider_userId: { provider: 'google', userId } },
    });
    if (cred?.clientId && cred?.clientSecret) {
      user = cred.clientId;
      pass = cred.clientSecret;
    }
  }

  if (!user || !pass) {
    throw new Error('No email credentials configured for this user.');
  }

  return nodemailer.createTransport({
    host, port,
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user, pass },
  });
}

/**
 * Interpolate {{firstName}}, {{lastName}}, {{company}}, {{email}} tokens in subject/body.
 */
// Heuristic: the body is treated as already-HTML if it contains any of
// the block / inline tags we know users / the editor will emit. Plain
// text bodies (from the LLM, from old templates) fall through to the
// newline-to-<br> path.
const HTML_TAG_PATTERN = /<(p|div|br|ul|ol|li|strong|b|em|i|u|a|span|h[1-6])\b/i;
function looksLikeHtml(s) {
  return typeof s === 'string' && HTML_TAG_PATTERN.test(s);
}

/**
 * Convert user / AI body text into safe HTML with clickable links.
 *
 *  1. Preserve any existing <a href="...">...</a> tags by stashing them
 *     behind sentinel placeholders so later regex passes don't touch them.
 *  2. Convert markdown-style links [text](url) → <a href="url">text</a>.
 *  3. Auto-link bare http(s) URLs to anchor tags.
 *  4. Restore the original <a> tags.
 *
 * Inputs may be plain text or already partly HTML; output is safe to
 * concatenate into an HTML body (after newlines are mapped to <br/>).
 */
function linkify(text) {
  if (!text) return '';
  const placeholders = [];
  let out = text.replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, (m) => {
    placeholders.push(m);
    return ` LINK${placeholders.length - 1} `;
  });

  // Markdown [label](url) — url may contain query strings, anchors, etc.
  out = out.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_, label, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`
  );

  // Bare URLs — require whitespace or start-of-string preceding so we
  // don't wrap URLs already embedded in attributes. Strips a trailing
  // punctuation mark that's almost never part of the URL.
  out = out.replace(
    /(^|[\s(])(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])/g,
    (_, lead, url) => `${lead}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`
  );

  // Restore <a> tags we stashed.
  out = out.replace(/ LINK(\d+) /g, (_, i) => placeholders[Number(i)]);
  return out;
}

function interpolate(template, prospect, sender = null) {
  if (!template) return '';
  let out = template
    .replace(/\{\{firstName\}\}/gi,   prospect.firstName || '')
    .replace(/\{\{first_name\}\}/gi,  prospect.firstName || '')
    .replace(/\{\{lastName\}\}/gi,    prospect.lastName  || '')
    .replace(/\{\{last_name\}\}/gi,   prospect.lastName  || '')
    .replace(/\{\{company\}\}/gi,     prospect.companyName || '')
    .replace(/\{\{companyName\}\}/gi, prospect.companyName || '')
    .replace(/\{\{email\}\}/gi,       prospect.email || '')
    .replace(/\{\{title\}\}/gi,       prospect.title || '');

  // Sender tokens — derived from the sequence owner's User record. Used
  // for sign-offs like "Thanks,\n{{sender.name}}". Fallback to the email
  // local part when the User.name field is empty.
  if (sender) {
    const fullName    = sender.name || (sender.email ? sender.email.split('@')[0] : '');
    const firstName   = fullName.split(' ')[0] || '';
    const lastName    = fullName.split(' ').slice(1).join(' ') || '';
    const email       = sender.email || '';
    out = out
      .replace(/\{\{sender\.name\}\}/gi,      fullName)
      .replace(/\{\{senderName\}\}/gi,        fullName)
      .replace(/\{\{sender\.firstName\}\}/gi, firstName)
      .replace(/\{\{sender\.first_name\}\}/gi, firstName)
      .replace(/\{\{sender\.lastName\}\}/gi,  lastName)
      .replace(/\{\{sender\.last_name\}\}/gi, lastName)
      .replace(/\{\{sender\.email\}\}/gi,     email)
      .replace(/\{\{senderEmail\}\}/gi,       email);
  }
  return out;
}

/**
 * Generate a personalized AI draft and store it as an EmailActivity with
 * status='draft_pending'. The enrollment is NOT paused — the draft just
 * sits in the review queue while the rest of the sequence keeps its
 * scheduled timing. Sending happens later when the user approves AND
 * nextStepDue has been reached.
 *
 * Idempotent: skips if a draft for this enrollment+step already exists in
 * any of draft_pending / approved / sent.
 */
async function createPersonalizedDraft(enrollment, step) {
  const existing = await prisma.emailActivity.findFirst({
    where: {
      enrollmentId: enrollment.id,
      sequenceStepId: step.id,
      status: { in: ['draft_pending', 'approved', 'sent'] },
    },
  });
  if (existing) return existing;

  const prospect = await prisma.prospect.findUnique({
    where: { id: enrollment.prospectId },
    include: { account: true },
  });

  let draft;
  try {
    draft = await personalize({ step, prospect, account: prospect.account });
  } catch (err) {
    await prisma.emailActivity.create({
      data: {
        prospectId: enrollment.prospectId,
        sequenceStepId: step.id,
        enrollmentId: enrollment.id,
        status: 'failed',
        subject: interpolate(step.subject || '', prospect),
        failureReason: `Personalization failed: ${err.message}`,
      },
    });
    throw err;
  }

  const draftRow = await prisma.emailActivity.create({
    data: {
      prospectId: enrollment.prospectId,
      sequenceStepId: step.id,
      enrollmentId: enrollment.id,
      status: 'draft_pending',
      subject: draft.subject,
      // Anchor scheduledFor to when the email should actually go out
      // (enrollment.nextStepDue). The review queue uses this to sort and
      // to enforce send timing after approval.
      scheduledFor: enrollment.nextStepDue || new Date(),
      draftBody: draft.body,
      draftPrompt: draft.prompt,
      draftReasoning: draft.reasoning,
      draftModel: draft.model,
      draftProvider: draft.provider,
    },
  });

  if (typeof hitlRouter.pushItem === 'function') {
    try {
      hitlRouter.pushItem({
        type: 'Email Draft',
        confidenceScore: 75,
        urgency: 'Medium',
        prospectId: enrollment.prospectId,
        emailActivityId: draftRow.id,
        draftContent: `Subject: ${draft.subject}\n\n${draft.body}`,
        aiSummary: draft.reasoning || `Personalized via ${draft.provider} ${draft.model}.`,
      });
    } catch { /* non-critical */ }
  }

  return draftRow;
}

/**
 * Send an already-approved draft. Reuses the same Graph/SMTP send path
 * as the plain template flow but pulls subject + body off the draft row.
 * On success, marks the draft EmailActivity as 'sent' (one record per
 * send — no duplicate sent activity is created) and advances the
 * enrollment to the next step.
 */
async function sendApprovedDraft(enrollment, step, draft) {
  const prospect = await prisma.prospect.findUnique({
    where: { id: enrollment.prospectId },
  });
  const ownerId = enrollment.sequence?.userId;
  const sender  = ownerId ? await prisma.user.findUnique({ where: { id: ownerId } }) : null;
  // Interpolate any tokens (sender.name etc.) the LLM kept verbatim in
  // the approved draft — these aren't resolved until send time.
  const subject = interpolate(draft.subject || '',   prospect, sender);
  const body    = interpolate(draft.draftBody || '', prospect, sender);
  const appUrl  = process.env.APP_URL || 'http://localhost:3000';
  const trackingUrl = `${appUrl}/track/open?prospectId=${prospect.id}&stepId=${step.id}`;
  // linkify converts markdown [text](url) and bare URLs to anchor
  // tags. If the body is already HTML (from the rich-text editor or
  // pasted formatting), pass it through; otherwise map newlines to
  // <br/> so plain-text bodies render correctly.
  const linkedBody = linkify(body);
  const bodyHtml = looksLikeHtml(linkedBody) ? linkedBody : linkedBody.replace(/\n/g, '<br/>');
  const htmlBody = `${bodyHtml}<img src="${trackingUrl}" width="1" height="1" style="display:none" />`;

  // If this step is configured to reply in-thread, look up the most
  // recent sent EmailActivity for this enrollment.
  const priorMessageId = step.replyToPrevious
    ? await findPriorInternetMessageId(enrollment.id)
    : null;

  let externalMessageId = null;
  try {
    const { accessToken, fromEmail } = await getMicrosoftAccessToken(ownerId);
    if (step.replyToPrevious && priorMessageId) {
      externalMessageId = await sendReplyViaGraph(accessToken, priorMessageId, prospect.email, htmlBody);
    } else {
      externalMessageId = await sendViaGraph(accessToken, fromEmail, prospect.email, subject, htmlBody);
    }
  } catch (msErr) {
    try {
      const transporter = await createSmtpTransport(ownerId);
      const smtpUser = transporter.options?.auth?.user || process.env.SMTP_USER || '';
      const fromName = process.env.EMAIL_FROM_NAME || smtpUser;
      const unsubscribeUrl = `${appUrl}/prospects/list-unsubscribe?email=${encodeURIComponent(prospect.email)}`;
      // SMTP threading: if this is a reply, prepend "Re: " and include
      // In-Reply-To / References headers (SMTP allows custom headers
      // without Microsoft's "x-" restriction).
      const smtpSubject = step.replyToPrevious && priorMessageId
        ? (subject.toLowerCase().startsWith('re:') ? subject : `Re: ${subject}`)
        : subject;
      const smtpHeaders = {
        'List-Unsubscribe':      `<${unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      };
      if (step.replyToPrevious && priorMessageId) {
        smtpHeaders['In-Reply-To'] = priorMessageId;
        smtpHeaders['References']  = priorMessageId;
      }
      const info = await transporter.sendMail({
        from: `"${fromName}" <${smtpUser}>`,
        to: prospect.email,
        subject: smtpSubject,
        html: htmlBody,
        text: looksLikeHtml(body)
          ? body.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{3,}/g, '\n\n').trim()
          : body,
        headers: smtpHeaders,
      });
      externalMessageId = info.messageId || null;
    } catch (smtpErr) {
      throw new Error(`Microsoft: ${msErr.message} | SMTP: ${smtpErr.message}`);
    }
  }

  // Find the next step so we can advance enrollment.nextStepDue
  const nextStep = await prisma.sequenceStep.findFirst({
    where: { sequenceId: enrollment.sequenceId, order: { gt: step.order } },
    orderBy: { order: 'asc' },
  });
  const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
  const nextStepDue = nextStep ? addDays(new Date(), nextStep.delayDays) : null;
  const isComplete = !nextStep;

  await Promise.all([
    prisma.emailActivity.update({
      where: { id: draft.id },
      data: { status: 'sent', sentAt: new Date(), externalMessageId, failureReason: null },
    }),
    prisma.sequenceEnrollment.update({
      where: { id: enrollment.id },
      data: {
        currentStepOrder: step.order,
        lastContactedAt: new Date(),
        nextStepDue,
        status: isComplete ? 'completed' : 'active',
        completedAt: isComplete ? new Date() : null,
      },
    }),
    prisma.prospect.update({
      where: { id: enrollment.prospectId },
      data: { status: 'In Sequence' },
    }),
  ]);

  return { id: draft.id };
}

/**
 * Lookahead: walk every active enrollment whose next AI-personalized step
 * is due within DRAFT_LOOKAHEAD_DAYS, sorted soonest-first, and generate
 * drafts for any that don't already have one. This is what lets the user
 * approve emails ahead of their scheduled send time instead of racing the
 * cron at the last minute.
 *
 * Throttled by MAX_DRAFTS_PER_RUN per cron pass to avoid hammering the LLM
 * provider on big sequences.
 */
async function prepareUpcomingDrafts() {
  const lookaheadDays = parseInt(process.env.DRAFT_LOOKAHEAD_DAYS || '7', 10);
  const maxPerRun    = parseInt(process.env.MAX_DRAFTS_PER_RUN   || '20', 10);
  const horizon = new Date(Date.now() + lookaheadDays * 24 * 60 * 60 * 1000);

  const enrollments = await prisma.sequenceEnrollment.findMany({
    where: {
      status: 'active',
      nextStepDue: { not: null, lte: horizon },
    },
    include: { sequence: { include: { steps: { orderBy: { order: 'asc' } } } } },
    orderBy: { nextStepDue: 'asc' }, // sooner sends drafted first
  });

  const result = { drafted: 0, skipped: 0, failed: 0, errors: [] };

  for (const enrollment of enrollments) {
    if (result.drafted >= maxPerRun) break;

    const steps = enrollment.sequence.steps;
    const nextStep = steps.find(s =>
      enrollment.currentStepOrder === 0 ? s.order === 1 : s.order > enrollment.currentStepOrder
    );
    if (!nextStep) { result.skipped += 1; continue; }
    if (!nextStep.aiPersonalize) { result.skipped += 1; continue; }

    // Skip if any meaningful EmailActivity already exists for this slot
    const existing = await prisma.emailActivity.findFirst({
      where: {
        enrollmentId: enrollment.id,
        sequenceStepId: nextStep.id,
        status: { in: ['draft_pending', 'approved', 'sent', 'rejected'] },
      },
    });
    if (existing) { result.skipped += 1; continue; }

    try {
      await createPersonalizedDraft(enrollment, nextStep);
      result.drafted += 1;
    } catch (err) {
      result.failed += 1;
      result.errors.push({ enrollmentId: enrollment.id, message: err.message });
    }
  }

  if (result.drafted > 0 || result.failed > 0) {
    console.log(`[Pre-draft] drafted=${result.drafted} skipped=${result.skipped} failed=${result.failed}`);
  }
  return result;
}

/**
 * Send one sequence step email to one prospect.
 * Uses the sequence owner's Microsoft credential via Graph API,
 * falling back to Google SMTP if no Microsoft credential exists.
 * Returns the EmailActivity record created.
 *
 * If step.aiPersonalize is true, instead of sending, generates a draft for HITL review.
 */
async function sendStepEmail(enrollment, step) {
  // AI-personalized steps don't get sent until a human-approved draft
  // exists for them. The lookahead drafter (prepareUpcomingDrafts) should
  // have already created the draft; here we just decide what to do based
  // on its current state.
  if (step.aiPersonalize) {
    const draft = await prisma.emailActivity.findFirst({
      where: {
        enrollmentId: enrollment.id,
        sequenceStepId: step.id,
        status: { in: ['draft_pending', 'approved', 'rejected'] },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!draft) {
      // No draft yet — generate one now, but don't send. The user has to
      // approve before this step can go out.
      console.log(`[Sequence Mailer] No draft for enrollment ${enrollment.id} step ${step.id} at send time — generating fallback`);
      return await createPersonalizedDraft(enrollment, step);
    }

    if (draft.status === 'draft_pending') {
      // Still waiting on the reviewer. Don't send and don't advance —
      // the cron will retry next pass.
      return null;
    }

    if (draft.status === 'rejected') {
      // User rejected without skipping; pause the enrollment until they
      // do something about it (regenerate, skip, or unenroll).
      await prisma.sequenceEnrollment.update({
        where: { id: enrollment.id },
        data: { status: 'paused', pausedAt: new Date(), pausedReason: 'draft_rejected' },
      });
      return null;
    }

    // status === 'approved' — send the human-approved subject/body via
    // the normal send path, then mark the draft as 'sent' instead of
    // creating a duplicate EmailActivity.
    return await sendApprovedDraft(enrollment, step, draft);
  }

  const { prospect } = enrollment;
  const ownerId = enrollment.sequence?.userId;
  const sender  = ownerId ? await prisma.user.findUnique({ where: { id: ownerId } }) : null;
  const subject = interpolate(step.subject, prospect, sender);
  const body    = interpolate(step.body, prospect, sender);
  const appUrl  = process.env.APP_URL || 'http://localhost:3000';
  const trackingUrl = `${appUrl}/track/open?prospectId=${prospect.id}&stepId=${step.id}`;
  // linkify converts markdown [text](url) and bare URLs to anchor
  // tags. If the body is already HTML (from the rich-text editor or
  // pasted formatting), pass it through; otherwise map newlines to
  // <br/> so plain-text bodies render correctly.
  const linkedBody = linkify(body);
  const bodyHtml = looksLikeHtml(linkedBody) ? linkedBody : linkedBody.replace(/\n/g, '<br/>');
  const htmlBody = `${bodyHtml}<img src="${trackingUrl}" width="1" height="1" style="display:none" />`;

  const priorMessageId = step.replyToPrevious
    ? await findPriorInternetMessageId(enrollment.id)
    : null;

  let externalMessageId = null;

  // Try Microsoft Graph first (preferred — sends from rep's own Outlook)
  try {
    const { accessToken, fromEmail } = await getMicrosoftAccessToken(ownerId);
    if (step.replyToPrevious && priorMessageId) {
      externalMessageId = await sendReplyViaGraph(accessToken, priorMessageId, prospect.email, htmlBody);
    } else {
      externalMessageId = await sendViaGraph(accessToken, fromEmail, prospect.email, subject, htmlBody);
    }
  } catch (msErr) {
    // Fall back to Google SMTP
    try {
      const transporter = await createSmtpTransport(ownerId);
      const smtpUser = transporter.options?.auth?.user || process.env.SMTP_USER || '';
      const fromName = process.env.EMAIL_FROM_NAME || smtpUser;
      const unsubscribeUrl = `${appUrl}/prospects/list-unsubscribe?email=${encodeURIComponent(prospect.email)}`;
      const smtpSubject = step.replyToPrevious && priorMessageId
        ? (subject.toLowerCase().startsWith('re:') ? subject : `Re: ${subject}`)
        : subject;
      const smtpHeaders = {
        'List-Unsubscribe':      `<${unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      };
      if (step.replyToPrevious && priorMessageId) {
        smtpHeaders['In-Reply-To'] = priorMessageId;
        smtpHeaders['References']  = priorMessageId;
      }
      const info = await transporter.sendMail({
        from: `"${fromName}" <${smtpUser}>`,
        to: prospect.email,
        subject: smtpSubject,
        html: htmlBody,
        text: looksLikeHtml(body)
          ? body.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{3,}/g, '\n\n').trim()
          : body,
        headers: smtpHeaders,
      });
      externalMessageId = info.messageId || null;
    } catch (smtpErr) {
      // Both failed — throw the original Microsoft error so it's clear which credential is missing
      throw new Error(`Microsoft: ${msErr.message} | SMTP: ${smtpErr.message}`);
    }
  }

  return recordStepSent(enrollment, step, externalMessageId);
}

// SMTP error codes / messages that indicate a permanent (hard) bounce.
// These should pause the enrollment rather than retry.
const HARD_BOUNCE_SIGNALS = [
  /\b55[0-4]\b/,              // SMTP 550–554 permanent failure
  /user (unknown|not found)/i,
  /no such user/i,
  /invalid (recipient|address)/i,
  /address.*does not exist/i,
  /mailbox.*unavailable/i,
  /recipient.*rejected/i,
];

function isHardBounce(errMessage) {
  return HARD_BOUNCE_SIGNALS.some(p => p.test(errMessage));
}

/**
 * Run all due enrollment steps. Called by cron or triggered manually.
 * Returns a summary of what was sent.
 *
 * Safety guardrails:
 *   - MAX_EMAILS_PER_DAY  (env, default 200) — daily cap across all sequences
 *   - EMAIL_SEND_DELAY_MS (env, default 2000) — pause between each send to avoid SMTP throttling
 *   - Hard bounces pause the enrollment immediately
 *   - 3+ failures on one enrollment in 7 days → paused
 */
async function runDueSequenceEmails() {
  const MAX_PER_DAY    = parseInt(process.env.MAX_EMAILS_PER_DAY   || '200');
  const SEND_DELAY_MS  = parseInt(process.env.EMAIL_SEND_DELAY_MS  || '2000');

  // Count emails already sent today
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const sentToday = await prisma.emailActivity.count({
    where: { status: 'sent', sentAt: { gte: todayStart } },
  });

  if (sentToday >= MAX_PER_DAY) {
    console.log(`[Sequence Mailer] Daily cap reached (${sentToday}/${MAX_PER_DAY}). Skipping run.`);
    return { sent: 0, failed: 0, errors: [], limitReached: true };
  }

  const remaining = MAX_PER_DAY - sentToday;
  const dueEnrollments = await getDueEnrollments();
  const results = { sent: 0, failed: 0, errors: [] };

  for (const enrollment of dueEnrollments) {
    if (results.sent >= remaining) {
      console.log(`[Sequence Mailer] Reached daily cap mid-run. Stopping.`);
      break;
    }

    // Pause enrollment if it has accumulated 3+ failures in the last 7 days
    const recentFailures = await prisma.emailActivity.count({
      where: {
        enrollmentId: enrollment.id,
        status: 'failed',
        createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
      },
    });
    if (recentFailures >= 3) {
      await prisma.sequenceEnrollment.update({
        where: { id: enrollment.id },
        data: { status: 'paused', pausedAt: new Date(), pausedReason: 'max_failures', nextStepDue: null },
      });
      console.warn(`[Sequence Mailer] Paused enrollment ${enrollment.id} — ${recentFailures} failures in 7 days`);
      continue;
    }

    const steps = enrollment.sequence.steps;
    const nextStep = steps.find((s) =>
      enrollment.currentStepOrder === 0 ? s.order === 1 : s.order > enrollment.currentStepOrder
    );
    if (!nextStep) continue;

    try {
      await sendStepEmail(enrollment, nextStep);
      results.sent++;
      // Throttle: wait between sends to avoid SMTP rate limiting
      if (results.sent < remaining) {
        await new Promise(r => setTimeout(r, SEND_DELAY_MS));
      }
    } catch (err) {
      results.failed++;
      results.errors.push({ prospectId: enrollment.prospectId, error: err.message });
      console.error(`[Sequence Mailer] Failed step ${nextStep.order} for prospect ${enrollment.prospectId}:`, err.message);

      try {
        await prisma.emailActivity.create({
          data: {
            prospectId: enrollment.prospectId,
            sequenceStepId: nextStep.id,
            enrollmentId: enrollment.id,
            status: 'failed',
            subject: nextStep.subject,
            failureReason: err.message,
          },
        });
      } catch (_) { /* non-critical */ }

      // Hard bounce: pause enrollment immediately, flag prospect
      if (isHardBounce(err.message)) {
        await prisma.sequenceEnrollment.update({
          where: { id: enrollment.id },
          data: { status: 'paused', pausedAt: new Date(), pausedReason: 'hard_bounce', nextStepDue: null },
        });
        await prisma.prospect.update({
          where: { id: enrollment.prospectId },
          data: { status: 'Bounced' },
        });
        console.warn(`[Sequence Mailer] Hard bounce for prospect ${enrollment.prospectId} — enrollment paused`);
      }
    }
  }

  // After the enrollment-driven send pass, also clear any approved
  // drafts whose scheduled send time has arrived. This runs independent
  // of enrollment.nextStepDue so a draft that was approved after its
  // original send time (or one created before the new flow that cleared
  // nextStepDue) still gets sent on the next cron tick.
  const approvedResults = await sendDueApprovedDrafts();
  results.sent += approvedResults.sent;
  results.failed += approvedResults.failed;
  results.errors.push(...approvedResults.errors);

  return results;
}

/**
 * Pick up every EmailActivity with status='approved' whose scheduledFor
 * has passed (or is null — treated as "send now") and ship it.
 *
 * This is the primary send mechanism for AI-personalized steps after the
 * pre-draft → human-approve flow. It's intentionally driven by the draft
 * row's status rather than enrollment.nextStepDue, so approvals are
 * honoured even when the enrollment was paused in a prior version of the
 * flow or its nextStepDue was cleared.
 */
async function sendDueApprovedDrafts() {
  const result = { sent: 0, failed: 0, errors: [] };
  const drafts = await prisma.emailActivity.findMany({
    where: {
      status: 'approved',
      OR: [
        { scheduledFor: null },
        { scheduledFor: { lte: new Date() } },
      ],
    },
    include: {
      enrollment: { include: { sequence: true } },
      sequenceStep: true,
      prospect: true,
    },
    orderBy: { scheduledFor: 'asc' }, // soonest-due first
  });

  for (const draft of drafts) {
    if (!draft.enrollment || !draft.sequenceStep) {
      // Record the broken relation so the user can see why it's stuck.
      result.failed += 1;
      const reason = `Draft is missing its ${!draft.enrollment ? 'enrollment' : 'step'} link`;
      result.errors.push({ draftId: draft.id, message: reason });
      await prisma.emailActivity.update({
        where: { id: draft.id },
        data: { failureReason: reason },
      }).catch(() => {});
      continue;
    }
    try {
      const enrollment = {
        ...draft.enrollment,
        sequence: draft.enrollment.sequence,
        prospect: draft.prospect,
      };
      await sendApprovedDraft(enrollment, draft.sequenceStep, draft);
      result.sent += 1;
    } catch (err) {
      result.failed += 1;
      result.errors.push({ draftId: draft.id, message: err.message });
      console.error(`[Approved Send] draft ${draft.id} failed: ${err.message}`);
      // Persist the error so the user can see WHY a "approved" item
      // isn't sending. Status stays 'approved' so cron keeps retrying;
      // failureReason is overwritten each time so the latest attempt
      // wins.
      await prisma.emailActivity.update({
        where: { id: draft.id },
        data: { failureReason: err.message },
      }).catch(() => {});
    }
  }

  if (result.sent > 0 || result.failed > 0) {
    console.log(`[Approved Send] sent=${result.sent} failed=${result.failed}`);
  }
  return result;
}

module.exports = {
  sendStepEmail,
  runDueSequenceEmails,
  sendDueApprovedDrafts,
  interpolate,
  createPersonalizedDraft,
  prepareUpcomingDrafts,
  sendApprovedDraft,
};
