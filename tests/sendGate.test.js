/**
 * Unit tests for the PURE server-side send gate (services/sendGate.js) and its
 * integration into validateItem/decideBatch. No DB, no IO — mirrors
 * enqueueBatch.test.js. Rule fidelity target: "Claude access"/send_gate.py.
 */
const {
  enforceHenrySignature,
  recipientBlockReasons,
  contentReasons,
} = require('../services/sendGate');
const { validateItem, decideBatch, countDecisions } = require('../services/enqueueBatch');

const HENRY_BODY = '<p>Hi Sam,</p><p>Proof point.</p><p>Worth 30 minutes?</p><p>Thanks,<br>Henry</p>';

describe('enforceHenrySignature', () => {
  test('passes an already-Henry-signed body unchanged', () => {
    expect(enforceHenrySignature(HENRY_BODY)).toEqual({ body: HENRY_BODY, changed: false, error: null });
  });

  test('rewrites an HTML rep signoff to Henry (the 2026-06-16 bug shape)', () => {
    const r = enforceHenrySignature('<p>Hi,</p><p>Body.</p><p>Thanks,<br>Wayman</p>');
    expect(r.error).toBeNull();
    expect(r.changed).toBe(true);
    expect(r.body).toContain('Thanks,<br>Henry');
    expect(r.body).not.toMatch(/Wayman/);
  });

  test('rewrites a plain-text rep signoff ("Best, Douglass" on its own line)', () => {
    const r = enforceHenrySignature('Hi,\n\nBody.\n\nBest,\nDouglass');
    expect(r.error).toBeNull();
    expect(r.body).toMatch(/Best,\nHenry$/);
  });

  test('strips rep coverage lines ("I cover … at C3 AI")', () => {
    const r = enforceHenrySignature('<p>Worth 30 minutes? I cover PNW + NorCal Hi-Tech at C3 AI.</p><p>Thanks,<br>Sai</p>');
    expect(r.error).toBeNull();
    expect(r.body).not.toMatch(/I cover/);
    expect(r.body).toContain('Thanks,<br>Henry');
  });

  test('replaces rep full names with Henry', () => {
    const r = enforceHenrySignature('<p>Body.</p><p>Regards,<br>Cole McConnell</p>');
    expect(r.error).toBeNull();
    expect(r.body).toContain('Regards,<br>Henry');
  });

  test('rewrites a ">Rep<" signoff token inside tags (same as the Python gate)', () => {
    const r = enforceHenrySignature('<p>Body.</p><p>Warm regards</p><p>Vikas</p>');
    expect(r.error).toBeNull();
    expect(r.body).toContain('>Henry<');
  });

  test('errors (never half-rewrites) when a rep name survives in signoff position', () => {
    // Plain text + a non-standard closer: no rewrite rule applies, the rep
    // name stays on the final line → hard error, original body returned.
    const r = enforceHenrySignature('Body.\n\nWarm regards\nVikas');
    expect(r.error).toMatch(/Vikas/);
    expect(r.body).toBe('Body.\n\nWarm regards\nVikas');
  });

  test('appends a Henry signoff when no signoff exists at all', () => {
    const r = enforceHenrySignature('<p>Hi, quick note.</p>');
    expect(r.error).toBeNull();
    expect(r.changed).toBe(true);
    expect(r.body).toContain('<p>Thanks,<br>Henry</p>');
  });

  test('does NOT flag a rep first name used mid-body as context', () => {
    const r = enforceHenrySignature('<p>My colleague Cole covers your region and will join the call.</p><p>Thanks,<br>Henry</p>');
    expect(r.error).toBeNull();
  });
});

describe('contentReasons', () => {
  const base = { to: 'p@prospect.com', subject: 's', body: HENRY_BODY, step: 1 };

  test('clean cold email → no reasons', () => {
    expect(contentReasons(base)).toEqual([]);
  });
  test('flags internal @c3.ai recipient', () => {
    expect(contentReasons({ ...base, to: 'someone@c3.ai' }).join()).toMatch(/INTERNAL_RECIPIENT/);
  });
  test('flags em dash in subject or body', () => {
    expect(contentReasons({ ...base, subject: 'A — B' }).join()).toMatch(/EM_DASH/);
    expect(contentReasons({ ...base, body: 'x — y' }).join()).toMatch(/EM_DASH/);
  });
  test('flags banned proof names (case-sensitive word match)', () => {
    expect(contentReasons({ ...base, body: 'Like Caterpillar did.' }).join()).toMatch(/BANNED_PROOF/);
    expect(contentReasons({ ...base, body: 'caterpillar tracks' })).toEqual([]); // lowercase ≠ the customer name
  });
  test('flags written-restricted names case-insensitively', () => {
    expect(contentReasons({ ...base, body: 'as GOODYEAR saw' }).join()).toMatch(/RESTRICTED_NAME/);
  });
  test('booking links blocked before step 4, allowed from step 4', () => {
    const withLink = { ...base, body: 'grab time: https://outlook.office.com/bookwithme/u/x' };
    expect(contentReasons({ ...withLink, step: 1 }).join()).toMatch(/BOOKING_LINK/);
    expect(contentReasons({ ...withLink, step: undefined }).join()).toMatch(/BOOKING_LINK/); // missing step = strictest
    expect(contentReasons({ ...withLink, step: 4 })).toEqual([]);
  });
  test('flags off-spec CTAs', () => {
    expect(contentReasons({ ...base, body: 'Worth 20 minutes?' }).join()).toMatch(/OFFSPEC_CTA/);
    expect(contentReasons({ ...base, body: 'quick chat sometime?' }).join()).toMatch(/OFFSPEC_CTA/);
  });
});

