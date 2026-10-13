/**
 * worker-ready.js
 * Fail-stop readiness gate for a worker Sprite, run before starting a hospital.
 *
 * The point is to catch a worker that is not actually in a clean state *before*
 * it spends hours on a hospital, rather than discovering it at handoff time.
 * On 2026-10-13 a worker finished parse and QA and then could not push at all
 * (no git credentials in a non-interactive session), and a separate session
 * concluded a correctly-parsed file was broken because it reasoned from what
 * it could see rather than from the disk.
 *
 * What this CANNOT check, deliberately: whether the SenseLab MCP tools work.
 * MCP servers are spoken to by the Claude session, not by a child node process,
 * so a script can confirm the config exists but not that this session's auth is
 * live. Claiming otherwise would make this gate assert something it never
 * measured -- the exact failure it exists to prevent. That one step is the
 * agent's, and it is printed as a required action at the end.
 *
 * Usage:
 *   node scripts/worker-ready.js                     Run the checks
 *   node scripts/worker-ready.js --record-baseline   Save this machine's write speed
 *   Options: --min-free-gb N (default 25), --min-speed-pct N (default 50)
 */

import { existsSync, readdirSync, writeFileSync, readFileSync, openSync, writeSync, fsyncSync, closeSync, unlinkSync, statfsSync } from 'fs';
import { execFileSync } from 'child_process';
import { homedir } from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { REPO_ROOT, RAW_DIR, PARSED_DIR } from './paths.js';

const args = process.argv.slice(2);
const RECORD = args.includes('--record-baseline');
const num = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? d : Number(args[i + 1]);
};
const MIN_FREE_GB = num('min-free-gb', 25);
const MIN_SPEED_PCT = num('min-speed-pct', 50);

const BASELINE_FILE = path.join(homedir(), '.hpt-worker-baseline.json');

const failures = [];
const warnings = [];
const ok = [];

function check(label, fn) {
  try {
    const detail = fn();
    ok.push(`${label}${detail ? ` -- ${detail}` : ''}`);
  } catch (err) {
    failures.push(`${label}: ${err.message}`);
  }
}

function git(...a) {
  return execFileSync('git', a, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

/**
 * Time-boxed throughput probe. Bounded on purpose: a fixed-size write would
 * take 8 minutes on a Sprite degraded to ~1MB/s, and degraded I/O is precisely
 * the condition this is meant to detect quickly rather than wait out.
 */
function measureWriteMbPerSec() {
  const file = path.join(REPO_ROOT, '.worker-ready-io.tmp');
  const block = Buffer.alloc(4 * 1024 * 1024, 7);
  const budgetMs = 5000;
  const capBytes = 512 * 1024 * 1024;
  let written = 0;
  const fd = openSync(file, 'w');
  const started = Date.now();
  try {
    while (written < capBytes && Date.now() - started < budgetMs) {
      writeSync(fd, block);
      written += block.length;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
    const elapsed = (Date.now() - started) / 1000;
    if (existsSync(file)) unlinkSync(file);
    measureWriteMbPerSec.last = written / 1024 / 1024 / elapsed;
  }
  return measureWriteMbPerSec.last;
}

function emptyOrAbsent(dir, label) {
  if (!existsSync(dir)) return 'absent';
  const entries = readdirSync(dir).filter(f => !f.startsWith('.'));
  if (entries.length) {
    throw new Error(`${entries.length} file(s) present -- a previous hospital's artifacts are still here (${label} reset did not happen)`);
  }
  return 'empty';
}

console.log(`worker readiness: ${REPO_ROOT}\n`);

check('data/raw is clear', () => emptyOrAbsent(RAW_DIR, 'raw'));
check('data/parsed is clear', () => emptyOrAbsent(PARSED_DIR, 'parsed'));

check('disk headroom', () => {
  const s = statfsSync(REPO_ROOT);
  const freeGb = (s.bsize * s.bavail) / 1024 ** 3;
  if (freeGb < MIN_FREE_GB) {
    throw new Error(`${freeGb.toFixed(1)}GB free, need at least ${MIN_FREE_GB}GB (the largest single hospital so far needs ~12GB of raw + parsed)`);
  }
  return `${freeGb.toFixed(1)}GB free`;
});

check('on main, clean, up to date', () => {
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch !== 'main') throw new Error(`on branch "${branch}", expected main`);
  const dirty = git('status', '--porcelain');
  if (dirty) {
    throw new Error(`uncommitted changes:\n      ${dirty.split('\n').join('\n      ')}`);
  }
  git('fetch', '--quiet', 'origin', 'main');
  const behind = git('rev-list', '--count', 'HEAD..origin/main');
  const ahead = git('rev-list', '--count', 'origin/main..HEAD');
  if (behind !== '0') throw new Error(`${behind} commit(s) behind origin/main -- run git pull`);
  if (ahead !== '0') throw new Error(`${ahead} unpushed commit(s) -- this worker has work nobody else can see`);
  return `main @ ${git('rev-parse', '--short', 'HEAD')}`;
});

check('better-sqlite3 loads', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE t(x)');
  db.close();
  return 'native module OK';
});

check('write throughput', () => {
  const speed = measureWriteMbPerSec();
  if (RECORD) {
    writeFileSync(BASELINE_FILE, JSON.stringify({ mbPerSec: Math.round(speed), recorded: new Date().toISOString() }, null, 2));
    return `${speed.toFixed(0)} MB/s -- recorded as this machine's baseline`;
  }
  if (!existsSync(BASELINE_FILE)) {
    warnings.push(`no write-speed baseline recorded. Measured ${speed.toFixed(0)} MB/s; run with --record-baseline to save it.`);
    return `${speed.toFixed(0)} MB/s (no baseline to compare)`;
  }
  const base = JSON.parse(readFileSync(BASELINE_FILE, 'utf8'));
  const pct = (speed / base.mbPerSec) * 100;
  if (pct < MIN_SPEED_PCT) {
    throw new Error(
      `${speed.toFixed(0)} MB/s is ${pct.toFixed(0)}% of the ${base.mbPerSec} MB/s baseline ` +
      `(recorded ${base.recorded.slice(0, 10)}). This Sprite has degraded -- destroy and recreate it rather than waiting it out (docs/known-issues.md).`
    );
  }
  return `${speed.toFixed(0)} MB/s, ${pct.toFixed(0)}% of baseline`;
});

check('SenseLab MCP configured', () => {
  const cfg = path.join(REPO_ROOT, '.mcp.json');
  if (!existsSync(cfg)) throw new Error('.mcp.json missing from the repo');
  const parsed = JSON.parse(readFileSync(cfg, 'utf8'));
  const names = Object.keys(parsed.mcpServers || {});
  if (!names.includes('senselab')) throw new Error(`.mcp.json has no "senselab" server (found: ${names.join(', ') || 'none'})`);
  return 'config present (auth NOT verified -- see below)';
});

// --- Report ---
for (const line of ok) console.log(`  PASS  ${line}`);
for (const w of warnings) console.log(`  WARN  ${w}`);
for (const f of failures) console.log(`  FAIL  ${f}`);

if (failures.length) {
  console.error(`\nNOT READY (${failures.length} failure(s)). Fix these before starting a hospital.`);
  process.exitCode = 1;
} else {
  console.log(`\nMechanical checks passed.`);
}

console.log(`
One check this script cannot make -- do it yourself before starting:
  Call amfs_search against "hospital-price-transparency/pipeline".
  If it errors on auth, stop and re-authenticate SenseLab; a restored
  checkpoint may carry a stale token. A passing config above proves only
  that .mcp.json names the server, not that this session can reach it.`);
