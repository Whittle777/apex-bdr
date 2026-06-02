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

    // Build scheduled items — find the next step for each enrollment
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
router.patch('/enrollment/:enrollmentId/reschedule', async (req, res) => {
  const { scheduledFor } = req.body;
  if (!scheduledFor) return res.status(400).json({ message: 'scheduledFor required' });
  try {
    const enrollment = await prisma.sequenceEnrollment.update({
      where: { id: parseInt(req.params.enrollmentId) },
      data: { status: 'active', nextStepDue: new Date(scheduledFor), pausedAt: null, pausedReason: null },
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
        enrollment: { select: { id: true, sequenceId: true, status: true, pausedReason: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(drafts);
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
    if (draft.status !== 'draft_pending') return res.status(400).json({ message: `Draft status is "${draft.status}", expected "draft_pending"` });

    const finalSubject = editedSubject || draft.subject;
    const finalBody    = editedBody    || draft.draftBody;

    // Hand off to sequenceMailer's send path with an inline override step.
    // We build a synthetic step that the mailer will treat as non-AI to avoid recursion.
    const { sendStepEmail } = require('../services/sequenceMailer');
    const overrideStep = {
      ...draft.sequenceStep,
      aiPersonalize: false,            // critical — prevents recursion
      subject: finalSubject,
      body: finalBody,
    };
    // Reuse the enrollment, swap prospect onto it (mailer reads enrollment.prospect)
    const enrollmentForSend = { ...draft.enrollment, prospect: draft.prospect };

    const sentActivity = await sendStepEmail(enrollmentForSend, overrideStep);

    // Mark the original draft row as resolved (point to the sent record)
    await prisma.emailActivity.update({
      where: { id },
      data: {
        status: 'cancelled',
        failureReason: `Approved → sent as EmailActivity ${sentActivity.id}`,
      },
    });

    // Resume the enrollment so subsequent steps can fire
    await prisma.sequenceEnrollment.update({
      where: { id: draft.enrollmentId },
      data: { status: 'active', pausedAt: null, pausedReason: null },
    });

    res.json({ ok: true, sentActivityId: sentActivity.id });
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
      // Advance past this step + resume
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
    }
    // else: leave enrollment paused — user can manually resume or regenerate

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
      include: { sequenceStep: true, prospect: { include: { account: true } } },
    });
    if (!draft) return res.status(404).json({ message: 'Draft not found' });
    if (draft.status !== 'draft_pending') return res.status(400).json({ message: `Draft status is "${draft.status}", expected "draft_pending"` });

    const { personalize } = require('../services/emailPersonalizer');
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
    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
