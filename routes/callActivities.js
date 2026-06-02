const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');

const prisma = require('../services/database');
router.use(authenticateToken);

/**
 * GET /call-activities/sequence/:sequenceId
 * Returns a merged list of:
 *   - CallActivity records (completed, skipped, no_answer, voicemail, cancelled)
 *   - Planned calls derived from active enrollments where the next step is type CALL
 */
router.get('/sequence/:sequenceId', async (req, res) => {
  const sequenceId = parseInt(req.params.sequenceId);
  try {
    // Historical call records
    const activities = await prisma.callActivity.findMany({
      where: { enrollment: { sequenceId } },
      include: {
        prospect: {
          select: { id: true, firstName: true, lastName: true, email: true, phone: true, companyName: true, title: true },
        },
        sequenceStep: { select: { id: true, order: true, subject: true, stepType: true } },
        enrollment: { select: { id: true, currentStepOrder: true, status: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Planned calls — active enrollments whose next step is type CALL
    const activeEnrollments = await prisma.sequenceEnrollment.findMany({
      where: { sequenceId, status: 'active', nextStepDue: { not: null } },
      include: {
        prospect: {
          select: { id: true, firstName: true, lastName: true, email: true, phone: true, companyName: true, title: true },
        },
        sequence: { include: { steps: { orderBy: { order: 'asc' } } } },
      },
    });

    const plannedItems = activeEnrollments
      .map(enr => {
        const nextStep = enr.sequence.steps.find(s =>
          enr.currentStepOrder === 0 ? s.order === 1 : s.order > enr.currentStepOrder
        );
        if (!nextStep || nextStep.stepType !== 'CALL') return null;
        return {
          type: 'planned',
          enrollmentId: enr.id,
          prospect: enr.prospect,
          sequenceStep: { id: nextStep.id, order: nextStep.order, subject: nextStep.subject, stepType: nextStep.stepType },
          scheduledFor: enr.nextStepDue,
          status: 'planned',
          notes: null,
          outcome: null,
          durationSecs: null,
        };
      })
      .filter(Boolean);

    const activityItems = activities.map(a => ({ type: 'activity', ...a }));

    res.json([...plannedItems, ...activityItems]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * POST /call-activities
 * Log a completed/skipped/no_answer/voicemail call result for a specific enrollment.
 * Body: { enrollmentId, sequenceStepId, prospectId, status, outcome, durationSecs, notes, completedAt }
 */
router.post('/', async (req, res) => {
  const { enrollmentId, sequenceStepId, prospectId, status, outcome, durationSecs, notes, completedAt, stepOrder } = req.body;
  if (!prospectId) {
    return res.status(400).json({ message: 'prospectId is required' });
  }
  try {
    const activity = await prisma.callActivity.create({
      data: {
        prospectId: parseInt(prospectId),
        sequenceStepId: sequenceStepId ? parseInt(sequenceStepId) : null,
        enrollmentId: enrollmentId ? parseInt(enrollmentId) : null,
        status: status || 'completed',
        outcome: outcome || null,
        durationSecs: durationSecs ? parseInt(durationSecs) : null,
        notes: notes || null,
        completedAt: completedAt ? new Date(completedAt) : new Date(),
      },
      include: {
        prospect: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, companyName: true } },
        sequenceStep: { select: { id: true, order: true, subject: true } },
      },
    });

    // Only advance the enrollment if this was a sequence-step call with a stepOrder
    if (enrollmentId && stepOrder !== undefined) {
      const enrollment = await prisma.sequenceEnrollment.findUnique({ where: { id: parseInt(enrollmentId) } });
      if (enrollment) {
        const nextStep = await prisma.sequenceStep.findFirst({
          where: { sequenceId: enrollment.sequenceId, order: { gt: parseInt(stepOrder) } },
          orderBy: { order: 'asc' },
        });
        await prisma.sequenceEnrollment.update({
          where: { id: parseInt(enrollmentId) },
          data: {
            currentStepOrder: parseInt(stepOrder),
            lastContactedAt: new Date(),
            nextStepDue: nextStep ? new Date(Date.now() + nextStep.delayDays * 86400000) : null,
            status: nextStep ? 'active' : 'completed',
            completedAt: nextStep ? null : new Date(),
          },
        });
      }
    }

    res.status(201).json(activity);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * PATCH /call-activities/:id
 * Update a call activity (e.g. add notes, change outcome).
 */
router.patch('/:id', async (req, res) => {
  try {
    const activity = await prisma.callActivity.update({
      where: { id: parseInt(req.params.id) },
      data: req.body,
    });
    res.json(activity);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * PATCH /call-activities/enrollment/:enrollmentId/skip
 * Skip the upcoming call — advances enrollment past the CALL step.
 * Body: { stepOrder, notes }
 */
router.patch('/enrollment/:enrollmentId/skip', async (req, res) => {
  const { stepOrder, notes, sequenceStepId, prospectId } = req.body;
  try {
    const enrollment = await prisma.sequenceEnrollment.findUnique({
      where: { id: parseInt(req.params.enrollmentId) },
      include: { sequence: { include: { steps: { orderBy: { order: 'asc' } } } } },
    });
    if (!enrollment) return res.status(404).json({ message: 'Enrollment not found' });

    // Log the skip
    if (sequenceStepId && prospectId) {
      await prisma.callActivity.create({
        data: {
          prospectId: parseInt(prospectId),
          sequenceStepId: parseInt(sequenceStepId),
          enrollmentId: enrollment.id,
          status: 'skipped',
          notes: notes || null,
          completedAt: new Date(),
        },
      });
    }

    // Advance to next step
    const currentOrder = parseInt(stepOrder) || enrollment.currentStepOrder;
    const nextStep = enrollment.sequence.steps.find(s => s.order > currentOrder);
    await prisma.sequenceEnrollment.update({
      where: { id: enrollment.id },
      data: {
        currentStepOrder: currentOrder,
        nextStepDue: nextStep ? new Date(Date.now() + nextStep.delayDays * 86400000) : null,
        status: nextStep ? 'active' : 'completed',
        completedAt: nextStep ? null : new Date(),
      },
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * PATCH /call-activities/enrollment/:enrollmentId/reschedule
 * Reschedule a planned call.
 * Body: { scheduledFor: ISO date string }
 */
router.patch('/enrollment/:enrollmentId/reschedule', async (req, res) => {
  const { scheduledFor } = req.body;
  if (!scheduledFor) return res.status(400).json({ message: 'scheduledFor required' });
  try {
    const enrollment = await prisma.sequenceEnrollment.update({
      where: { id: parseInt(req.params.enrollmentId) },
      data: { nextStepDue: new Date(scheduledFor), status: 'active', pausedAt: null, pausedReason: null },
    });
    res.json(enrollment);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * PATCH /call-activities/enrollment/:enrollmentId/cancel
 * Cancel a planned call — pauses the enrollment.
 */
router.patch('/enrollment/:enrollmentId/cancel', async (req, res) => {
  try {
    const enrollment = await prisma.sequenceEnrollment.update({
      where: { id: parseInt(req.params.enrollmentId) },
      data: { status: 'paused', nextStepDue: null, pausedAt: new Date(), pausedReason: 'Call cancelled by user' },
    });
    res.json(enrollment);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
