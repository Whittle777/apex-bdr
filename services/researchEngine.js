/**
 * Research engine — orchestrates LinkedIn scrape (Apify) + LLM summarisation
 * for a list of prospects.
 *
 * Job state lives in-memory; the engine writes the final brief to the
 * Prospect record once each prospect finishes. A separate cleanup interval
 * (owned by routes/research.js) drops job records after 1h.
 */
const axios = require('axios');
const { PrismaClient } = require('@prisma/client');
const { generate } = require('./aiProvider');

const prisma = new PrismaClient();

const APIFY_ACTOR_ID = '2SyF0bVxmgGr8IVCZ'; // dev_fusion/linkedin-profile-scraper
const APIFY_SYNC_URL = (token) =>
  `https://api.apify.com/v2/acts/${APIFY_ACTOR_ID}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;

const CONCURRENCY = 3;

/**
 * Call the Apify LinkedIn scraper synchronously for one profile URL.
 * Returns the first dataset item or null on failure.
 */
async function scrapeLinkedIn(url, apifyToken) {
  if (!url || !apifyToken) return null;
  try {
    const resp = await axios.post(
      APIFY_SYNC_URL(apifyToken),
      { profileUrls: [url] },
      { headers: { 'Content-Type': 'application/json' }, timeout: 5 * 60 * 1000 }
    );
    const items = Array.isArray(resp.data) ? resp.data : [];
    return items[0] || null;
  } catch (err) {
    console.warn('[research] LinkedIn scrape failed for', url, '-', err.response?.data || err.message);
    return null;
  }
}

/**
 * Build a compact representation of the LinkedIn payload to inline in the
 * LLM prompt. Apify returns a lot of fields; we keep only the high-signal
 * ones to control token count.
 */
function compactLinkedInForPrompt(data) {
  if (!data || typeof data !== 'object') return null;
  return {
    headline:    data.headline,
    fullName:    data.fullName,
    jobTitle:    data.jobTitle,
    companyName: data.companyName,
    jobLocation: data.jobLocation,
    connections: data.connections,
    followers:   data.followers,
    about:       typeof data.about === 'string' ? data.about.slice(0, 800) : undefined,
    experiences: Array.isArray(data.experiences) ? data.experiences.slice(0, 4).map(e => ({
      title:    e.title || e.position || e.jobTitle,
      company:  e.company || e.companyName,
      duration: e.duration || e.period,
      location: e.location,
    })) : undefined,
    educations:  Array.isArray(data.educations) ? data.educations.slice(0, 3).map(e => ({
      school:    e.school || e.university || e.name,
      degree:    e.degree,
      field:     e.fieldOfStudy || e.field,
    })) : undefined,
    skills:      Array.isArray(data.skills) ? data.skills.slice(0, 10) : undefined,
  };
}

/**
 * Generate a natural-language research brief for one prospect.
 */
async function generateBrief({ prospect, linkedInData }) {
  const compact = compactLinkedInForPrompt(linkedInData);
  const linkedInBlock = compact
    ? `LinkedIn profile (scraped):\n${JSON.stringify(compact, null, 2)}`
    : 'LinkedIn profile: not available.';

  const userPrompt = `Prospect:
  Name: ${prospect.firstName} ${prospect.lastName}
  Title: ${prospect.title || 'unknown'}
  Company: ${prospect.companyName || 'unknown'}
  Country / Region: ${prospect.country || '-'} / ${prospect.region || '-'}
  Industry / dept: ${prospect.techStack || '-'}

${linkedInBlock}

Write a 3–5 sentence research brief on this prospect for an SDR preparing
outreach. Focus on:
 - Their role's likely priorities, pain points, and budget posture.
 - The company's situation, industry context, and any timely angle.
 - Distinctive angles from LinkedIn (recent moves, notable past roles,
   shared backgrounds the SDR could namedrop) — only if present in the data.

Output plain prose only — no bullet points, no preamble, no headings, no
"Here is the brief". Start directly with the substance.`;

  const systemPrompt =
    'You are an experienced B2B sales research analyst writing concise, ' +
    'actionable prospect briefs for SDRs. You write in flowing prose, ' +
    'never use bullet points, and never invent facts not in the input.';

  const { text } = await generate({
    systemPrompt,
    userPrompt,
    mode: 'fast',
    json: false,
  });
  return text;
}

/**
 * Build the chunked-concurrency executor: at most CONCURRENCY items run
 * concurrently; the loop tracks per-item status in the shared job object.
 */
async function runResearchJob(job, apifyToken) {
  const queue = job.items.map((item, idx) => ({ item, idx }));
  let cursor = 0;

  const next = async () => {
    while (cursor < queue.length) {
      const { item, idx } = queue[cursor++];
      await processOne(job, item, idx, apifyToken);
    }
  };

  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => next());
  await Promise.all(workers);

  job.status = 'complete';
  job.finishedAt = new Date().toISOString();
}

async function processOne(job, item, idx, apifyToken) {
  try {
    item.status = 'scraping';
    let linkedInData = null;
    if (item.prospect.linkedIn && apifyToken) {
      linkedInData = await scrapeLinkedIn(item.prospect.linkedIn, apifyToken);
      item.scraped = !!linkedInData;
    }

    item.status = 'summarizing';
    const brief = await generateBrief({
      prospect: item.prospect,
      linkedInData,
    });

    if (item.prospectId) {
      await prisma.prospect.update({
        where: { id: item.prospectId },
        data: { researchBrief: brief, enrichmentStatus: 'enriched' },
      });
    }

    item.brief = brief;
    item.status = 'done';
    job.completed += 1;
  } catch (err) {
    console.error('[research] item', idx, 'failed:', err.message);
    item.status = 'failed';
    item.error = err.message || String(err);
    job.failed += 1;
  }
}

module.exports = { scrapeLinkedIn, generateBrief, runResearchJob };
