/**
 * emailAssets — store binary email assets (inline images) ONCE and resolve them
 * to Graph attachment descriptors at send time.
 *
 * Why a table instead of inline base64 on each queue row: a 142-item batch that
 * each carried a ~300KB image would be a ~45MB enqueue POST and 45MB of duplicated
 * rows. Here the bytes live once in EmailAsset; every OutboundQueue row (and the
 * immediate send path) carries only a tiny reference {assetId, contentId, inline}.
 * The worker/route resolves the ref to {name,contentType,contentBytes,isInline,
 * contentId} and hands it to bridgeMailer, which builds the Graph fileAttachment.
 *
 * bridgeMailer stays credential/Graph-only and never touches prisma; this module
 * is the DB side, imported by BOTH routes/mcpBridge.js and services/sendQueueWorker.js.
 */
const crypto = require('crypto');
const prisma = require('./database');

// Per-asset decoded ceiling. Inline email images are small; this is a sanity
// bound, well under Graph's ~4MB whole-message limit (enforced in bridgeMailer).
const MAX_ASSET_BYTES = 5 * 1024 * 1024;

class AssetError extends Error {
  constructor(message, { httpStatus = 400, code = 'asset_error' } = {}) {
    super(message);
    this.name = 'AssetError';
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

const isImageType = (t) => typeof t === 'string' && /^image\/(png|jpe?g|gif|webp)$/i.test(t.trim());

/**
 * Persist a new asset. Accepts base64 with or without a `data:...;base64,` prefix;
 * normalizes by decoding and re-encoding (so what we store is canonical base64 and
 * the byteSize is the true decoded length). Returns the public descriptor (no bytes).
 */
async function createAsset({ name, contentType, contentBytesB64, userId = null }) {
  if (!name || typeof name !== 'string') throw new AssetError('"name" is required');
  if (!isImageType(contentType)) throw new AssetError('"contentType" must be image/png, image/jpeg, image/gif, or image/webp');
  if (!contentBytesB64 || typeof contentBytesB64 !== 'string') throw new AssetError('"contentBytesB64" is required');

  const rawB64 = contentBytesB64.replace(/^data:[^;]+;base64,/, '').trim();
  const buf = Buffer.from(rawB64, 'base64');
  if (!buf.length) throw new AssetError('"contentBytesB64" did not decode to any bytes');
  // Buffer.from silently drops invalid chars, so re-encode and compare lengths to
  // catch a payload that wasn't really base64 (a corrupt upload) rather than store junk.
  if (buf.toString('base64').length < Math.floor(rawB64.replace(/=+$/, '').length * 0.9)) {
    throw new AssetError('"contentBytesB64" is not valid base64');
  }
  if (buf.length > MAX_ASSET_BYTES) {
    throw new AssetError(`asset too large: ${buf.length} bytes (max ${MAX_ASSET_BYTES})`, { httpStatus: 413 });
  }

  const assetId = `asset_${crypto.randomUUID()}`;
  const row = await prisma.emailAsset.create({
    data: { assetId, userId, name: name.trim(), contentType: contentType.trim().toLowerCase(), contentBytes: buf.toString('base64'), byteSize: buf.length },
  });
  return { assetId: row.assetId, name: row.name, contentType: row.contentType, byteSize: row.byteSize, createdAt: row.createdAt };
}

/** Return the subset of assetIds that exist (for enqueue-time validation; loads no bytes). */
async function existingAssetIds(assetIds) {
  const ids = [...new Set((assetIds || []).filter(Boolean))];
  if (!ids.length) return new Set();
  const rows = await prisma.emailAsset.findMany({ where: { assetId: { in: ids } }, select: { assetId: true } });
  return new Set(rows.map((r) => r.assetId));
}

/**
 * Resolve reference objects to bridgeMailer attachment descriptors.
 * refs: [{ assetId, contentId?, inline?, name? }]. Loads bytes. Throws AssetError
 * if any ref lacks an assetId or points at an unknown asset (so a missing image
 * fails LOUDLY rather than sending a broken cid: with no picture).
 */
async function resolveAttachmentRefs(refs) {
  const list = Array.isArray(refs) ? refs.filter(Boolean) : [];
  if (!list.length) return [];
  if (list.some((r) => !r.assetId)) throw new AssetError('every attachment reference needs an "assetId"');
  const ids = [...new Set(list.map((r) => r.assetId))];
  const rows = await prisma.emailAsset.findMany({ where: { assetId: { in: ids } } });
  const byId = new Map(rows.map((r) => [r.assetId, r]));
  return list.map((r) => {
    const a = byId.get(r.assetId);
    if (!a) throw new AssetError(`unknown assetId "${r.assetId}"`, { httpStatus: 422 });
    return {
      name: r.name || a.name,
      contentType: a.contentType,
      contentBytes: a.contentBytes,
      isInline: r.inline !== false,
      ...(r.contentId ? { contentId: String(r.contentId) } : {}),
    };
  });
}

module.exports = { AssetError, MAX_ASSET_BYTES, isImageType, createAsset, existingAssetIds, resolveAttachmentRefs };
