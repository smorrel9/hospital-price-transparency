/**
 * fetch-artifact.js
 * Reconciler side of the handoff: pull a QA-passed hospital from Tigris.
 *
 * Replaces `sprite file pull` off a worker's disk, which required the worker
 * to still be reachable and had no resume -- the 681MB Texas Children's
 * NDJSON had to be split into chunks by hand on 2026-10-13 because a single
 * pull exceeded a 30s server-side deadline.
 *
 * Writes the parsed artifact (checksum-verified), the QA report, and the
 * column map. The manifest entry is printed rather than merged, because
 * data/hospitals.json is the one file every session touches and silently
 * rewriting it would undercut the git-pull-before-write convention in
 * docs/adding-a-hospital.md. Pass --apply-manifest to merge it anyway.
 *
 * Usage:
 *   node scripts/fetch-artifact.js <hospital_id>
 *   node scripts/fetch-artifact.js --list
 *   Options: --key <stem> (a specific handoff), --apply-manifest
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { pipeline } from 'stream/promises';
import path from 'path';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { PARSED_DIR, QA_REPORTS_DIR, COLUMN_MAPS_DIR, MANIFEST_PATH } from './paths.js';
import { s3, BUCKET, HANDOFF_PREFIX, listKeys, human } from './s3.js';

const args = process.argv.slice(2);
const LIST = args.includes('--list');
const APPLY = args.includes('--apply-manifest');
const keyIdx = args.indexOf('--key');
const KEY = keyIdx === -1 ? null : args[keyIdx + 1];
const hospitalId = args.find(a => !a.startsWith('--') && a !== KEY);

async function getBody(client, key) {
  const res = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return res.Body;
}

async function getText(client, key) {
  const body = await getBody(client, key);
  return await body.transformToString();
}

async function main() {
  const client = s3();

  if (LIST || !hospitalId) {
    const all = await listKeys(client, `${HANDOFF_PREFIX}/`);
    const meta = all.filter(o => o.key.endsWith('.json'));
    if (!meta.length) {
      console.log(`No handoffs published to s3://${BUCKET}/${HANDOFF_PREFIX}/ yet.`);
      return;
    }
    console.log(`handoffs in s3://${BUCKET}:\n`);
    const byHospital = new Map();
    for (const o of meta) {
      const id = o.key.split('/')[1];
      if (!byHospital.has(id)) byHospital.set(id, []);
      byHospital.get(id).push(o);
    }
    for (const [id, objs] of [...byHospital].sort()) {
      console.log(`  ${id}`);
      for (const o of objs.sort((a, b) => b.key.localeCompare(a.key))) {
        const artifact = all.find(a => a.key === o.key.replace(/\.json$/, '.ndjson'));
        console.log(`    ${o.key.split('/')[2].replace(/\.json$/, '')}  ${artifact ? human(artifact.size) : 'artifact MISSING'}  ${o.modified.toISOString().slice(0, 16)}`);
      }
    }
    if (!hospitalId) console.log(`\nFetch one with: node scripts/fetch-artifact.js <hospital_id>`);
    return;
  }

  // --- Pick the handoff ---
  const objs = await listKeys(client, `${HANDOFF_PREFIX}/${hospitalId}/`);
  if (!objs.length) {
    console.error(`No handoffs published for "${hospitalId}". Run --list to see what's available.`);
    process.exitCode = 1;
    return;
  }
  const stems = [...new Set(objs.map(o => o.key.replace(/\.(ndjson|json)$/, '')))].sort().reverse();
  const stem = KEY ? stems.find(s => s.endsWith(KEY)) : stems[0];
  if (!stem) {
    console.error(`No handoff matching "${KEY}" for ${hospitalId}. Available:\n  ${stems.join('\n  ')}`);
    process.exitCode = 1;
    return;
  }
  if (!KEY && stems.length > 1) console.log(`${stems.length} handoffs available; taking the newest.`);

  const metadata = JSON.parse(await getText(client, `${stem}.json`));
  console.log(`\nhandoff:   ${stem}`);
  console.log(`published: ${metadata.published_at} by ${metadata.published_by}${metadata.git_sha ? ` @ ${metadata.git_sha}` : ''}`);
  console.log(`artifact:  ${human(metadata.artifact.bytes)}, ${metadata.artifact.lines.toLocaleString()} lines`);
  console.log(`manifest:  status "${metadata.manifest_entry.status}"${metadata.column_map ? ', has column-map override' : ''}`);

  // --- Download and verify ---
  mkdirSync(PARSED_DIR, { recursive: true });
  const dest = path.join(PARSED_DIR, `${hospitalId}.ndjson`);
  console.log(`\ndownloading -> ${dest}`);
  const body = await getBody(client, `${stem}.ndjson`);
  const hash = createHash('sha256');
  body.on('data', d => hash.update(d));
  await pipeline(body, createWriteStream(dest));

  const got = hash.digest('hex');
  if (got !== metadata.artifact.sha256) {
    console.error(`\nChecksum mismatch -- the download is corrupt, not using it.\n  expected ${metadata.artifact.sha256}\n  got      ${got}`);
    process.exitCode = 1;
    return;
  }
  console.log(`checksum verified: ${got.slice(0, 16)}...`);

  // --- Restore the small files the worker would otherwise have git-pushed ---
  mkdirSync(QA_REPORTS_DIR, { recursive: true });
  writeFileSync(path.join(QA_REPORTS_DIR, `${hospitalId}.md`), metadata.qa_report);
  console.log(`wrote ${path.join(QA_REPORTS_DIR, `${hospitalId}.md`)}`);

  if (metadata.column_map) {
    mkdirSync(COLUMN_MAPS_DIR, { recursive: true });
    writeFileSync(path.join(COLUMN_MAPS_DIR, `${hospitalId}.json`), JSON.stringify(metadata.column_map, null, 2) + '\n');
    console.log(`wrote ${path.join(COLUMN_MAPS_DIR, `${hospitalId}.json`)}`);
  }

  // --- Manifest ---
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  const existing = manifest.hospitals.findIndex(h => h.id === hospitalId);
  if (APPLY) {
    if (existing === -1) manifest.hospitals.push(metadata.manifest_entry);
    else manifest.hospitals[existing] = metadata.manifest_entry;
    writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`merged the manifest entry into ${MANIFEST_PATH} (${existing === -1 ? 'added' : 'updated'})`);
  } else if (existing === -1) {
    console.log(`\n${hospitalId} is not in the manifest yet. Add this entry (or re-run with --apply-manifest):\n`);
    console.log(JSON.stringify(metadata.manifest_entry, null, 2));
  } else {
    console.log(`\n${hospitalId} is already in the manifest; left untouched. Use --apply-manifest to overwrite it from the handoff.`);
  }

  console.log(`\nReady to seed:\n  node scripts/seed-db.js ${hospitalId}\n  npm run verify-db\n  npm run publish-db`);
}

main().catch(err => {
  console.error(`\nFAILED: ${err.message}`);
  process.exitCode = 1;
});
