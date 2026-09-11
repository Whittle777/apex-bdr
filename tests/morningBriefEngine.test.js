/**
 * Unit tests for the PURE scoring + fixture behavior in
 * services/morningBriefEngine.js. No DB, no network, no env.
 */
const {
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
  computeConfidence,
  recommendAction,
  draftCallOpener,
  parseRevenueBand,
  runMorningBrief,
  getDemoTargets,
  renderMarkdown,
} = require('../services/morningBriefEngine');

const AS_OF = '2026-01-15';

describe('daysBetween', () => {
  test('same day is 0', () => {
    expect(daysBetween('2026-01-15', '2026-01-15')).toBe(0);
  });
  test('positive span', () => {
    expect(daysBetween('2026-01-10', '2026-01-20')).toBe(10);
  });
  test('negative span', () => {
    expect(daysBetween('2026-01-20', '2026-01-10')).toBe(-10);
  });
  test('null on unparseable', () => {
    expect(daysBetween('nope', '2026-01-10')).toBeNull();
    expect(daysBetween(null, '2026-01-10')).toBeNull();
  });
});

describe('scoreTrigger', () => {
  test('today => 1.0', () => {
    expect(scoreTrigger('2026-01-15', AS_OF)).toBeCloseTo(1.0, 5);
  });
  test('future dated => 1.0', () => {
    expect(scoreTrigger('2026-01-20', AS_OF)).toBeCloseTo(1.0, 5);
  });
  test('decays over 30 days to ~0.5', () => {
    const s = scoreTrigger('2025-12-16', AS_OF); // 30 days prior
    expect(s).toBeCloseTo(0.5, 1);
  });
  test('floors to 0 beyond 60 days', () => {
    expect(scoreTrigger('2025-10-01', AS_OF)).toBe(0);
  });
  test('missing date => 0', () => {
    expect(scoreTrigger(null, AS_OF)).toBe(0);
    expect(scoreTrigger('', AS_OF)).toBe(0);
  });
});

describe('scoreFit', () => {
  const icp = { industries: ['Software', 'Technology'], minEmployees: 500, maxEmployees: 50000, minRevenue: 1e8, maxRevenue: 1e10 };
  test('full match => 1.0', () => {
    expect(scoreFit({ industry: 'Software', employees: 5000, revenue: '$3.4B', icp })).toBeCloseTo(1.0, 5);
  });
  test('industry only => 0.4', () => {
    expect(scoreFit({ industry: 'Technology', employees: 10, revenue: '$1M', icp })).toBeCloseTo(0.4, 5);
  });
  test('no match => 0', () => {
    expect(scoreFit({ industry: 'Retail', employees: 10, revenue: '$1M', icp })).toBe(0);
  });
  test('missing icp => 0', () => {
    expect(scoreFit({ industry: 'Software', employees: 5000 })).toBe(0);
  });
});

describe('scoreUrgency', () => {
  test('no closeDate => 0', () => {
    expect(scoreUrgency(null, AS_OF)).toBe(0);
  });
  test('<=30 days => 1.0', () => {
    expect(scoreUrgency('2026-02-01', AS_OF)).toBeCloseTo(1.0, 5);
  });
  test('past date => 0.1', () => {
    expect(scoreUrgency('2025-12-01', AS_OF)).toBeCloseTo(0.1, 5);
  });
  test('>90 days => 0.2', () => {
    expect(scoreUrgency('2026-06-01', AS_OF)).toBeCloseTo(0.2, 5);
  });
});

describe('scoreCoverage', () => {
  test('0 sources => 0', () => {
    expect(scoreCoverage({ signals: [] })).toBe(0);
  });
  test('1 source => 0.4', () => {
    expect(scoreCoverage({ signals: [{ sourceUrl: 'https://x.com/a' }] })).toBeCloseTo(0.4, 5);
  });
  test('2 sources => 0.7', () => {
    expect(scoreCoverage({ signals: [{ sourceUrl: 'https://x.com/a' }, { sourceUrl: 'https://x.com/b' }] })).toBeCloseTo(0.7, 5);
  });
  test('3+ sources => 1.0', () => {
    expect(scoreCoverage({ signals: [
      { sourceUrl: 'https://x.com/a' }, { sourceUrl: 'https://x.com/b' }, { sourceUrl: 'https://x.com/c' },
    ] })).toBeCloseTo(1.0, 5);
  });
  test('dedupes identical urls', () => {
    expect(scoreCoverage({ signals: [
      { sourceUrl: 'https://x.com/a' }, { sourceUrl: 'https://x.com/a' },
    ] })).toBeCloseTo(0.4, 5);
  });
  test('ignores unsourced signals', () => {
    expect(scoreCoverage({ signals: [{ claim: 'x' }, { sourceUrl: '  ' }] })).toBe(0);
  });
});

