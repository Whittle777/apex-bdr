const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');

const prisma = require('../services/database');
router.use(authenticateToken);

/**
 * GET /meeting-activities/prospect/:prospectId
 * All meetings for a specific prospect.
 */
router.get('/prospect/:prospectId', async (req, res) => {
  try {
    const meetings = await prisma.meetingActivity.findMany({
      where: { prospectId: parseInt(req.params.prospectId) },
      include: {
        prospect:   { select: { id: true, firstName: true, lastName: true, email: true, companyName: true } },
        enrollment: { select: { id: true, sequence: { select: { id: true, name: true } } } },
      },
      orderBy: { scheduledFor: 'desc' },
    });
    res.json(meetings);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * POST /meeting-activities
 * Log a meeting. prospectId and scheduledFor are required.
 * Body: { prospectId, enrollmentId?, title?, scheduledFor, durationMins?, outcome?, notes?, source? }
 */
router.post('/', async (req, res) => {
  const { prospectId, enrollmentId, title, scheduledFor, durationMins, outcome, notes, source } = req.body;
  if (!prospectId) return res.status(400).json({ message: 'prospectId is required' });
  if (!scheduledFor) return res.status(400).json({ message: 'scheduledFor is required' });

  try {
    // Verify the prospect exists — reject if not known
    const prospect = await prisma.prospect.findUnique({ where: { id: parseInt(prospectId) } });
    if (!prospect) return res.status(404).json({ message: 'Prospect not found — meetings must tie to a known prospect' });

    const meeting = await prisma.meetingActivity.create({
      data: {
        prospectId:   parseInt(prospectId),
        enrollmentId: enrollmentId ? parseInt(enrollmentId) : null,
        title:        title || 'Meeting',
        scheduledFor: new Date(scheduledFor),
        durationMins: durationMins ? parseInt(durationMins) : null,
        outcome:      outcome || null,
        notes:        notes || null,
        source:       source || 'manual',
      },
      include: {
        prospect:   { select: { id: true, firstName: true, lastName: true, email: true, companyName: true } },
        enrollment: { select: { id: true, sequence: { select: { id: true, name: true } } } },
      },
    });

    // Auto-update prospect status to 'Meeting Booked' if not already at a later stage
    const TERMINAL_STATUSES = ['Meeting Booked', 'Not Interested'];
    if (!TERMINAL_STATUSES.includes(prospect.status)) {
      await prisma.prospect.update({
        where: { id: parseInt(prospectId) },
        data: { status: 'Meeting Booked' },
      });
    }

    res.status(201).json(meeting);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * PATCH /meeting-activities/:id
 * Update outcome, notes, duration after the meeting occurs.
 */
router.patch('/:id', async (req, res) => {
  const ALLOWED = ['title', 'scheduledFor', 'durationMins', 'outcome', 'notes'];
  const data = Object.fromEntries(Object.entries(req.body).filter(([k]) => ALLOWED.includes(k)));
  if (data.scheduledFor) data.scheduledFor = new Date(data.scheduledFor);
  if (data.durationMins) data.durationMins = parseInt(data.durationMins);
  try {
    const meeting = await prisma.meetingActivity.update({
      where: { id: parseInt(req.params.id) },
      data,
      include: {
        prospect: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
    });
    res.json(meeting);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * DELETE /meeting-activities/:id
 */
router.delete('/:id', async (req, res) => {
  try {
    await prisma.meetingActivity.delete({ where: { id: parseInt(req.params.id) } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
