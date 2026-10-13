/**
 * smoke.js
 * Hits every endpoint the site actually depends on and asserts each one
 * returns 200, returns data, and returns it quickly.
 *
 * Two real incidents this would have caught in seconds:
 *   - 2026-10-12: /api/hospitals, /api/stats and /api/payer-categories each
 *     ran a full-table aggregate synchronously, freezing every request on the
 *     site for 15-60s. A latency budget catches that; a 200-only check does not.
 *   - 2026-10-12: the friendly_names table was missing entirely, so
 *     /api/autocomplete was a hard 500 while the rest of the site looked fine.
 *
 * Usage: node scripts/smoke.js                        (default localhost:3001)
 *        node scripts/smoke.js https://example.com
 *        node scripts/smoke.js <url> --max-ms 3000
 */

const args = process.argv.slice(2);
const base = (args.find(a => !a.startsWith('--')) || 'http://localhost:3001').replace(/\/$/, '');
const maxMsArg = args.indexOf('--max-ms');
const MAX_MS = maxMsArg !== -1 ? Number(args[maxMsArg + 1]) : 2000;

const CHECKS = [
  { path: '/', expect: 'html' },
  { path: '/api/hospitals' },
  { path: '/api/stats' },
  { path: '/api/payer-categories' },
  // Depends on friendly_names -- the table whose absence was a silent 500.
  { path: '/api/autocomplete?q=knee' },
  // Exercises FTS plus the friendly-name code join, the deepest read path.
  { path: '/api/search?q=knee%20replacement' },
  { path: '/api/procedure/99213' },
];

/**
 * How many items came back. Shape-agnostic on purpose: the point is "this
 * endpoint returned data", not a schema assertion that breaks on every
 * harmless response change.
 */
function countItems(data) {
  if (Array.isArray(data)) return data.length;
  if (data && typeof data === 'object') {
    const arrays = Object.values(data).filter(Array.isArray);
    if (arrays.length) return Math.max(...arrays.map(a => a.length));
    return Object.keys(data).length;
  }
  return 0;
}

async function hit(path, { timed = true } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), Math.max(MAX_MS * 3, 15000));
  const started = Date.now();
  try {
    const res = await fetch(base + path, { signal: ctl.signal });
    const body = await res.text();
    return { status: res.status, ms: Date.now() - started, body, timed };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  console.log(`smoke: ${base} (budget ${MAX_MS}ms)\n`);

  // Untimed warm-up. With autostop enabled the first request cold-starts the
  // machine and takes seconds, which is not a latency regression.
  try {
    await hit('/', { timed: false });
  } catch {
    console.error(`FAIL: ${base} is not reachable at all`);
    process.exitCode = 1;
    return;
  }

  const failures = [];
  const pad = Math.max(...CHECKS.map(c => c.path.length));

  for (const { path, expect } of CHECKS) {
    let line = `${path.padEnd(pad)}  `;
    try {
      const { status, ms, body } = await hit(path);
      const slow = ms > MAX_MS;

      let items = 0;
      let detail;
      if (expect === 'html') {
        detail = /<html|<!doctype/i.test(body) ? 'html' : 'NOT HTML';
        items = detail === 'html' ? 1 : 0;
      } else {
        try {
          items = countItems(JSON.parse(body));
          detail = `${items} items`;
        } catch {
          detail = 'INVALID JSON';
        }
      }

      line += `${status}  ${String(ms + 'ms').padStart(7)}  ${detail}`;
      if (status !== 200) failures.push(`${path}: HTTP ${status}`);
      else if (items === 0) failures.push(`${path}: returned 200 but no data (${detail})`);
      if (status === 200 && slow) failures.push(`${path}: ${ms}ms exceeds ${MAX_MS}ms budget`);
      console.log(line + (slow ? '  SLOW' : ''));
    } catch (err) {
      console.log(line + `ERROR  ${err.name === 'AbortError' ? 'timed out' : err.message}`);
      failures.push(`${path}: ${err.name === 'AbortError' ? 'timed out' : err.message}`);
    }
  }

  if (failures.length) {
    console.error(`\nFAIL (${failures.length}):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nOK: ${CHECKS.length} endpoints healthy.`);
}

main();
