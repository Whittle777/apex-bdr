/**
 * routes/vmRecordings.js — Voicemail drop recordings
 *
 * POST   /vm-recordings            Upload a new WAV recording (JSON body)
 * GET    /vm-recordings            List recordings for current user (no audio bytes)
 * GET    /vm-recordings/:id/audio  Serve raw audio — no auth (Microsoft fetches this URL)
 * DELETE /vm-recordings/:id        Delete a recording
 */

const express = require('express');
const router  = express.Router();

const prisma = require('../services/database');
const { authenticateToken } = require('../middleware/auth');

// ── POST /vm-recordings ───────────────────────────────────────────────────────
// Body: { name, durationSecs, audioBase64, mimeType }
// audioBase64 is the raw base64 string (without data: prefix) of a WAV file.
router.post('/', authenticateToken, async (req, res) => {
  const { name, durationSecs, audioBase64, mimeType = 'audio/wav' } = req.body;
  if (!name || !audioBase64) {
    return res.status(400).json({ message: 'name and audioBase64 are required' });
  }

  try {
    const audioData = Buffer.from(audioBase64, 'base64');
    const recording = await prisma.vmRecording.create({
      data: {
        userId: req.userId,
        name,
        durationSecs: durationSecs ? parseFloat(durationSecs) : null,
        audioData,
        mimeType,
      },
      select: { id: true, name: true, durationSecs: true, mimeType: true, createdAt: true },
    });
    res.json(recording);
  } catch (err) {
    console.error('[VmRecordings] create failed:', err.message);
    res.status(500).json({ message: 'Failed to save recording.' });
  }
});

// ── GET /vm-recordings ────────────────────────────────────────────────────────
router.get('/', authenticateToken, async (req, res) => {
  const recordings = await prisma.vmRecording.findMany({
    where: { userId: req.userId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true, durationSecs: true, mimeType: true, createdAt: true },
  });
  res.json(recordings);
});

// ── GET /vm-recordings/:id/audio ──────────────────────────────────────────────
// No authentication — Microsoft's cloud must be able to fetch this URL directly.
router.get('/:id/audio', async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).end();

  try {
    const rec = await prisma.vmRecording.findUnique({
      where: { id },
      select: { audioData: true, mimeType: true },
    });
    if (!rec) return res.status(404).end();

    res.set('Content-Type', rec.mimeType);
    res.set('Content-Length', rec.audioData.length);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(rec.audioData);
  } catch (err) {
    console.error('[VmRecordings] audio fetch failed:', err.message);
    res.status(500).end();
  }
});

// ── DELETE /vm-recordings/:id ─────────────────────────────────────────────────
router.delete('/:id', authenticateToken, async (req, res) => {
  const id = parseInt(req.params.id);
  const rec = await prisma.vmRecording.findUnique({ where: { id }, select: { userId: true } });
  if (!rec) return res.status(404).json({ message: 'Not found.' });
  if (rec.userId !== req.userId) return res.status(403).json({ message: 'Not your recording.' });

  await prisma.vmRecording.delete({ where: { id } });
  res.json({ ok: true });
});

module.exports = router;