describe('scoreDisqualifier', () => {
  test('no flags => 1.0', () => {
    expect(scoreDisqualifier({})).toBe(1);
  });
  test('one flag reduces multiplier', () => {
    expect(scoreDisqualifier({ disqualifiers: ['acquired'] })).toBeLessThan(1);
    expect(scoreDisqualifier({ disqualifiers: ['acquired'] })).toBeGreaterThan(0);
  });
  test('more flags reduce further', () => {
    const one = scoreDisqualifier({ disqualifiers: ['a'] });
    const two = scoreDisqualifier({ disqualifiers: ['a', 'b'] });
    expect(two).toBeLessThan(one);
  });
});

describe('scoreAccount', () => {
  test('returns total 0..100 and a breakdown', () => {
    const acct = {
      name: 'TestCo', industry: 'Software', employees: 5000, revenue: '$3.4B',
      triggerDate: '2026-01-13', closeDate: '2026-02-01', icp: {
        industries: ['Software'], minEmployees: 500, maxEmployees: 50000, minRevenue: 1e8, maxRevenue: 1e10,
      },
      signals: [
        { sourceUrl: 'https://x.com/a' }, { sourceUrl: 'https://x.com/b' }, { sourceUrl: 'https://x.com/c' },
      ],
    };
    const r = scoreAccount(acct, AS_OF);
    expect(r.total).toBeGreaterThanOrEqual(0);
    expect(r.total).toBeLessThanOrEqual(100);
    expect(r.breakdown).toHaveProperty('trigger');
    expect(r.breakdown).toHaveProperty('fit');
    expect(r.breakdown).toHaveProperty('urgency');
    expect(r.breakdown).toHaveProperty('coverage');
    expect(r.breakdown).toHaveProperty('disqualifier');
  });

  test('deterministic — same input twice yields same total', () => {
    const acct = {
      name: 'DetCo', industry: 'Software', employees: 5000, revenue: '$2B',
      triggerDate: '2026-01-10', closeDate: '2026-02-10', icp: {
        industries: ['Software'], minEmployees: 500, maxEmployees: 50000, minRevenue: 1e8, maxRevenue: 1e10,
      },
      signals: [{ sourceUrl: 'https://x.com/a' }, { sourceUrl: 'https://x.com/b' }],
    };
    expect(scoreAccount(acct, AS_OF)).toEqual(scoreAccount(acct, AS_OF));
  });

  test('disqualifier reduces total vs clean account', () => {
    const base = {
      name: 'Co', industry: 'Software', employees: 5000, revenue: '$2B',
      triggerDate: '2026-01-12', closeDate: '2026-02-01', icp: {
        industries: ['Software'], minEmployees: 500, maxEmployees: 50000, minRevenue: 1e8, maxRevenue: 1e10,
      },
      signals: [{ sourceUrl: 'https://x.com/a' }, { sourceUrl: 'https://x.com/b' }, { sourceUrl: 'https://x.com/c' }],
    };
    const clean = scoreAccount(base, AS_OF).total;
    const dirty = scoreAccount({ ...base, disqualifiers: ['acquired'] }, AS_OF).total;
    expect(dirty).toBeLessThan(clean);
  });
});

