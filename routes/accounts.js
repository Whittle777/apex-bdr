const express = require('express');
const router = express.Router();
const multer = require('multer');
const crypto = require('crypto');
const { authenticateToken } = require('../middleware/auth');

const { parseAccountTracker, parseRaw, applyMapping } = require('../services/accountTrackerImporter');
const { proposeMapping, ACCOUNT_FIELDS, FIELD_DESCRIPTIONS } = require('../services/headerMapper');
const prisma = require('../services/database');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// In-memory cache of parsed uploads pending mapping confirmation.
// TTL: 10 minutes. Keyed by uploadId (UUID).
const pendingUploads = new Map();
const UPLOAD_TTL_MS = 10 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingUploads.entries()) {
    if (now - v.createdAt > UPLOAD_TTL_MS) pendingUploads.delete(k);
  }
}, 60_000).unref();

router.use(authenticateToken);

const ALLOWED = new Set([
  'name', 'domain', 'website', 'industry', 'subIndustry', 'revenue', 'employees',
  'country', 'region', 'city', 'description', 'notes', 'researchSummary',
  'status', 'tier',
  'techStack', 'tags', 'linkedInUrl', 'twitterUrl', 'foundedYear',
  'priorityTier', 'dealMotion', 'targetCloseDate', 'closeQuarter', 'useCases',
  'primaryStakeholder', 'backupStakeholders', 'warmIntroPaths', 'weeklyFocus',
  'outreachStatus', 'lastContactedAt', 'myNotes', 'rep',
]);

const accountIncludes = {
  prospects: {
    select: {
      id: true, firstName: true, lastName: true, email: true,
      title: true, phone: true, status: true, enrichmentStatus: true,
      trackingPixelData: true,
      _count: { select: { emailActivities: true, callActivities: true, meetingActivities: true } },
    },
    orderBy: { createdAt: 'desc' },
  },
  _count: { select: { prospects: true } },
  owners: { select: { id: true, name: true, email: true } },
};

