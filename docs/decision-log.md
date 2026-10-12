# Decision log

Open questions worth parking rather than deciding on the spot -- things to think on, not bugs (`known-issues.md`) or backlog items (`hospital-queue.md`).

## Open

### Extend the "fixed boundary, judgment on everything else" framing to hospital-discovery and schema-mapper?

**Context:** `data-qa`'s instructions got rewritten after a live incident (2026-10-11) -- it re-scanned a 1.48GB raw CSV with a slow Python loop instead of the already-parsed NDJSON, retrying the same approach for 36 minutes. Fix drew an explicit line: the hard boundary (report anomalies, don't fix, don't decide to proceed) stays exactly as strict, but tooling/data-source/when-to-change-approach choices are now explicitly its judgment call, not something to ask permission for.

**Question:** `hospital-discovery` and `schema-mapper` haven't shown an analogous problem -- no observed incident, just symmetry with the fix just made. Worth adding the same explicit "here's what's fixed, everything else is your judgment" framing to those two as well, or leave them as-is until something actually comes up?

**Status:** Open -- wanted to think on it rather than decide immediately.

### Multi-Sprite seeding: assembly line, not n-way coordination

**Context:** Triggered 2026-10-11/12 by the UT Southwestern onboarding, which surfaced a real problem live: `seed-db.js` does a full `DROP TABLE` + rebuild from every file in `data/parsed/`, every time, even for a single new hospital. On the Sprite this meant a ~30+ minute reseed to add one hospital, re-processing two ~4GB files that hadn't changed. Agreed fix (next up, not yet built): per-hospital upsert in `seed-db.js` -- delete rows for one `hospital_id`, reinsert from its current NDJSON, instead of rebuilding everything. Needed either way, including for a single Sprite, since it also fixes legitimate re-seeds after a fix (Houston Methodist and MD Anderson both got reseeded twice today for exactly this reason).

**The bigger question:** if multiple Sprites ever work in parallel (one per hospital, or one per metro), each has its own local `prices.db`. Per-hospital upsert makes each Sprite's own database cheap to maintain, but doesn't make several Sprites' databases converge into one -- whoever seeds last silently overwrites whoever seeded first, not a crash, just quietly wrong.

**Shape of the fix, agreed in principle:** split by what's actually parallel-safe. Discovery, fetch, parse, and QA are all per-hospital-id files -- three Sprites on three different hospitals never touch the same file, so that part needs zero coordination, same as the existing git-pull-before-write convention for the manifest. Seeding is different: it should happen in one place, on its own schedule, not independently on every worker. "A little assembly line" -- worker Sprites as stations (discover, fetch, parse, QA-inspect), a separate seeder Sprite pulls from whatever's QA-passed and ready, on its own cadence.

**Per-hospital upsert: built 2026-10-12.** `node scripts/seed-db.js <hospital_id>` now deletes and re-seeds just that hospital's rows instead of rebuilding the whole database. Required adding an `AFTER DELETE` trigger on `procedures` (the existing FTS sync trigger only covered `INSERT`) so `procedures_fts` doesn't accumulate orphans. Tested against `houston-methodist` (smallest hospital): exact row-count match before/after, zero FTS orphans, other hospitals untouched. Not yet run against production -- local-only so far.

**Still open: how the seeder gets what it needs.**
- *Re-derive from source (lower effort, leaning this way):* worker's QA pass + manifest status flip are small and already git-synced -- that's the real shared signal. Seeder sees "QA-passed" in the manifest, re-fetches the raw file from its already-recorded `source_url`, re-parses it itself. Costs a second parse of the same file, needs zero new infrastructure.
- *Actually transfer the parsed artifact (more capable, more to build):* worker uploads its finished NDJSON to shared object storage (Fly.io's Tigris, S3-compatible) once QA passes; seeder downloads and seeds directly, no re-parse. Faster per-hospital, but a new dependency, credentials across every Sprite, and artifact lifecycle/cleanup to manage.

**Status:** Open. Per-hospital upsert is agreed and next to build regardless of this question. The producer/consumer split (parallel-safe stages vs. centralized seeding) is agreed in principle. Re-derive vs. transfer is genuinely undecided -- not urgent, since no parallel Sprites are running yet; revisit when it's a real setup, not a hypothetical one.
