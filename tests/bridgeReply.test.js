/**
 * Regression tests for the 2026-06-17 misdirected-reply bug: threaded replies
 * (sequence step 2/4) went to the SENDER of the parent (= the mailbox owner,
 * Henry) instead of the prospect, because Graph's reply action auto-addresses
 * to the original message's sender and the caller's `to` was ignored.
 *
 * sendReplyViaGraph must now (a) set toRecipients = the caller's explicit `to`,
 * (b) refuse to send a reply that would loop back to the sending mailbox, and
 * (c) return the ids for reconciliation. Graph is fully mocked.
 */
jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn(), patch: jest.fn() }));
jest.mock('../services/sequenceMailer', () => ({ linkify: (s) => s }));
jest.mock('../services/graphSentLookup', () => ({ pollSentMessage: jest.fn() }));

const axios = require('axios');
const { pollSentMessage } = require('../services/graphSentLookup');
const { sendReplyViaGraph } = require('../services/bridgeMailer');

const SELF = 'henry.whittle@c3.ai';
const PROSPECT = 'melissa.glupker@deckers.com';

// A parent that the mailbox SENT (from = self, to = prospect) — the exact shape
// that triggered the bug.
const SENT_PARENT = {
  subject: 'Quick question',
  from: { emailAddress: { address: SELF } },
  toRecipients: [{ emailAddress: { address: PROSPECT } }],
  ccRecipients: [],
  sentDateTime: '2026-06-16T17:00:00Z',
  conversationId: 'CONV123',
  internetMessageId: '<parent@c3.ai>',
  body: { contentType: 'text', content: 'original body' },
};

function mockGraph({ parent = SENT_PARENT, sentToRecipients, matchedBy } = {}) {
  axios.get.mockImplementation((url) => {
    if (url.includes('$select=id')) return Promise.resolve({ data: { id: 'PARENTID' } }); // resolveGraphMessageId
    if (url.includes('$select=subject')) return Promise.resolve({ data: parent });        // GET original
    return Promise.resolve({ data: {} });
  });
  axios.post.mockResolvedValue({ status: 202, headers: {}, data: null });
  // Mirror the real pollSentMessage contract (2026-07-23): it reports HOW it matched, so the
  // caller can tell "this is our message" from "this is some other same-subject reply".
  const addrs = (sentToRecipients || []).map((r) => r.emailAddress.address.toLowerCase());
  const resolvedMatchedBy = matchedBy
    || (sentToRecipients ? (addrs.includes(PROSPECT.toLowerCase()) ? 'recipient' : 'newest') : null);
  pollSentMessage.mockResolvedValue({
    message: sentToRecipients
      ? { id: 'SENTID', internetMessageId: '<reply@c3.ai>', conversationId: 'CONV123', subject: 'Re: Quick question', toRecipients: sentToRecipients }
      : null,
    attempts: 1,
    lastError: null,
    matchedBy: resolvedMatchedBy,
  });
}

beforeEach(() => {
  axios.get.mockReset();
  axios.post.mockReset();
  pollSentMessage.mockReset();
});

