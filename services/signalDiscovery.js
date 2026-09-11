/**
 * Public-web trigger discovery for Morning Brief.
 *
 * V1 deliberately uses public RSS rather than an AI or paid-data dependency.
 * Google News RSS gives us a bounded search surface with titles, snippets,
 * publisher names, dates, and URLs. The engine never treats an undated result
 * as a fresh trigger, and every promoted signal keeps its source URL.
 */
'use strict';

const axios = require('axios');

const DEFAULT_MAX_AGE_DAYS = 120;
const DEFAULT_MAX_SIGNALS = 6;
const DEFAULT_TIMEOUT_MS = 15_000;

const SIGNAL_KINDS = [
  { type: 'funding', score: 8, pattern: /\b(raised|raises|funding|series [a-f]|investment|investor|capital)\b/i },
  { type: 'acquisition', score: 8, pattern: /\b(acquire|acquired|acquisition|merger|merges|buyout)\b/i },
  { type: 'partnership', score: 5, pattern: /\b(partner|partnership|alliance|integrat(?:es|ed|ion)|collaborat(?:es|ion))\b/i },
  { type: 'launch', score: 5, pattern: /\b(launch(?:es|ed)?|unveil(?:s|ed)?|introduc(?:es|ed|ing)|debut)\b/i },
  { type: 'hiring', score: 5, pattern: /\b(hir(?:e|es|ed|ing)|appoint(?:s|ed)?|joins|named as|chief [a-z]+ officer|job opening)\b/i },
  { type: 'incident', score: 5, pattern: /\b(outage|breach|incident|recall|vulnerability|attack|disruption|downtime)\b/i },
  { type: 'expansion', score: 4, pattern: /\b(expand(?:s|ed|ing)?|expansion|opens|opening|enters|new office|international)\b/i },
  { type: 'earnings', score: 4, pattern: /\b(earnings|quarterly|revenue|10-q|10-k|profit|loss|guidance|forecast)\b/i },
  { type: 'release', score: 3, pattern: /\b(release|released|version|update|changelog|availability|general availability)\b/i },
];

const OUTREACH_ANGLES = {
  funding: 'Use the investment moment to ask what the team is scaling next and where execution is creating operational drag.',
  acquisition: 'Use the acquisition to ask how the team is consolidating data, workflows, or customer operations across the businesses.',
  partnership: 'Use the partnership to ask what the new motion changes for revenue, delivery, or customer experience.',
  launch: 'Use the launch to ask how the team will operationalize adoption and measure the new initiative after announcement day.',
  hiring: 'Use the hiring signal to ask what the new role is expected to change and where the current team needs leverage.',
  incident: 'Use the incident carefully to ask how the team is reducing repeat risk and improving operational visibility.',
  expansion: 'Use the expansion to ask how the team will maintain consistency and visibility as the footprint grows.',
  earnings: 'Use the earnings signal to ask which growth priority is most constrained by execution or decision latency.',
  release: 'Use the release to ask how the team plans to turn the product update into repeatable customer value.',
  news: 'Use the recent company news to ask what priority is moving from announcement into execution.',
};

const OUTREACH_PLANS = {
  funding: {
    persona: 'CFO, COO, or VP Operations',
    question: 'What does this investment need to change operationally over the next two quarters?',
  },
  acquisition: {
    persona: 'COO, CIO, or VP Integration',
    question: 'Where is integration work creating the most friction for the combined team?',
  },
  partnership: {
    persona: 'VP Partnerships, CRO, or VP Customer Success',
    question: 'What new workflow or customer promise does this partnership create for your team?',
  },
  launch: {
    persona: 'VP Product, VP Marketing, or GM',
    question: 'How are you turning the launch into repeatable adoption and measurable customer value?',
  },
  hiring: {
    persona: 'Hiring manager or functional VP',
    question: 'What business outcome is the new role expected to unlock first?',
  },
  incident: {
    persona: 'CISO, CIO, or VP Engineering',
    question: 'What needs to change to reduce repeat risk and improve visibility after the incident?',
  },
  expansion: {
    persona: 'COO, VP Operations, or Regional GM',
    question: 'How are you keeping execution consistent as the footprint expands?',
  },
  earnings: {
    persona: 'CFO, COO, or VP Strategy',
    question: 'Which growth priority is currently most constrained by execution or decision latency?',
  },
  release: {
    persona: 'VP Product, VP Engineering, or Head of Platform',
    question: 'What needs to happen for this release to become repeatable customer value?',
  },
  news: {
    persona: 'Functional leader closest to the initiative',
    question: 'What is moving from announcement into execution for your team now?',
  },
};

const COMPANY_SUFFIXES = new Set([
  'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'ltd',
  'limited', 'llc', 'plc', 'nv', 'sa', 'ag', 'lp', 'holdings', 'group',
  'technologies', 'technology',
]);

