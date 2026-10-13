/**
 * publish-db.js
 * Publishes a built database to production as an immutable, versioned artifact
 * and switches the live site onto it by repointing a symlink.
 *
 * The model: /data/prices.db is a symlink to /data/prices-<date>-<sha>.db.
 * Publishing never mutates the file a live server is reading -- it lands a new
 * one beside it, proves it, then repoints. Rolling back is repointing the
 * symlink, which takes seconds instead of a 17-minute re-upload.
 *
 * This replaces the 2026-10-13 approach of running seed scripts against the
 * serving database, which deleted it. See docs/decision-log.md
 * ("Production data deploys").
 *
 * Safety properties, in the order they matter:
 *   - verify-db must pass on the artifact before anything is uploaded.
 *   - the upload is chunked and resumable, so an interrupted transfer costs
 *     one chunk rather than starting over (a closed laptop cost 4.7GB once).
 *   - the remote sha256 must equal the local one before the symlink moves.
 *   - smoke runs after the flip, and a failure rolls back automatically.
 * SQLite names -wal/-shm after the resolved path, so each version owns its
 * own WAL and a flip can never bind a stale WAL to a different artifact
 * (verified empirically 2026-10-13 before this was written).
 *
 * Usage:
 *   node scripts/publish-db.js                  Publish the local data/prices.db
 *   node scripts/publish-db.js --adopt-current  Version the file already live
 *                                               and symlink to it (migration)
 *   node scripts/publish-db.js --source <path>  Publish a specific file
 *   Options: --keep N (default 3), --chunk-mb N (default 512), --skip-smoke
 */

import { statSync, existsSync, createReadStream, openSync, readSync, closeSync, writeSync, unlinkSync } from 'fs';
import { createHash } from 'crypto';
import { execFileSync, spawnSync } from 'child_process';
import path from 'path';
import { DB_PATH, REPO_ROOT } from './paths.js';
import * as fly from './fly-remote.js';
import { quoteRemote as q } from './fly-remote.js';
import { REMOTE_DIR, LIVE_LINK, VERSION_RE, currentTarget, listVersions, flipTo } from './db-artifacts.js';

const args = process.argv.slice(2);
const flag = n => args.includes(`--${n}`);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? d : args[i + 1];
};

const ADOPT = flag('adopt-current');
const SKIP_SMOKE = flag('skip-smoke');
const KEEP = Number(opt('keep', 3));
const CHUNK = Number(opt('chunk-mb', 512)) * 1024 * 1024;
const SOURCE = opt('source', DB_PATH);

const GB = n => `${(n / 1024 ** 3).toFixed(2)}GB`;

function versionName() {
  const date = new Date().toISOString().slice(0, 10);
  let sha = 'nogit';
  let dirty = '';
  try {
    sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
    if (status) dirty = '-dirty';
  } catch {
    // Not a git checkout -- the date still identifies the artifact.
  }
  return `prices-${date}-${sha}${dirty}.db`;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', d => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

/** Run another script in this repo, inheriting stdio. Returns true on exit 0. */
function runScript(script, scriptArgs = []) {
  const r = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', script), ...scriptArgs], {
    stdio: 'inherit',
    cwd: REPO_ROOT,
  });
  return r.status === 0;
}

function publicUrl() {
  const status = JSON.parse(execFileSync('flyctl', ['status', '--json'], { encoding: 'utf8' }));
  const host = status.Hostname;
  if (!host) throw new Error('Could not determine the app hostname from flyctl status.');
  return `https://${host}`;
}

/**
 * Append `source` to `remotePath` in whole chunks, skipping whatever already
 * landed. Only complete chunks are ever appended, so an interrupted run
 * resumes on a boundary; a partially appended tail is trimmed first.
 */
async function uploadResumable(source, remotePath) {
  const total = statSync(source).size;
  let already = fly.remoteSize(remotePath);
  if (already < 0) already = 0;

  if (already > total) {
    throw new Error(
      `${remotePath} is already ${GB(already)}, larger than the ${GB(total)} source. ` +
      `Remove it on the volume and re-run.`
    );
  }

  const aligned = Math.floor(already / CHUNK) * CHUNK;
  if (aligned !== already) {
    console.log(`  trimming partial tail: ${GB(already)} -> ${GB(aligned)}`);
    fly.ssh(`truncate -s ${aligned} ${q(remotePath)}`);
    already = aligned;
  }
  if (already > 0) console.log(`  resuming at ${GB(already)} of ${GB(total)}`);

  const tmpLocal = path.join(REPO_ROOT, '.publish-chunk.tmp');
  const tmpRemote = `${REMOTE_DIR}/.publish-chunk.tmp`;
  const fd = openSync(source, 'r');
  try {
    for (let offset = already; offset < total; offset += CHUNK) {
      const size = Math.min(CHUNK, total - offset);
      const buf = Buffer.allocUnsafe(size);
      let read = 0;
      while (read < size) read += readSync(fd, buf, read, size - read, offset + read);

      const out = openSync(tmpLocal, 'w');
      try { writeSync(out, buf, 0, size); } finally { closeSync(out); }

      const pct = (((offset + size) / total) * 100).toFixed(1);
      console.log(`  chunk at ${GB(offset)} (+${GB(size)}) -> ${pct}%`);
      fly.sftpPut(tmpLocal, tmpRemote);
      fly.ssh(`cat ${q(tmpRemote)} >> ${q(remotePath)} && rm -f ${q(tmpRemote)}`);
    }
  } finally {
    closeSync(fd);
    if (existsSync(tmpLocal)) unlinkSync(tmpLocal);
  }

  const landed = fly.remoteSize(remotePath);
  if (landed !== total) throw new Error(`size mismatch after upload: ${landed} remote vs ${total} local`);
}

