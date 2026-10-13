# Multi-Sprite workflow: workers and a reconciler

For running more than one hospital through the pipeline genuinely in parallel, on separate Sprites, without one session's git push colliding with another's or one Sprite's local `prices.db` silently overwriting another's. See `docs/decision-log.md` ("Multi-Sprite seeding") for how this was decided.

If you're only running one Sprite (or working locally) at a time, you don't need this -- follow `docs/adding-a-hospital.md` as normal. That doc's "Working in parallel" section (git-pull-before-write on the manifest) is still the right amount of coordination for that case. This doc is for when two or more Sprites are actively onboarding *different* hospitals *at the same time*.

## Why not just let every Sprite seed its own `prices.db`?

Each Sprite would have its own local database. Per-hospital upsert (`scripts/seed-db.js <hospital_id>`) makes each one cheap to maintain, but it doesn't make several Sprites' databases converge into one -- whoever deploys last silently overwrites whoever deployed first. Not a crash, just quietly wrong. Seeding has to happen in one place.

## Worker role (one Sprite per hospital, run in parallel)

Same as `adding-a-hospital.md` steps 1-6, with two differences:

1. **Stop at `qa_pending`.** Do not run `seed-db.js`. Do not update the manifest status past `qa_pending`. Seeding is the reconciler's job, done once, against the one canonical database -- not something every worker does independently.
2. **Push a branch, not `main`.** Once QA passes:
   ```bash
   git checkout -b hospital/<hospital-id>
   git add data/hospitals.json data/qa-reports/<hospital-id>.md data/column-maps/<hospital-id>.json  # if one exists
   git commit -m "Worker: <hospital-id> ready for seed (QA passed)"
   git push -u origin hospital/<hospital-id>
   ```
   The parsed NDJSON (`data/parsed/<hospital-id>.ndjson`) is **not** part of this commit -- it's gitignored, same as `prices.db`, and it's what the reconciler comes to fetch directly from this Sprite. Leave the Sprite running (or at least don't destroy it) until the reconciler has pulled it.

A worker never touches `main`, never opens the shared `prices.db`, and never seeds. Two workers on two different hospitals can run at the same time with zero coordination between them -- they don't share anything until the reconciler steps in.

## Reconciler role (run once per worker branch, wherever is convenient)

The reconciler isn't a dedicated Sprite -- it's a role you run from wherever has `sprite` CLI access and the canonical `prices.db` (your laptop, a Claude Code session, or a Sprite you've designated for this). Per worker branch, ready to merge:

1. **Review the branch.**
   ```bash
   git fetch origin hospital/<hospital-id>
   git log origin/hospital/<hospital-id> -1 --stat
   ```
   Read the QA report on that branch (`data/qa-reports/<hospital-id>.md`) before pulling any data. If QA flagged something that should block (not just a non-blocking note), stop here and go back to the worker instead of proceeding.

2. **Pull the parsed NDJSON directly from the worker Sprite** -- this is the one piece of data that needs to move:
   ```bash
   sprite file pull -s <worker-sprite-name> hospital-price-transparency/data/parsed/<hospital-id>.ndjson data/parsed/
   ```
   No re-parsing, no object storage, no new credentials -- `sprite file pull` is a built-in `sprite` CLI command, confirmed available 2026-10-12.

3. **Merge the branch**, so the manifest entry and QA report land on `main`:
   ```bash
   git checkout main && git pull
   git merge origin/hospital/<hospital-id>
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

6. **Delete the worker branch** (its job is done, the content is on `main` now):
   ```bash
   git push origin --delete hospital/<hospital-id>
   ```

7. **Verify, publish, and check off the board.**
   ```bash
   npm run verify-db      # actual row counts vs. the manifest -- catches a phantom "seeded"
   npm run publish-db     # versioned artifact + symlink flip, auto-rollback if checks fail
   ```
   `verify-db` is the step that would have caught Memorial Hermann sitting at `status: "seeded"` with zero rows in the canonical database, which is exactly the failure this reconciler role exists to prevent -- a worker's manifest entry is a claim, and the database is the only thing that settles it. Then mark it Done on the board, same as `adding-a-hospital.md` step 10.

## Open questions, not yet resolved

- **Timing**: the worker Sprite needs to stay alive until its branch has been reconciled. No automated signal yet for "the reconciler is done, safe to destroy this worker" -- for now, that's a manual check (confirm the branch was deleted in step 6 above before tearing down the worker).
- **Conflicting column-map overrides**: if two workers independently hit the same vendor quirk and both propose a `data/column-maps/` file, there's no conflict (different hospital IDs, different filenames) -- but if a quirk turns out to be vendor-wide rather than hospital-specific (the kind of thing `schema-mapper` is now instructed to flag), reconciling that into a shared default (`DEFAULT_PROMOTIONS` in `scripts/parse-csv.js`) is still a manual judgment call, not automated.
