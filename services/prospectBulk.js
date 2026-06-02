/**
 * Shared bulk-import helper: upserts Accounts, creates new Prospects,
 * assigns ownership, and returns the resolved prospect IDs (existing + new)
 * so callers (Prospects CSV import, Research upload, etc.) can reuse the
 * same accounts-and-ownership wiring.
 */

const { createProspectsBulk } = require('../controllers/prospectsController');

const prisma = require('./database');
/**
 * @param {Object} opts
 * @param {Array<Object>} opts.prospects - parsed prospect rows
 * @param {number}        opts.userId    - uploader user id (becomes owner)
 * @returns {Promise<{ count, accountsCreated, prospectIds: Record<string, number> }>}
 *   prospectIds maps email -> Prospect.id for every prospect in the batch
 *   (existing or just-created).
 */
async function upsertProspectBatch({ prospects, userId }) {
  if (!Array.isArray(prospects) || prospects.length === 0) {
    return { count: 0, accountsCreated: 0, prospectIds: {} };
  }

  // Upsert one Account per unique companyName in the batch
  const uniqueCompanies = [...new Set(prospects.map(p => p.companyName).filter(Boolean))];
  const accountMap = {};
  let accountsCreated = 0;

  for (const name of uniqueCompanies) {
    const existing = await prisma.account.findFirst({ where: { name } });
    if (existing) {
      accountMap[name] = existing.id;
      // Backfill ownership if missing
      if (userId) {
        await prisma.account.update({
          where: { id: existing.id },
          data: { owners: { connect: [{ id: userId }] } },
        }).catch(() => { /* already owned — ignore */ });
      }
    } else {
      const sample = prospects.find(p => p.companyName === name);
      const created = await prisma.account.create({
        data: {
          name,
          country:   sample?.country   || null,
          region:    sample?.region    || null,
          techStack: sample?.techStack || null,
          ...(userId ? { owners: { connect: [{ id: userId }] } } : {}),
        },
      });
      accountMap[name] = created.id;
      accountsCreated += 1;
    }
  }

  const prospectsWithOwner = prospects.map(p => ({
    ...p,
    ownedById: userId,
    accountId: p.companyName ? accountMap[p.companyName] : undefined,
  }));

  const result = await createProspectsBulk(prospectsWithOwner);

  const emails = prospectsWithOwner.map(p => p.email).filter(Boolean);
  const allRows = emails.length === 0
    ? []
    : await prisma.prospect.findMany({
        where: { email: { in: emails } },
        select: { id: true, email: true },
      });
  const prospectIds = {};
  for (const row of allRows) prospectIds[row.email] = row.id;

  // Owner table is keyed (prospectId, userId); upsert idempotently
  if (userId && allRows.length > 0) {
    await Promise.all(allRows.map(p =>
      prisma.prospectOwner.upsert({
        where: { prospectId_userId: { prospectId: p.id, userId } },
        update: {},
        create: { prospectId: p.id, userId },
      })
    ));
  }

  return {
    count: result.count || 0,
    accountsCreated,
    prospectIds,
  };
}

module.exports = { upsertProspectBatch };