describe('rankAccounts', () => {
  test('sorts by score desc then name asc', () => {
    const a = { name: 'Zeta', industry: 'Software', employees: 5000, revenue: '$3.4B', triggerDate: '2026-01-14', closeDate: '2026-02-01', icp: { industries: ['Software'], minEmployees: 500, maxEmployees: 50000, minRevenue: 1e8, maxRevenue: 1e10 }, signals: [{ sourceUrl: 'https://x.com/a' }, { sourceUrl: 'https://x.com/b' }, { sourceUrl: 'https://x.com/c' }] };
    const b = { name: 'Alpha', industry: 'Retail', employees: 10, revenue: '$1M', triggerDate: '2025-10-01', closeDate: null, icp: { industries: ['Software'], minEmployees: 500, maxEmployees: 50000, minRevenue: 1e8, maxRevenue: 1e10 }, signals: [] };
    const ranked = rankAccounts([b, a], AS_OF);
    expect(ranked[0].account.name).toBe('Zeta');
    expect(ranked[1].account.name).toBe('Alpha');
  });

  test('tiebreak by name asc when scores equal', () => {
    const a = { name: 'Bravo', signals: [] };
    const b = { name: 'Alpha', signals: [] };
    const ranked = rankAccounts([a, b], AS_OF);
    // both score 0 -> alphabetical: Alpha first
    expect(ranked[0].account.name).toBe('Alpha');
    expect(ranked[1].account.name).toBe('Bravo');
  });

  test('does not mutate input array order', () => {
    const input = [
      { name: 'Low', signals: [] },
      { name: 'High', industry: 'Software', employees: 5000, revenue: '$3.4B', triggerDate: '2026-01-14', closeDate: '2026-02-01', icp: { industries: ['Software'], minEmployees: 500, maxEmployees: 50000, minRevenue: 1e8, maxRevenue: 1e10 }, signals: [{ sourceUrl: 'https://x.com/a' }, { sourceUrl: 'https://x.com/b' }, { sourceUrl: 'https://x.com/c' }] },
    ];
    const snapshot = input.map(x => x.name);
    rankAccounts(input, AS_OF);
    expect(input.map(x => x.name)).toEqual(snapshot);
  });
});

describe('collectSourceUrls', () => {
  test('returns unique trimmed urls', () => {
    const urls = collectSourceUrls({ signals: [
      { sourceUrl: 'https://x.com/a ' }, { sourceUrl: 'https://x.com/b' }, { sourceUrl: 'https://x.com/a' },
    ] });
    expect(Array.from(urls)).toEqual(['https://x.com/a', 'https://x.com/b']);
  });
});

describe('parseRevenueBand', () => {
  test('parses $X.B', () => {
    expect(parseRevenueBand('$3.4B')).toBe(3.4e9);
  });
  test('parses X M', () => {
    expect(parseRevenueBand('580M')).toBe(5.8e8);
  });
  test('parses plain number', () => {
    expect(parseRevenueBand(2000000)).toBe(2000000);
  });
  test('null on garbage', () => {
    expect(parseRevenueBand('abc')).toBeNull();
    expect(parseRevenueBand(null)).toBeNull();
  });
});

describe('recommendAction', () => {
  test('hold when disqualifiers present', () => {
    const r = recommendAction({ disqualifiers: ['acquired'] }, { total: 90 }, AS_OF);
    expect(r.channel).toBe('none');
    expect(r.action).toMatch(/Hold/);
  });
  test('prioritize when score >= 70', () => {
    const r = recommendAction({}, { total: 75 }, AS_OF);
    expect(r.channel).toBe('call');
    expect(r.action).toMatch(/Prioritize/);
  });
  test('nurture when 40-69', () => {
    const r = recommendAction({}, { total: 50 }, AS_OF);
    expect(r.channel).toBe('email');
    expect(r.action).toMatch(/Nurture/);
  });
  test('monitor when < 40', () => {
    const r = recommendAction({}, { total: 20 }, AS_OF);
    expect(r.channel).toBe('none');
    expect(r.action).toMatch(/Monitor/);
  });
});

describe('draftCallOpener', () => {
  test('null when channel none', () => {
    const action = { channel: 'none' };
    expect(draftCallOpener({}, action)).toBeNull();
  });
  test('uses trigger claim when present', () => {
    const action = { channel: 'call' };
    const opener = draftCallOpener({
      name: 'TestCo',
      signals: [{ type: 'trigger', claim: 'TestCo raised Series E.', sourceUrl: 'https://x.com' }],
    }, action);
    expect(opener).toMatch(/TestCo team/);
    expect(opener).toMatch(/series e/i);
  });
  test('falls back to generic when no trigger', () => {
    const action = { channel: 'email' };
    const opener = draftCallOpener({ name: 'TestCo', industry: 'Finance', signals: [] }, action);
    expect(opener).toMatch(/TestCo team/);
    expect(opener).toMatch(/Finance/);
  });

  test('run cards contain the opener string, not the generator function', async () => {
    const brief = await runMorningBrief({ demo: true, asOf: AS_OF });
    const callable = brief.cards.find(card => card.recommendedAction.channel !== 'none');
    expect(typeof callable.draftCallOpener).toBe('string');
    expect(callable.draftCallOpener).toMatch(/team/);
  });
});

