/**
 * trackingLinks.js
 *
 * Builders + verifiers for open-pixel and click-redirect tracking URLs.
 *
 * Every URL carries an HMAC signature over its identifying parts so the
 * public /track endpoints can't be abused: /track/click would otherwise
 * be an open redirect (anyone could craft a link that bounces through
 * our domain to an arbitrary site), and unsigned pixel hits could
 * fabricate open stats.
 *
 * Secret resolution: TRACKING_SECRET > JWT_SECRET > dev fallback. The
 * signature only needs to survive as long as sent emails do — rotating
 * the secret invalidates tracking links in previously sent emails.
 */

const crypto = require('crypto');

const SECRET =
  process.env.TRACKING_SECRET ||
  process.env.JWT_SECRET ||
  'apex-dev-tracking-secret';

const appUrl = () => process.env.APP_URL || 'http://localhost:3000';

/** HMAC-SHA256 over the joined parts, truncated to 16 hex chars. */
function sign(...parts) {
  return crypto
    .createHmac('sha256', SECRET)
    .update(parts.join(':'))
    .digest('hex')
    .slice(0, 16);
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function buildOpenPixelUrl(prospectId, stepId) {
  const sig = sign('open', prospectId, stepId);
  return `${appUrl()}/track/open?prospectId=${prospectId}&stepId=${stepId}&sig=${sig}`;
}

function verifyOpenSig(sig, prospectId, stepId) {
  return safeEqual(sig, sign('open', prospectId, stepId));
}

function buildClickUrl(prospectId, stepId, targetUrl) {
  const sig = sign('click', prospectId, stepId, targetUrl);
  return (
    `${appUrl()}/track/click?prospectId=${prospectId}&stepId=${stepId}` +
    `&url=${encodeURIComponent(targetUrl)}&sig=${sig}`
  );
}

function verifyClickSig(sig, prospectId, stepId, targetUrl) {
  return safeEqual(sig, sign('click', prospectId, stepId, targetUrl));
}

/**
 * Minimal HTML entity decode for href attribute values. Rich-text /
 * pasted / LLM HTML serializes '&' inside attributes as '&amp;'; the
 * mail client would normally decode that before navigating, but once we
 * lift the href out of the HTML and into a redirect parameter we must
 * decode it ourselves or the target lands on a mangled URL.
 */
function decodeHtmlEntities(s) {
  const map = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'" };
  return s.replace(/&(amp|lt|gt|quot|#39|#x27);/gi, (m, e) => map[e.toLowerCase()] ?? m);
}

/**
 * Click-wrapping only makes sense when APP_URL is a host the RECIPIENT
 * can reach. With the local-dev default (localhost:3000) rewriting would
 * turn every CTA link in delivered mail into a dead link, so we skip
 * wrapping entirely and let clicks go untracked instead.
 */
function isPublicAppUrl() {
  const u = process.env.APP_URL;
  return !!u && !/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])([:/]|$)/i.test(u);
}

/**
 * Rewrite every external http(s) anchor href in an HTML body to a signed
 * /track/click redirect. Links pointing back at APP_URL are left alone
 * (unsubscribe links, already-wrapped tracking links), so this is safe
 * to call on any body the mailer produces. No-op unless APP_URL is a
 * publicly reachable host.
 */
function wrapLinksForClickTracking(html, prospectId, stepId) {
  if (!html || !isPublicAppUrl()) return html;
  const own = appUrl();
  return html.replace(
    /(<a\b[^>]*?href=)(["'])(https?:\/\/[^"']+)\2/gi,
    (match, prefix, quote, url) => {
      const target = decodeHtmlEntities(url);
      if (target.startsWith(own)) return match;
      return `${prefix}${quote}${buildClickUrl(prospectId, stepId, target)}${quote}`;
    }
  );
}

module.exports = {
  buildOpenPixelUrl,
  verifyOpenSig,
  buildClickUrl,
  verifyClickSig,
  wrapLinksForClickTracking,
};
