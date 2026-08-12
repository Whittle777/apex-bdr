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

/**
 * HMAC-SHA256 over the parts, truncated to 16 hex chars. Each part is
 * length-prefixed before joining so no part containing a delimiter can
 * shift the boundaries and make two different tuples collide.
 */
function sign(...parts) {
  const encoded = parts.map((p) => `${Buffer.byteLength(String(p))}:${p}`).join('|');
  return crypto.createHmac('sha256', SECRET).update(encoded).digest('hex').slice(0, 16);
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

// ── Queue-item variants ─────────────────────────────────────────────────
// Bridge/queue sends (OutboundQueue) are keyed by trackingId instead of
// prospect+step. Distinct sign prefixes ('qopen'/'qclick') keep the two
// URL families from ever cross-verifying.

function buildQueueOpenPixelUrl(trackingId) {
  const sig = sign('qopen', trackingId);
  return `${appUrl()}/track/open?tid=${encodeURIComponent(trackingId)}&sig=${sig}`;
}

function verifyQueueOpenSig(sig, trackingId) {
  return safeEqual(sig, sign('qopen', trackingId));
}

function buildQueueClickUrl(trackingId, targetUrl) {
  const sig = sign('qclick', trackingId, targetUrl);
  return (
    `${appUrl()}/track/click?tid=${encodeURIComponent(trackingId)}` +
    `&url=${encodeURIComponent(targetUrl)}&sig=${sig}`
  );
}

function verifyQueueClickSig(sig, trackingId, targetUrl) {
  return safeEqual(sig, sign('qclick', trackingId, targetUrl));
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
 * Shared link-rewriting core: wrap every external http(s) anchor href
 * through the click redirect produced by buildUrl(target). Links
 * pointing back at APP_URL are left alone (unsubscribe links,
 * already-wrapped tracking links). No-op unless APP_URL is a publicly
 * reachable host.
 */
function wrapLinks(html, buildUrl) {
  if (!html || !isPublicAppUrl()) return html;
  const own = appUrl();
  return html.replace(
    /(<a\b[^>]*?href=)(["'])(https?:\/\/[^"']+)\2/gi,
    (match, prefix, quote, url) => {
      const target = decodeHtmlEntities(url);
      if (target.startsWith(own)) return match;
      return `${prefix}${quote}${buildUrl(target)}${quote}`;
    }
  );
}

/** Sequence-email variant: click URLs keyed by prospect+step. */
function wrapLinksForClickTracking(html, prospectId, stepId) {
  return wrapLinks(html, (target) => buildClickUrl(prospectId, stepId, target));
}

/** Queue-item variant: click URLs keyed by OutboundQueue trackingId. */
function wrapLinksForQueueClickTracking(html, trackingId) {
  return wrapLinks(html, (target) => buildQueueClickUrl(trackingId, target));
}

/**
 * Neutralize OUR tracking artifacts inside an HTML fragment being quoted
 * into a new email (reply threading): remove /track/open pixels and
 * unwrap /track/click anchors back to their original targets. Without
 * this, a quoted parent email's still-valid pixel would fire on every
 * open of the follow-up and credit the WRONG row. Covers both URL
 * families (sequence and queue) since they share the /track prefixes.
 */
function stripTrackingFromHtml(html) {
  if (!html) return html;
  const esc = appUrl().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let out = html.replace(
    new RegExp(`<img\\b[^>]*src=(["'])${esc}\\/track\\/open[^"']*\\1[^>]*\\/?>`, 'gi'),
    ''
  );
  out = out.replace(
    new RegExp(`(href=)(["'])(${esc}\\/track\\/click[^"']+)\\2`, 'gi'),
    (match, prefix, quote, trackUrl) => {
      try {
        const target = new URL(decodeHtmlEntities(trackUrl)).searchParams.get('url');
        return target ? `${prefix}${quote}${target}${quote}` : match;
      } catch {
        return match;
      }
    }
  );
  return out;
}

module.exports = {
  buildOpenPixelUrl,
  verifyOpenSig,
  buildClickUrl,
  verifyClickSig,
  wrapLinksForClickTracking,
  buildQueueOpenPixelUrl,
  verifyQueueOpenSig,
  buildQueueClickUrl,
  verifyQueueClickSig,
  wrapLinksForQueueClickTracking,
  stripTrackingFromHtml,
  isPublicAppUrl,
};
