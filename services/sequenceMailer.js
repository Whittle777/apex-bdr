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
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

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
    scope:         'https://graph.microsoft.com/Mail.Send offline_access',
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
  const messageId = `<${crypto.randomUUID()}@apex-bdr>`;
  await axios.post(
    'https://graph.microsoft.com/v1.0/me/sendMail',
    {
      message: {
        subject,
        body: { contentType: 'HTML', content: htmlBody },
        toRecipients: [{ emailAddress: { address: toEmail } }],
        internetMessageHeaders: [
          { name: 'Message-ID',              value: messageId },
          { name: 'List-Unsubscribe',        value: `<${process.env.APP_URL || 'http://localhost:3000'}/prospects/list-unsubscribe?email=${encodeURIComponent(toEmail)}>` },
          { name: 'List-Unsubscribe-Post',   value: 'List-Unsubscribe=One-Click' },
        ],
      },
      saveToSentItems: true,
    },
    { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
  );
  return messageId;
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
function interpolate(template, prospect) {
  return template
    .replace(/\{\{firstName\}\}/gi, prospect.firstName || '')
    .replace(/\{\{lastName\}\}/gi, prospect.lastName || '')
    .replace(/\{\{company\}\}/gi, prospect.companyName || '')
    .replace(/\{\{email\}\}/gi, prospect.email || '')
    .replace(/\{\{title\}\}/gi, prospect.title || '');
}

/**
 * If the step has aiPersonalize=true, generate a draft and queue it for HITL review
 * instead of sending. Returns the draft EmailActivity row.
 *
 * Side effects:
 *   - Creates an EmailActivity with status='draft_pending'
 *   - Pauses the enrollment (pausedReason='awaiting_review') so cron doesn't loop
 *   - Pushes a reference to the in-memory HITL queue for UI awareness
 *
 * Idempotent: if a draft_pending already exists for this enrollment+step, returns it.
 */
async function createPersonalizedDraft(enrollment, step) {
  const existing = await prisma.emailActivity.findFirst({
    where: { enrollmentId: enrollment.id, sequenceStepId: step.id, status: 'draft_pending' },
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
      scheduledFor: new Date(),
      draftBody: draft.body,
      draftPrompt: draft.prompt,
      draftReasoning: draft.reasoning,
      draftModel: draft.model,
      draftProvider: draft.provider,
    },
  });

  await prisma.sequenceEnrollment.update({
    where: { id: enrollment.id },
    data: { status: 'paused', pausedAt: new Date(), pausedReason: 'awaiting_review', nextStepDue: null },
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
 * Send one sequence step email to one prospect.
 * Uses the sequence owner's Microsoft credential via Graph API,
 * falling back to Google SMTP if no Microsoft credential exists.
 * Returns the EmailActivity record created.
 *
 * If step.aiPersonalize is true, instead of sending, generates a draft for HITL review.
 */
async function sendStepEmail(enrollment, step) {
  const ownerId = enrollment.sequence?.userId;

  let subject;
  let body;

  if (step.aiPersonalize) {
    // Pull the prospect record fresh so we have researchBrief + linked account
    // (the enrollment's nested prospect is a slim include and may not carry them).
    const prospect = await prisma.prospect.findUnique({
      where: { id: enrollment.prospectId },
      include: { account: true },
    });
    try {
      const draft = await personalize({ step, prospect, account: prospect.account });
      subject = draft.subject;
      body    = draft.body;
    } catch (err) {
      console.warn(`[Sequence Mailer] AI personalization failed for prospect ${prospect.id} step ${step.id}: ${err.message}. Falling back to template.`);
      subject = interpolate(step.subject, prospect);
      body    = interpolate(step.body, prospect);
    }
    // Use the freshly-loaded prospect for the rest of the flow
    enrollment = { ...enrollment, prospect };
  } else {
    const { prospect } = enrollment;
    subject = interpolate(step.subject, prospect);
    body    = interpolate(step.body, prospect);
  }

  const { prospect } = enrollment;
  const appUrl  = process.env.APP_URL || 'http://localhost:3000';
  const trackingUrl = `${appUrl}/track/open?prospectId=${prospect.id}&stepId=${step.id}`;
  const htmlBody = `${body.replace(/\n/g, '<br/>')}<img src="${trackingUrl}" width="1" height="1" style="display:none" />`;

  let externalMessageId = null;

  // Try Microsoft Graph first (preferred — sends from rep's own Outlook)
  try {
    const { accessToken, fromEmail } = await getMicrosoftAccessToken(ownerId);
    externalMessageId = await sendViaGraph(accessToken, fromEmail, prospect.email, subject, htmlBody);
  } catch (msErr) {
    // Fall back to Google SMTP
    try {
      const transporter = await createSmtpTransport(ownerId);
      const smtpUser = transporter.options?.auth?.user || process.env.SMTP_USER || '';
      const fromName = process.env.EMAIL_FROM_NAME || smtpUser;
      const unsubscribeUrl = `${appUrl}/prospects/list-unsubscribe?email=${encodeURIComponent(prospect.email)}`;
      const info = await transporter.sendMail({
        from: `"${fromName}" <${smtpUser}>`,
        to: prospect.email,
        subject,
        html: htmlBody,
        text: body,
        headers: {
          'List-Unsubscribe':      `<${unsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
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

  return results;
}

module.exports = { sendStepEmail, runDueSequenceEmails, interpolate, createPersonalizedDraft };
