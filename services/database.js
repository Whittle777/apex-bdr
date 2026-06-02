/**
 * Shared PrismaClient singleton.
 *
 * Every part of the app should require THIS module instead of calling
 * `new PrismaClient()` directly — otherwise each requirer opens its own
 * connection pool and Railway's Postgres (with limited max_connections)
 * starts rejecting with "FATAL: sorry, too many clients already" at
 * deploy time. The globalThis cache also prevents duplicate instances
 * across hot-reloads (nodemon) in dev.
 */
const { PrismaClient } = require('@prisma/client');

/**
 * Force a small connection pool. Railway's Postgres has a low
 * max_connections cap, and during deploy the old container's pool
 * can still be live while the new one starts up. Default Prisma pool
 * is (num_cpus * 2 + 1) per instance, which is way too generous here.
 * Capping at 5 keeps us safely under typical small-Postgres limits
 * even when multiple containers overlap.
 */
function buildClient() {
  const raw = process.env.DATABASE_URL;
  if (!raw) return new PrismaClient();
  try {
    const u = new URL(raw);
    if (!u.searchParams.has('connection_limit')) u.searchParams.set('connection_limit', '5');
    if (!u.searchParams.has('pool_timeout'))    u.searchParams.set('pool_timeout', '20');
    return new PrismaClient({ datasources: { db: { url: u.toString() } } });
  } catch {
    return new PrismaClient();
  }
}

const prisma = globalThis.__apexPrisma__ || buildClient();
if (!globalThis.__apexPrisma__) globalThis.__apexPrisma__ = prisma;

module.exports = prisma;
