# Multi-Sprite workflow: workers and a reconciler

For running more than one hospital through the pipeline genuinely in parallel, on separate Sprites, without one session's git push colliding with another's or one Sprite's local `prices.db` silently overwriting another's. See `docs/decision-log.md` ("Multi-Sprite seeding") for how this was decided.

If you're only running one Sprite (or working locally) at a time, you don't need this -- follow `docs/adding-a-hospital.md` as normal. That doc's "Working in parallel" section (git-pull-before-write on the manifest) is still the right amount of coordination for that case. This doc is for when two or more Sprites are actively onboarding *different* hospitals *at the same time*.

## Why not just let every Sprite seed its own `prices.db`?

Each Sprite would have its own local database. Per-hospital upsert (`scripts/seed-db.js <hospital_id>`) makes each one cheap to maintain, but it doesn't make several Sprites' databases converge into one -- whoever deploys last silently overwrites whoever deployed first. Not a crash, just quietly wrong. Seeding has to happen in one place.

## Worker role (one Sprite per hospital, run in parallel)

Same as `adding-a-hospital.md` steps 1-6, with two differences:

1. **Stop at `qa_pending`.** Do not run `seed-db.js`. Do not update the manifest status past `qa_pending`. Seeding is the reconciler's job, done once, against the one canonical database -- not something every worker does independently.
2. **Publish the handoff to object storage.** Once QA passes:
   ```bash
   npm run publish-artifact -- <hospital-id>
   ```
   This uploads two objects to the Tigris bucket under `handoff/<hospital-id>/`: the parsed NDJSON, and a metadata JSON carrying the manifest entry, the QA report, the column map, and the artifact's sha256/size/line count. It refuses to publish without a QA report on disk, or if the manifest status isn't `qa_pending`.

   **The worker's job ends here.** It does not push a branch, does not need git credentials, and does not need to stay reachable -- everything the reconciler needs is in the bucket. This replaced a git-branch-plus-`sprite file pull` handoff that failed in both halves on 2026-10-13: one worker died before it could push, the non-interactive recovery session had no git credentials to push with, and a single `sprite file pull` of a 681MB NDJSON exceeded a 30s server-side deadline and had to be split into chunks by hand. Later that same day a worker became unreachable for half an hour mid-"filesystem transition", which under the old design would have blocked its hospital entirely.

A worker never touches `main`, never opens the shared `prices.db`, and never seeds. Two workers on two different hospitals can run at the same time with zero coordination between them -- they don't share anything, and now they don't even have to be alive at the same time as the reconciler.

**Credentials:** `publish-artifact` needs the Tigris keys, which live in a gitignored `.env` at the repo root. A fresh clone won't have it, so copy it onto each new worker (`sprite file push .env <sprite>:hospital-price-transparency/.env`). `flyctl storage dashboard` shows the values again if needed.

## Reconciler role (run once per worker branch, wherever is convenient)

The reconciler isn't a dedicated Sprite -- it's a role you run from wherever has `sprite` CLI access and the canonical `prices.db` (your laptop, a Claude Code session, or a Sprite you've designated for this). Per worker branch, ready to merge:

1. **See what's waiting.**
   ```bash
   npm run fetch-artifact -- --list
   ```

2. **Fetch the handoff.**
   ```bash
   npm run fetch-artifact -- <hospital-id>
   ```
   Downloads the parsed NDJSON to `data/parsed/`, **verifies its sha256 against the publisher's**, and writes out the QA report and column map. It prints the manifest entry rather than merging it, since `data/hospitals.json` is the one file every session touches and silently rewriting it would undercut the git-pull-before-write convention in `adding-a-hospital.md`; pass `--apply-manifest` to merge it anyway.

   Read the QA report before going further. If QA flagged something that should block (not just a non-blocking note), stop here and go back to the worker rather than seeding it.

3. **Commit the small files to `main`** -- the manifest entry, QA report and column map that the worker no longer pushes itself:
   ```bash
   git checkout main && git pull
   git add data/hospitals.json data/qa-reports/<hospital-id>.md data/column-maps/<hospital-id>.json
   ```

4. **Seed, then build names.**
   ```bash
   node scripts/seed-db.js <hospital_id>
   npm run build-names
   ```
   Per-hospital upsert against the canonical `prices.db` -- other hospitals untouched, indexes and summary-stats tables refreshed automatically. `build-names` is incremental by default (only processes codes not already in `friendly_names`), so it's safe and cheap to always run it here rather than deciding case by case whether this hospital introduced new codes.

5. **Update the manifest status to `seeded`**, commit, push to `main`:
   ```bash
   git add data/hospitals.json
   git commit -m "Seed <hospital-id>"
   git push
   ```

6. **Verify, publish, and check off the board.**
   ```bash
   npm run verify-db      # actual row counts vs. the manifest -- catches a phantom "seeded"
   npm run publish-db     # versioned artifact + symlink flip, auto-rollback if checks fail
   ```
   `verify-db` is the step that would have caught Memorial Hermann sitting at `status: "seeded"` with zero rows in the canonical database, which is exactly the failure this reconciler role exists to prevent -- a worker's manifest entry is a claim, and the database is the only thing that settles it. Then mark it Done on the board, same as `adding-a-hospital.md` step 10.

## Open questions, not yet resolved

- **Timing: resolved 2026-10-13.** This used to read "the worker needs to stay alive until its branch has been reconciled, and there's no automated signal for when it's safe to destroy one." Once the worker publishes to object storage, the question stops existing: a worker can be reset, restored from a checkpoint, or destroyed the moment `publish-artifact` returns, because nothing downstream reads its disk. Worth noting the fix came from the constraint rather than from building the signal -- the day a worker became unreachable for half an hour made it obvious that "keep the worker alive long enough" was the wrong thing to engineer.
- **Conflicting column-map overrides**: if two workers independently hit the same vendor quirk and both propose a `data/column-maps/` file, there's no conflict (different hospital IDs, different filenames) -- but if a quirk turns out to be vendor-wide rather than hospital-specific (the kind of thing `schema-mapper` is now instructed to flag), reconciling that into a shared default (`DEFAULT_PROMOTIONS` in `scripts/parse-csv.js`) is still a manual judgment call, not automated.
