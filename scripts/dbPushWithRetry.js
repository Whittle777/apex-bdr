#!/usr/bin/env node
/**
 * Run `prisma db push` with retry + boot-anyway fallback.
 *
 * Why: on Railway, the Postgres add-on can be briefly unreachable on
 * cold-start or during platform incidents. Without retries, the container
 * crash-loops and the API never serves /api/health, which means Railway
 * keeps killing it.
 *
 * Strategy: retry up to MAX_ATTEMPTS with exponential backoff. If every
 * attempt fails, log loudly and exit 0 so the next command in the chain
 * (`node index.js`) still runs. Routes that hit the DB will return 500
 * until Postgres recovers, but /api/health responds and Railway stops
 * restarting the container.
 */
const { spawnSync } = require('child_process');

const MAX_ATTEMPTS = parseInt(process.env.DB_PUSH_MAX_ATTEMPTS || '3', 10);
const BASE_DELAY_MS = parseInt(process.env.DB_PUSH_BASE_DELAY_MS || '5000', 10);

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`[db-push] attempt ${attempt}/${MAX_ATTEMPTS}…`);
    const result = spawnSync('npx', ['prisma', 'db', 'push'], {
      stdio: 'inherit',
      env: process.env,
    });
    if (result.status === 0) {
      console.log(`[db-push] success on attempt ${attempt}`);
      process.exit(0);
    }
    console.warn(`[db-push] attempt ${attempt} failed (exit ${result.status})`);
    if (attempt < MAX_ATTEMPTS) {
      const delay = BASE_DELAY_MS * Math.pow(3, attempt - 1); // 5s, 15s, 45s
      console.log(`[db-push] sleeping ${delay}ms before retry…`);
      await sleep(delay);
    }
  }
  console.error(`[db-push] all ${MAX_ATTEMPTS} attempts failed. Booting API anyway so health checks respond.`);
  console.error(`[db-push] Routes that hit the database will return 500 until Postgres is reachable.`);
  process.exit(0); // critical: 0 so the && in npm start still runs `node index.js`
}

main().catch(err => {
  console.error('[db-push] unexpected error:', err);
  process.exit(0);
});