describe('sendReplyViaGraph — recipient is the prospect, not the parent sender', () => {
  test('the EXACT failing case: reply to a self-sent parent goes to the prospect', async () => {
    mockGraph({ sentToRecipients: [{ emailAddress: { address: PROSPECT } }] });

    const r = await sendReplyViaGraph({
      accessToken: 'tok', to: PROSPECT, inReplyToMessageId: 'PARENTID',
      body: 'following up', selfEmail: SELF,
    });

    // The reply POST must carry toRecipients = the prospect (the override).
    expect(axios.post).toHaveBeenCalledTimes(1);
    const [url, payload] = axios.post.mock.calls[0];
    expect(url).toContain('/messages/PARENTID/reply');
    expect(payload.message.toRecipients).toEqual([{ emailAddress: { address: PROSPECT } }]);
    // And NOT to the mailbox owner.
    const addrs = payload.message.toRecipients.map((t) => t.emailAddress.address);
    expect(addrs).not.toContain(SELF);

    expect(r.to).toBe(PROSPECT);
    expect(r.misdirected).toBe(false);
  });

  test('threads under the parent + returns ids for reconciliation', async () => {
    mockGraph({ sentToRecipients: [{ emailAddress: { address: PROSPECT } }] });
    const r = await sendReplyViaGraph({
      accessToken: 'tok', to: PROSPECT, inReplyToMessageId: 'PARENTID', body: 'hi', selfEmail: SELF,
    });
    expect(axios.post.mock.calls[0][0]).toContain('/messages/PARENTID/reply'); // same conversation
    expect(r.messageId).toBe('SENTID');
    expect(r.internetMessageId).toBe('<reply@c3.ai>');
    expect(r.conversationId).toBe('CONV123');
  });

  test('loud loop-guard: no explicit `to` and parent only addresses self → throws, never sends', async () => {
    // Parent whose only recipient is the mailbox owner (so the fallback resolves to nothing external).
    mockGraph({ parent: { ...SENT_PARENT, toRecipients: [{ emailAddress: { address: SELF } }] } });

    await expect(
      sendReplyViaGraph({ accessToken: 'tok', inReplyToMessageId: 'PARENTID', body: 'hi', selfEmail: SELF })
    ).rejects.toMatchObject({ code: 'reply_loop_guard', httpStatus: 422 });

    expect(axios.post).not.toHaveBeenCalled(); // nothing was sent
  });

  test('loop-guard also fires when the explicit `to` IS the sending mailbox', async () => {
    mockGraph();
    await expect(
      sendReplyViaGraph({ accessToken: 'tok', to: SELF, inReplyToMessageId: 'PARENTID', body: 'hi', selfEmail: SELF })
    ).rejects.toMatchObject({ code: 'reply_loop_guard' });
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('post-send verification flags a misdirected send (Graph ignored the override)', async () => {
    // Simulate Graph delivering to self despite our override → must be caught.
    mockGraph({ sentToRecipients: [{ emailAddress: { address: SELF } }] });
    const r = await sendReplyViaGraph({
      accessToken: 'tok', to: PROSPECT, inReplyToMessageId: 'PARENTID', body: 'hi', selfEmail: SELF,
    });
    expect(r.misdirected).toBe(true);
  });

  // Regression: one internetMessageId must never be reported for two different prospects.
  // Two prospects at the same company share a step-3 subject, so their step-4 replies share
  // `replySubject` and the paced worker sends them seconds apart, inside the same 60s poll window.
  // The poll used to pass toEmail:undefined and take candidates[0], so BOTH sends were credited
  // with the same Sent-Items message. Observed 2026-06-23/06-25/07-15/07-23.
  test('the reply poll is disambiguated BY RECIPIENT, not "newest same-subject wins"', async () => {
    mockGraph({ sentToRecipients: [{ emailAddress: { address: PROSPECT } }] });
    await sendReplyViaGraph({
      accessToken: 'tok', to: PROSPECT, inReplyToMessageId: 'PARENTID', body: 'hi', selfEmail: SELF,
    });
    const args = pollSentMessage.mock.calls[0][0];
    expect(args.toEmail).toBe(PROSPECT);          // NOT undefined — this is the fix
    expect(args.fallbackToNewest).toBe(true);     // still able to spot a misdirected send
  });

  test('a same-subject reply addressed to ANOTHER prospect is not claimed as ours', async () => {
    const OTHER = 'someone.else@prospect.com';
    // Poll found only the other prospect's concurrent reply → matchedBy 'newest', not ours.
    mockGraph({ sentToRecipients: [{ emailAddress: { address: OTHER } }] });
    const r = await sendReplyViaGraph({
      accessToken: 'tok', to: PROSPECT, inReplyToMessageId: 'PARENTID', body: 'hi', selfEmail: SELF,
    });
    // Report a capture MISS rather than the colliding id.
    expect(r.messageId).toBeNull();
    expect(r.internetMessageId).toBeNull();
    expect(r.misdirected).toBe(false);            // it went to a prospect, just not this one
    expect(r.conversationId).toBe('CONV123');     // conversation is still reliable
  });

  test('falls back to the parent To line (minus self) when no explicit `to`', async () => {
    // Parent sent to the prospect; fallback should pick the prospect, not self.
    mockGraph({ sentToRecipients: [{ emailAddress: { address: PROSPECT } }] });
    const r = await sendReplyViaGraph({
      accessToken: 'tok', inReplyToMessageId: 'PARENTID', body: 'hi', selfEmail: SELF,
    });
    const payload = axios.post.mock.calls[0][1];
    expect(payload.message.toRecipients).toEqual([{ emailAddress: { address: PROSPECT } }]);
    expect(r.to).toBe(PROSPECT);
  });
});
