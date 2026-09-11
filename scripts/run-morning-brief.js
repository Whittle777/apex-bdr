#!/usr/bin/env node
/**
 * Morning Brief CLI — generate a brief artifact from the repo root.
 *
 * Usage:
 *   node scripts/run-morning-brief.js --demo
 *   node scripts/run-morning-brief.js --input path/to/targets.json
 *
 * Writes:
 *   artifacts/morning-brief/latest.json  (machine-readable)
 *   artifacts/morning-brief/latest.md    (human-readable report)
 *
 * Does NOT read .env or print secrets. Exits nonzero on invalid input.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { runMorningBrief, renderMarkdown } = require('../services/morningBriefEngine');

function parseArgs(argv) {
  const args = { demo: false, input: null, discover: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--demo') args.demo = true;
    else if (a === '--discover') args.discover = true;
    else if (a === '--input') args.input = argv[++i];
    else if (a.startsWith('--input=')) args.input = a.slice('--input='.length);
    else if (a === '-h' || a === '--help') args.help = true;
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/run-morning-brief.js --demo
  node scripts/run-morning-brief.js --input path/to/targets.json --discover

Options:
  --demo            Run with the seeded fixture targets (synthetic, labelled).
  --input <path>    Path to a JSON file with { targets: [...] } or an array.
  --discover        Search public Google News RSS feeds for fresh trigger signals.
  -h, --help        Show this help.

Outputs:
  artifacts/morning-brief/latest.json
  artifacts/morning-brief/latest.md
`);
}

/**
 * Bounded, safe directory creation. Only creates the leaf morning-brief dir
 * inside an existing artifacts/ dir; refuses to walk above the repo root.
 */
function ensureArtifactsDir(repoRoot) {
  const artifactsRoot = path.join(repoRoot, 'artifacts');
  const briefDir = path.join(artifactsRoot, 'morning-brief');
  // Resolve and ensure we never escape repoRoot.
  const resolved = path.resolve(briefDir);
  const resolvedRoot = path.resolve(repoRoot);
  if (!resolved.startsWith(resolvedRoot + path.sep) && resolved !== resolvedRoot) {
    throw new Error('Refusing to create artifact directory outside repo root');
  }
  fs.mkdirSync(artifactsRoot, { recursive: true });
  fs.mkdirSync(briefDir, { recursive: true });
  return briefDir;
}

function readTargetsFile(inputPath) {
  if (!inputPath) return null;
  const abs = path.resolve(inputPath);
  if (!fs.existsSync(abs)) {
    throw new Error(`Input file not found: ${abs}`);
  }
  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    throw new Error(`Could not read input file: ${e.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Input file is not valid JSON: ${e.message}`);
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.targets)) return parsed.targets;
  throw new Error('Input JSON must be an array or { targets: [...] }');
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return 0;
  }

  if (!args.demo && !args.input) {
    console.error('Error: must specify --demo or --input <path>');
    printHelp();
    return 2;
  }

  let targets = null;
  if (args.input) {
    try {
      targets = readTargetsFile(args.input);
    } catch (e) {
      console.error(`Error: ${e.message}`);
      return 2;
    }
    if (!Array.isArray(targets) || targets.length === 0) {
      console.error('Error: input file contained no targets');
      return 2;
    }
  }

  const brief = await runMorningBrief({ targets, demo: args.demo, discover: args.discover });

  const repoRoot = path.resolve(__dirname, '..');
  const dir = ensureArtifactsDir(repoRoot);

  const jsonPath = path.join(dir, 'latest.json');
  const mdPath = path.join(dir, 'latest.md');

  fs.writeFileSync(jsonPath, JSON.stringify(brief, null, 2) + '\n', 'utf8');
  fs.writeFileSync(mdPath, renderMarkdown(brief) + '\n', 'utf8');

  console.log(`Morning brief written:`);
  console.log(`  ${jsonPath}`);
  console.log(`  ${mdPath}`);
  console.log(`  Run ID: ${brief.runId} | accounts: ${brief.summary.total} | demo: ${brief.demo} | discovery: ${brief.discovery.enabled}`);
  if (brief.discovery.enabled) {
    console.log(`  Fresh signals: ${brief.discovery.freshSignals} | accounts with signals: ${brief.discovery.accountsWithSignals} | feed errors: ${brief.discovery.errors}`);
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('Fatal:', err && err.message ? err.message : err);
    process.exit(1);
  });
