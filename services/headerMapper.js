/**
 * Header mapper — Track A improvement.
 *
 * Given a list of spreadsheet column headers + a few sample data rows,
 * propose a mapping { columnHeader -> AccountField | "notes" | "skip" }.
 *
 * Strategy:
 *   1. Try AI mapping (Gemini/Claude via aiProvider). If it works, use it.
 *   2. Fall back to deterministic exact-match against the legacy HEADER_MAP.
 *   3. Unknown headers default to "notes" (catch-all) so nothing is silently lost.
 *
 * The AI proposes the mapping; the user confirms it via UI before commit, so
 * the AI doesn't get the final say.
 */
const { generate, status: aiStatus } = require('./aiProvider');

// Account fields the AI may map to. Keep in sync with `ALLOWED` in routes/accounts.js
// and the schema. `_skip` and `notes` are reserved meta values.
const ACCOUNT_FIELDS = [
  // identity / classification
  'name', 'domain', 'website', 'industry', 'subIndustry', 'revenue', 'employees',
  'country', 'region', 'city', 'description', 'status', 'tier', 'techStack',
  'linkedInUrl', 'twitterUrl', 'foundedYear',
  // FY27 / outreach
  'priorityTier', 'dealMotion', 'targetCloseDate', 'closeQuarter', 'useCases',
  'primaryStakeholder', 'backupStakeholders', 'warmIntroPaths', 'weeklyFocus',
  'outreachStatus', 'lastContactedAt', 'myNotes', 'rep',
  // catch-all
  'notes',
];

const FIELD_DESCRIPTIONS = {
  name:              'Company / account name. REQUIRED — used as upsert key.',
  domain:            'Primary domain, e.g. acme.com',
  website:           'Full website URL',
  industry:          'Top-level industry / vertical',
  subIndustry:       'Sub-vertical / category',
  revenue:           'Revenue band, e.g. "$10M-$50M"',
  employees:         'Headcount band',
  country:           'Country',
  region:            'State / region / province',
  city:              'City',
  description:       'Short company description',
  status:            'prospect | customer | churned | partner',
  tier:              'enterprise | mid-market | smb (legacy)',
  techStack:         'Detected tech stack',
  linkedInUrl:       'LinkedIn company page',
  twitterUrl:        'Twitter / X URL',
  foundedYear:       'Year founded (int)',
  priorityTier:      'Outreach priority, e.g. A-Existing, A-Priority, B-Pursue, B-Watch, Tier 1, Tier 2',
  dealMotion:        'Sales motion, e.g. "Net-New Pursuit"',
  targetCloseDate:   'Target close date (parsed as date)',
  closeQuarter:      'Target close quarter, e.g. "Q2 (Aug-Oct 2026)"',
  useCases:          'Top use cases / pain points to anchor outreach on (key personalization field)',
  primaryStakeholder:'Main decision-maker / contact at the account',
  backupStakeholders:'Secondary stakeholders',
  warmIntroPaths:    'Mutual connections or warm-intro paths',
  weeklyFocus:       'Weekly cadence / key gates / focus areas',
  outreachStatus:    'Current outreach state, e.g. "Not Started", "Research Phase"',
  lastContactedAt:   'Last contact date (parsed as date)',
  myNotes:           'Personal notes from the rep',
  rep:               'Owning rep / SDR / BDR name',
  notes:             'Catch-all bucket. Use for any research/context that does not match other fields — content is concatenated as "<header>: <value>" lines.',
};

function normalize(s) {
  return (s == null ? '' : String(s)).trim().toLowerCase();
}

// Deterministic fallback (used if AI is not configured or fails)
const FALLBACK_HEADER_MAP = {
  'company':                       'name',
  'company name':                  'name',
  'account':                       'name',
  'account name':                  'name',
  'revenue':                       'revenue',
  'category':                      'subIndustry',
  'sub-industry':                  'subIndustry',
  'vertical':                      'industry',
  'industry':                      'industry',
  'location':                      'city',
  'country':                       'country',
  'region':                        'region',
  'state':                         'region',
  'city':                          'city',
  'priority tier':                 'priorityTier',
  'priority':                      'priorityTier',
  'deal motion':                   'dealMotion',
  'target close':                  'targetCloseDate',
  'target close date':             'targetCloseDate',
  'close quarter':                 'closeQuarter',
  'quarter':                       'closeQuarter',
  'top c3 ai use cases':           'useCases',
  'use cases':                     'useCases',
  'pain points':                   'useCases',
  'primary stakeholder':           'primaryStakeholder',
  'stakeholder':                   'primaryStakeholder',
  'backup stakeholders':           'backupStakeholders',
  'warm intro paths':              'warmIntroPaths',
  'warm intro':                    'warmIntroPaths',
  'q1 weekly focus':               'weeklyFocus',
  'q1 weekly focus (key gates)':   'weeklyFocus',
  'weekly focus':                  'weeklyFocus',
  'outreach status':               'outreachStatus',
  'status':                        'outreachStatus',
  'last contact date':             'lastContactedAt',
  'last contacted':                'lastContactedAt',
  'my notes':                      'myNotes',
  'notes':                         'notes',
  'rep':                           'rep',
  'owner':                         'rep',
  'sdr':                           'rep',
  'bdr':                           'rep',
  'domain':                        'domain',
  'website':                       'website',
  'linkedin':                      'linkedInUrl',
  'linkedin url':                  'linkedInUrl',
  'twitter':                       'twitterUrl',
  'description':                   'description',
  'tech stack':                    'techStack',
  'employees':                     'employees',
  'headcount':                     'employees',
  'founded':                       'foundedYear',
  'founded year':                  'foundedYear',
};