function buildGoogleNewsRssUrl(query, locale = 'US') {
  const country = String(locale || 'US').toUpperCase();
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=${country}&ceid=${country}:en`;
}

function buildSearchQueries(target) {
  const name = String(target.name || '').trim();
  const domain = String(target.domain || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const triggerTerms = 'funding OR raised OR launch OR hiring OR partnership OR acquisition OR expansion OR outage OR earnings';
  const ownSite = domain ? ` site:${domain}` : '';
  return [
    `"${name}" (${triggerTerms})${ownSite}`,
    `"${name}" (${triggerTerms})`,
  ];
}

async function fetchRss(url, {
  axiosClient = axios,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const response = await axiosClient.get(url, {
    timeout: timeoutMs,
    maxContentLength: 2 * 1024 * 1024,
    responseType: 'text',
    headers: {
      Accept: 'application/rss+xml, application/xml, text/xml, text/plain',
      'User-Agent': 'Apex-Morning-Brief/1.0 (+public-signal-discovery)',
    },
  });
  return typeof response.data === 'string' ? response.data : '';
}

function parseRss(xml, feedUrl = '') {
  if (typeof xml !== 'string' || !xml.trim()) return [];
  const items = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];
  return items.map(item => {
    const title = cleanText(readTag(item, 'title'));
    const link = cleanUrl(cleanText(readTag(item, 'link')));
    const description = cleanText(readTag(item, 'description'));
    const publishedAt = cleanText(readTag(item, 'pubDate') || readTag(item, 'published'));
    const sourceNode = item.match(/<source\b([^>]*)>([\s\S]*?)<\/source>/i);
    const publisher = sourceNode ? cleanText(sourceNode[2]) : '';
    const publisherUrl = sourceNode ? cleanUrl(readAttribute(sourceNode[1], 'url')) : null;
    if (!title || !link) return null;
    return {
      title,
      link,
      description: stripHtml(description).slice(0, 500),
      publishedAt: publishedAt || null,
      publisher: publisher || null,
      publisherUrl,
      feedUrl,
    };
  }).filter(Boolean);
}

function readTag(input, tag) {
  const match = input.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? match[1] : '';
}

function readAttribute(input, name) {
  const match = String(input || '').match(new RegExp(`${name}=["']([^"']+)["']`, 'i'));
  return match ? match[1] : '';
}

function cleanText(value) {
  return decodeEntities(String(value || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim();
}

function stripHtml(value) {
  return cleanText(String(value || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function cleanUrl(value) {
  const url = String(value || '').trim();
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function normalizeDate(value, asOf = new Date().toISOString().slice(0, 10)) {
  if (!value) return null;
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  const match = String(value).match(/\b(20\d{2})[/-](\d{1,2})[/-](\d{1,2})\b/);
  if (!match) return null;
  const candidate = `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`;
  return candidate <= asOf ? candidate : null;
}

function daysOld(date, asOf) {
  if (!date || !asOf) return null;
  const start = new Date(`${date}T00:00:00Z`);
  const end = new Date(`${asOf}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return Math.floor((end.getTime() - start.getTime()) / 86_400_000);
}

function classifySignal(result, target = {}) {
  const text = `${result.title || ''} ${result.description || ''}`;
  const match = SIGNAL_KINDS.find(kind => kind.pattern.test(text));
  const type = match?.type || 'news';
  const date = normalizeDate(result.publishedAt, target.asOf);
  const age = daysOld(date, target.asOf);
  const domain = String(target.domain || '').replace(/^www\./, '').toLowerCase();
  let hostMatches = false;
  for (const candidate of [result.link, result.publisherUrl]) {
    try {
      if (domain && candidate && new URL(candidate).hostname.replace(/^www\./, '').endsWith(domain)) {
        hostMatches = true;
        break;
      }
    } catch {}
  }
  const relevance = getCompanyTokens(target).some(token => text.toLowerCase().includes(token))
    || getCompanyTokens(target).some(token => String(result.publisher || '').toLowerCase().includes(token));
  const recencyScore = age == null ? 0 : age <= 7 ? 4 : age <= 30 ? 3 : age <= 90 ? 2 : age <= 120 ? 1 : 0;
  const ownSiteScore = hostMatches ? 2 : 0;
  const snippetScore = result.description ? 1 : 0;
  const thirdPartyPenalty = hostMatches ? 0 : -1;
  const signalScore = (match?.score || 1) + recencyScore + ownSiteScore + snippetScore + thirdPartyPenalty;
  const angle = OUTREACH_ANGLES[type] || OUTREACH_ANGLES.news;
  const plan = getOutreachPlan(type);

  return {
    type,
    claim: result.title,
    description: result.description || null,
    date,
    sourceUrl: result.link,
    publisher: result.publisher || null,
    publisherUrl: result.publisherUrl || null,
    source: 'google-news-rss',
    signalScore,
    fresh: age != null && age <= 45,
    dated: age != null,
    relevant: Boolean(relevance),
    thirdParty: !hostMatches,
    ownSite: Boolean(hostMatches),
    suggestedAngle: angle,
    suggestedPersona: plan.persona,
    suggestedQuestion: plan.question,
  };
}