// GET /accounts — list all with prospect count
router.get('/', async (req, res) => {
  try {
    const accounts = await prisma.account.findMany({
      include: {
        _count: { select: { prospects: true } },
        owners: { select: { id: true, name: true, email: true } },
      },
      orderBy: { name: 'asc' },
    });
    res.json(accounts);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /accounts/import-xlsx/preview — parse the file, get an AI-proposed mapping
// for the user to confirm/edit. Returns { uploadId, headers, sampleRows, proposedMapping, ... }
router.post('/import-xlsx/preview', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No file uploaded (field name: file)' });
  try {
    const { headers, rows, sampleRows, sheetName, warnings } = parseRaw(req.file.buffer);
    if (!headers.length || !rows.length) {
      return res.status(400).json({ message: 'Could not find headers + data rows', warnings, sheetName });
    }

    const proposal = await proposeMapping(headers, sampleRows);

    const uploadId = crypto.randomUUID();
    pendingUploads.set(uploadId, { headers, rows, sheetName, createdAt: Date.now() });

    res.json({
      uploadId,
      sheetName,
      headers,
      sampleRows,                     // 2-D array, first 3 data rows
      proposedMapping: proposal.mapping,
      mappingSource: proposal.source, // 'ai' | 'fallback'
      mappingReasoning: proposal.reasoning,
      mappingModel: proposal.model,
      accountFields: ACCOUNT_FIELDS,
      fieldDescriptions: FIELD_DESCRIPTIONS,
      rowCount: rows.length,
      warnings,
      expiresInMs: UPLOAD_TTL_MS,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /accounts/import-xlsx/commit — apply the (possibly user-edited) mapping and upsert
router.post('/import-xlsx/commit', async (req, res) => {
  const { uploadId, mapping } = req.body || {};
  if (!uploadId || !mapping || typeof mapping !== 'object') {
    return res.status(400).json({ message: 'uploadId and mapping are required' });
  }
  const cached = pendingUploads.get(uploadId);
  if (!cached) {
    return res.status(410).json({ message: 'Upload expired or not found — please re-upload the file' });
  }

  try {
    const { accounts, warnings } = applyMapping(cached.headers, cached.rows, mapping);
    if (warnings.length && !accounts.length) {
      return res.status(400).json({ message: warnings[0], warnings });
    }

    let created = 0;
    let updated = 0;
    const failures = [];

    for (const acct of accounts) {
      try {
        const existing = await prisma.account.findFirst({
          where: { name: { equals: acct.name } },
          select: { id: true },
        });
        const data = Object.fromEntries(
          Object.entries(acct).filter(([k]) => ACCOUNT_FIELDS.includes(k))
        );
        if (existing) {
          await prisma.account.update({ where: { id: existing.id }, data });
          updated++;
        } else {
          await prisma.account.create({ data });
          created++;
        }
      } catch (err) {
        failures.push({ name: acct.name, error: err.message });
      }
    }

    pendingUploads.delete(uploadId);
    res.json({ ok: true, sheetName: cached.sheetName, created, updated, total: accounts.length, failures, warnings });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /accounts/import-xlsx — legacy direct upload (uses hardcoded HEADER_MAP). Kept for compatibility.
router.post('/import-xlsx', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No file uploaded (field name: file)' });
  try {
    const { accounts, warnings, sheetName } = parseAccountTracker(req.file.buffer);
    if (!accounts.length) {
      return res.status(400).json({ message: 'No account rows found', warnings, sheetName });
    }

    let created = 0;
    let updated = 0;
    const failures = [];

    for (const acct of accounts) {
      try {
        const existing = await prisma.account.findFirst({
          where: { name: { equals: acct.name } },
          select: { id: true },
        });
        const data = Object.fromEntries(
          Object.entries(acct).filter(([k]) => ALLOWED.has(k))
        );
        if (existing) {
          await prisma.account.update({ where: { id: existing.id }, data });
          updated++;
        } else {
          await prisma.account.create({ data });
          created++;
        }
      } catch (err) {
        failures.push({ name: acct.name, error: err.message });
      }
    }

    res.json({ ok: true, sheetName, created, updated, total: accounts.length, failures, warnings });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /accounts/:id — full detail with prospects
router.get('/:id', async (req, res) => {
  try {
    const account = await prisma.account.findUnique({
      where: { id: parseInt(req.params.id) },
      include: accountIncludes,
    });
    if (!account) return res.status(404).json({ message: 'Account not found' });
    res.json(account);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /accounts — create
router.post('/', async (req, res) => {
  const data = Object.fromEntries(Object.entries(req.body).filter(([k]) => ALLOWED.has(k)));
  if (!data.name) return res.status(400).json({ message: 'name is required' });
  try {
    const account = await prisma.account.create({
      data: {
        ...data,
        owners: { connect: [{ id: req.userId }] },
      },
      include: accountIncludes,
    });
    res.status(201).json(account);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// POST /accounts/:id/owners — add an owner
router.post('/:id/owners', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ message: 'userId required' });
  try {
    const account = await prisma.account.update({
      where: { id: parseInt(req.params.id) },
      data: { owners: { connect: { id: parseInt(userId) } } },
      include: accountIncludes,
    });
    res.json(account);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// DELETE /accounts/:id/owners/:ownerId — remove an owner
router.delete('/:id/owners/:ownerId', async (req, res) => {
  try {
    const account = await prisma.account.update({
      where: { id: parseInt(req.params.id) },
      data: { owners: { disconnect: { id: parseInt(req.params.ownerId) } } },
      include: accountIncludes,
    });
    res.json(account);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// PUT /accounts/:id — update
router.put('/:id', async (req, res) => {
  const data = Object.fromEntries(Object.entries(req.body).filter(([k]) => ALLOWED.has(k)));
  try {
    const account = await prisma.account.update({
      where: { id: parseInt(req.params.id) },
      data,
      include: accountIncludes,
    });
    res.json(account);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// DELETE /accounts/:id
router.delete('/:id', async (req, res) => {
  try {
    await prisma.account.delete({ where: { id: parseInt(req.params.id) } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /accounts/:id/link-prospect — link a prospect to this account
router.post('/:id/link-prospect', async (req, res) => {
  const { prospectId } = req.body;
  if (!prospectId) return res.status(400).json({ message: 'prospectId required' });
  try {
    const prospect = await prisma.prospect.update({
      where: { id: parseInt(prospectId) },
      data: { accountId: parseInt(req.params.id) },
    });
    res.json(prospect);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// DELETE /accounts/:id/link-prospect/:prospectId — unlink
router.delete('/:id/link-prospect/:prospectId', async (req, res) => {
  try {
    await prisma.prospect.update({
      where: { id: parseInt(req.params.prospectId) },
      data: { accountId: null },
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /accounts/research-upload — bulk APPEND account research summaries.
// Body: { rows: [{ name, researchSummary }] }
// For each row: if an Account exists, prepend the new research with a
// dated header to the existing summary so prior context is preserved;
// otherwise create a new Account with the research as its initial body.
// Returns { updated, created, skipped }.
router.post('/research-upload', async (req, res) => {
  try {
    const rows = req.body?.rows;
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ message: 'No rows provided' });
    }

    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    let updated = 0;
    let created = 0;
    let skipped = 0;

    for (const row of rows) {
      const name = (row?.name || '').trim();
      const incoming = (row?.researchSummary || '').trim();
      if (!name || !incoming) { skipped += 1; continue; }

      const existing = await prisma.account.findFirst({ where: { name } });
      if (existing) {
        const prior = (existing.researchSummary || '').trim();
        // Don't double-append if this exact research is already at the top.
        const alreadyHasIt = prior.includes(incoming);
        const newSummary = !prior
          ? `[${today}]\n${incoming}`
          : alreadyHasIt
            ? prior
            : `[${today}]\n${incoming}\n\n${prior}`;
        await prisma.account.update({
          where: { id: existing.id },
          data: {
            researchSummary: newSummary,
            ...(req.userId ? { owners: { connect: [{ id: req.userId }] } } : {}),
          },
        });
        updated += 1;
      } else {
        await prisma.account.create({
          data: {
            name,
            researchSummary: `[${today}]\n${incoming}`,
            ...(req.userId ? { owners: { connect: [{ id: req.userId }] } } : {}),
          },
        });
        created += 1;
      }
    }

    res.json({ updated, created, skipped });
  } catch (err) {
    console.error('[accounts/research-upload]', err);
    res.status(500).json({ message: err.message });
  }
});

// POST /accounts/backfill — create Account rows for every distinct companyName
// on existing Prospects that doesn't already have a matching Account, then
// link prospects to those accounts. Idempotent — safe to re-run.
router.post('/backfill', async (req, res) => {
  try {
    const distinctCompanies = await prisma.prospect.findMany({
      where: { companyName: { not: null } },
      select: { companyName: true, country: true, region: true, techStack: true },
    });

    const seen = new Set();
    const samples = [];
    for (const p of distinctCompanies) {
      if (p.companyName && !seen.has(p.companyName)) {
        seen.add(p.companyName);
        samples.push(p);
      }
    }

    let accountsCreated = 0;
    let prospectsLinked = 0;

    for (const sample of samples) {
      let account = await prisma.account.findFirst({ where: { name: sample.companyName } });
      if (!account) {
        account = await prisma.account.create({
          data: {
            name:      sample.companyName,
            country:   sample.country   || null,
            region:    sample.region    || null,
            techStack: sample.techStack || null,
            owners:    { connect: [{ id: req.userId }] },
          },
        });
        accountsCreated += 1;
      } else if (req.userId) {
        await prisma.account.update({
          where: { id: account.id },
          data: { owners: { connect: [{ id: req.userId }] } },
        }).catch(() => { /* already owned */ });
      }
      const linkResult = await prisma.prospect.updateMany({
        where: { companyName: sample.companyName, accountId: null },
        data: { accountId: account.id },
      });
      prospectsLinked += linkResult.count;
    }

    res.json({ accountsCreated, prospectsLinked });
  } catch (err) {
    console.error('[accounts/backfill]', err);
    res.status(500).json({ message: err.message });
  }
});

// POST /accounts/auto-link — auto-link prospects to accounts by matching companyName
router.post('/auto-link', async (req, res) => {
  try {
    const accounts = await prisma.account.findMany({ select: { id: true, name: true } });
    let linked = 0;
    for (const acc of accounts) {
      const result = await prisma.prospect.updateMany({
        where: { companyName: { equals: acc.name }, accountId: null },
        data: { accountId: acc.id },
      });
      linked += result.count;
    }
    res.json({ linked });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
