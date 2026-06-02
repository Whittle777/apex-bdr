/**
 * Reply activities route — surface and manage detected inbox replies.
 *
 * GET  /reply-activities/sequence/:sequenceId   → all replies for a sequence
 * GET  /reply-activities/prospect/:prospectId   → all replies for a prospect
 * PATCH /reply-activities/:id/reclassify        → manually override classification
 * POST /reply-activities/trigger-scan           → manually trigger reply detection (dev/testing)
 */

const express = require('express');
const router = express.Router();

const { authenticateToken } = require('../middleware/auth');
const { runReplyDetection, classifyReply } = require('../services/replyDetector');
const { pauseForOoo, markReplied, optOutProspect } = require('../services/enrollmentService');

const prisma = require('../services/database');
router.use(authenticateToken);

// ── GET /sequence/:sequenceId ─────────────────────────────────────────────────
router.get('/sequence/:sequenceId', async (req, res) => {
  const sequenceId = parseInt(req.params.sequenceId);
  try {
    const replies = await prisma.replyActivity.findMany({
      where: { sequenceId },
      include: {
        prospect: {
          select: { id: true, firstName: true, lastName: true, email: true, companyName: true },
        },
      },
      orderBy: { receivedAt: 'desc' },
    });
    res.json(replies);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── GET /prospect/:prospectId ─────────────────────────────────────────────────
router.get('/prospect/:prospectId', async (req, res) => {
  const prospectId = parseInt(req.params.prospectId);
  try {
    const replies = await prisma.replyActivity.findMany({
      where: { prospectId },
      orderBy: { receivedAt: 'desc' },
    });
    res.json(replies);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── PATCH /:id/reclassify ─────────────────────────────────────────────────────
// Body: { classification: 'ooo' | 'genuine_reply' | 'bounce' | 'unsubscribe' | 'unknown' }
router.patch('/:id/reclassify', async (req, res) => {
  const id = parseInt(req.params.id);
  const { classification } = req.body;
  const valid = ['ooo', 'genuine_reply', 'bounce', 'unsubscribe', 'unknown'];
  if (!valid.includes(classification)) {
    return res.status(400).json({ message: `classification must be one of: ${valid.join(', ')}` });
  }

  try {
    const reply = await prisma.replyActivity.findUnique({
      where: { id },
      include: { enrollment: { include: { sequence: true } } },
    });
    if (!reply) return res.status(404).json({ message: 'Reply not found' });

    // Update the classification record
    const updated = await prisma.replyActivity.update({
      where: { id },
      data: { classification, processedAt: new Date() },
    });

    // Apply the new action if enrollment is still active/paused
    const { status } = reply.enrollment;
    if (['active', 'paused'].includes(status)) {
      if (classification === 'ooo') {
        await pauseForOoo(reply.enrollment.sequenceId, reply.prospectId, reply.oooReturnDate);
      } else if (classification === 'genuine_reply') {
        await markReplied(reply.enrollment.sequenceId, reply.prospectId);
      } else if (classification === 'unsubscribe') {
        await optOutProspect(reply.enrollment.sequenceId, reply.prospectId);
      }
    }

    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── POST /trigger-scan ────────────────────────────────────────────────────────
// Manually trigger reply detection — useful during dev/demo
router.post('/trigger-scan', async (req, res) => {
  try {
    // Run in background; respond immediately
    res.json({ ok: true, message: 'Reply scan triggered' });
    await runReplyDetection();
  } catch (err) {
    console.error('[Reply Scan] Manual trigger error:', err.message);
  }
});

module.exports = router;
