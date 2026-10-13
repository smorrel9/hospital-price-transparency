/**
 * rollback-db.js
 * Switch production back to a previously published database artifact.
 *
 * This is the thing that did not exist on 2026-10-13, when recovering from a
 * deleted database meant a 17-minute re-upload from a laptop that then went to
 * sleep mid-transfer. Rolling back is now repointing a symlink and restarting:
 * seconds, and it needs nothing from the machine you run it on.
 *
 * Usage:
 *   node scripts/rollback-db.js --list        Show what is published and live
 *   node scripts/rollback-db.js               Roll back to the previous version
 *   node scripts/rollback-db.js --to <file>   Roll back to a specific version
 */

import { execFileSync, spawnSync } from 'child_process';
import path from 'path';
import { REPO_ROOT } from './paths.js';
import * as fly from './fly-remote.js';
import { LIVE_LINK, currentTarget, listVersions, flipTo } from './db-artifacts.js';

const args = process.argv.slice(2);
const LIST = args.includes('--list');
const toIndex = args.indexOf('--to');
const TO = toIndex === -1 ? null : args[toIndex + 1];

function publicUrl() {
  const status = JSON.parse(execFileSync('flyctl', ['status', '--json'], { encoding: 'utf8' }));
  return `https://${status.Hostname}`;
}

function main() {
  const current = currentTarget();
  const versions = listVersions();

  if (!versions.length) {
    console.error(`No published artifacts found. ${LIVE_LINK} is ${current ? `-> ${current}` : 'a regular file'}.`);
    process.exitCode = 1;
    return;
  }

  console.log(`live: ${LIVE_LINK} ${current ? `-> ${current}` : '(regular file, not yet versioned)'}\n`);
  console.log('published versions, newest first:');
  for (const v of versions) console.log(`  ${v === current ? '*' : ' '} ${v}`);

  if (LIST) return;

  if (!current) {
    console.error(`\n${LIVE_LINK} is not a symlink yet -- run "node scripts/publish-db.js --adopt-current" first.`);
    process.exitCode = 1;
    return;
  }

  const target = TO || versions.find(v => v !== current);
  if (!target) {
    console.error('\nNothing to roll back to -- only one published version exists.');
    process.exitCode = 1;
    return;
  }
  if (!versions.includes(target)) {
    console.error(`\n"${target}" is not a published version on the volume.`);
    process.exitCode = 1;
    return;
  }
  if (target === current) {
    console.error(`\n"${target}" is already live.`);
    process.exitCode = 1;
    return;
  }

  console.log(`\nrolling back: ${current} -> ${target}`);
  flipTo(target);

  const verified = fly.ssh('node /app/scripts/verify-db.js');
  console.log(`\n${verified.trim()}`);

  const url = publicUrl();
  console.log(`\n--- smoke against ${url} ---`);
  const ok = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'smoke.js'), url], {
    stdio: 'inherit',
    cwd: REPO_ROOT,
  }).status === 0;

  if (!ok) {
    console.error(`\nSmoke still failing after rolling back to ${target}. The problem is probably not the artifact.`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nRolled back. ${LIVE_LINK} -> ${target}`);
}

main();
