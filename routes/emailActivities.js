const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');

const prisma = require('../services/database');
router.use(authenticateToken);

/**
 * GET /email-activities/sequence/:sequenceId
 * Returns a merged list of:
 *   - EmailActivity records (sent, opened, failed, cancelled) for this sequence
 *   - Upcoming/scheduled items derived from active SequenceEnrollments with nextStepDue set
 */
router.get('/sequence/:sequenceId', async (req, res) => {
  const sequenceId = parseInt(req.params.sequenceId);
  try {
    // Historical activity records
    const activities = await prisma.emailActivity.findMany({
      where: {
        enrollment: { sequenceId },
      },
      include: {
        prospect: { select: { id: true, firstName: true, lastName: true, email: true, companyName: true } },
        sequenceStep: { select: { id: true, order: true, subject: true, stepType: true } },
        enrollment: { select: { id: true, currentStepOrder: true, status: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Upcoming scheduled emails — active enrollments with a nextStepDue
    const scheduled = await prisma.sequenceEnrollment.findMany({
      where: { sequenceId, status: 'active', nextStepDue: { not: null } },
      include: {
        prospect: { select: { id: true, firstName: true, lastName: true, email: true, companyName: true } },
        sequence: {
          include: { steps: { orderBy: { order: 'asc' } } },
        },
      },
    });

    // Build scheduled items — find the next step for each enrollment.
    // Suppress the placeholder when an EmailActivity already covers the
    // same slot (a draft awaiting approval, an approved draft that will
    // send shortly, or a sent record). The activity row is the
    // source-of-truth for that step; the placeholder would be a
    // confusing duplicate.
    const COVERED_STATUSES = new Set(['draft_pending', 'approved', 'sent']);
    const activityCovers = (enrollmentId, stepId) =>
      activities.some(a =>
        a.enrollmentId === enrollmentId &&
        a.sequenceStepId === stepId &&
        COVERED_STATUSES.has(a.status)
      );

    const scheduledItems = scheduled.map(enr => {
      const nextStep = enr.sequence.steps.find(s =>
        enr.currentStepOrder === 0 ? s.order === 1 : s.order > enr.currentStepOrder
      );
      return {
        type: 'scheduled',
        enrollmentId: enr.id,
        prospect: enr.prospect,
        sequenceStep: nextStep ? { id: nextStep.id, order: nextStep.order, subject: nextStep.subject, stepType: nextStep.stepType } : null,
        subject: nextStep?.subject || '',
        scheduledFor: enr.nextStepDue,
        status: 'scheduled',
      };
    }).filter(item => {
      if (!item.sequenceStep) return false;
      return !activityCovers(item.enrollmentId, item.sequenceStep.id);
    });

    const activityItems = activities.map(a => ({ type: 'activity', ...a }));

    res.json([...scheduledItems, ...activityItems]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * PATCH /email-activities/:id/cancel
 * Mark an EmailActivity as cancelled (for sent/failed records).
 */
router.patch('/:id/cancel', async (req, res) => {
  try {
    const activity = await prisma.emailActivity.update({
      where: { id: parseInt(req.params.id) },
      data: { status: 'cancelled' },
    });
    res.json(activity);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * PATCH /email-activities/enrollment/:enrollmentId/cancel
 * Cancel a scheduled email — pauses the enrollment so nextStepDue is cleared.
 */
router.patch('/enrollment/:enrollmentId/cancel', async (req, res) => {
  try {
    const enrollment = await prisma.sequenceEnrollment.update({
      where: { id: parseInt(req.params.enrollmentId) },
      data: { status: 'paused', nextStepDue: null, pausedAt: new Date(), pausedReason: 'Cancelled by user' },
    });
    res.json(enrollment);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * PATCH /email-activities/enrollment/:enrollmentId/reschedule
 * Reschedule a scheduled email — updates nextStepDue.
 * Body: { scheduledFor: ISO date string }
 */
// GET /email-activities/stats?since=ISO&until=ISO
// Returns per-status counts for EmailActivity rows whose sentAt (for sent
// records) or createdAt (for non-sent — e.g. failed, opened, drafts)
// falls in the range. Used by Analytics for the "Emails Sent" KPI.
router.get('/stats', async (req, res) => {
  try {
    const since = req.query.since ? new Date(req.query.since) : new Date(0);
    const until = req.query.until ? new Date(req.query.until) : new Date();
    if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime())) {
      return res.status(400).json({ message: 'Invalid since/until' });
    }

    // For 'sent' / 'opened' we anchor on sentAt; for the rest, createdAt.
    // Counted via separate queries so the date column matches semantics.
    const [sent, opened, failed, draftPending, approved] = await Promise.all([
      prisma.emailActivity.count({
        where: { status: 'sent', sentAt: { gte: since, lte: until } },
      }),
      prisma.emailActivity.count({
        where: { status: 'opened', sentAt: { gte: since, lte: until } },
      }),
      prisma.emailActivity.count({
        where: { status: 'failed', createdAt: { gte: since, lte: until } },
      }),
      prisma.emailActivity.count({
        where: { status: 'draft_pending', createdAt: { gte: since, lte: until } },
      }),
      prisma.emailActivity.count({
        where: { status: 'approved', createdAt: { gte: since, lte: until } },
      }),
    ]);

    res.json({
      since: since.toISOString(),
      until: until.toISOString(),
      sent, opened, failed, draftPending, approved,
      // Total "delivered or attempted" — useful as the headline number
      totalAttempts: sent + failed,
    });
  } catch (err) {
    console.error('[email-stats]', err);
    res.status(500).json({ message: err.message });
  }
});

// POST /email-activities/run-now
// Force-run the lookahead drafter and the send pass immediately, instead of
// waiting for the next cron tick. Useful for testing and for unsticking a
// just-enrolled prospect whose draft hasn't materialised yet.
router.post('/run-now', async (req, res) => {
  try {
    const { prepareUpcomingDrafts, runDueSequenceEmails } = require('../services/sequenceMailer');
    const draftsResult = await prepareUpcomingDrafts();
    const sendResult   = await runDueSequenceEmails();
    res.json({ ok: true, drafts: draftsResult, send: sendResult });
  } catch (err) {
    console.error('[run-now]', err);
    res.status(500).json({ message: err.message });
  }
});

router.patch('/enrollment/:enrollmentId/reschedule', async (req, res) => {
  const { scheduledFor } = req.body;
  if (!scheduledFor) return res.status(400).json({ message: 'scheduledFor required' });
  try {
    const enrollment = await prisma.sequenceEnrollment.update({
      where: { id: parseInt(req.params.enrollmentId) },
      data: { status: 'active', nextStepDue: new Date(scheduledFor), pausedAt: null, pausedReason: null },
    });

    // Update the scheduledFor on any in-flight draft so the send pass
    // honours the new time. If no draft exists yet, kick off the
    // lookahead pass so one gets generated for the new send time.
    await prisma.emailActivity.updateMany({
      where: {
        enrollmentId: enrollment.id,
        status: { in: ['draft_pending', 'approved'] },
      },
      data: { scheduledFor: new Date(scheduledFor) },
    });
    const { prepareUpcomingDrafts } = require('../services/sequenceMailer');
    prepareUpcomingDrafts().catch(err => {
      console.error('[reschedule] prepareUpcomingDrafts failed:', err.message);
    });

    res.json(enrollment);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * PATCH /email-activities/enrollment/:enrollmentId/retry
 * Retry a failed email — set nextStepDue to now so it's picked up by the next cron run.
 */
router.patch('/enrollment/:enrollmentId/retry', async (req, res) => {
  try {
    const enrollment = await prisma.sequenceEnrollment.update({
      where: { id: parseInt(req.params.enrollmentId) },
      data: { status: 'active', nextStepDue: new Date(), pausedAt: null, pausedReason: null },
    });
    res.json(enrollment);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── Personalized-draft endpoints (Track B) ─────────────────────────────────

// GET /email-activities/drafts — list all pending draft_pending rows for HITL UI
router.get('/drafts', async (req, res) => {
  try {
    const drafts = await prisma.emailActivity.findMany({
      where: { status: 'draft_pending' },
      include: {
        prospect: { select: { id: true, firstName: true, lastName: true, email: true, companyName: true, title: true } },
        sequenceStep: { select: { id: true, order: true, subject: true, aiPurpose: true, aiInstructions: true, aiModel: true } },
        // Pull the sequence owner so we can interpolate {{sender.*}}
        // tokens for the preview.
        enrollment: {
          select: {
            id: true, sequenceId: true, status: true, pausedReason: true,
            sequence: { select: { name: true, user: { select: { id: true, name: true, email: true } } } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Render a "what the prospect will actually see" preview for each
    // draft by interpolating prospect + sender tokens. Keeps the raw
    // tokenised subject/draftBody on the response too — the UI can show
    // the preview by default and reveal the raw template on edit.
    const { interpolate } = require('../services/sequenceMailer');
    const enriched = drafts.map(d => {
      const sender = d.enrollment?.sequence?.user || null;
      return {
        ...d,
        previewSubject: interpolate(d.subject || '',   d.prospect || {}, sender),
        previewBody:    interpolate(d.draftBody || '', d.prospect || {}, sender),
        sender,
      };
    });
    res.json(enriched);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /email-activities/:id/approve — send the draft, advance enrollment
router.post('/:id/approve', async (req, res) => {
  const id = parseInt(req.params.id);
  const { editedSubject, editedBody } = req.body || {};
  try {
    const draft = await prisma.emailActivity.findUnique({
      where: { id },
      include: {
        enrollment: { include: { sequence: { include: { steps: true } } } },
        sequenceStep: true,
        prospect: true,
      },
    });
    if (!draft) return res.status(404).json({ message: 'Draft not found' });
    if (draft.status !== 'draft_pending') {
      return res.status(400).json({ message: `Draft status is "${draft.status}", expected "draft_pending"` });
    }

    const finalSubject = editedSubject || draft.subject;
    const finalBody    = editedBody    || draft.draftBody;

    // Approval flips the draft to 'approved' and persists any edits. The
    // actual send is handled by sendDueApprovedDrafts on the next cron
    // tick — this preserves the original send timing chosen when the
    // sequence was built, while still guaranteeing delivery for drafts
    // whose scheduledFor has already passed.
    const updatedDraft = await prisma.emailActivity.update({
      where: { id },
      data: {
        subject: finalSubject,
        draftBody: finalBody,
        status: 'approved',
      },
    });

    // Ensure the enrollment is active and its nextStepDue mirrors the
    // draft's scheduledFor. Older drafts may have been created in a
    // version of the flow that cleared nextStepDue on pause — without
    // this, the enrollment would be invisible to other parts of the UI.
    await prisma.sequenceEnrollment.update({
      where: { id: draft.enrollmentId },
      data: {
        status: 'active',
        pausedAt: null,
        pausedReason: null,
        nextStepDue: draft.enrollment.nextStepDue || updatedDraft.scheduledFor || new Date(),
      },
    });

    // If the scheduled send time has already passed (e.g., the user
    // approved late), kick off the send right now so it doesn't have to
    // wait for the next cron tick.
    let sentNow = false;
    let sendError = null;
    if (updatedDraft.scheduledFor && new Date(updatedDraft.scheduledFor) <= new Date()) {
      const { sendApprovedDraft } = require('../services/sequenceMailer');
      try {
        const enrollment = {
          ...draft.enrollment,
          sequence: draft.enrollment.sequence,
          prospect: draft.prospect,
        };
        await sendApprovedDraft(enrollment, draft.sequenceStep, updatedDraft);
        sentNow = true;
      } catch (err) {
        sendError = err.message;
        console.error('[approve] immediate send failed:', err.message);
      }
    }

    res.json({
      ok: true,
      status: sentNow ? 'sent' : 'approved',
      scheduledFor: updatedDraft.scheduledFor,
      sendError, // surfaced when immediate send was attempted but failed;
                 // the cron will retry on the next tick
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /email-activities/:id/reject — discard the draft, optionally skip the step
router.post('/:id/reject', async (req, res) => {
  const id = parseInt(req.params.id);
  const { skipStep = false, reason } = req.body || {};
  try {
    const draft = await prisma.emailActivity.findUnique({
      where: { id },
      include: { enrollment: { include: { sequence: { include: { steps: { orderBy: { order: 'asc' } } } } } }, sequenceStep: true },
    });
    if (!draft) return res.status(404).json({ message: 'Draft not found' });

    await prisma.emailActivity.update({
      where: { id },
      data: { status: 'rejected', failureReason: reason || 'Rejected by reviewer' },
    });

    if (skipStep) {
      // Advance past this step and let the next step's pre-draft happen
      // on the next cron pass.
      const steps = draft.enrollment.sequence.steps;
      const stepOrder = draft.sequenceStep.order;
      const nextStep = steps.find(s => s.order > stepOrder);
      await prisma.sequenceEnrollment.update({
        where: { id: draft.enrollmentId },
        data: {
          status: 'active',
          currentStepOrder: stepOrder,
          nextStepDue: nextStep ? new Date(Date.now() + (nextStep.delayDays || 0) * 86400000) : null,
          pausedAt: null,
          pausedReason: null,
          completedAt: nextStep ? null : new Date(),
        },
      });
    } else {
      // Pause the enrollment so it doesn't try to send the rejected step.
      // User must regenerate or skip to continue.
      await prisma.sequenceEnrollment.update({
        where: { id: draft.enrollmentId },
        data: { status: 'paused', pausedAt: new Date(), pausedReason: 'draft_rejected' },
      });
    }

    res.json({ ok: true, skipped: skipStep });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /email-activities/:id/regenerate — re-personalize with optional prompt override
router.post('/:id/regenerate', async (req, res) => {
  const id = parseInt(req.params.id);
  const { customInstructions } = req.body || {};
  try {
    const draft = await prisma.emailActivity.findUnique({
      where: { id },
      include: {
        sequenceStep: true,
        prospect: { include: { account: true } },
        enrollment: { include: { sequence: { include: { user: { select: { id: true, name: true, email: true } } } } } },
      },
    });
    if (!draft) return res.status(404).json({ message: 'Draft not found' });
    if (draft.status !== 'draft_pending') return res.status(400).json({ message: `Draft status is "${draft.status}", expected "draft_pending"` });

    const { personalize } = require('../services/emailPersonalizer');
    const { interpolate } = require('../services/sequenceMailer');
    const fresh = await personalize({
      step: draft.sequenceStep,
      prospect: draft.prospect,
      account: draft.prospect.account,
      customInstructions,
    });

    const updated = await prisma.emailActivity.update({
      where: { id },
      data: {
        subject: fresh.subject,
        draftBody: fresh.body,
        draftPrompt: fresh.prompt,
        draftReasoning: fresh.reasoning,
        draftModel: fresh.model,
        draftProvider: fresh.provider,
      },
    });

    // Return the resolved preview so the UI can refresh without a full
    // refetch — interpolate using the same sender + prospect the
    // /drafts endpoint uses.
    const sender = draft.enrollment?.sequence?.user || null;
    res.json({
      ...updated,
      previewSubject: interpolate(updated.subject || '',   draft.prospect, sender),
      previewBody:    interpolate(updated.draftBody || '', draft.prospect, sender),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