describe('computeConfidence', () => {
  test('low when few sources', () => {
    // 0 sources: source factor 0.1; high score still drags it up, so use a low score.
    expect(computeConfidence({ total: 10 }, 0)).toBeLessThanOrEqual(0.3);
  });
  test('high when many sources + high score', () => {
    expect(computeConfidence({ total: 90 }, 3)).toBeGreaterThan(0.7);
  });
});

describe('runMorningBrief', () => {
  test('demo fixture when demo true', async () => {
    const brief = await runMorningBrief({ demo: true, asOf: AS_OF });
    expect(brief.demo).toBe(true);
    expect(brief.source).toBe('fixture');
    expect(Array.isArray(brief.cards)).toBe(true);
    expect(brief.cards.length).toBe(5);
    expect(brief.summary.total).toBe(5);
  });

  test('demo fixture when no targets', async () => {
    const brief = await runMorningBrief({ targets: [], asOf: AS_OF });
    expect(brief.demo).toBe(true);
  });

  test('supplied targets used when provided', async () => {
    const targets = [{
      name: 'SuppliedCo', industry: 'Software', employees: 5000, revenue: '$3.4B',
      triggerDate: '2026-01-14', closeDate: '2026-02-01',
      icp: { industries: ['Software'], minEmployees: 500, maxEmployees: 50000, minRevenue: 1e8, maxRevenue: 1e10 },
      signals: [{ sourceUrl: 'https://x.com/a' }, { sourceUrl: 'https://x.com/b' }],
    }];
    const brief = await runMorningBrief({ targets, asOf: AS_OF });
    expect(brief.demo).toBe(false);
    expect(brief.source).toBe('supplied');
    expect(brief.cards[0].account.name).toBe('SuppliedCo');
  });

  test('cards have required fields', async () => {
    const brief = await runMorningBrief({ demo: true, asOf: AS_OF });
    const c = brief.cards[0];
    expect(c).toHaveProperty('rank');
    expect(c).toHaveProperty('account');
    expect(c).toHaveProperty('score');
    expect(c).toHaveProperty('scoreBreakdown');
    expect(c).toHaveProperty('confidence');
    expect(c).toHaveProperty('signals');
    expect(c).toHaveProperty('recommendedAction');
    expect(c).toHaveProperty('draftCallOpener');
  });

  test('every demo signal has a sourceUrl', async () => {
    const brief = await runMorningBrief({ demo: true, asOf: AS_OF });
    for (const card of brief.cards) {
      for (const sig of card.signals) {
        expect(sig.sourceUrl).toBeTruthy();
      }
    }
  });

  test('demo claims are labelled via brief.demo flag', async () => {
    const brief = await runMorningBrief({ demo: true, asOf: AS_OF });
    expect(brief.demo).toBe(true);
    const md = renderMarkdown(brief);
    expect(md).toMatch(/DEMO \/ FIXTURE DATA/);
  });

  test('deterministic ranking for same asOf', async () => {
    const a = await runMorningBrief({ demo: true, asOf: AS_OF });
    const b = await runMorningBrief({ demo: true, asOf: AS_OF });
    const aNames = a.cards.map(c => c.account.name);
    const bNames = b.cards.map(c => c.account.name);
    expect(aNames).toEqual(bNames);
    const aScores = a.cards.map(c => c.score);
    const bScores = b.cards.map(c => c.score);
    expect(aScores).toEqual(bScores);
  });
});

describe('getDemoTargets', () => {
  test('returns 5 targets with asOf and demo flag', () => {
    const f = getDemoTargets();
    expect(f.demo).toBe(true);
    expect(f.targets.length).toBe(5);
    expect(f.asOf).toBeTruthy();
  });

  test('every target has at least one sourced signal', () => {
    const f = getDemoTargets();
    for (const t of f.targets) {
      expect(t.signals.some(s => s.sourceUrl && s.sourceUrl.trim())).toBe(true);
    }
  });
});
