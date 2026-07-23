/**
 * Regression test for the send_email messageId capture bug.
 *
 * Models Microsoft Graph's real behaviour: after `POST /me/sendMail`
 * (202, empty body), the message is NOT immediately queryable in Sent
 * Items — it appears only after an indexing delay of a few seconds.
 *
 * - The OLD code queried Sent Items exactly once, immediately → almost
 *   always missed (the observed ~1-in-24 capture rate).
 * - The NEW pollSentMessage retries with backoff until the message is
 *   indexed → captures it ~100% of the time.
 *
 * A fake `http` client and a no-op `sleep` make the polling deterministic
 * and instant (no real network, no real timers).
 */
const { pollSentMessage, matchByRecipient, recoverSentMessageIds } = require('../services/graphSentLookup');

const noopSleep = () => Promise.resolve();

/**
 * Build a fake Graph http client that "indexes" a sent message only after
 * `indexAfter` Sent-Items queries. Until then, queries return an empty
 * value array (exactly what Graph does pre-indexing).
 */
function fakeGraph({ indexAfter, message }) {
  let queries = 0;
  return {
    queries: () => queries,
    get: async () => {
      queries += 1;
      const value = queries > indexAfter ? [message] : [];
      return { status: 200, data: { value } };
    },
  };
}

const sentMessage = (to, subject) => ({
  id: `AAMkAGI-graph-id-${subject.replace(/\W+/g, '')}`,
  internetMessageId: `<${subject.replace(/\W+/g, '')}@prod.outlook.com>`,
  conversationId: `AAQk-convo-${subject.replace(/\W+/g, '')}`,
  subject,
  sentDateTime: new Date().toISOString(),
  toRecipients: [{ emailAddress: { address: to } }],
});

describe('send_email messageId capture (poll-with-backoff)', () => {
  test('OLD behaviour: a single immediate query misses while Graph is still indexing', async () => {
    const to = 'test@internal.example.com';
    const subject = 'Indexing lag demo';
    const http = fakeGraph({ indexAfter: 2, message: sentMessage(to, subject) });

    // attempts: 1 reproduces the original single-shot lookup.
    const { message } = await pollSentMessage({
      accessToken: 'tok', toEmail: to, subject, http, sleep: noopSleep, attempts: 1,
    });

    expect(message).toBeNull(); // <-- the bug: id not captured
  });

  test('NEW behaviour: poll-with-backoff captures the id once indexed', async () => {
    const to = 'test@internal.example.com';
    const subject = 'Indexing lag demo';
    const msg = sentMessage(to, subject);
    const http = fakeGraph({ indexAfter: 2, message: msg });

    const { message, attempts } = await pollSentMessage({
      accessToken: 'tok', toEmail: to, subject, http, sleep: noopSleep, attempts: 5,
    });

    expect(message).not.toBeNull();
    expect(message.id).toBe(msg.id);
    expect(message.internetMessageId).toBe(msg.internetMessageId);
    expect(message.conversationId).toBe(msg.conversationId);
    expect(attempts).toBe(3); // missed twice, hit on the third
  });

  test('captures messageId on 10/10 back-to-back sends with varied indexing lag', async () => {
    const lags = [0, 1, 2, 3, 1, 0, 2, 3, 1, 2]; // queries before each becomes visible
    const captured = [];

    for (let i = 0; i < lags.length; i++) {
      const to = `prospect-${i}@internal.example.com`;
      const subject = `Outreach ${i}`;
      const http = fakeGraph({ indexAfter: lags[i], message: sentMessage(to, subject) });
      const { message } = await pollSentMessage({
        accessToken: 'tok', toEmail: to, subject, http, sleep: noopSleep, attempts: 5,
      });
      captured.push(message?.id || null);
    }

    const hits = captured.filter(Boolean).length;
    expect(hits).toBe(10); // 100% capture (vs ~1/24 before)
    expect(captured.every((id) => typeof id === 'string')).toBe(true);
  });

  test('returns null (not a throw) when the message never indexes — caller gets an explicit miss', async () => {
    const to = 'test@internal.example.com';
    const subject = 'Never indexed';
    const http = fakeGraph({ indexAfter: 999, message: sentMessage(to, subject) });

    const { message, attempts, lastError } = await pollSentMessage({
      accessToken: 'tok', toEmail: to, subject, http, sleep: noopSleep, attempts: 4,
    });

    expect(message).toBeNull();
    expect(attempts).toBe(4);
    expect(lastError).toBeNull();
  });

  test('matchByRecipient picks the right candidate among same-subject sends', () => {
    const candidates = [
      sentMessage('someone-else@x.com', 'Same subject'),
      sentMessage('target@x.com', 'Same subject'),
    ];
    const match = matchByRecipient(candidates, 'TARGET@x.com'); // case-insensitive
    expect(match.toRecipients[0].emailAddress.address).toBe('target@x.com');
  });

  // 2026-07-23: two prospects at one company get identical reply subjects seconds apart, so a
  // same-subject poll can only be resolved by recipient. These pin the contract the reply path
  // now depends on (see services/bridgeMailer.js).
  test('a same-subject send to a DIFFERENT recipient is never returned as a recipient match', async () => {
    const subject = 'Re: Shared company subject';
    const http = fakeGraph({ indexAfter: 0, message: sentMessage('other@x.com', subject) });

    const { message, matchedBy } = await pollSentMessage({
      accessToken: 'tok', toEmail: 'target@x.com', subject, http, sleep: noopSleep, attempts: 2,
    });

    expect(message).toBeNull();          // without the fallback: an explicit miss
    expect(matchedBy).toBeNull();
  });

  test('fallbackToNewest surfaces the other message but tags it "newest", not "recipient"', async () => {
    const subject = 'Re: Shared company subject';
    const other = sentMessage('other@x.com', subject);
    const http = fakeGraph({ indexAfter: 0, message: other });

    const { message, matchedBy } = await pollSentMessage({
      accessToken: 'tok', toEmail: 'target@x.com', subject, http, sleep: noopSleep,
      attempts: 2, fallbackToNewest: true,
    });

    expect(message).toBe(other);         // available for the misdirection check
    expect(matchedBy).toBe('newest');    // but explicitly NOT our capture
  });

  test('an exact recipient match still wins and is tagged "recipient"', async () => {
    const subject = 'Re: Shared company subject';
    const mine = sentMessage('target@x.com', subject);
    const http = fakeGraph({ indexAfter: 0, message: mine });

    const { message, matchedBy } = await pollSentMessage({
      accessToken: 'tok', toEmail: 'TARGET@x.com', subject, http, sleep: noopSleep,
      attempts: 2, fallbackToNewest: true,
    });

    expect(message).toBe(mine);
    expect(matchedBy).toBe('recipient');
  });

  test('recovery utility backfills ids for already-sent messages', async () => {
    const to = 'jane@internal.example.com';
    const subject = 'Quick question, Jane';
    // Historical sends are already indexed → first query returns them.
    const http = fakeGraph({ indexAfter: 0, message: sentMessage(to, subject) });

    const results = await recoverSentMessageIds({
      accessToken: 'tok',
      items: [{ recipient: to, subject, approxSendTime: '2026-06-09T14:03:00Z' }],
      http,
    });

    expect(results).toHaveLength(1);
    expect(results[0].found).toBe(true);
    expect(results[0].messageId).toMatch(/^AAMk/);
    expect(results[0].internetMessageId).toContain('@');
  });
});
