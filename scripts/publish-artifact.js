/**
 * publish-artifact.js
 * Worker side of the handoff: publish a QA-passed hospital to Tigris so the
 * reconciler can pick it up without ever touching this machine.
 *
 * Publishes two objects under handoff/<hospital-id>/:
 *   <utc>-<sha8>.ndjson   the parsed artifact
 *   <utc>-<sha8>.json     everything else the reconciler needs -- the manifest
 *                         entry, the QA report, the column map, and the
 *                         artifact's sha256/size/line count
 *
 * Bundling the metadata is the point. Previously the reconciler needed a git
 * branch from the worker *and* a file pull off its disk, so a worker that died
 * before pushing (or had no git credentials in a non-interactive session --
 * both happened on 2026-10-13) stranded finished work. Now the worker's job
 * ends here and nothing downstream depends on it staying alive.
 *
 * Usage:
 *   node scripts/publish-artifact.js <hospital_id>
 *   Options: --force (publish even if the manifest status isn't qa_pending)
 *            --keep N (handoffs to retain per hospital, default 2)
 */

import { createReadStream, existsSync, readFileSync, statSync } from 'fs';
import { createHash } from 'crypto';
import { createInterface } from 'readline';
import { execFileSync } from 'child_process';
import { hostname } from 'os';
import path from 'path';
import { Upload } from '@aws-sdk/lib-storage';
import { PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { PARSED_DIR, QA_REPORTS_DIR, COLUMN_MAPS_DIR, MANIFEST_PATH, REPO_ROOT } from './paths.js';
import { s3, BUCKET, HANDOFF_PREFIX, listKeys, human } from './s3.js';

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const keepIdx = args.indexOf('--keep');
const KEEP = keepIdx === -1 ? 2 : Number(args[keepIdx + 1]);
const hospitalId = args.find(a => !a.startsWith('--'));

async function hashAndCount(file) {
  const h = createHash('sha256');
  let lines = 0;
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on('data', d => h.update(d));
    stream.on('error', reject);
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', () => lines++);
    rl.on('close', resolve);
    rl.on('error', reject);
  });
  return { sha256: h.digest('hex'), lines };
}

function gitSha() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

async function main() {
  if (!hospitalId) {
    console.error('Usage: node scripts/publish-artifact.js <hospital_id> [--force] [--keep N]');
    process.exitCode = 1;
    return;
  }

  const ndjson = path.join(PARSED_DIR, `${hospitalId}.ndjson`);
  const qaReport = path.join(QA_REPORTS_DIR, `${hospitalId}.md`);
  const columnMap = path.join(COLUMN_MAPS_DIR, `${hospitalId}.json`);

  // --- Gates. A worker should not be able to hand off something unproven. ---
  if (!existsSync(ndjson)) {
    console.error(`No parsed artifact at ${ndjson}`);
    process.exitCode = 1;
    return;
  }
  if (!existsSync(qaReport)) {
    console.error(`No QA report at ${qaReport} -- run the data-qa subagent before publishing.`);
    process.exitCode = 1;
    return;
  }
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  const entry = manifest.hospitals.find(h => h.id === hospitalId);
  if (!entry) {
    console.error(`"${hospitalId}" is not in ${MANIFEST_PATH}`);
    process.exitCode = 1;
    return;
  }
  if (!['qa_pending', 'seeded'].includes(entry.status) && !FORCE) {
    console.error(
      `${hospitalId} has status "${entry.status}", expected "qa_pending".\n` +
      `The pipeline sets qa_pending when QA passes. Pass --force if you really mean to publish this.`
    );
    process.exitCode = 1;
    return;
  }

  const size = statSync(ndjson).size;
  console.log(`artifact: ${ndjson} (${human(size)})`);
  process.stdout.write('hashing... ');
  const { sha256, lines } = await hashAndCount(ndjson);
  console.log(`${lines.toLocaleString()} lines, sha256 ${sha256.slice(0, 16)}...`);

  // Second precision, not minute: an earlier version sliced this down to
  // YYYY-MM-DD-HHMM, so two publishes in the same minute produced the same key
  // and the second silently overwrote the first. Still ISO-ordered, so keys
  // sort lexicographically into chronological order for retention.
  // The sha8 suffix means re-publishing byte-identical content reuses the same
  // key, which is the one collision worth having.
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '');
  const stem = `${HANDOFF_PREFIX}/${hospitalId}/${stamp}-${sha256.slice(0, 8)}`;
  const client = s3();

  const metadata = {
    hospital_id: hospitalId,
    published_at: new Date().toISOString(),
    published_by: hostname(),
    git_sha: gitSha(),
    artifact: {
      key: `${stem}.ndjson`,
      bytes: size,
      lines,
      sha256,
    },
    manifest_entry: entry,
    qa_report: readFileSync(qaReport, 'utf8'),
    column_map: existsSync(columnMap) ? JSON.parse(readFileSync(columnMap, 'utf8')) : null,
  };

  console.log(`\nuploading to s3://${BUCKET}/${stem}.ndjson`);
  const upload = new Upload({
    client,
    params: {
      Bucket: BUCKET,
      Key: `${stem}.ndjson`,
      Body: createReadStream(ndjson),
      ChecksumAlgorithm: 'SHA256',
    },
    // 64MB parts: the biggest artifact so far is 7.7GB, and S3 allows 10,000
    // parts, so this leaves plenty of headroom while keeping a failed part cheap.
    partSize: 64 * 1024 * 1024,
    queueSize: 4,
  });
  let lastPct = -5;
  upload.on('httpUploadProgress', p => {
    const pct = Math.floor((p.loaded / size) * 100);
    if (pct >= lastPct + 5) {
      lastPct = pct;
      console.log(`  ${pct}% (${human(p.loaded)} of ${human(size)})`);
    }
  });
  await upload.done();

  await client.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: `${stem}.json`,
    Body: JSON.stringify(metadata, null, 2),
    ContentType: 'application/json',
  }));
  console.log(`uploaded metadata to s3://${BUCKET}/${stem}.json`);

  // --- Retention: keep the most recent KEEP handoffs for this hospital ---
  const existing = await listKeys(client, `${HANDOFF_PREFIX}/${hospitalId}/`);
  const stems = [...new Set(existing.map(o => o.key.replace(/\.(ndjson|json)$/, '')))].sort().reverse();
  const doomed = stems.slice(KEEP);
  for (const old of doomed) {
    for (const ext of ['.ndjson', '.json']) {
      await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: old + ext })).catch(() => {});
    }
    console.log(`pruned old handoff ${old}`);
  }

  console.log(`\nPublished ${hospitalId}. The reconciler needs nothing from this machine now:`);
  console.log(`  node scripts/fetch-artifact.js ${hospitalId}`);
}

main().catch(err => {
  console.error(`\nFAILED: ${err.message}`);
  process.exitCode = 1;
});