function getOutreachPlan(type) {
  return OUTREACH_PLANS[type] || OUTREACH_PLANS.news;
}

function getCompanyTokens(target = {}) {
  const nameTokens = String(target.name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(token => token && !COMPANY_SUFFIXES.has(token) && token.length >= 3);
  const domainToken = String(target.domain || '')
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('.')[0]
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
  return Array.from(new Set([...nameTokens, domainToken].filter(Boolean)));
}

function isRelevantResult(result, target) {
  const text = `${result.title || ''} ${result.description || ''} ${result.publisher || ''}`.toLowerCase();
  const tokens = getCompanyTokens(target);
  if (tokens.some(token => text.includes(token))) return true;
  try {
    const domain = String(target.domain || '').replace(/^www\./, '').toLowerCase();
    return Boolean(domain && new URL(result.link).hostname.replace(/^www\./, '').endsWith(domain));
  } catch {
    return false;
  }
}

function dedupeSignals(signals) {
  const seen = new Set();
  return signals.filter(signal => {
    const key = `${signal.sourceUrl}|${String(signal.claim || '').toLowerCase()}`;
    if (!signal.sourceUrl || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function discoverSignalsForTarget(target, {
  asOf = new Date().toISOString().slice(0, 10),
  maxAgeDays = DEFAULT_MAX_AGE_DAYS,
  maxSignals = DEFAULT_MAX_SIGNALS,
  fetcher = fetchRss,
} = {}) {
  const enrichedTarget = { ...target, asOf };
  const queries = buildSearchQueries(enrichedTarget);
  const results = [];
  const errors = [];

  for (const query of queries) {
    const feedUrl = buildGoogleNewsRssUrl(query);
    try {
      const xml = await fetcher(feedUrl);
      results.push(...parseRss(xml, feedUrl));
    } catch (error) {
      errors.push(error.message || String(error));
    }
  }

  const signals = dedupeSignals(results
    .filter(result => isRelevantResult(result, enrichedTarget))
    .map(result => classifySignal(result, enrichedTarget))
    .filter(signal => {
      const age = daysOld(signal.date, asOf);
      return age == null || age <= maxAgeDays;
    }))
    .sort((a, b) => {
      if (b.signalScore !== a.signalScore) return b.signalScore - a.signalScore;
      return String(b.date || '').localeCompare(String(a.date || ''));
    })
    .slice(0, maxSignals);

  return {
    target: {
      ...target,
      signals: dedupeSignals([...(Array.isArray(target.signals) ? target.signals : []), ...signals]),
      triggerDate: newestTriggerDate(target, signals) || target.triggerDate || null,
    },
    signals,
    queries,
    errors,
  };
}

async function discoverSignalsForTargets(targets, options = {}) {
  const list = Array.isArray(targets) ? targets : [];
  const maxConcurrency = Math.max(1, Math.min(Number(options.concurrency) || 3, 5));
  const output = new Array(list.length);
  let cursor = 0;

  const worker = async () => {
    while (cursor < list.length) {
      const index = cursor++;
      output[index] = await discoverSignalsForTarget(list[index], options);
    }
  };

  await Promise.all(Array.from({ length: Math.min(maxConcurrency, list.length) }, worker));
  return {
    targets: output.map(item => item.target),
    results: output,
    summary: {
      accounts: output.length,
      accountsWithSignals: output.filter(item => item.signals.length > 0).length,
      freshSignals: output.reduce((total, item) => total + item.signals.filter(signal => signal.fresh).length, 0),
      errors: output.reduce((total, item) => total + item.errors.length, 0),
    },
  };
}

function newestTriggerDate(target, signals) {
  const dates = [
    ...(Array.isArray(target.signals) ? target.signals : []),
    ...signals,
  ]
    .filter(signal => signal?.date && signal.type !== 'fit')
    .map(signal => signal.date)
    .sort()
    .reverse();
  return dates[0] || null;
}

module.exports = {
  DEFAULT_MAX_AGE_DAYS,
  SIGNAL_KINDS,
  OUTREACH_ANGLES,
  OUTREACH_PLANS,
  getOutreachPlan,
  buildGoogleNewsRssUrl,
  buildSearchQueries,
  parseRss,
  normalizeDate,
  classifySignal,
  getCompanyTokens,
  isRelevantResult,
  dedupeSignals,
  discoverSignalsForTarget,
  discoverSignalsForTargets,
};
