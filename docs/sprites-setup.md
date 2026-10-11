# Running the ingestion pipeline in a Fly.io Sprite

Optional. Lets the multi-GB MRF downloads and the subagent pipeline (`.claude/agents/`) run on Fly.io's NVMe storage instead of your laptop, billed only while active (scale-to-zero). Same vendor as production (`fly.toml`), no new account needed -- your org slug is `suziemorrel-hey-com`.

This is deliberately a manual, on-demand setup, not a standing service. Spin the Sprite up when you're adding a batch of hospitals; let it sleep (or delete it) when you're done.

## One-time setup

```bash
# Install the CLI
curl https://sprites.dev/install.sh | bash
sprite --help

# Authenticate against your Fly.io org
sprite org auth

# Create a Sprite for this project
sprite create hpt-pipeline
sprite use hpt-pipeline
```

`sprite use` writes a local `.sprite` file pointing commands at this Sprite by default, so you don't have to pass `--sprite hpt-pipeline` every time.

## Get the repo onto the Sprite

Sprites don't have a built-in continuous file-sync command -- the straightforward path is to clone from GitHub inside the Sprite:

```bash
sprite exec -- git clone https://github.com/smorrel9/hospital-price-transparency.git
sprite exec -- bash -c "cd hospital-price-transparency && npm install"
```

If you have uncommitted local changes you want on the Sprite too, commit and push them first -- there isn't a reason to build a separate sync mechanism for an occasional-use sandbox.

## Run Claude Code inside the Sprite

Claude Code comes pre-installed on Sprites. Open an interactive session:

```bash
sprite console
cd hospital-price-transparency
claude
```

From there, the `.claude/agents/` subagents (`hospital-discovery`, `schema-mapper`, `data-qa`) work exactly as they do locally -- same repo, same subagent files, just running on Fly.io's storage instead of yours. Follow `docs/adding-a-hospital.md` as normal.

Detach without killing the session: `Ctrl+\`. Reattach any time with `sprite console` again -- state persists.

## Checkpoints (your undo button)

Before a risky step (e.g. first parse of a new hospital's file), it's worth a checkpoint:

```bash
sprite checkpoint create --comment "before parsing methodist-dallas"
sprite checkpoint list
sprite restore <version-id>   # if the parse goes badly
```

## Getting data back out

Once `data/prices.db` is seeded and looks right, either:
- `git push` from inside the Sprite if you want the DB tracked somewhere other than the Sprite (it's gitignored today, per `database-architecture.md`'s "don't store data in git" rule -- deploy straight from the Sprite instead), or
- run `fly deploy` from inside the Sprite console, since it already has the repo and the built DB.

## Shutting down

Sprites pause automatically when idle (no billing while paused; filesystem persists). If you're done with a hospital-adding batch for a while and want to stop storage costs too, destroy it -- this is irreversible (files, packages, checkpoints all go), but you'll `git clone` fresh next time anyway:

```bash
sprite destroy hpt-pipeline
```
