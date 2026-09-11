const {
  buildGoogleNewsRssUrl,
  parseRss,
  classifySignal,
  discoverSignalsForTarget,
} = require('../services/signalDiscovery');

const RSS = `<?xml version="1.0"?>
<rss><channel>
  <item>
    <title><![CDATA[Example Co raises Series B to expand its AI platform]]></title>
    <link>https://example.com/news/series-b</link>
    <description><![CDATA[Example Co announced a $50M round.]]></description>
    <pubDate>Wed, 09 Sep 2026 12:00:00 GMT</pubDate>
    <source url="https://example.com">Example Co</source>
  </item>
  <item>
    <title>Example Co opens a new office</title>
    <link>https://news.example.test/story</link>
    <description>Expansion news</description>
    <pubDate>Mon, 01 Jun 2026 12:00:00 GMT</pubDate>
  </item>
  <item>
    <title>Unrelated Corp raises Series C</title>
    <link>https://unrelated.example.test/story</link>
    <description>Nothing to do with the target.</description>
    <pubDate>Wed, 09 Sep 2026 12:00:00 GMT</pubDate>
  </item>
</channel></rss>`;

describe('signalDiscovery', () => {
  test('builds a bounded Google News query URL', () => {
    const url = buildGoogleNewsRssUrl('"Example Co" funding');
    expect(url).toContain('news.google.com/rss/search');
    expect(url).toContain('Example%20Co');
  });

  test('parses RSS items and preserves source metadata', () => {
    const items = parseRss(RSS);
    expect(items).toHaveLength(3);
    expect(items[0].title).toMatch(/Series B/);
    expect(items[0].link).toBe('https://example.com/news/series-b');
    expect(items[0].publisher).toBe('Example Co');
  });

  test('classifies a dated funding result and suggests a usable angle', () => {
    const signal = classifySignal({
      title: 'Example Co raises Series B',
      description: 'The company announced a new round.',
      link: 'https://example.com/news/series-b',
      publishedAt: 'Wed, 09 Sep 2026 12:00:00 GMT',
    }, { name: 'Example Co', domain: 'example.com', asOf: '2026-09-11' });
    expect(signal.type).toBe('funding');
    expect(signal.date).toBe('2026-09-09');
    expect(signal.fresh).toBe(true);
    expect(signal.ownSite).toBe(true);
    expect(signal.suggestedAngle).toMatch(/investment/i);
    expect(signal.suggestedPersona).toMatch(/CFO|COO/);
    expect(signal.suggestedQuestion).toMatch(/\?/);
  });

  test('discovers and ranks sourced signals with an injected fetcher', async () => {
    const result = await discoverSignalsForTarget(
      { name: 'Example Co', domain: 'example.com' },
      {
        asOf: '2026-09-11',
        fetcher: async () => RSS,
      },
    );
    expect(result.signals.length).toBeGreaterThan(0);
    expect(result.signals[0].sourceUrl).toBeTruthy();
    expect(result.signals[0].type).toBe('funding');
    expect(result.target.triggerDate).toBe('2026-09-09');
    expect(result.signals.every(signal => !/Unrelated Corp/i.test(signal.claim))).toBe(true);
  });
});
