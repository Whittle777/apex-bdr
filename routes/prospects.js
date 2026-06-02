const express = require('express');
const router = express.Router();
const { GoogleGenAI } = require('@google/genai');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { authenticateToken } = require('../middleware/auth');
const { createProspect, createProspectsBulk, getProspectById, getAllProspects, updateProspect, deleteProspect, getFilterChips, filterProspects, getTopOpportunities, recordWin, recordLoss, handleListUnsubscribe } = require('../controllers/prospectsController');

router.use(authenticateToken);

// ── IMPORTANT: specific paths BEFORE generic /:id ────────────────────────────

router.get('/filter-chips', async (req, res) => {
  try {
    const filterChips = await getFilterChips();
    res.json(filterChips);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/filter', async (req, res) => {
  try {
    const filters = req.query;
    const prospects = await filterProspects(filters);
    res.json(prospects);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/top-opportunities', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const sortBy = req.query.sortBy || 'dealHealthScore';
    const sortOrder = req.query.sortOrder || 'desc';
    const topOpportunities = await getTopOpportunities(limit, sortBy, sortOrder);
    res.json(topOpportunities);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/geographic-routing', async (req, res) => {
  try {
    const { countryRegion } = req.query;
    if (!countryRegion) {
      return res.status(400).json({ message: 'countryRegion query parameter is required' });
    }
    const prospects = await filterProspects({ countryRegion });
    res.json(prospects);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ── Collection routes ─────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const prospects = await getAllProspects();
    res.json(prospects);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const prospect = await createProspect({ ...req.body, ownedById: req.userId });
    if (req.userId) {
      await prisma.prospectOwner.upsert({
        where: { prospectId_userId: { prospectId: prospect.id, userId: req.userId } },
        update: {},
        create: { prospectId: prospect.id, userId: req.userId },
      });
    }
    res.status(201).json(prospect);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

router.delete('/demo-reset', async (req, res) => {
  try {
    await prisma.sequenceEnrollment.deleteMany({});
    const deleted = await prisma.prospect.deleteMany({});
    res.json({ message: `Cleared ${deleted.count} prospects and all enrollments` });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/bulk', async (req, res) => {
  try {
    const prospects = req.body.prospects;
    if (!prospects || !Array.isArray(prospects)) {
      return res.status(400).json({ message: 'Invalid prospects array' });
    }
    const { upsertProspectBatch } = require('../services/prospectBulk');
    const result = await upsertProspectBatch({ prospects, userId: req.userId });
    res.status(201).json({
      count: result.count,
      accountsCreated: result.accountsCreated,
    });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

router.post('/list-unsubscribe', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }
    await handleListUnsubscribe(email);
    res.json({ message: 'Unsubscribed successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Bulk enrich (pending prospects)
router.post('/enrich', async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY missing from .env' });

    const pendingProspects = await prisma.prospect.findMany({
      where: { enrichmentStatus: 'pending' },
      take: 10
    });

    if (pendingProspects.length === 0) return res.json({ message: 'No unstructured prospects found for enrichment.' });

    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const systemInstruction = `You are a B2B Data Enrichment Service (similar to ZoomInfo).

Here are CRM prospects that need their job titles and tech stacks inferred/simulated based on their company and name:
${JSON.stringify(pendingProspects.map(p => ({ id: p.id, name: p.firstName + ' ' + p.lastName, company: p.companyName })), null, 2)}

Assign highly realistic job titles (e.g., "VP of Sales", "Marketing Director", "Software Engineer") and a realistic comma-separated Tech Stack (e.g., "HubSpot, AWS, React", "Salesforce, Marketo"). Make educated realistic corporate guesses.

Return STRICTLY valid JSON like this:
{
  "enriched": [
    { "id": 1, "title": "VP of Marketing", "techStack": "HubSpot, WordPress" }
  ]
}`;

    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: systemInstruction,
        config: { responseMimeType: 'application/json' }
    });

    const parsed = JSON.parse(response.text);

    for (const item of parsed.enriched) {
      await prisma.prospect.update({
        where: { id: item.id },
        data: {
          title: item.title,
          techStack: item.techStack,
          enrichmentStatus: 'enriched'
        }
      });
    }

    res.json({ message: `Successfully enriched ${parsed.enriched.length} prospects via simulated ZoomInfo pull.` });
  } catch (error) {
    console.error('Enrichment Error:', error);
    res.status(500).json({ error: 'Failed to run enrichment scrape' });
  }
});

// ── Single-resource routes (/:id must come last) ───────────────────────────

/**
 * GET /prospects/:id/activity-timeline
 * Unified chronological feed of all prospect-centric activity:
 * emails sent/opened/failed, calls, replies, and meetings.
 * Every item is guaranteed to have a prospectId — non-prospect records are never included.
 */
router.get('/:id/activity-timeline', async (req, res) => {
  const prospectId = parseInt(req.params.id);
  if (isNaN(prospectId)) return res.status(400).json({ message: 'Invalid prospect id' });
  try {
    const [emails, calls, replies, meetings] = await Promise.all([
      prisma.emailActivity.findMany({
        where: { prospectId },
        include: {
          sequenceStep: { select: { id: true, order: true, stepType: true, subject: true } },
          enrollment:   { select: { id: true, sequence: { select: { id: true, name: true } } } },
        },
      }),
      prisma.callActivity.findMany({
        where: { prospectId },
        include: {
          sequenceStep: { select: { id: true, order: true, stepType: true } },
          enrollment:   { select: { id: true, sequence: { select: { id: true, name: true } } } },
        },
      }),
      prisma.replyActivity.findMany({
        where: { prospectId },
        include: {
          enrollment: { select: { id: true, sequence: { select: { id: true, name: true } } } },
        },
      }),
      prisma.meetingActivity.findMany({
        where: { prospectId },
        include: {
          enrollment: { select: { id: true, sequence: { select: { id: true, name: true } } } },
        },
      }),
    ]);

    const timeline = [
      ...emails.map(e => ({ ...e, type: 'email',   date: e.sentAt || e.createdAt })),
      ...calls.map(c  => ({ ...c, type: 'call',    date: c.completedAt || c.scheduledFor || c.createdAt })),
      ...replies.map(r => ({ ...r, type: 'reply',  date: r.receivedAt || r.createdAt })),
      ...meetings.map(m => ({ ...m, type: 'meeting', date: m.scheduledFor || m.createdAt })),
    ].sort((a, b) => new Date(b.date) - new Date(a.date));

    res.json(timeline);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const prospect = await getProspectById(req.params.id);
    if (prospect == null) {
      return res.status(404).json({ message: 'Cannot find prospect' });
    }
    res.json(prospect);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const prospect = await updateProspect(req.params.id, req.body);
    if (prospect == null) {
      return res.status(404).json({ message: 'Cannot find prospect' });
    }
    res.json(prospect);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const prospect = await deleteProspect(req.params.id);
    if (prospect == null) {
      return res.status(404).json({ message: 'Cannot find prospect' });
    }
    res.json({ message: 'Deleted prospect' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/:id/win', async (req, res) => {
  try {
    const prospect = await recordWin(req.params.id);
    if (prospect == null) {
      return res.status(404).json({ message: 'Cannot find prospect' });
    }
    res.json(prospect);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/:id/loss', async (req, res) => {
  try {
    const prospect = await recordLoss(req.params.id);
    if (prospect == null) {
      return res.status(404).json({ message: 'Cannot find prospect' });
    }
    res.json(prospect);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Single prospect enrich
router.post('/:id/enrich', async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY missing from .env' });

    const prospect = await prisma.prospect.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!prospect) return res.status(404).json({ message: 'Prospect not found' });

    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const prompt = `You are a B2B data enrichment service. Given this prospect, simulate realistic enrichment data.

Prospect: ${prospect.firstName} ${prospect.lastName}
Company: ${prospect.companyName}
Country: ${prospect.country || 'US'}
Current Title: ${prospect.title || 'unknown'}

Return STRICTLY valid JSON:
{
  "title": "realistic job title",
  "techStack": "Comma, Separated, Tools",
  "phone": "realistic US/international phone number",
  "linkedIn": "https://linkedin.com/in/realistic-slug",
  "timezone": "e.g. America/New_York"
}`;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: { responseMimeType: 'application/json' },
    });

    const enriched = JSON.parse(response.text);

    await prisma.prospect.update({
      where: { id: prospect.id },
      data: {
        title: enriched.title || prospect.title,
        techStack: enriched.techStack || prospect.techStack,
        enrichmentStatus: 'enriched',
        trackingPixelData: {
          ...(typeof prospect.trackingPixelData === 'object' && prospect.trackingPixelData !== null
            ? prospect.trackingPixelData : {}),
          phone: enriched.phone,
          linkedIn: enriched.linkedIn,
          timezone: enriched.timezone,
          enrichedAt: new Date().toISOString(),
        },
      },
    });

    const updated = await prisma.prospect.findUnique({ where: { id: prospect.id } });
    res.json({ message: 'Prospect enriched.', prospect: updated, enriched });
  } catch (error) {
    console.error('Single enrich error:', error);
    res.status(500).json({ error: 'Failed to enrich prospect' });
  }
});

module.exports = router;
