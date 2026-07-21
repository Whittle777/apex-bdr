/**
 * greetingAdjust — recompute a time-based greeting at the moment of dispatch.
 *
 * Drafts are written hours (sometimes days) before the paced queue actually
 * sends them, so a body drafted "Good morning" can otherwise land at 2pm.
 * Right before dispatch, sendQueueWorker calls adjustGreetingForSendTime with
 * the actual send clock and the recipient's tz offset (meta.recipientTzOffsetHours,
 * hours relative to the send tz — e.g. +1 for Calgary vs PT, +2 for Texas;
 * omitted/0 = same as send tz). Only the LEADING greeting is touched; bodies
 * without a time-based greeting pass through unchanged.
 *
 * Pure function — no clock, no env — so it is unit-testable (tests/greetingAdjust.test.js).
 */

const GREETING_RE = /^(\s*(?:<p[^>]*>)?\s*)Good (morning|afternoon|evening)\b/i;

function greetingForHour(hour) {
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/**
 * @param body           the email body (HTML or plain text)
 * @param localHourSendTz current hour (0-23) in the sender's send tz (PT)
 * @param tzOffsetHours  recipient offset from the send tz, in hours (default 0)
 * @returns body with the leading greeting corrected for the recipient's local time
 */
function adjustGreetingForSendTime(body, localHourSendTz, tzOffsetHours = 0) {
  if (!body || typeof body !== 'string') return body;
  const m = body.match(GREETING_RE);
  if (!m) return body;
  const recipientHour = (((localHourSendTz + Number(tzOffsetHours || 0)) % 24) + 24) % 24;
  const correct = greetingForHour(recipientHour);
  const current = `Good ${m[2].toLowerCase()}`;
  if (current === correct.toLowerCase() || current === correct) return body;
  return body.replace(GREETING_RE, `$1${correct}`);
}

module.exports = { adjustGreetingForSendTime, greetingForHour };