function prune(keepCurrent) {
  const ordered = listVersions();
  if (ordered.length <= KEEP) {
    console.log(`\nretention: ${ordered.length} version(s) on the volume, keeping up to ${KEEP} -- nothing to prune`);
    return;
  }
  const doomed = ordered.slice(KEEP).filter(f => f !== keepCurrent);
  if (!doomed.length) {
    console.log('\nretention: nothing eligible to prune');
    return;
  }
  console.log(`\nretention: removing ${doomed.length} old version(s): ${doomed.join(', ')}`);
  for (const f of doomed) {
    fly.ssh(`rm -f ${q(`${REMOTE_DIR}/${f}`)} ${q(`${REMOTE_DIR}/${f}-wal`)} ${q(`${REMOTE_DIR}/${f}-shm`)}`);
  }
}

async function main() {
  const previous = currentTarget();
  const wasSymlink = previous !== null;
  console.log(
    wasSymlink
      ? `current: ${LIVE_LINK} -> ${previous}`
      : `current: ${LIVE_LINK} is a regular file (not yet versioned)`
  );

  let version;
  let autostopChanged = false;

  try {
    if (ADOPT) {
      if (wasSymlink) {
        console.error(`\n${LIVE_LINK} is already a symlink (-> ${previous}). --adopt-current is only for the one-time migration.`);
        process.exitCode = 1;
        return;
      }
      version = versionName();
      const size = fly.remoteSize(LIVE_LINK);
      console.log(`\nadopting the live file as ${version} (${GB(size)}) -- no upload needed`);
      fly.ssh(`mv ${q(LIVE_LINK)} ${q(`${REMOTE_DIR}/${version}`)}`);
      flipTo(version);
    } else {
      if (!existsSync(SOURCE)) {
        console.error(`No artifact at ${SOURCE}`);
        process.exitCode = 1;
        return;
      }

      console.log('\n--- gate: verify-db on the artifact ---');
      if (!runScript('verify-db.js')) {
        console.error('\nRefusing to publish: verify-db failed on the local artifact.');
        process.exitCode = 1;
        return;
      }

      version = versionName();
      const size = statSync(SOURCE).size;
      console.log(`\nartifact: ${SOURCE} (${GB(size)})`);
      console.log(`version:  ${version}`);
      process.stdout.write('local sha256... ');
      const localSha = await sha256File(SOURCE);
      console.log(localSha);

      const free = fly.remoteFree(REMOTE_DIR);
      console.log(`volume free: ${GB(free)}`);
      if (free < size * 1.1) {
        console.error(`\nRefusing to publish: needs ~${GB(size * 1.1)} free, volume has ${GB(free)}. Prune old versions first.`);
        process.exitCode = 1;
        return;
      }

      // Autostop would kill the upload partway through; Fly's idle check only
      // sees HTTP traffic and knows nothing about a transfer in progress.
      console.log('\ndisabling autostop for the transfer');
      fly.setAutostop('off');
      autostopChanged = true;

      console.log(`\n--- uploading in ${CHUNK / 1024 ** 2}MB chunks ---`);
      await uploadResumable(SOURCE, `${REMOTE_DIR}/${version}`);

      process.stdout.write('remote sha256... ');
      const remoteSha = fly.remoteSha256(`${REMOTE_DIR}/${version}`);
      console.log(remoteSha);
      if (remoteSha !== localSha) {
        console.error(`\nRefusing to flip: checksum mismatch.\n  local  ${localSha}\n  remote ${remoteSha}\nThe artifact is on the volume but not live; re-run to resume or remove it.`);
        process.exitCode = 1;
        return;
      }
      console.log('checksums match');

      flipTo(version);
    }

    // --- Prove the thing now being served ---
    console.log('\n--- verify-db against production ---');
    const verified = fly.ssh(`node /app/scripts/verify-db.js`);
    console.log(verified.trim());
    const verifyOk = /^OK:/m.test(verified);

    let smokeOk = true;
    if (!SKIP_SMOKE) {
      const url = publicUrl();
      console.log(`\n--- smoke against ${url} ---`);
      smokeOk = runScript('smoke.js', [url]);
    }

    if (!verifyOk || !smokeOk) {
      console.error(`\nPost-publish checks FAILED (verify-db ${verifyOk ? 'ok' : 'failed'}, smoke ${smokeOk ? 'ok' : 'failed'}).`);
      if (previous) {
        console.error(`Rolling back to ${previous}.`);
        flipTo(previous);
        console.error('Rolled back. The bad artifact is still on the volume for inspection.');
      } else {
        console.error(`No previous version to roll back to. ${LIVE_LINK} -> ${version} is live and failing.`);
      }
      process.exitCode = 1;
      return;
    }

    prune(version);

    console.log(`\nPublished: ${LIVE_LINK} -> ${version}`);
    if (previous) console.log(`Roll back with: node scripts/rollback-db.js --to ${previous}`);
  } finally {
    if (autostopChanged) {
      console.log('\nrestoring autostop=stop');
      try { fly.setAutostop('stop'); } catch (e) { console.error(`WARNING: could not restore autostop: ${e.message}`); }
    }
  }
}

main().catch(err => {
  console.error(`\nFAILED: ${err.message}`);
  process.exitCode = 1;
});
