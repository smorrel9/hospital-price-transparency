# Running the ingestion pipeline in a Fly.io Sprite

Optional. Lets the multi-GB MRF downloads and the subagent pipeline (`.claude/agents/`) run on Fly.io's NVMe storage instead of your laptop, billed only while active (scale-to-zero). Same vendor as production (`fly.toml`), no new account needed -- your org slug is `suziemorrel-hey-com`.

This is deliberately a manual, on-demand setup, not a standing service. Spin the Sprite up when you're adding a batch of hospitals; let it sleep (or delete it) when you're done.

## One-time setup

```bash
# Install the CLI
curl -fsSL https://sprites.dev/install.sh | bash
sprite --help

# Authenticate (opens a browser) -- run this one yourself, it needs a
# real interactive terminal, not something Claude Code can do on your behalf
sprite login

# Create a Sprite for this project
sprite create hpt-pipeline
sprite use hpt-pipeline
```

(`sprite org auth` also exists, but that's for adding a pre-generated API token -- a CI/non-interactive path. `sprite login` is the normal one-time setup.)

`sprite use` writes a local `.sprite` file pointing commands at this Sprite by default, so you don't have to pass `--sprite hpt-pipeline` every time.

## Get the repo onto the Sprite

Sprites don't have a built-in continuous file-sync command -- the straightforward path is to clone from GitHub inside the Sprite:

```bash
sprite exec -- git clone https://github.com/smorrel9/hospital-price-transparency.git
sprite exec -- bash -c "cd hospital-price-transparency && npm ci"
```

If you have uncommitted local changes you want on the Sprite too, commit and push them first -- there isn't a reason to build a separate sync mechanism for an occasional-use sandbox.

**Use `npm ci`, not `npm install`.** Confirmed on a fresh `hpt-worker-2` 2026-10-13: `npm install` rewrites `package-lock.json` (it strips `"peer": true` markers that a different npm version wrote), which leaves the tree dirty and makes `worker-ready` fail its clean-tree check on *every* newly set-up worker. `npm ci` installs strictly from the lockfile, does not rewrite it, and still builds the native module correctly -- verified both.

**Gotcha, now fixed in `package.json`: native builds used to be silently skipped on a fresh Sprite.** Sprites block `install`/`postinstall` lifecycle scripts by default (a supply-chain security measure), and npm warns but exits 0 -- so it was easy to miss that `better-sqlite3`'s native binary never compiled, and anything touching the DB failed later with a missing-module error. The `allowScripts` field in `package.json` now pre-approves `better-sqlite3` and `esbuild`, and a fresh clone needs no manual step (re-confirmed on `hpt-worker-2`). If it ever regresses:

```bash
sprite exec -- bash -c "cd hospital-price-transparency && npm install-scripts approve better-sqlite3 esbuild && npm rebuild better-sqlite3"
```

Verify before trusting anything else:
```bash
sprite exec -- bash -c "cd hospital-price-transparency && node -e \"require('better-sqlite3')(':memory:')\""
```

### Copy the Tigris credentials over

A worker publishes its finished artifact to object storage, which needs the keys in `.env`. That file is gitignored, so a fresh clone won't have it:

```bash
sprite file push .env <sprite-name>:hospital-price-transparency/.env
```

`flyctl storage dashboard` shows the values again if you lose them. Without this, `publish-artifact` fails with a message naming exactly which variables are missing rather than an opaque SDK credentials error.

Then confirm the whole worker is actually in a fit state before starting a hospital:
```bash
sprite exec -- bash -c "cd hospital-price-transparency && npm run worker-ready"
```

## Run Claude Code inside the Sprite

Claude Code comes pre-installed on Sprites. Open an interactive session:

```bash
sprite console
cd hospital-price-transparency
claude
```

From there, the `.claude/agents/` subagents (`hospital-discovery`, `schema-mapper`, `data-qa`) work exactly as they do locally -- same repo, same subagent files, just running on Fly.io's storage instead of yours. Follow `docs/adding-a-hospital.md` as normal.

### Shared memory (SenseLab) -- pilot, schema-mapper only

`.mcp.json` points Claude Code at the SenseLab memory server, so what `schema-mapper` learns on one Sprite is there on the next fresh clone. The approval and the sign-in are per machine -- doing them on your laptop does nothing for the Sprite. First time in a Sprite's `claude` session:

1. Approve the `senselab` server when Claude Code asks about the project's MCP servers (or run `/mcp`).
2. Ask Claude to authenticate senselab; it gives you a URL to open in your own browser.
3. After you authorize, the browser redirects to a `http://localhost:<port>/callback?...` page that will fail to load -- that's expected, the Sprite isn't your laptop. Copy the full URL from the address bar and paste it back into the Sprite's Claude session to finish.

Not yet confirmed: whether the sign-in survives the Sprite pausing and waking. If `schema-mapper` reports the SenseLab tools weren't available, repeat steps 2-3.

Detach without killing the session: `Ctrl+\`. Reattach any time with `sprite console` again -- state persists.

## Checkpoints (your undo button)

Before a risky step (e.g. first parse of a new hospital's file), it's worth a checkpoint:

```bash
sprite checkpoint create --comment "before parsing methodist-dallas"
sprite checkpoint list
sprite restore <version-id>   # if the parse goes badly
```

## Getting data back out

```bash
npm run publish-artifact -- <hospital-id>
```

That's the whole answer now. The worker uploads its parsed NDJSON plus the manifest entry, QA report and column map to the Tigris bucket, and a reconciler elsewhere picks it up with `npm run fetch-artifact -- <hospital-id>`. Nothing reads the Sprite's disk afterwards, so the worker can be reset, restored from a checkpoint, or destroyed as soon as that command returns.

A worker never seeds and never deploys: there is no `prices.db` on a worker to get out. Seeding happens once, on the canonical database, and production is updated with `npm run publish-db` -- see `docs/multi-sprite-workflow.md`.

This section used to suggest `git push`-ing the database or running `fly deploy` from inside the Sprite. Both are wrong under the current model, and the second one is how production ended up running stale scripts against current data on 2026-10-13.

## Shutting down

Sprites pause automatically when idle (no billing while paused; filesystem persists). If you're done with a hospital-adding batch for a while and want to stop storage costs too, destroy it -- this is irreversible (files, packages, checkpoints all go), but you'll `git clone` fresh next time anyway:

```bash
sprite destroy hpt-pipeline
```
