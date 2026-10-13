/**
 * paths.js
 * Single source of truth for where this pipeline's files live.
 *
 * Resolved from this file's own location rather than process.cwd(), so every
 * script behaves identically no matter which directory it's invoked from, and
 * DB_PATH wins when set -- matching what src/server.js already did.
 *
 * This exists because of a real outage. The CLI scripts used to build paths
 * from process.cwd(); production sets DB_PATH=/data/prices.db and has no
 * /app/data directory at all, so `node /app/scripts/seed-db.js` silently
 * pointed at a nonexistent path from /app and at the live database from /data
 * (via a self-referential /data/data symlink added to make that work). See
 * docs/known-issues.md, 2026-10-13.
 *
 * Two kinds of path, deliberately resolved differently:
 *   - Data artifacts (prices.db, raw/, parsed/) are large and gitignored, and
 *     live on the mounted volume in production. They follow DATA_DIR.
 *   - Git-tracked inputs (hospitals.json, column-maps/, qa-reports/) are repo
 *     files and always resolve inside the repo, never onto the data volume.
 * Locally these are the same directory; only in production do they diverge.
 */

import path from 'path';
import { fileURLToPath } from 'url';

export const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DB_PATH = process.env.DB_PATH || path.join(REPO_ROOT, 'data', 'prices.db');
export const DATA_DIR = process.env.DATA_DIR || path.dirname(DB_PATH);

export const RAW_DIR = path.join(DATA_DIR, 'raw');
export const PARSED_DIR = path.join(DATA_DIR, 'parsed');

export const MANIFEST_PATH = path.join(REPO_ROOT, 'data', 'hospitals.json');
export const COLUMN_MAPS_DIR = path.join(REPO_ROOT, 'data', 'column-maps');
export const QA_REPORTS_DIR = path.join(REPO_ROOT, 'data', 'qa-reports');

/** True when pointed at the deployed database rather than a local one. */
export const IS_PRODUCTION = process.env.NODE_ENV === 'production';
