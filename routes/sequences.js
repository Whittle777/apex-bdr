const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');

const prisma = require('../services/database');
const {
  getAllSequences,
  getSequenceById,
  createSequence,
  updateSequence,
  deleteSequence,
} = require('../controllers/sequences');

const {
  enrollProspects,
  unenrollProspect,
  optOutProspect,
  pauseEnrollment,
  resumeEnrollment,
  getProspectEnrollments,
} = require('../services/enrollmentService');

router.use(authenticateToken);

// ── IMPORTANT: specific paths BEFORE generic /:id ────────────────────────────

// Get all enrollments for a specific prospect (must come before /:id)
router.get('/enrollments/prospect/:prospectId', async (req, res) => {
  try {
    const enrollments = await getProspectEnrollments(parseInt(req.params.prospectId));
    res.json(enrollments);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── CRUD ──────────────────────────────────────────────────────────────────────
router.get('/',     getAllSequences);
router.get('/:id',  getSequenceById);
router.post('/',    createSequence);
router.put('/:id',  updateSequence);
router.delete('/:id', deleteSequence);

// ── Enrollment actions ────────────────────────────────────────────────────────

// Enroll one or more prospects
router.post('/:id/enroll', async (req, res) => {
  const sequenceId = parseInt(req.params.id);
  const { prospectIds } = req.body;
  if (!Array.isArray(prospectIds) || prospectIds.length === 0) {
    return res.status(400).json({ message: 'prospectIds array required' });
  }
  try {
    const ids = prospectIds.map(Number);

    // Skip prospects already in ANY active sequence (whether this one or
    // a different one). Business rule: a prospect should only be in one
    // active sequence at a time. Already-completed / opted-out
    // enrollments don't count, so re-engagement is still allowed.
    const alreadyActive = await prisma.sequenceEnrollment.findMany({
      where: {
        prospectId: { in: ids },
        status: { in: ['active', 'paused'] },
      },
      select: { prospectId: true, sequenceId: true, sequence: { select: { name: true } } },
    });
    const skippedIds = new Set(alreadyActive.map(e => e.prospectId));
    const enrollableIds = ids.filter(id => !skippedIds.has(id));

    let enrollments = [];
    if (enrollableIds.length > 0) {
      enrollments = await enrollProspects(sequenceId, enrollableIds, req.userId);

      // Kick off AI draft generation immediately so the user sees drafts in
      // the Review Queue right away instead of waiting up to 30 min for the
      // next pre-draft cron tick. Fire-and-forget — errors are logged but
      // don't block the enroll response.
      const { prepareUpcomingDrafts } = require('../services/sequenceMailer');
      prepareUpcomingDrafts().catch(err => {
        console.error('[enroll] post-enroll prepareUpcomingDrafts failed:', err.message);
      });
    }

    res.json({
      enrollments,
      enrolled: enrollments.length,
      skipped: alreadyActive.length,
      skippedDetails: alreadyActive.map(e => ({
        prospectId: e.prospectId,
        currentSequenceId: e.sequenceId,
        currentSequenceName: e.sequence?.name || null,
      })),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Unenroll a single prospect
router.delete('/:id/enroll/:prospectId', async (req, res) => {
  try {
    await unenrollProspect(parseInt(req.params.id), parseInt(req.params.prospectId));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Opt out (stops emails, marks prospect Not Interested)
router.post('/:id/opt-out/:prospectId', async (req, res) => {
  try {
    const enrollment = await optOutProspect(parseInt(req.params.id), parseInt(req.params.prospectId));
    res.json(enrollment);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Pause a single enrollment
router.post('/:id/pause/:prospectId', async (req, res) => {
  try {
    const enrollment = await pauseEnrollment(
      parseInt(req.params.id),
      parseInt(req.params.prospectId),
      req.body.reason || null
    );
    res.json(enrollment);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Resume a paused enrollment
router.post('/:id/resume/:prospectId', async (req, res) => {
  try {
    const enrollment = await resumeEnrollment(
      parseInt(req.params.id),
      parseInt(req.params.prospectId)
    );
    res.json(enrollment);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Pause ALL active enrollments in a sequence at once
router.post('/:id/pause-all', async (req, res) => {
  const sequenceId = parseInt(req.params.id);
  try {
    const active = await prisma.sequenceEnrollment.findMany({
      where: { sequenceId, status: 'active' },
    });
    await Promise.all(
      active.map(e => pauseEnrollment(sequenceId, e.prospectId, 'Paused by sequence manager'))
    );
    res.json({ paused: active.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Resume ALL paused enrollments in a sequence at once
router.post('/:id/resume-all', async (req, res) => {
  const sequenceId = parseInt(req.params.id);
  try {
    const paused = await prisma.sequenceEnrollment.findMany({
      where: { sequenceId, status: 'paused' },
    });
    await Promise.all(
      paused.map(e => resumeEnrollment(sequenceId, e.prospectId))
    );
    res.json({ resumed: paused.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Clone a sequence (copies steps, no enrollments)
router.post('/:id/clone', async (req, res) => {
  const sequenceId = parseInt(req.params.id);
  try {
    const original = await prisma.sequence.findUnique({
      where: { id: sequenceId },
      include: { steps: { orderBy: { order: 'asc' } } },
    });
    if (!original) return res.status(404).json({ message: 'Sequence not found' });

    const clone = await prisma.sequence.create({
      data: {
        name: `Copy of ${original.name}`,
        userId: original.userId,
        schemaTag: original.schemaTag,
      },
    });

    if (original.steps.length > 0) {
      await prisma.sequenceStep.createMany({
        data: original.steps.map(s => ({
          sequenceId: clone.id,
          order:      s.order,
          stepType:   s.stepType,
          delayDays:  s.delayDays,
          subject:    s.subject,
          body:       s.body,
          schemaTag:  s.schemaTag,
        })),
      });
    }

    const full = await prisma.sequence.findUnique({
      where: { id: clone.id },
      include: { steps: { orderBy: { order: 'asc' } }, prospectEnrollments: true },
    });
    res.status(201).json(full);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
