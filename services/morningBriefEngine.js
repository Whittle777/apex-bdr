/**
 * Morning Brief engine — ranks target accounts for overnight sales review.
 *
 * Design goals:
 *  - Deterministic, explainable scoring. Same inputs => same outputs.
 *  - Never invent sources. Every signal must carry a supplied sourceUrl, or
 *    it is dropped from the brief.
 *  - Human approval is preserved by the caller; this engine only *drafts* a
 *    recommended action + call opener. It sends nothing.
 *  - Demo/fixture data is explicitly labelled so no one mistakes it for live intel.
 *
 * Scoring is composed from five weighted sub-scores (each 0..1), then scaled
 * to a 0..100 integer:
 *
 *   trigger   — how recent / relevant the dated trigger is
 *   fit       — how well the account matches the ICP
 *   urgency   — how soon the buying window is closing
 *   coverage  — how well sourced the account is (more independent URLs = more trust)
 *   disqualifier — penalty multiplier when red flags are present (1.0 = none)
 *
 *   rawScore  = 100 * (0.30*trigger + 0.25*fit + 0.20*urgency + 0.15*coverage) * disqualifier
 *
 * Pure helpers (scoreAccount, rankAccounts, buildCard, buildSummary,
 * getDemoTargets) are exported for unit testing without DB/network.
 * runMorningBrief is the async entry point used by routes + CLI.
 */

'use strict';

const { discoverSignalsForTargets } = require('./signalDiscovery');

// ── Weighting (centralized so tests can pin it) ──────────────────────────────
const WEIGHTS = Object.freeze({
  trigger: 0.30,
  fit: 0.25,
  urgency: 0.20,
  coverage: 0.15,
  // remaining 0.10 reserved for a future "momentum" signal; not used yet so
  // rawScore max stays 90 when coverage is perfect, which is intentional —
  // no account should hit 100 on draft data alone.
});
const DISQUALIFIER_WEIGHT = 0.10; // absent from WEIGHTS sum on purpose

const MAX_SCORE = 100;

// ── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Days between two YYYY-MM-DD dates (b - a), rounded down. Returns null if
 * either date is unparseable. Deterministic — no Date.now.
 */
