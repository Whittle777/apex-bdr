#!/usr/bin/env node
/**
 * One-time purge: blank the confidential client secret that was historically
 * copied into every Microsoft IntegrationCredential row. The app secret now
 * lives only in MICROSOFT_CLIENT_SECRET (env); the token paths read it from
 * there (sequenceMailer.js, replyDetector.js, oauthService.js), so blanking the
 * DB copies removes the duplication flagged by the C3.ai security review.
 *
 * Idempotent — safe to run repeatedly. Run AFTER the code that switches the
 * readers to env is deployed.
 *
 * Usage (against prod, like the other ops scripts):
 *   DATABASE_URL=<public-pg-url> node scripts/purgeMicrosoftSecretFromRows.js
 *   # or: railway run --service apex-bdr (with DATABASE_URL overridden to the
 *   #     Postgres public proxy URL)
 */
const prisma = require('../services/database');

(async () => {
  try {
    const before = await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM "IntegrationCredential"
       WHERE provider='microsoft' AND COALESCE("clientSecret",'') <> ''`
    );
    const withSecret = before[0].n;
    console.log(`Microsoft rows still holding a clientSecret: ${withSecret}`);

    if (withSecret === 0) {
      console.log('Nothing to purge — all Microsoft rows already have a blank clientSecret. ✅');
    } else {
      const updated = await prisma.$executeRawUnsafe(
        `UPDATE "IntegrationCredential" SET "clientSecret"='' WHERE provider='microsoft' AND COALESCE("clientSecret",'') <> ''`
      );
      console.log(`Blanked clientSecret on ${updated} Microsoft row(s). ✅`);
    }

    const after = await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM "IntegrationCredential"
       WHERE provider='microsoft' AND COALESCE("clientSecret",'') <> ''`
    );
    console.log(`VERIFY: Microsoft rows with a non-empty clientSecret now: ${after[0].n} (expect 0)`);
  } catch (err) {
    console.error('purge failed:', err.message);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
})();
