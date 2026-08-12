/**
 * routes/tracking.js — public open-pixel + click-redirect endpoints.
 *
 * Mounted at /track with NO auth middleware: these URLs are fetched by
 * recipients' mail clients, not by the app frontend.
 *
 *   GET /track/open?prospectId=&stepId=&sig=   → 1x1 GIF, records an open
 *   GET /track/click?prospectId=&stepId=&url=&sig= → records a click, 302s
 *
 * Signatures come from services/trackingLinks.js. Opens tolerate a
 * MISSING sig (emails sent before signing shipped carry unsigned pixel
 * URLs, and an open is low-stakes) but reject a present-and-wrong one.
 * Clicks always require a valid sig — the redirect would otherwise be an
 * open-redirect vector.
 */

const express = require('express');
const router = express.Router();
const { recordOpen, recordClick } = require('../services/enrollmentService');
const { verifyOpenSig, verifyClickSig } = require('../services/trackingLinks');

// 1x1 transparent GIF
const PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);

const toId = (v) => {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
};

router.get('/open', async (req, res) => {
  const prospectId = toId(req.query.prospectId);
  const stepId = toId(req.query.stepId);
  const sig = req.query.sig;

  try {
    if (prospectId && stepId) {
      if (!sig) {
        // Legacy pixel from an email sent before signing existed.
        await recordOpen(prospectId, stepId);
        console.log(`[track/open] unsigned (legacy) open — prospect ${prospectId} step ${stepId}`);
      } else if (verifyOpenSig(sig, prospectId, stepId)) {
        await recordOpen(prospectId, stepId);
      }
    }
  } catch (err) {
    // Never fail the pixel — the recipient's mail client is waiting on an image.
    console.error('[track/open] failed to record open:', err.message);
  }

  res.set({
    'Content-Type': 'image/gif',
    'Content-Length': PIXEL.length,
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    Pragma: 'no-cache',
    Expires: '0',
  });
  res.end(PIXEL);
});

router.get('/click', async (req, res) => {
  const prospectId = toId(req.query.prospectId);
  const stepId = toId(req.query.stepId);
  const url = req.query.url;
  const sig = req.query.sig;

  const isHttpUrl = typeof url === 'string' && /^https?:\/\//i.test(url);
  if (!prospectId || !stepId || !isHttpUrl || !verifyClickSig(sig, prospectId, stepId, url)) {
    return res.status(400).send('Invalid tracking link');
  }

  try {
    await recordClick(prospectId, stepId);
  } catch (err) {
    // Recording failure must not strand the recipient — still redirect.
    console.error('[track/click] failed to record click:', err.message);
  }

  res.redirect(302, url);
});

module.exports = router;
