/**
 * fly-remote.js
 * Thin wrapper over the flyctl commands the publish/rollback scripts need.
 *
 * Kept in one place because the awkward parts are easy to get wrong twice:
 * `flyctl ssh console` does not autostart a stopped machine (it just fails with
 * "no started VMs"), `--autostop` must use the `=` form or its value parses as
 * a second positional argument, and machine autostop will kill a long-running
 * volume operation partway through because Fly's idle check only sees HTTP.
 * All three cost real time on 2026-10-13; see docs/known-issues.md.
 */

import { execFileSync } from 'child_process';

function fly(args, { capture = true } = {}) {
  return execFileSync('flyctl', args, {
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Single-quote for the remote shell. */
function q(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export function machine() {
  const status = JSON.parse(fly(['status', '--json']));
  const m = (status.Machines || [])[0];
  if (!m?.id) throw new Error('No machine found for this app.');
  return { id: m.id, state: m.state };
}

/** Run a shell command on the machine, returning stdout. Starts it if stopped. */
export function ssh(command, { ensureStarted = true } = {}) {
  if (ensureStarted) start();
  const out = fly(['ssh', 'console', '-C', `sh -c ${q(command)}`]);
  // flyctl prints a connection banner on stdout; drop it so callers can parse.
  return out.replace(/^Connecting to .*\n?/m, '');
}

// Checking machine state costs a flyctl round trip, and a chunked upload issues
// dozens of remote commands. Once we've started it in this process, trust it --
// long operations disable autostop anyway.
let knownStarted = null;

export function start() {
  if (knownStarted) return knownStarted;
  const m = machine();
  if (m.state !== 'started') {
    fly(['machine', 'start', m.id], { capture: true });
    // Give init a moment; ssh immediately after a start can still refuse.
    execFileSync('sleep', ['3']);
  }
  knownStarted = m.id;
  return m.id;
}

export function restart() {
  const { id } = machine();
  fly(['machine', 'restart', id], { capture: true });
  execFileSync('sleep', ['3']);
  knownStarted = id;
}

export function stop() {
  const { id } = machine();
  fly(['machine', 'stop', id], { capture: true });
  knownStarted = null;
}

/**
 * 'off' while doing long volume work, 'stop' to restore the configured
 * scale-to-zero behaviour. Always restore it, including on failure.
 */
export function setAutostop(mode) {
  const { id } = machine();
  fly(['machine', 'update', id, `--autostop=${mode}`, '--yes'], { capture: true });
}

export function sftpPut(localPath, remotePath) {
  start();
  fly(['ssh', 'sftp', 'put', localPath, remotePath], { capture: true });
}

export function remoteSize(path) {
  const out = ssh(`[ -e ${q(path)} ] && wc -c < ${q(path)} || echo -1`).trim();
  return Number(out.split(/\s+/).pop());
}

export function remoteSha256(path) {
  return ssh(`sha256sum ${q(path)}`).trim().split(/\s+/)[0];
}

/** Resolved target of a symlink, or null when the path is not a symlink. */
export function remoteLinkTarget(path) {
  const out = ssh(`readlink ${q(path)} || true`).trim();
  return out || null;
}

export function remoteIsSymlink(path) {
  return ssh(`[ -L ${q(path)} ] && echo yes || echo no`).trim() === 'yes';
}

export function remoteList(dir) {
  const out = ssh(`ls -1 ${q(dir)} 2>/dev/null || true`);
  return out.split('\n').map(s => s.trim()).filter(Boolean);
}

/** Bytes free on the filesystem holding `dir`. */
export function remoteFree(dir) {
  const out = ssh(`df -k ${q(dir)} | tail -1`).trim().split(/\s+/);
  return Number(out[3]) * 1024;
}

export { q as quoteRemote };