function daysBetween(a, b) {
  if (!a || !b) return null;
  const da = new Date(a + 'T00:00:00Z');
  const db = new Date(b + 'T00:00:00Z');
  if (Number.isNaN(da.getTime()) || Number.isNaN(db.getTime())) return null;
  return Math.floor((db.getTime() - da.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Trigger sub-score (0..1). More recent triggers score higher, decaying over
 * 30 days and flooring at 0 beyond 60 days. A missing triggerDate yields 0.
 *
 *   ageDays <= 0  -> 1.0  (today / future-dated)
 *   0 < age <= 30 -> linear decay from 1.0 to 0.5
 *   30 < age <=60 -> linear decay from 0.5 to 0.1
 *   age > 60      -> 0
 */
function scoreTrigger(triggerDate, asOf) {
  if (!triggerDate) return 0;
  const age = daysBetween(triggerDate, asOf);
  if (age === null) return 0;
  if (age <= 0) return 1.0;
  if (age <= 30) return 1.0 - (age / 30) * 0.5;       // 1.0 -> 0.5
  if (age <= 60) return 0.5 - ((age - 30) / 30) * 0.4; // 0.5 -> 0.1
  return 0;
}

/**
 * Fit sub-score (0..1). Based on ICP signals present on the account:
 *  - industry in the target industry set  -> +0.4
 *  - employee band in target range        -> +0.3
 *  - revenue band in target range         -> +0.3
 * Capped at 1.0. Missing fields contribute 0 (never invented).
 */
function scoreFit(account) {
  const icp = account.icp || {};
  let s = 0;
  const ind = (account.industry || '').toLowerCase();
  if (icp.industries && Array.isArray(icp.industries)) {
    if (icp.industries.some(i => String(i).toLowerCase() === ind)) s += 0.4;
  }
  const emp = Number(account.employees);
  if (!Number.isNaN(emp) && icp.minEmployees != null && icp.maxEmployees != null) {
    if (emp >= icp.minEmployees && emp <= icp.maxEmployees) s += 0.3;
  }
  const rev = parseRevenueBand(account.revenue);
  if (rev != null && icp.minRevenue != null && icp.maxRevenue != null) {
    if (rev >= icp.minRevenue && rev <= icp.maxRevenue) s += 0.3;
  }
  return clamp01(s);
}

/**
 * Urgency sub-score (0..1). Driven by a target close date / deal window:
 *   no closeDate                    -> 0
 *   closeDate in the past           -> 0.1 (stale, low urgency)
 *   <= 30 days out                  -> 1.0
 *   31-90 days out                  -> linear 0.9 -> 0.4
 *   > 90 days out                   -> 0.2
 */
function scoreUrgency(closeDate, asOf) {
  if (!closeDate) return 0;
  const days = daysBetween(asOf, closeDate);
  if (days === null) return 0;
  if (days < 0) return 0.1;
  if (days <= 30) return 1.0;
  if (days <= 90) return 0.9 - ((days - 30) / 60) * 0.5; // 0.9 -> 0.4
  return 0.2;
}

/**
 * Coverage sub-score (0..1). Rewards multiple *independent* source URLs.
 * Only URLs actually supplied on signals are counted — never invented.
 *   0 sources -> 0
 *   1 source  -> 0.4
 *   2 sources -> 0.7
 *   3+ sources -> 1.0
 */
function scoreCoverage(account) {
  const urls = collectSourceUrls(account);
  const n = urls.size;
  if (n <= 0) return 0;
  if (n === 1) return 0.4;
  if (n === 2) return 0.7;
  return 1.0;
}

/**
 * Disqualifier multiplier (0..1). Starts at 1.0; each present disqualifier
 * flag multiplies by DISQUALIFIER_WEIGHT. Flags come from account.disqualifiers
 * (array of strings) — e.g. "acquired", "bankrupt", "competitor_customer".
 */
function scoreDisqualifier(account) {
  const flags = Array.isArray(account.disqualifiers) ? account.disqualifiers : [];
  let mult = 1.0;
  for (const _f of flags) mult *= (1 - DISQUALIFIER_WEIGHT);
  return clamp01(mult);
}

/**
 * Full deterministic score for one account given an as-of date.
 * Returns { total, breakdown } where breakdown has each sub-score and the
 * weighted contribution, so the card can render an explanation.
 */
function scoreAccount(account, asOf) {
  const asOfDate = asOf || todayUTC();

  const trigger = scoreTrigger(account.triggerDate, asOfDate);
  const fit = scoreFit(account);
  const urgency = scoreUrgency(account.closeDate, asOfDate);
  const coverage = scoreCoverage(account);
  const disqualifier = scoreDisqualifier(account);

  const weighted =
    WEIGHTS.trigger * trigger +
    WEIGHTS.fit * fit +
    WEIGHTS.urgency * urgency +
    WEIGHTS.coverage * coverage;

  const total = Math.round(weighted * MAX_SCORE * disqualifier);

  return {
    total,
    breakdown: {
      trigger: { raw: round2(trigger), weight: WEIGHTS.trigger, contribution: round2(trigger * WEIGHTS.trigger) },
      fit: { raw: round2(fit), weight: WEIGHTS.fit, contribution: round2(fit * WEIGHTS.fit) },
      urgency: { raw: round2(urgency), weight: WEIGHTS.urgency, contribution: round2(urgency * WEIGHTS.urgency) },
      coverage: { raw: round2(coverage), weight: WEIGHTS.coverage, contribution: round2(coverage * WEIGHTS.coverage) },
      disqualifier: { multiplier: round2(disqualifier), flags: Array.isArray(account.disqualifiers) ? account.disqualifiers : [] },
    },
  };
}

/**
 * Rank accounts by total score desc, then by name asc as a stable tiebreak.
 * Returns a new array; does not mutate input.
 */
function rankAccounts(accounts, asOf) {
  const scored = accounts.map(a => ({ account: a, score: scoreAccount(a, asOf) }));
  scored.sort((x, y) => {
    if (y.score.total !== x.score.total) return y.score.total - x.score.total;
    return String(x.account.name || '').localeCompare(String(y.account.name || ''));
  });
  return scored;
}

/**
 * Collect every distinct source URL referenced by the account's signals.
 * Signals without a sourceUrl are NOT counted (and are surfaced separately
 * as unsourced so the UI can warn). Returns a Set<string>.
 */
function collectSourceUrls(account) {
  const urls = new Set();
  const signals = Array.isArray(account.signals) ? account.signals : [];
  for (const sig of signals) {
    const u = sig && sig.sourceUrl;
    if (typeof u === 'string' && u.trim()) urls.add(u.trim());
  }
  return urls;
}

/**
 * Build a single ranked "card" object for the brief. Separates sourced
 * signals from unsourced ones so the UI can render evidence + warnings.
 */
function buildCard(entry, rank, asOf) {
  const { account, score } = entry;
  const signals = Array.isArray(account.signals) ? account.signals : [];
  const sourced = signals.filter(s => s && typeof s.sourceUrl === 'string' && s.sourceUrl.trim());
  const unsourced = signals.filter(s => !s || !s.sourceUrl || !String(s.sourceUrl).trim());

  const evidence = sourced.map(s => ({
    claim: s.claim || '',
    type: s.type || 'general',
    date: s.date || null,
    sourceUrl: s.sourceUrl.trim(),
    description: s.description || null,
    publisher: s.publisher || null,
    publisherUrl: s.publisherUrl || null,
    signalScore: s.signalScore ?? null,
    fresh: s.fresh ?? null,
    dated: s.dated ?? Boolean(s.date),
    relevant: s.relevant ?? null,
    thirdParty: s.thirdParty ?? null,
    ownSite: s.ownSite ?? null,
    suggestedPersona: s.suggestedPersona || null,
    suggestedQuestion: s.suggestedQuestion || null,
    suggestedAngle: s.suggestedAngle || null,
  }));

  const recommendedAction = recommendAction(account, score, asOf);
  const draftOpener = draftCallOpener(account, recommendedAction);
  const triggerSignal = evidence
    .filter(signal => signal.type !== 'fit')
    .sort((a, b) => {
      if ((b.signalScore || 0) !== (a.signalScore || 0)) return (b.signalScore || 0) - (a.signalScore || 0);
      return String(b.date || '').localeCompare(String(a.date || ''));
    })[0] || null;

  return {
    rank,
    account: {
      name: account.name || 'Unknown',
      domain: account.domain || null,
      industry: account.industry || null,
      employees: account.employees || null,
      revenue: account.revenue || null,
      region: account.region || null,
    },
    score: score.total,
    scoreBreakdown: score.breakdown,
    confidence: computeConfidence(score, sourced.length),
    triggerDate: account.triggerDate || null,
    closeDate: account.closeDate || null,
    signals: evidence,
    triggerSignal,
    outreachAngle: triggerSignal?.suggestedAngle || null,
    outreachPlan: triggerSignal ? {
      persona: triggerSignal.suggestedPersona || null,
      question: triggerSignal.suggestedQuestion || null,
      channel: recommendedAction.channel,
    } : null,
    unsourcedSignals: unsourced.map(s => ({ claim: s?.claim || '', type: s?.type || 'general', date: s?.date || null })),
    disqualifiers: Array.isArray(account.disqualifiers) ? account.disqualifiers : [],
    recommendedAction,
    draftCallOpener: draftOpener,
  };
}

/**
 * Confidence is a 0..1 heuristic combining score strength and source count.
 *   <2 sources OR score <20 -> low (<=0.4)
 *   2 sources, score 20-60  -> medium (0.5-0.7)
 *   3+ sources, score >60   -> high (>0.7)
 */
function computeConfidence(score, sourceCount) {
  const s = score.total / MAX_SCORE;
  const c = sourceCount >= 3 ? 1.0 : sourceCount === 2 ? 0.7 : sourceCount === 1 ? 0.4 : 0.1;
  const blended = clamp01((s * 0.6) + (c * 0.4));
  return round2(blended);
}

/**
 * Deterministic recommended action. Based on score band + disqualifiers.
 * Returns { action, rationale, channel }.
 */
function recommendAction(account, score, asOf) {
  const flags = Array.isArray(account.disqualifiers) ? account.disqualifiers : [];
  if (flags.length > 0) {
    return {
      action: 'Hold — review disqualifiers before outreach',
      rationale: `Disqualifier flags present: ${flags.join(', ')}. Do not outreach until cleared by a human.`,
      channel: 'none',
    };
  }
  if (score.total >= 70) {
    return {
      action: 'Prioritize — schedule executive intro call this week',
      rationale: 'High score: strong recent trigger, good fit, and closing window with solid source coverage.',
      channel: 'call',
    };
  }
  if (score.total >= 40) {
    return {
      action: 'Nurture — send tailored insight + propose a discovery call',
      rationale: 'Moderate score: worth a personalised touch but not top priority today.',
      channel: 'email',
    };
  }
  return {
    action: 'Monitor — re-evaluate when a fresh trigger lands',
    rationale: 'Low score: insufficient recency/fit/urgency or thin sourcing. No outreach yet.',
    channel: 'none',
  };
}

/**
 * Draft a call opener string. Never sends; just text for human review.
 * Uses only supplied account fields. Falls back gracefully on missing data.
 */
function draftCallOpener(account, recommendedAction) {
  const name = account.name || 'your team';
  const trigger = (account.signals || [])
    .filter(s => s && s.sourceUrl && s.type !== 'fit')
    .sort((a, b) => {
      if ((b.signalScore || 0) !== (a.signalScore || 0)) return (b.signalScore || 0) - (a.signalScore || 0);
      return String(b.date || '').localeCompare(String(a.date || ''));
    })[0];
  const triggerLine = trigger && trigger.claim
    ? `I noticed ${String(trigger.claim).replace(/\.$/, '')}`
    : null;

  if (recommendedAction.channel === 'none') {
    return null; // no opener when we're not recommending contact
  }

  const opener = triggerLine
    ? `Hi ${name} team — ${triggerLine}, and I wanted to share how peers are responding.${trigger?.suggestedQuestion ? ` ${trigger.suggestedQuestion}` : ''}`
    : `Hi ${name} team — I work with ${account.industry || 'enterprise'} teams on similar initiatives and wanted to connect.`;
  return opener;
}

/**
 * Summary counts across the ranked set.
 */
function buildSummary(cards) {
  const total = cards.length;
  let high = 0, medium = 0, low = 0, hold = 0, unsourcedSignalCount = 0;
  for (const c of cards) {
    if (c.recommendedAction.channel === 'none' && c.disqualifiers.length > 0) hold += 1;
    if (c.score >= 70) high += 1;
    else if (c.score >= 40) medium += 1;
    else low += 1;
    unsourcedSignalCount += c.unsourcedSignals.length;
  }
  return { total, high, medium, low, hold, unsourcedSignalCount };
}

// ── Small utilities ──────────────────────────────────────────────────────────

function clamp01(x) { return Math.max(0, Math.min(1, x)); }
function round2(x) { return Math.round(x * 100) / 100; }

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Parse a revenue value that may be a number or a string like "$1.2B" / "500M".
 * Returns a number in absolute dollars, or null if unparseable.
 */
function parseRevenueBand(input) {
  if (input == null) return null;
  if (typeof input === 'number') return input;
  const s = String(input).trim().toLowerCase().replace(/[$,\s]/g, '');
  if (!s) return null;
  const m = s.match(/^([\d.]+)([bmk])?$/);
  if (!m) return null;
  const num = parseFloat(m[1]);
  if (Number.isNaN(num)) return null;
  const unit = m[2];
  if (unit === 'b') return num * 1e9;
  if (unit === 'm') return num * 1e6;
  if (unit === 'k') return num * 1e3;
  return num;
}

// ── Demo fixture ─────────────────────────────────────────────────────────────
/**
 * Five synthetic public-company-style target rows with public source URLs.
 * Every claim carries a real, public source URL so the demo is honest about
 * provenance. All content is explicitly labelled demo/fixture downstream.
 *
 * Source URLs point to publicly reachable pages (company IR / press / SEC
 * filings) — these are real public URLs, not invented article links.
 */
function getDemoTargets() {
  const asOf = todayUTC();
  return {
    asOf,
    demo: true,
    targets: [
      {
        name: 'Snowflake Inc.',
        domain: 'snowflake.com',
        industry: 'Technology',
        employees: 7000,
        revenue: '$3.4B',
        region: 'US',
        triggerDate: recentDate(asOf, -3),
        closeDate: recentDate(asOf, 45),
        icp: { industries: ['Technology', 'Software'], minEmployees: 500, maxEmployees: 50000, minRevenue: 1e8, maxRevenue: 1e10 },
        disqualifiers: [],
        signals: [
          { type: 'trigger', claim: 'Snowflake reported product revenue growth in its latest earnings.', date: recentDate(asOf, -3), sourceUrl: 'https://investors.snowflake.com/financials/quarterly-results/default.aspx' },
          { type: 'news', claim: 'Snowflake announced Neeva acquisition to bolster AI search.', date: recentDate(asOf, -10), sourceUrl: 'https://www.snowflake.com/news/press-releases/' },
          { type: 'fit', claim: 'Listed ICP industry match: Technology / Software.', date: recentDate(asOf, -1), sourceUrl: 'https://www.snowflake.com/company/' },
        ],
      },
      {
        name: 'Palantir Technologies Inc.',
        domain: 'palantir.com',
        industry: 'Software',
        employees: 3800,
        revenue: '$2.2B',
        region: 'US',
        triggerDate: recentDate(asOf, -7),
        closeDate: recentDate(asOf, 75),
        icp: { industries: ['Technology', 'Software'], minEmployees: 500, maxEmployees: 50000, minRevenue: 1e8, maxRevenue: 1e10 },
        disqualifiers: [],
        signals: [
          { type: 'trigger', claim: 'Palantir filed its latest 10-Q with the SEC.', date: recentDate(asOf, -7), sourceUrl: 'https://investors.palantir.com/financial-information/sec-filings/default.aspx' },
          { type: 'news', claim: 'Palantir announced expanded AIP bootcamp program.', date: recentDate(asOf, -14), sourceUrl: 'https://www.palantir.com/news/' },
        ],
      },
      {
        name: 'MongoDB, Inc.',
        domain: 'mongodb.com',
        industry: 'Software',
        employees: 4500,
        revenue: '$1.7B',
        region: 'US',
        triggerDate: recentDate(asOf, -25),
        closeDate: recentDate(asOf, 20),
        icp: { industries: ['Technology', 'Software'], minEmployees: 500, maxEmployees: 50000, minRevenue: 1e8, maxRevenue: 1e10 },
        disqualifiers: [],
        signals: [
          { type: 'trigger', claim: 'MongoDB posted quarterly earnings with Atlas momentum.', date: recentDate(asOf, -25), sourceUrl: 'https://investors.mongodb.com/financials/quarterly-results/default.aspx' },
          { type: 'news', claim: 'MongoDB World developer conference announced.', date: recentDate(asOf, -20), sourceUrl: 'https://www.mongodb.com/newsroom' },
        ],
      },
      {
        name: 'GitLab Inc.',
        domain: 'gitlab.com',
        industry: 'Software',
        employees: 2000,
        revenue: '$580M',
        region: 'US',
        triggerDate: recentDate(asOf, -55),
        closeDate: recentDate(asOf, 110),
        icp: { industries: ['Technology', 'Software'], minEmployees: 500, maxEmployees: 50000, minRevenue: 1e8, maxRevenue: 1e10 },
        disqualifiers: ['competitor_customer'],
        signals: [
          { type: 'trigger', claim: 'GitLab released latest version with AI features.', date: recentDate(asOf, -55), sourceUrl: 'https://about.gitlab.com/releases/categories/releases/' },
        ],
      },
      {
        name: 'Elastic N.V.',
        domain: 'elastic.co',
        industry: 'Software',
        employees: 2500,
        revenue: '$1.2B',
        region: 'Global',
        triggerDate: recentDate(asOf, -2),
        closeDate: null,
        icp: { industries: ['Technology', 'Software'], minEmployees: 500, maxEmployees: 50000, minRevenue: 1e8, maxRevenue: 1e10 },
        disqualifiers: [],
        signals: [
          { type: 'trigger', claim: 'Elastic announced new AI search capabilities.', date: recentDate(asOf, -2), sourceUrl: 'https://www.elastic.co/newsroom' },
          { type: 'fit', claim: 'Elastic company overview confirms ICP industry match.', date: recentDate(asOf, -1), sourceUrl: 'https://www.elastic.co/company' },
        ],
      },
    ],
  };
}

/** Return a YYYY-MM-DD offset by `days` from `base`. days negative = past. */
function recentDate(base, days) {
  const d = new Date(base + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ── Async entry point ────────────────────────────────────────────────────────

/**
 * Run the morning brief over a target list.
 *
 * @param {object} opts
 * @param {Array}  opts.targets  - array of account objects (see demo shape)
 * @param {boolean} opts.demo    - if true (or targets empty), use demo fixture
 * @param {string} [opts.asOf]   - YYYY-MM-DD; defaults to today UTC
 * @returns {Promise<object>} brief object with run metadata, summary, cards
 */
async function runMorningBrief({ targets, demo, asOf, discover = false, discoveryOptions = {} } = {}) {
  const useDemo = demo || !Array.isArray(targets) || targets.length === 0;
  const fixture = useDemo ? getDemoTargets() : null;
  let list = useDemo ? fixture.targets : targets;
  const asOfDate = asOf || (useDemo ? fixture.asOf : todayUTC());
  let discovery = {
    enabled: false,
    provider: null,
    accounts: 0,
    accountsWithSignals: 0,
    freshSignals: 0,
    errors: 0,
  };

  if (!useDemo && discover) {
    const discovered = await discoverSignalsForTargets(list, {
      ...discoveryOptions,
      asOf: asOfDate,
    });
    list = discovered.targets;
    discovery = {
      enabled: true,
      provider: 'google-news-rss',
      ...discovered.summary,
    };
  }

  // Validate + reject any signal that lacks a sourceUrl: we keep the signal
  // but flag it unsourced in the card. We never promote an unsourced claim
  // to evidence.
  const validated = list.map(a => validateAccount(a)).filter(Boolean);

  const ranked = rankAccounts(validated, asOfDate);
  const cards = ranked.map((entry, i) => buildCard(entry, i + 1, asOfDate));
  const summary = buildSummary(cards);

  const runId = makeRunId();
  const generatedAt = new Date().toISOString();

  return {
    runId,
    generatedAt,
    asOf: asOfDate,
    demo: useDemo,
    source: useDemo ? 'fixture' : (discover ? 'live-discovery' : 'supplied'),
    discovery,
    summary,
    cards,
  };
}

/**
 * Validate/normalize one account. Throws nothing; returns null only if the
 * account has no name at all (truly unusable).
 */
function validateAccount(account) {
  if (!account || typeof account !== 'object') return null;
  if (!account.name) return null;
  return account;
}

/**
 * Deterministic run id: time-orderable + short random suffix. Not crypto-secure
 * (that's fine — routes layer adds its own cache key if needed).
 */
function makeRunId() {
  return `mb_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

// ── Markdown rendering (used by CLI; pure) ───────────────────────────────────

/**
 * Render a brief object as a human-readable Markdown report.
 */
function renderMarkdown(brief) {
  const lines = [];
  const demoTag = brief.demo ? ' (DEMO / FIXTURE DATA)' : '';
  lines.push(`# Morning Brief — ${brief.asOf}${demoTag}`);
  lines.push('');
  lines.push(`Run ID: \`${brief.runId}\``);
  lines.push(`Generated: ${brief.generatedAt}`);
  lines.push(`Source: ${brief.source}`);
  if (brief.discovery?.enabled) {
    lines.push(`Live signal discovery: ${brief.discovery.freshSignals} fresh signals across ${brief.discovery.accountsWithSignals} accounts; feed errors: ${brief.discovery.errors}`);
  }
  lines.push('');
  lines.push('## Summary');
  const s = brief.summary;
  lines.push(`- Total accounts: ${s.total}`);
  lines.push(`- High priority: ${s.high}`);
  lines.push(`- Medium priority: ${s.medium}`);
  lines.push(`- Low priority: ${s.low}`);
  lines.push(`- On hold (disqualified): ${s.hold}`);
  lines.push(`- Unsourced signals (ignored as evidence): ${s.unsourcedSignalCount}`);
  lines.push('');

  for (const card of brief.cards) {
    lines.push(`## ${card.rank}. ${card.account.name} — Score ${card.score}`);
    const a = card.account;
    lines.push(`- Industry: ${a.industry || 'n/a'} | Employees: ${a.employees || 'n/a'} | Revenue: ${a.revenue || 'n/a'} | Region: ${a.region || 'n/a'}`);
    if (card.triggerDate) lines.push(`- Trigger date: ${card.triggerDate}`);
    if (card.closeDate) lines.push(`- Target close: ${card.closeDate}`);
    lines.push(`- Confidence: ${card.confidence}`);
    if (card.disqualifiers.length) lines.push(`- Disqualifiers: ${card.disqualifiers.join(', ')}`);
    lines.push('');
    lines.push('### Score breakdown');
    const b = card.scoreBreakdown;
    lines.push(`- trigger: ${b.trigger.raw} (weight ${b.trigger.weight}) -> ${b.trigger.contribution}`);
    lines.push(`- fit: ${b.fit.raw} (weight ${b.fit.weight}) -> ${b.fit.contribution}`);
    lines.push(`- urgency: ${b.urgency.raw} (weight ${b.urgency.weight}) -> ${b.urgency.contribution}`);
    lines.push(`- coverage: ${b.coverage.raw} (weight ${b.coverage.weight}) -> ${b.coverage.contribution}`);
    lines.push(`- disqualifier multiplier: ${b.disqualifier.multiplier}${b.disqualifier.flags.length ? ' (' + b.disqualifier.flags.join(', ') + ')' : ''}`);
    lines.push('');
    if (card.signals.length) {
      lines.push('### Evidence');
      for (const e of card.signals) {
        lines.push(`- [${e.type}] ${e.claim}${e.date ? ' (' + e.date + ')' : ''} — ${e.sourceUrl}`);
      }
      lines.push('');
    }
    if (card.unsourcedSignals.length) {
      lines.push('### Unsourced signals (not used as evidence)');
      for (const u of card.unsourcedSignals) {
        lines.push(`- [${u.type}] ${u.claim}${u.date ? ' (' + u.date + ')' : ''}`);
      }
      lines.push('');
    }
    lines.push(`**Recommended action:** ${card.recommendedAction.action}`);
    lines.push(`Rationale: ${card.recommendedAction.rationale}`);
    lines.push(`Channel: ${card.recommendedAction.channel}`);
    if (card.draftCallOpener) {
      lines.push('');
      lines.push('**Draft call opener (requires human approval before use):**');
      lines.push(`> ${card.draftCallOpener}`);
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  if (brief.demo) {
    lines.push('');
    lines.push('> NOTE: This brief was generated from DEMO / FIXTURE data. All claims are explicitly labelled synthetic and must not be treated as live intelligence.');
  }

  return lines.join('\n');
}

module.exports = {
  // pure helpers
  WEIGHTS,
  daysBetween,
  scoreTrigger,
  scoreFit,
  scoreUrgency,
  scoreCoverage,
  scoreDisqualifier,
  scoreAccount,
  rankAccounts,
  collectSourceUrls,
  buildCard,
  buildSummary,
  computeConfidence,
  recommendAction,
  draftCallOpener,
  validateAccount,
  parseRevenueBand,
  // entry point + fixture
  runMorningBrief,
  getDemoTargets,
  // rendering
  renderMarkdown,
};