describe('recipientBlockReasons', () => {
  const lists = {
    dncEmails: new Set(['optout@x.com']),
    bouncedEmails: new Set(['gone@x.com']),
    suppressedDomains: new Set(['deadco.com']),
  };
  test('clear recipient → no reasons', () => {
    expect(recipientBlockReasons('ok@x.com', lists)).toEqual([]);
  });
  test('flags DNC / bounced / suppressed (case-insensitive)', () => {
    expect(recipientBlockReasons('OptOut@x.com', lists)).toEqual(['DNC_RECIPIENT']);
    expect(recipientBlockReasons('gone@x.com', lists)).toEqual(['BOUNCED_RECIPIENT']);
    expect(recipientBlockReasons('any@deadco.com', lists).join()).toMatch(/SUPPRESSED_DOMAIN/);
  });
  test('tolerates missing lists', () => {
    expect(recipientBlockReasons('ok@x.com')).toEqual([]);
  });
});

describe('validateItem + decideBatch with the gate wired in', () => {
  const gateLists = {
    dncEmails: new Set(['optout@x.com']),
    bouncedEmails: new Set(),
    suppressedDomains: new Set(),
  };
  const opts = { blockedDomains: new Set(), gateLists, contentGate: 'on' };

  test('recipient compliance is hard even without contentGate', () => {
    expect(validateItem({ to: 'optout@x.com', subject: 's', body: HENRY_BODY }, { blockedDomains: new Set(), gateLists }))
      .toMatchObject({ valid: false, reason: 'DNC_RECIPIENT' });
  });

  test('contentGate=on rejects a gate violation with joined reasons', () => {
    const v = validateItem({ to: 'p@x.com', subject: 's', body: 'Worth 20 minutes? — see Caterpillar' }, opts);
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/EM_DASH/);
    expect(v.reason).toMatch(/BANNED_PROOF/);
    expect(v.reason).toMatch(/OFFSPEC_CTA/);
  });

  test('contentGate=on auto-corrects a rep signoff and returns cleanBody', () => {
    const v = validateItem({ to: 'p@x.com', subject: 's', body: '<p>Body.</p><p>Thanks,<br>Wayman</p>' }, opts);
    expect(v.valid).toBe(true);
    expect(v.signatureCorrected).toBe(true);
    expect(v.cleanBody).toContain('Thanks,<br>Henry');
  });

  test('contentGate=on rejects an unrewritable rep signoff', () => {
    const v = validateItem({ to: 'p@x.com', subject: 's', body: 'Body.\n\nWarm regards\nVikas' }, opts);
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/SIGNATURE/);
  });

  test('contentGate=shadow accepts violations but reports shadowReasons, body untouched', () => {
    const v = validateItem(
      { to: 'p@x.com', subject: 's', body: '<p>Body.</p><p>Thanks,<br>Wayman</p>' },
      { ...opts, contentGate: 'shadow' }
    );
    expect(v.valid).toBe(true);
    expect(v.cleanBody).toBeUndefined();
    expect(v.shadowReasons).toBeUndefined(); // a correctable signoff is not a would-be rejection
    const v2 = validateItem({ to: 'p@x.com', subject: 's', body: 'x — y\n\nThanks,\nHenry' }, { ...opts, contentGate: 'shadow' });
    expect(v2.valid).toBe(true);
    expect(v2.shadowReasons.join()).toMatch(/EM_DASH/);
  });

  test('meta.step reaches the booking-link rule through decideBatch', () => {
    const items = [
      { to: 'a@x.com', subject: 's', body: 'book me https://calendly.com/x\n\nThanks,\nHenry', clientRef: 'P1', meta: { step: 5 } },
      { to: 'b@x.com', subject: 's', body: 'book me https://calendly.com/x\n\nThanks,\nHenry', clientRef: 'P2', meta: { step: 2 } },
    ];
    const { decisions } = decideBatch({ items, existingKeys: new Set(), blockedDomains: new Set(), gateLists, contentGate: 'on', dedupeScope: 'queue' });
    expect(decisions[0].status).toBe('accepted');
    expect(decisions[1].status).toBe('rejected');
    expect(decisions[1].reason).toMatch(/BOOKING_LINK/);
    expect(countDecisions(decisions)).toEqual({ accepted: 1, skippedDuplicate: 0, rejected: 1 });
  });

  test('decideBatch carries cleanBody + signatureCorrected on accepted decisions', () => {
    const items = [{ to: 'a@x.com', subject: 's', body: '<p>Body.</p><p>Thanks,<br>Sai</p>', clientRef: 'P1', meta: { step: 1 } }];
    const { decisions } = decideBatch({ items, existingKeys: new Set(), blockedDomains: new Set(), gateLists, contentGate: 'on', dedupeScope: 'queue' });
    expect(decisions[0]).toMatchObject({ status: 'accepted', signatureCorrected: true });
    expect(decisions[0].cleanBody).toContain('Thanks,<br>Henry');
  });

  test('no gate options → legacy behavior unchanged', () => {
    const v = validateItem({ to: 'p@x.com', subject: 's', body: 'x — y, Caterpillar, quick chat' }, { blockedDomains: new Set() });
    expect(v.valid).toBe(true);
    expect(v.cleanBody).toBeUndefined();
  });
});
