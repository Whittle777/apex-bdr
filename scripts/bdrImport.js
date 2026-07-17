#!/usr/bin/env node
/**
 * bdrImport — full-refresh loader: exporter JSON snapshot → Bdr* shadow tables.
 *
 * Run LOCALLY (not deployed) with DATABASE_URL pointing at the target DB:
 *   DATABASE_URL="$(railway variables --service Postgres --json | jq -r .DATABASE_PUBLIC_URL)" \
 *     node scripts/bdrImport.js /path/to/bdr_snapshot.json
 *
 * Full refresh by design: during the shadow phase the workbook is canonical,
 * so the tables always hold exactly one workbook state, stamped with its
 * wbSha256 in BdrSnapshotMeta. Wipes ONLY the Bdr* tables — never anything
 * the app owns. All-or-nothing: wipe + reload run inside one transaction, so
 * a failed import leaves the previous load intact.
 */
const fs = require('fs');
const prisma = require('../services/database');

const CHUNK = 500;

async function loadChunked(tx, model, rows, label) {
  for (let i = 0; i < rows.length; i += CHUNK) {
    await tx[model].createMany({ data: rows.slice(i, i + CHUNK), skipDuplicates: true });
  }
  const n = await tx[model].count();
  console.log(`  ${label}: loaded ${n}/${rows.length}${n !== rows.length ? '  ⚠ DUPLICATE KEYS SKIPPED' : ''}`);
  return n;
}

async function main() {
  const path = process.argv[2];
  if (!path) { console.error('usage: node scripts/bdrImport.js <snapshot.json>'); process.exit(2); }
  const snap = JSON.parse(fs.readFileSync(path, 'utf8'));
  const { meta, prospects, sequenceState, emailLog } = snap;
  console.log(`snapshot: wbSha256=${meta.wbSha256.slice(0, 16)}… exportedAt=${meta.exportedAt}`);
  console.log(`  rows: prospects=${prospects.length} seqState=${sequenceState.length} emailLog=${emailLog.length}`);

  const counts = await prisma.$transaction(async (tx) => {
    await tx.bdrEmailLog.deleteMany({});
    await tx.bdrSequenceState.deleteMany({});
    await tx.bdrProspect.deleteMany({});
    const p = await loadChunked(tx, 'bdrProspect', prospects, 'BdrProspect');
    const s = await loadChunked(tx, 'bdrSequenceState', sequenceState, 'BdrSequenceState');
    const e = await loadChunked(tx, 'bdrEmailLog', emailLog, 'BdrEmailLog');
    await tx.bdrSnapshotMeta.create({
      data: {
        wbSha256: meta.wbSha256,
        exportedAt: meta.exportedAt,
        prospectRows: p,
        seqStateRows: s,
        emailLogRows: e,
      },
    });
    return { p, s, e };
  }, { timeout: 10 * 60 * 1000 });

  console.log(`import complete: ${counts.p} prospects, ${counts.s} sequence rows, ${counts.e} email-log rows`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('IMPORT FAILED (previous load left intact):', err.message);
  await prisma.$disconnect();
  process.exit(1);
});
