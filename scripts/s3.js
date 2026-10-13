/**
 * s3.js
 * Tigris (S3-compatible) client and bucket config, shared by the artifact
 * publish/fetch scripts.
 *
 * Why object storage at all: the reconciler used to pull a worker's parsed
 * NDJSON straight off that worker's disk, which made every handoff depend on
 * the worker still being reachable. On 2026-10-13 a worker went unavailable
 * for half an hour mid-session ("filesystem transition") with no ETA and no
 * lever, which would have blocked its hospital entirely. A worker that
 * publishes the moment QA passes is no longer on the critical path.
 *
 * Config comes from the environment, falling back to .env in the repo root
 * (gitignored). Real environment variables win, so a Sprite or the deployed
 * app can be configured without a file. The .env path is resolved from this
 * file's location rather than cwd, for the same reason every other path in
 * this repo now is -- see scripts/paths.js.
 */

import path from 'path';
import dotenv from 'dotenv';
import { S3Client } from '@aws-sdk/client-s3';
import { REPO_ROOT } from './paths.js';

dotenv.config({ path: path.join(REPO_ROOT, '.env'), quiet: true });

export const BUCKET = process.env.BUCKET_NAME;
export const HANDOFF_PREFIX = 'handoff';

const REQUIRED = ['BUCKET_NAME', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_ENDPOINT_URL_S3'];

/** Throws with something actionable rather than an SDK credential error. */
export function requireConfig() {
  const missing = REQUIRED.filter(k => !process.env[k]);
  if (missing.length) {
    throw new Error(
      `Missing Tigris config: ${missing.join(', ')}.\n` +
      `Put them in ${path.join(REPO_ROOT, '.env')} or set them in the environment.\n` +
      `On a new worker Sprite, copy .env over -- it is gitignored, so a fresh clone will not have it.\n` +
      `To see the values again: flyctl storage dashboard`
    );
  }
}

export function s3() {
  requireConfig();
  return new S3Client({
    region: process.env.AWS_REGION || 'auto',
    endpoint: process.env.AWS_ENDPOINT_URL_S3,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  });
}

/** All object keys under a prefix, handling pagination. */
export async function listKeys(client, prefix) {
  const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
  const keys = [];
  let token;
  do {
    const res = await client.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: prefix,
      ContinuationToken: token,
    }));
    for (const o of res.Contents || []) keys.push({ key: o.Key, size: o.Size, modified: o.LastModified });
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

export const human = n =>
  n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)}GB`
  : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)}MB`
  : `${(n / 1024).toFixed(0)}KB`;
