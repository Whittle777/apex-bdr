/**
 * Research routes — accept a list of parsed ZoomInfo-CSV prospects, upsert
 * them via the shared bulk helper, then kick off an async job that scrapes
 * LinkedIn (Apify) and summarises each via the configured LLM.
 *
 * State lives in an in-memory Map keyed by jobId. Cleanup interval drops
 * entries older than 1 hour. Survives only until backend restart — that's
 * acceptable for V1 (matches the HITL queue pattern).
 */
const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const prisma = require('../services/database');
const { authenticateToken } = require('../middleware/auth');
const { upsertProspectBatch } = require('../services/prospectBulk');
const { runResearchJob } = require('../services/researchEngine');

router.use(authenticateToken);

const jobs = new Map(); // jobId -> job object

setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, job] of jobs.entries()) {
    if (new Date(job.startedAt).getTime() < cutoff) jobs.delete(id);
  }
}, 5 * 60 * 1000);

const PROSPECT_FIELDS_FOR_JOB = [
  'firstName', 'lastName', 'email', 'companyName', 'title', 'phone',
  'country', 'region', 'techStack', 'linkedIn', 'researchBrief',
];

/**
 * POST /research/upload
 * Body: { prospects: [<rows from parseZoomInfoCsv>] }
 * Response: { jobId, prospectCount }
 */
router.post('/upload', async (req, res) => {
  try {
    const prospects = req.body.prospects;
    if (!Array.isArray(prospects) || prospects.length === 0) {
      return res.status(400).json({ message: 'No prospects provided' });
    }

    const apifyCred = await prisma.integrationCredential.findFirst({
      where: { provider: 'apify' },
    });
    const apifyToken = apifyCred?.clientId || null;

    // Upsert into Prospect + Account first so we can attach the brief to a
    // real record. Existing prospects (by email) are reused.
    const { prospectIds, accountsCreated, count } = await upsertProspectBatch({
      prospects,
      userId: req.userId,
    });

    // If the CSV included an "Account Research" column (e.g. from a Claude
    // Enterprise run), dedupe by company name and append onto each Account's
    // researchSummary — same date-prefixed append logic as /research-upload.
    const accountResearchByCompany = new Map();
    for (const p of prospects) {
      const company = (p.companyName || '').trim();
      const research = (p.accountResearch || '').trim();
      if (!company || !research) continue;
      if (!accountResearchByCompany.has(company)) {
        accountResearchByCompany.set(company, research);
      }
    }
    let accountResearchAppended = 0;
    if (accountResearchByCompany.size > 0) {
      const today = new Date().toISOString().slice(0, 10);
      for (const [name, incoming] of accountResearchByCompany.entries()) {
        const acct = await prisma.account.findFirst({ where: { name } });
        if (!acct) continue;
        const prior = (acct.researchSummary || '').trim();
        if (prior.includes(incoming)) continue; // dedupe
        const newSummary = !prior
          ? `[${today}]\n${incoming}`
          : `[${today}]\n${incoming}\n\n${prior}`;
        await prisma.account.update({
          where: { id: acct.id },
          data: { researchSummary: newSummary },
        });
        accountResearchAppended += 1;
      }
    }

    const jobId = crypto.randomBytes(8).toString('hex');
    const job = {
      id: jobId,
      status: 'running',
      total: prospects.length,
      completed: 0,
      failed: 0,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      accountsCreated,
      accountResearchAppended,
      prospectsCreated: count,
      apifyConfigured: !!apifyToken,
      items: prospects.map(p => ({
        status: 'pending',
        prospectId: prospectIds[p.email] || null,
        prospect: Object.fromEntries(
          PROSPECT_FIELDS_FOR_JOB.map(k => [k, p[k] ?? null])
        ),
        // Stash the original parsed row so the export endpoint can write a
        // CSV with all the original columns plus the brief.
        original: p,
        brief: null,
        scraped: false,
        error: null,
      })),
    };
    jobs.set(jobId, job);

    // Fire-and-forget; errors per item are caught inside runResearchJob.
    runResearchJob(job, apifyToken).catch(err => {
      console.error('[research] job', jobId, 'fatal:', err);
      job.status = 'failed';
      job.error = err.message;
    });

    res.status(202).json({
      jobId,
      prospectCount: prospects.length,
      accountsCreated,
      accountResearchAppended,
      apifyConfigured: !!apifyToken,
    });
  } catch (err) {
    console.error('[research] upload failed:', err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * GET /research/jobs/:id
 * Returns the job snapshot the frontend polls every 2s.
 */
router.get('/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ message: 'Job not found' });

  res.json({
    id: job.id,
    status: job.status,
    total: job.total,
    completed: job.completed,
    failed: job.failed,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    accountsCreated: job.accountsCreated,
    prospectsCreated: job.prospectsCreated,
    apifyConfigured: job.apifyConfigured,
    error: job.error || null,
    items: job.items.map(item => ({
      status: item.status,
      prospectId: item.prospectId,
      firstName: item.prospect.firstName,
      lastName: item.prospect.lastName,
      email: item.prospect.email,
      companyName: item.prospect.companyName,
      title: item.prospect.title,
      linkedIn: item.prospect.linkedIn,
      scraped: item.scraped,
      brief: item.brief,
      error: item.error,
    })),
  });
});

/**
 * GET /research/jobs/:id/export
 * Streams a CSV: original columns from the upload + a final "Research Brief".
 */
router.get('/jobs/:id/export', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ message: 'Job not found' });

  const rows = job.items.map(i => ({ ...i.original, 'Research Brief': i.brief || '' }));
  if (rows.length === 0) {
    return res.status(200).type('text/csv').send('');
  }

  const headers = Array.from(
    rows.reduce((set, row) => {
      Object.keys(row).forEach(k => set.add(k));
      return set;
    }, new Set())
  );

  const escape = (v) => {
    if (v == null) return '';
    const s = String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const lines = [
    headers.join(','),
    ...rows.map(row => headers.map(h => escape(row[h])).join(',')),
  ];
  const csv = lines.join('\r\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="research-${job.id}.csv"`
  );
  res.send(csv);
});

module.exports = router;
