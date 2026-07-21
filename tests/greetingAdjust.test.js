const { adjustGreetingForSendTime, greetingForHour } = require('../services/greetingAdjust');

describe('greetingForHour', () => {
  test('buckets', () => {
    expect(greetingForHour(8)).toBe('Good morning');
    expect(greetingForHour(11)).toBe('Good morning');
    expect(greetingForHour(12)).toBe('Good afternoon');
    expect(greetingForHour(16)).toBe('Good afternoon');
    expect(greetingForHour(17)).toBe('Good evening');
  });
});

describe('adjustGreetingForSendTime', () => {
  const html = '<p>Good morning Anders,</p><p>Body text about Good morning routines.</p>';

  test('morning send, same tz: unchanged', () => {
    expect(adjustGreetingForSendTime(html, 9, 0)).toBe(html);
  });

  test('afternoon send, same tz: greeting corrected, later mentions untouched', () => {
    const out = adjustGreetingForSendTime(html, 14, 0);
    expect(out).toMatch(/^<p>Good afternoon Anders,/);
    expect(out).toContain('Good morning routines'); // only the leading greeting changes
  });

  test('recipient tz offset pushes past noon (11am PT send, +2 CT recipient)', () => {
    const out = adjustGreetingForSendTime(html, 11, 2);
    expect(out).toMatch(/^<p>Good afternoon Anders,/);
  });

  test('recipient behind send tz stays morning (9am PT send, -1 offset)', () => {
    expect(adjustGreetingForSendTime(html, 9, -1)).toBe(html);
  });

  test('afternoon draft sent in the morning corrects back to morning', () => {
    const pm = '<p>Good afternoon Rich,</p><p>x</p>';
    expect(adjustGreetingForSendTime(pm, 9, 0)).toMatch(/^<p>Good morning Rich,/);
  });

  test('plain-text body works', () => {
    expect(adjustGreetingForSendTime('Good morning Rich,\n\nx', 15, 0)).toMatch(/^Good afternoon Rich,/);
  });

  test('no time-based greeting: untouched', () => {
    const hi = '<p>Hi Rich,</p><p>x</p>';
    expect(adjustGreetingForSendTime(hi, 15, 0)).toBe(hi);
  });

  test('null/empty body: untouched', () => {
    expect(adjustGreetingForSendTime('', 15, 0)).toBe('');
    expect(adjustGreetingForSendTime(null, 15, 0)).toBe(null);
  });

  test('large offsets wrap correctly (NZ +19 from PT: 8am PT = 3am NZ = morning)', () => {
    expect(adjustGreetingForSendTime(html, 8, 19)).toBe(html);
  });
});
