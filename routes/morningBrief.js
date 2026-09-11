/**
 * Morning Brief routes — authenticated endpoints for generating and reviewing
 * overnight target-account briefs.
 *
 * Mounted at /morning-brief. All routes require authenticateToken.
 *
 *   GET  /latest               -> most recent run (or 404 if none yet)
 *   POST /run                  -> generate a new brief; body { targets, demo }
 *   GET  /runs/:id             -> fetch a stored run by id
 *   POST /runs/:id/review      -> record human approval; does NOT send anything
 *
 * In-memory run cache for V1 (Map). Survives until backend restart — matches
 * the HITL/research queue pattern already in the codebase. Route ordering is
 * safe: /latest is declared before /runs/:id.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const { authenticateToken } = require('../middleware/auth');
const { runMorningBrief } = require('../services/morningBriefEngine');

router.use(authenticateToken);

// In-memory run store: runId -> brief snapshot (with optional review block).
const runs = new Map();
let latestRunId = null;

// Bounded cleanup — drop runs older than 24h so the Map can't grow unbounded.
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [id, brief] of runs.entries()) {
    if (new Date(brief.generatedAt).getTime() < cutoff) {
      runs.delete(id);
      if (latestRunId === id) latestRunId = null;
    }
  }
}, 60 * 60 * 1000).unref();

/**
 * GET /morning-brief/latest
 * Returns the most recently generated run, or 404 if none exists.
 */
router.get('/latest', (req, res) => {
  if (!latestRunId || !runs.has(latestRunId)) {
    // The overnight CLI may have run while the API was stopped. Rehydrate its
    // bounded local artifact so the morning UI can show the completed run.
    const artifactPath = path.join(__dirname, '..', 'artifacts', 'morning-brief', 'latest.json');
    try {
      const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
      if (artifact?.runId && artifact?.cards) {
        runs.set(artifact.runId, artifact);
        latestRunId = artifact.runId;
        return res.json(artifact);
      }
    } catch {
      // No artifact yet, or it is incomplete. Fall through to the normal 404.
    }
    return res.status(404).json({ message: 'No morning brief run yet' });
  }
  const latest = runs.get(latestRunId);
  if (latest.userId && latest.userId !== req.userId) {
    return res.status(404).json({ message: 'No morning brief run yet' });
  }
  res.json(latest);
});

/**
 * POST /morning-brief/run
 * Body: { targets?: Account[], demo?: boolean, discover?: boolean }
 * If demo is true or no targets supplied, runs the seeded fixture.
 * Returns the generated brief.
 */
router.post('/run', async (req, res) => {
  try {
    const { targets, demo, discover, discoveryOptions } = req.body || {};
    const brief = await runMorningBrief({ targets, demo, discover, discoveryOptions });

    // Stamp ownership + cache it.
    brief.userId = req.userId;
    runs.set(brief.runId, brief);
    latestRunId = brief.runId;

    res.status(201).json(brief);
  } catch (err) {
    console.error('[morning-brief] run failed:', err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * GET /morning-brief/runs/:id
 * Returns the stored run snapshot (including any review decision).
 */
router.get('/runs/:id', (req, res) => {
  const brief = runs.get(req.params.id);
  if (!brief) return res.status(404).json({ message: 'Run not found' });
  if (brief.userId && brief.userId !== req.userId) {
    return res.status(404).json({ message: 'Run not found' });
  }
  res.json(brief);
});

/**
 * POST /morning-brief/runs/:id/review
 * Body: { decision: 'approved' | 'rejected', editedAction?: string, note?: string }
 * Records the human decision into the run snapshot. Does NOT send anything —
 * outreach is a separate, human-initiated step.
 */
router.post('/runs/:id/review', (req, res) => {
  const brief = runs.get(req.params.id);
  if (!brief) return res.status(404).json({ message: 'Run not found' });
  if (brief.userId && brief.userId !== req.userId) {
    return res.status(404).json({ message: 'Run not found' });
  }

  const { decision, editedAction, note } = req.body || {};
  if (!['approved', 'rejected'].includes(decision)) {
    return res.status(400).json({ message: "decision must be 'approved' or 'rejected'" });
  }

  brief.review = {
    decision,
    editedAction: typeof editedAction === 'string' && editedAction.trim() ? editedAction.trim() : null,
    note: typeof note === 'string' ? note : null,
    reviewedBy: req.userId,
    reviewedAt: new Date().toISOString(),
  };

  // If a human edited the recommended action, persist it on each card's
  // recommendedAction so downstream consumers see the approved version.
  if (brief.review.editedAction) {
    for (const card of brief.cards) {
      card.recommendedAction = { ...card.recommendedAction, action: brief.review.editedAction, humanEdited: true };
    }
  }

  runs.set(brief.runId, brief);
  res.json(brief);
});

module.exports = router;
