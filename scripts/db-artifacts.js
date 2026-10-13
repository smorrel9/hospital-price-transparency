/**
 * db-artifacts.js
 * The published-artifact layout on the Fly volume, shared by publish-db.js
 * and rollback-db.js so the two can't drift apart.
 *
 * /data/prices.db            symlink -> the version currently being served
 * /data/prices-<date>-<sha>.db   an immutable published artifact
 *
 * The symlink sits at the path the server already opens (DB_PATH in fly.toml),
 * so switching versions needs no config change and no deploy.
 */

import * as fly from './fly-remote.js';
import { quoteRemote as q } from './fly-remote.js';

export const REMOTE_DIR = '/data';
export const LIVE_LINK = `${REMOTE_DIR}/prices.db`;
export const VERSION_RE = /^prices-\d{4}-\d{2}-\d{2}-[A-Za-z0-9._-]+\.db$/;

/** The version being served, or null when prices.db is still a regular file. */
export function currentTarget() {
  if (!fly.remoteIsSymlink(LIVE_LINK)) return null;
  return fly.remoteLinkTarget(LIVE_LINK);
}

/** Published versions, newest first by the volume's own mtimes. */
export function listVersions() {
  return fly
    .ssh(`ls -1t ${q(REMOTE_DIR)}`)
    .split('\n')
    .map(s => s.trim())
    .filter(f => VERSION_RE.test(f));
}

/**
 * Point the live path at `version` and restart so the server reopens it.
 *
 * Deliberately repoints before restarting rather than stopping first: the
 * running server keeps serving from its open file descriptor until the
 * restart, so there is no window where the path is missing. SQLite names
 * -wal/-shm after the resolved path, so the outgoing version keeps its own
 * journal and the incoming one starts clean.
 */
export function flipTo(version) {
  console.log(`\nrepointing ${LIVE_LINK} -> ${version}`);
  fly.ssh(`ln -sfn ${q(version)} ${q(LIVE_LINK)}`);
  console.log('restarting the machine so the server reopens the new artifact');
  fly.restart();
  // Only now are any pre-symlink journals definitely unused: before the
  // restart the still-running server may hold prices.db-wal open from its
  // original open, and pulling it out from under a live connection is a
  // needless risk. After the restart the server resolves the symlink and
  // uses <version>.db-wal instead, so these are orphans.
  fly.ssh(`rm -f ${q(LIVE_LINK + '-wal')} ${q(LIVE_LINK + '-shm')}`);
}
