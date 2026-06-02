const express = require('express');
const router = express.Router();

const prisma = require('../services/database');
// In-memory review queue for prototype (replace with DB-backed queue in production)
let reviewQueue = [
  {
    id: 1, type: 'Email Draft', confidenceScore: 62, urgency: 'High',
    status: 'pending',
    prospectId: null,
    draftContent: 'Hi Sarah, congratulations on the Series B...',
    aiSummary: 'Drafted hyper-personalized outreach. Low confidence due to limited LinkedIn data.',
    createdAt: new Date(Date.now() - 2 * 60 * 1000).toISOString()
  },
  {
    id: 2, type: 'Call Script', confidenceScore: 78, urgency: 'Medium',
    status: 'pending',
    prospectId: null,
    draftContent: '"Hi Marcus, this is Henry from Apex..."',
    aiSummary: 'Generated tech-stack discovery call script. Moderate confidence.',
    createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString()
  },
  {
    id: 3, type: 'Email Draft', confidenceScore: 91, urgency: 'Low',
    status: 'pending',
    prospectId: null,
    draftContent: 'Hi Jessica, thank you for your reply...',
    aiSummary: 'Follow-up email ready for auto-execution. High confidence — positive reply detected.',
    createdAt: new Date(Date.now() - 12 * 60 * 1000).toISOString()
  }
];

let nextId = 4;

/**
 * Push an item to the in-memory HITL queue from other modules (e.g. sequenceMailer).
 * Pairs with EmailActivity rows that are the durable source of truth — this is for
 * UI awareness only.
 */
function pushItem(item) {
  const queueItem = {
    id: nextId++,
    type: item.type || 'Email Draft',
    confidenceScore: item.confidenceScore ?? 75,
    urgency: item.urgency || 'Medium',
    status: 'pending',
    prospectId: item.prospectId || null,
    emailActivityId: item.emailActivityId || null,
    draftContent: item.draftContent || '',
    aiSummary: item.aiSummary || '',
    createdAt: new Date().toISOString(),
  };
  reviewQueue.push(queueItem);
  return queueItem;
}

// GET /hitl/queue — return all pending review items
router.get('/queue', (req, res) => {
  const pending = reviewQueue.filter(item => item.status === 'pending');
  res.json(pending);
});

// GET /hitl/queue/:id — return a single review item
router.get('/queue/:id', (req, res) => {
  const item = reviewQueue.find(i => i.id === parseInt(req.params.id));
  if (!item) return res.status(404).json({ error: 'Review item not found' });
  res.json(item);
});

// POST /hitl/queue — add a new item to the review queue (called by AI engine)
router.post('/queue', (req, res) => {
  const { type, confidenceScore, urgency, prospectId, draftContent, aiSummary } = req.body;

  if (!type || confidenceScore === undefined) {
    return res.status(400).json({ error: 'type and confidenceScore are required' });
  }

  const item = {
    id: nextId++,
    type,
    confidenceScore: parseInt(confidenceScore),
    urgency: urgency || 'Medium',
    status: 'pending',
    prospectId: prospectId || null,
    draftContent: draftContent || '',
    aiSummary: aiSummary || '',
    createdAt: new Date().toISOString()
  };

  reviewQueue.push(item);
  res.status(201).json(item);
});

// POST /hitl/queue/:id/accept — accept the AI's draft
router.post('/queue/:id/accept', (req, res) => {
  const item = reviewQueue.find(i => i.id === parseInt(req.params.id));
  if (!item) return res.status(404).json({ error: 'Review item not found' });

  item.status = 'accepted';
  item.resolvedAt = new Date().toISOString();
  item.resolvedBy = req.body.userId || 'human-reviewer';

  res.json({ message: 'Item accepted. AI action will execute.', item });
});

// POST /hitl/queue/:id/reject — reject the AI's draft
router.post('/queue/:id/reject', (req, res) => {
  const item = reviewQueue.find(i => i.id === parseInt(req.params.id));
  if (!item) return res.status(404).json({ error: 'Review item not found' });

  item.status = 'rejected';
  item.resolvedAt = new Date().toISOString();
  item.resolvedBy = req.body.userId || 'human-reviewer';
  item.rejectionReason = req.body.reason || null;

  res.json({ message: 'Item rejected. AI action will not execute.', item });
});

// POST /hitl/queue/:id/edit — edit draft and accept
router.post('/queue/:id/edit', (req, res) => {
  const item = reviewQueue.find(i => i.id === parseInt(req.params.id));
  if (!item) return res.status(404).json({ error: 'Review item not found' });

  const { editedContent } = req.body;
  if (!editedContent) return res.status(400).json({ error: 'editedContent is required' });

  item.status = 'accepted';
  item.draftContent = editedContent;
  item.humanEdited = true;
  item.resolvedAt = new Date().toISOString();
  item.resolvedBy = req.body.userId || 'human-reviewer';

  res.json({ message: 'Edited draft accepted. Modified content will execute.', item });
});

// POST /hitl/queue/:id/escalate — escalate to supervisor
router.post('/queue/:id/escalate', (req, res) => {
  const item = reviewQueue.find(i => i.id === parseInt(req.params.id));
  if (!item) return res.status(404).json({ error: 'Review item not found' });

  item.status = 'escalated';
  item.urgency = 'High';
  item.escalatedAt = new Date().toISOString();
  item.escalatedBy = req.body.userId || 'human-reviewer';

  res.json({ message: 'Item escalated to supervisor.', item });
});

// GET /hitl/flags — derive actionable flags from the pending queue (used by topbar CallFlags)
router.get('/flags', (req, res) => {
  const timeSince = (dateStr) => {
    const secs = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    return `${Math.floor(mins / 60)}h ago`;
  };

  const flags = reviewQueue
    .filter(i => i.status === 'pending')
    .map(i => ({
      id: i.id,
      type: i.confidenceScore < 70 ? 'LOW_CONFIDENCE_ACTION'
          : i.urgency === 'High' ? 'REVIEW_QUEUE_ITEM'
          : 'REVIEW_QUEUE_ITEM',
      severity: i.confidenceScore < 70 ? 'high'
              : i.urgency === 'High' ? 'medium'
              : 'low',
      prospect: i.prospect
        ? `${i.prospect.firstName} ${i.prospect.lastName}`
        : `Queue Item #${i.id}`,
      time: timeSince(i.createdAt),
      callId: null,
    }));

  res.json(flags);
});

// GET /hitl/stats — summary stats for the review queue
router.get('/stats', (req, res) => {
  const pending = reviewQueue.filter(i => i.status === 'pending').length;
  const accepted = reviewQueue.filter(i => i.status === 'accepted').length;
  const rejected = reviewQueue.filter(i => i.status === 'rejected').length;
  const escalated = reviewQueue.filter(i => i.status === 'escalated').length;
  const highConfidence = reviewQueue.filter(i => i.confidenceScore >= 85 && i.status === 'pending').length;
  const lowConfidence = reviewQueue.filter(i => i.confidenceScore < 70 && i.status === 'pending').length;

  res.json({
    pending, accepted, rejected, escalated,
    highConfidence, lowConfidence,
    total: reviewQueue.length
  });
});

module.exports = router;
module.exports.pushItem = pushItem;