function fallbackMap(headers) {
  const mapping = {};
  for (const h of headers) {
    if (!h) continue;
    const key = normalize(h);
    if (FALLBACK_HEADER_MAP[key]) {
      mapping[h] = FALLBACK_HEADER_MAP[key];
    } else {
      mapping[h] = 'notes'; // unknown -> catch-all
    }
  }
  return mapping;
}

const SYSTEM_PROMPT = `You map spreadsheet columns to a fixed schema of Account fields.
Output strict JSON only: { "mapping": { "<column header>": "<field name or _skip>" }, "reasoning": "<one sentence>" }
Use "notes" for any column whose content is useful research context but doesn't match a specific field — it becomes a catch-all bucket.
Use "_skip" for columns that are empty, contain row numbers / IDs, or are otherwise junk.
You MUST map exactly one column to "name" — that's the upsert key.
Return ONLY columns that were in the input.`;

function buildUserPrompt(headers, sampleRows) {
  const fieldsBlock = ACCOUNT_FIELDS
    .map(f => `  - ${f}: ${FIELD_DESCRIPTIONS[f] || ''}`)
    .join('\n');
  const rowsBlock = sampleRows.slice(0, 3).map((r, i) => {
    const obj = {};
    headers.forEach((h, j) => { if (h) obj[h] = r[j]; });
    return `Row ${i + 1}: ${JSON.stringify(obj)}`;
  }).join('\n');
  return `=== AVAILABLE FIELDS ===\n${fieldsBlock}\n\n=== SPREADSHEET HEADERS ===\n${JSON.stringify(headers)}\n\n=== SAMPLE ROWS ===\n${rowsBlock}\n\n=== TASK ===\nMap each header to the best field, "notes", or "_skip". Output JSON.`;
}

/**
 * Propose a mapping for the given headers + sample rows.
 * Returns { mapping, provider, model, source: 'ai' | 'fallback', reasoning? }.
 */
async function proposeMapping(headers, sampleRows) {
  const s = await aiStatus();
  if (!s.configured) {
    return { mapping: fallbackMap(headers), source: 'fallback', reasoning: 'No AI provider configured — used keyword matching' };
  }

  try {
    const result = await generate({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: buildUserPrompt(headers, sampleRows),
      mode: 'thorough',
      json: true,
    });
    let parsed;
    try {
      let txt = result.text.trim();
      if (txt.startsWith('```')) txt = txt.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
      parsed = JSON.parse(txt);
    } catch (e) {
      // Last resort: try to extract JSON
      const m = result.text.match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]);
      else throw e;
    }

    const aiMapping = parsed.mapping || {};
    // Sanitize: ensure every header is present; normalize values to known fields/_skip/notes
    const mapping = {};
    for (const h of headers) {
      if (!h) continue;
      const proposed = aiMapping[h];
      if (proposed === '_skip') mapping[h] = '_skip';
      else if (ACCOUNT_FIELDS.includes(proposed)) mapping[h] = proposed;
      else mapping[h] = 'notes';
    }
    // Ensure at least one column maps to 'name'
    const hasName = Object.values(mapping).includes('name');
    if (!hasName) {
      // Try to find a likely company column via fallback heuristics
      for (const h of headers) {
        if (!h) continue;
        if (FALLBACK_HEADER_MAP[normalize(h)] === 'name') {
          mapping[h] = 'name';
          break;
        }
      }
    }

    return {
      mapping,
      source: 'ai',
      provider: result.provider,
      model: result.model,
      reasoning: parsed.reasoning || '',
    };
  } catch (err) {
    // AI failed — fall back deterministically
    return {
      mapping: fallbackMap(headers),
      source: 'fallback',
      reasoning: `AI mapping failed (${err.message.slice(0, 100)}) — used keyword matching`,
    };
  }
}

module.exports = { proposeMapping, ACCOUNT_FIELDS, FIELD_DESCRIPTIONS, FALLBACK_HEADER_MAP };
