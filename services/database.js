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

const prisma = globalThis.__apexPrisma__ || new PrismaClient();
if (!globalThis.__apexPrisma__) globalThis.__apexPrisma__ = prisma;

module.exports = prisma;
