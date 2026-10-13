# Decision log

Open questions worth parking rather than deciding on the spot -- things to think on, not bugs (`known-issues.md`) or backlog items (`hospital-queue.md`).

## Open

### Extend the "fixed boundary, judgment on everything else" framing to hospital-discovery and schema-mapper?

**Context:** `data-qa`'s instructions got rewritten after a live incident (2026-10-11) -- it re-scanned a 1.48GB raw CSV with a slow Python loop instead of the already-parsed NDJSON, retrying the same approach for 36 minutes. Fix drew an explicit line: the hard boundary (report anomalies, don't fix, don't decide to proceed) stays exactly as strict, but tooling/data-source/when-to-change-approach choices are now explicitly its judgment call, not something to ask permission for.

**Question:** `hospital-discovery` and `schema-mapper` haven't shown an analogous problem -- no observed incident, just symmetry with the fix just made. Worth adding the same explicit "here's what's fixed, everything else is your judgment" framing to those two as well, or leave them as-is until something actually comes up?

**Update 2026-10-12:** a different but related incident did show up in `schema-mapper` -- a fresh Sprite session concluded an already-correctly-parsed file (Memorial Hermann) was mislabeled, reasoning from "pre-flight didn't run in this session" instead of checking the file's actual content (which was already correct). Added an explicit "check the artifact, not the process" instruction to both `schema-mapper.md` and `hospital-discovery.md` -- verify ground truth before concluding something is wrong, don't infer from whether a prior step happened to run in *this* session's visible history. This is a narrower, more specific fix than the full "judgment on tooling" framing `data-qa` got; whether that broader framing is still worth adding to these two remains open.

**Status:** Open -- wanted to think on it rather than decide immediately.

### Multi-Sprite seeding: assembly line, not n-way coordination

**Context:** Triggered 2026-10-11/12 by the UT Southwestern onboarding, which surfaced a real problem live: `seed-db.js` does a full `DROP TABLE` + rebuild from every file in `data/parsed/`, every time, even for a single new hospital. On the Sprite this meant a ~30+ minute reseed to add one hospital, re-processing two ~4GB files that hadn't changed. Agreed fix (next up, not yet built): per-hospital upsert in `seed-db.js` -- delete rows for one `hospital_id`, reinsert from its current NDJSON, instead of rebuilding everything. Needed either way, including for a single Sprite, since it also fixes legitimate re-seeds after a fix (Houston Methodist and MD Anderson both got reseeded twice today for exactly this reason).

**The bigger question:** if multiple Sprites ever work in parallel (one per hospital, or one per metro), each has its own local `prices.db`. Per-hospital upsert makes each Sprite's own database cheap to maintain, but doesn't make several Sprites' databases converge into one -- whoever seeds last silently overwrites whoever seeded first, not a crash, just quietly wrong.

**Shape of the fix, agreed in principle:** split by what's actually parallel-safe. Discovery, fetch, parse, and QA are all per-hospital-id files -- three Sprites on three different hospitals never touch the same file, so that part needs zero coordination, same as the existing git-pull-before-write convention for the manifest. Seeding is different: it should happen in one place, on its own schedule, not independently on every worker. "A little assembly line" -- worker Sprites as stations (discover, fetch, parse, QA-inspect), a separate seeder Sprite pulls from whatever's QA-passed and ready, on its own cadence.

**Per-hospital upsert: built 2026-10-12.** `node scripts/seed-db.js <hospital_id>` now deletes and re-seeds just that hospital's rows instead of rebuilding the whole database. Required adding an `AFTER DELETE` trigger on `procedures` (the existing FTS sync trigger only covered `INSERT`) so `procedures_fts` doesn't accumulate orphans. Tested against `houston-methodist` (smallest hospital): exact row-count match before/after, zero FTS orphans, other hospitals untouched. Not yet run against production -- local-only so far.

**Still open: how the seeder gets what it needs.**
- *Re-derive from source (lower effort, leaning this way):* worker's QA pass + manifest status flip are small and already git-synced -- that's the real shared signal. Seeder sees "QA-passed" in the manifest, re-fetches the raw file from its already-recorded `source_url`, re-parses it itself. Costs a second parse of the same file, needs zero new infrastructure.
- *Actually transfer the parsed artifact (more capable, more to build):* worker uploads its finished NDJSON to shared object storage (Fly.io's Tigris, S3-compatible) once QA passes; seeder downloads and seeds directly, no re-parse. Faster per-hospital, but a new dependency, credentials across every Sprite, and artifact lifecycle/cleanup to manage.

**Decided 2026-10-12, now a real setup (not hypothetical):** `hpt-pipeline` showed recurring I/O degradation under heavy write load for the second time (first after the UT Southwestern marathon, now again mid-Memorial-Hermann), confirming it should be treated as disposable rather than kept patched -- a new Sprite is getting created, which made this question live.

**Agreed shape:**
- **Workers** (one or more Sprites, each on a different hospital) run discovery -> fetch -> pre-flight -> schema-mapper (if needed) -> parse -> QA, same as `adding-a-hospital.md`. They stop at manifest status `qa_pending` -- they never run `seed-db.js` and never touch `main`. When QA passes, a worker pushes a branch (`hospital/<hospital-id>`) containing just the manifest entry and the QA report -- both small, git-native. The parsed NDJSON stays on the worker's own disk; it is never pushed to git (same "don't store data in git" rule as `prices.db`).
- **Reconciler** is a role, not new infrastructure -- it runs wherever is convenient (laptop, a Claude Code session, a dedicated Sprite) once a worker's branch is ready. It reviews the branch, pulls just that hospital's NDJSON with `sprite file pull -s <worker-sprite> data/parsed/<hospital-id>.ndjson data/parsed/`, runs `node scripts/seed-db.js <hospital_id>` against the canonical `prices.db`, flips the manifest status to `seeded`, merges the worker's branch into `main`, and pushes.

This resolves the re-derive-vs-transfer question from below: neither. `sprite file pull`/`push` (built into the `sprite` CLI, confirmed available, not something that needed building) moves the one artifact that matters -- the parsed NDJSON -- directly between machines, without re-parsing from source and without standing up object storage (Tigris/S3) or new credentials anywhere. See `docs/multi-sprite-workflow.md` for the full worker/reconciler steps.

**Original open question below, kept for context:**

Per-hospital upsert is built (`docs/decision-log.md`'s own earlier note, now done). The producer/consumer split (parallel-safe stages vs. centralized seeding) is agreed and scaffolded. Re-derive vs. transfer is resolved above: transfer, via `sprite file pull`/`push`, no new infra.

### Disambiguating flagship vs. sibling-campus files under a shared EIN/vendor grouping

**Context:** 2026-10-12, while `hpt-worker-1` refreshed Ascension Seton Austin, discovery hit a combined vendor file (`741109643-1093810327_ascension-seton_standardcharges.csv`, a different filename/EIN pattern than the existing single-campus `ascension-seton-austin.csv`) that bundled in sibling campuses -- Woodlands, West, North Austin -- named in a way that didn't obviously confirm they were even the same metro market as Austin. Worker-1 excluded them as flagship-only, consistent with the Houston Methodist/Memorial Hermann precedent, and confirmed it's working the actual flagship. Not actually wrong this time, but the *scenario* is a real gap: a large system filing one combined file across several facilities (possibly across markets) looks, from the filename alone, a lot like a single-campus file -- nothing in `data/hospitals.json`'s schema today records "this source file covers N facilities, here's how we identified which one is ours."

**Question:** worth a consistent way to record, at manifest time, which facility within a multi-facility source file an entry actually represents -- a `facility_identifier` note, a required one-line justification in `notes` when a source file is shared across campuses, or something else. Not urgent (worker-1 handled this one correctly), but the pattern will recur as more large systems (HCA, Ascension, CommonSpirit) get added, and "looked at the filename and assumed" is exactly the failure mode `schema-mapper`/`hospital-discovery` just got instructed to stop doing.

**Related question, same day: can billing-software/vendor be identified from file metadata, to tell a hospital-specific quirk from a vendor-family one?** Checked directly rather than assumed: the CMS v3.0.0-mandated metadata header (`hospital_name`, `last_updated_on`, `version`, address, attestation, etc. -- verified against BSW, MD Anderson, UTSW, and Ascension Seton's actual files) has no vendor/billing-software field. CMS specifies which fields must exist, not a "generated by" tag, so there's no clean lookup. Two practical substitutes, both already available with zero new data collection:
- **`source_url`'s hosting domain** (already in `data/hospitals.json`) -- a file hosted on a vendor's own domain rather than the hospital's is a strong, free tell.
- **The header's structural fingerprint** -- CMS mandates *which* fields exist, not their column ordering/naming style, so each vendor's template has a consistent signature. UT Southwestern and Ascension Seton's header rows are near-identical in structure; BSW's and MD Anderson's each diverge from that and from each other.

Gained a second concrete case the same day: `schema-mapper` found Texas Children's Hospital mislabeling codes in the *opposite* direction from the known BSW/Houston Methodist pattern (CPT-labeled codes that are actually letter+4-digit HCPCS Level II shapes -- `C1713`, `P9011`, etc., 20% of that column's CPT-labeled rows, verified against the full 1.4M-row file). It correctly flagged this to SenseLab as `risk-cpt-labeled-column-contains-hcpcs-codes`, a possible vendor-family pattern, at `belief`/`0.7` -- not yet promoted to a pipeline-wide default since it's only been seen once. Exactly the kind of flag the hosting-domain/header-fingerprint check above would help resolve faster next time: is Texas Children's vendor the same one used elsewhere, and if a future hospital hits the same pattern, do their `source_url` domains or header structures match?

**Status:** Open, pending -- parked for later, not blocking anything right now. Worth revisiting once a third hospital hits either a shared-EIN bundling or a reversed-mislabeling pattern, since two real data points (BSW/Houston Methodist's direction, Texas Children's reverse) plus the hosting-domain/fingerprint idea might be enough to actually build the disambiguation rather than keep parking it.

### Production data deploys: stop mutating the serving database

**Context:** 2026-10-13, adding Texas Children's and Memorial Hermann to production took the site down for roughly an hour. The proximate cause is in `known-issues.md` (a no-args `seed-db.js` deleted the live DB and then failed to rebuild it). The structural causes are more interesting, and they group into six:

1. **The manifest asserts state instead of measuring it.** `status: "seeded"` is a hand-written claim nothing verifies. Memorial Hermann was marked `seeded` while having zero rows in both the canonical DB and production -- it had been seeded only onto a Sprite that was later destroyed. "Seeded" meant three different things in three places.
2. **Scripts are written for one environment and run in three** (laptop, Sprite, production container). Path resolution from `process.cwd()` rather than the `DB_PATH` env var the server uses means the same command does different things depending on where you `cd` first.
3. **Destructive operations have no guard rails.** No confirmation, no snapshot, no refusal under `NODE_ENV=production`, no "this database has 8M rows, are you sure".
4. **Large-artifact movement is un-resumable.** Every transport in use is all-or-nothing with no checksum and no resume, and several have deadlines shorter than the work.
5. **Worker liveness is invisible.** The designed handoff is "worker pushes a branch"; worker-1 died before pushing, and the recovery path couldn't push either (no git credentials in a non-interactive `sprite exec`). Completed work sat on a disk with no signal.
6. **Production's code version is unknown.** Nothing connects the script being reasoned about to the script being invoked.

**Process failures worth recording alongside the code ones**, since the code wasn't the only thing that failed:

- A script was run against production without first reading the *deployed* copy of it. The local copy was read and reasoned about carefully; the remote one was invoked. That is exactly the "check the artifact, not the process" rule added to `schema-mapper.md` and `hospital-discovery.md` on 2026-10-12 -- violated two days later against the most dangerous target available. The rule is right; it just hadn't been applied to production operations.
- The risk was *noticed and then overridden*. The deployed script had already been diffed and found to differ; the stated plan was "redeploy first, then seed". When the deploy step got blocked by a permission guard, the response was to find another route to the seed rather than to treat the block as an unmet precondition. The block was information and got read as an obstacle.
- No backup was taken before a destructive operation on the only copy, despite a directory listing read minutes earlier showing two backups someone had previously taken for exactly this reason.
- The permission rules added mid-incident made the dangerous operation easy while leaving the safe prerequisite blocked. If permission rules are kept, they should cover reversible operations (`deploy`) and leave destructive ones gated.

**Agreed direction: `prices.db` becomes an immutable build artifact, not a thing we mutate in place.**

Production is currently a stateful box we run scripts against, which is why every mistake is an outage. Instead:

- A build produces a versioned file -- `prices-2026-10-13-b453860.db` -- plus per-hospital row counts and a checksum.
- Publishing means: land the file where nothing is reading it, verify checksum, run a smoke query against the *uploaded* file, then flip `/data/current.db` to point at it and restart the machine (seconds, and autostart brings it back on the next request).
- Rollback is flipping the symlink back. Instant. Precisely what was needed on 2026-10-13 and didn't exist.
- Keep 2-3 previous versions on the volume. There is 40GB; the DB is 5GB.

This subsumes "take a backup before destructive ops" by never having a destructive op, and it makes `fly deploy` meaningful again -- right now code ships one way and data ships another, which is exactly how production ended up running stale scripts against current data.

**On scaling:** shipping the whole 5GB per hospital added is ~17 minutes of transfer and gets worse with every hospital. The better endgame is to move the smallest artifact and do the work next to the data -- copy `current.db` to `next.db` on the volume, upsert the one new hospital, verify, flip -- so only the NDJSON crosses the network instead of the whole database. Worth doing somewhere past ~15 hospitals; not worth building today.

**Sequence (agreed 2026-10-13): stabilize before adding concurrency.**

*Phase 0 -- restore service (in flight 2026-10-13).* Verify the uploaded DB byte-for-byte against the local file, atomic `mv` into place, smoke-check the endpoints, restore `--autostop=stop`.

*Phase 1 -- defuse the landmines. No further production data work before this lands.*
1. `seed-db.js`: require `--rebuild-all` for the full-rebuild path; bare invocation prints usage and exits non-zero; refuse under `NODE_ENV=production` without an explicit override.
2. Env-var path resolution across all CLI scripts; delete the `/data/data` symlink once nothing depends on it.
3. Redeploy, so production's scripts match the repo. This is the precondition that got skipped.

*Phase 2 -- make state verifiable rather than asserted.*
4. `scripts/verify-db.js` -- per-hospital row counts from the DB vs. the manifest, non-zero exit on mismatch.
5. `scripts/smoke.js <base-url>` -- `/api/hospitals`, `/api/stats`, `/api/autocomplete?q=knee`, `/api/search?code=99213`; assert non-empty and under a latency bound. Would have caught both the `friendly_names` gap and the empty-DB outage immediately.
6. Run both against production and local; reconcile whatever manifest claims turn out to be false.

*Phase 3 -- make publishing safe and reversible.*
7. Versioned artifacts, `/data/current.db` symlink, flip-to-publish, retain 2-3 prior versions.
8. `scripts/push-artifact.sh` -- chunk, upload, verify checksum, atomic move, with the autostop guard built in so it can't be left half-done.
9. Document the publish path in `adding-a-hospital.md` and `multi-sprite-workflow.md`, replacing the current step 9 "`fly deploy` and you're done", which is misleading since deploy ships no data.

*Phase 4 -- only then resume Sprite scaling* (the worker-reset plan in the next entry).

**Why this order:** 1-3 stop the bleeding and cost about an hour. 4-6 are what turn "is it actually fine?" from a judgment call into one command -- the absence of that is what made 2026-10-13 confusing rather than merely bad. 7-9 make the operation performed most often, publishing data, reversible. Concurrency comes last because parallelism multiplies whatever reliability you already have, and right now that multiplier is below one.

**Done 2026-10-13, same day.** All four phases except the Sprite work:

- *Phase 0:* service restored by re-uploading the verified local DB. The resumable-by-hand recovery (append the missing 266MB tail rather than re-send 4.7GB) is what later became `publish-db.js`'s uploader.
- *Phase 1:* `seed-db.js`'s full rebuild now requires `--rebuild-all` and refuses under `NODE_ENV=production`; `scripts/paths.js` resolves every path from file location with `DB_PATH` winning, so the same command can no longer mean different things from different directories. Verified by running the exact command that caused the outage, on production: it printed usage and resolved `/data/prices.db` correctly with no `cd`.
- *Phase 2:* `verify-db.js` and `smoke.js`. Smoke found a real defect on its first run -- `/api/payers`, a fourth endpoint of the 2026-10-12 full-table-aggregate class that the original fix missed, 45.4s for 675 rows and a site-wide freeze per request. Removed rather than precomputed, since nothing called it. The latency budget is what caught it; a 200-only check would have passed.
- *Phase 3:* `publish-db.js` / `rollback-db.js` / `db-artifacts.js` / `fly-remote.js`, and production cut over to `prices.db -> prices-2026-10-13-ff08583.db`. The cutover needed no transfer and no deploy: the live file was renamed to a versioned name and the symlink put in its place.

**Two things worth keeping from building it:**

- *The symlink can live at `/data/prices.db` itself*, so `DB_PATH` never changes and rollback does not depend on a working build or a deploy. This rested on an assumption worth testing rather than reasoning about: SQLite names `-wal`/`-shm` after the **resolved** path, not the opened one. Tested locally first, then confirmed in production, where `prices-2026-10-13-ff08583.db-wal` duly appeared beside the versioned file. Each version therefore owns its own journal and a flip cannot bind a stale WAL to a different artifact. The flip also repoints *before* restarting, so the running server keeps serving from its open descriptor and there is no window where the path is missing.
- *Testing the uploader found a bug that correctness checks would have hidden.* A re-run against an already-complete file trimmed its final partial chunk and re-sent it, because a file whose size is not a chunk multiple always looks misaligned. The checksum still matched, so nothing would ever have reported it -- it would just have silently re-sent up to 512MB on every retry. Fixed with a completeness short-circuit ahead of the alignment test.

**Status:** Phases 0-3 done and deployed. Phase 4 (Sprite scaling) is now unblocked -- see the worker-reset entry below, which was deliberately parked until this landed.

### Medallion layering: we already have one, and the preciousness is inverted

**Context:** raised 2026-10-13, from the medallion (bronze/silver/gold) structure in use at Dell Med for data processing -- does something like that make sense for this pipeline, and is it possible on Fly.io? Answer: the layers already exist here, unnamed. What's missing isn't the architecture, it's enforcement at the boundaries -- and naming the layers exposes an inversion worth fixing.

| Layer | What it is here | Re-derivable? | Currently treated as |
|---|---|---|---|
| Bronze | `data/raw/<id>.csv`/`.json` -- the CMS MRF exactly as published | **No.** Sources expire and mutate | Disposable, gitignored |
| Silver | `data/parsed/<id>.ndjson` -- column maps and promotion rules applied, normalized to one schema | Yes, from bronze | Disposable |
| Gold | `prices.db` -- filtered to CPT/HCPCS/DRG, deduped, indexed, FTS, plus `hospital_stats`/`db_stats`/`payer_category_stats`/`friendly_names` | Yes, from silver | **Precious** |

**The inversion:** `prices.db` has been treated as the irreplaceable artifact -- which is why losing it on 2026-10-13 was a crisis -- when a full bronze-to-gold rebuild of all seven hospitals took 7m22s on 2026-10-12. Meanwhile `data/raw/` is gitignored and routinely discarded, and it is the only artifact in the system that cannot be reconstructed. Two issues already in `known-issues.md` are both bronze-retention failures, and neither was recognized as the same problem until the layers had names:

- St. David's `source_url` is an expired Azure SAS-signed URL. The bronze file is simply gone and cannot be re-fetched.
- BSW's row count differed between two fetches eight hours apart (877,867 vs. 934,716) with identical parsing code. The hospital's published file changed underneath us, and because the previous bronze copy wasn't kept there's no way to diff what changed or when.

**Worth adopting (the discipline, not the platform):**

- **Bronze becomes immutable and retained**, keyed by fetch date -- `raw/<hospital-id>/<date>.<ext>` plus a sidecar recording `source_url`, HTTP `Last-Modified`, `Content-Length`, sha256, and fetch timestamp. A changed source then becomes a visible, dated diff instead of a silent row-count drift someone notices by accident. This also finally answers the "CMS annual refresh" maintenance note in `known-issues.md`, which has been open for exactly this reason.
- **A gate at every boundary.** Two of three already exist: `preflight-check.js` is the bronze-to-silver gate, `data-qa` is the silver gate. The missing one is the gold gate, which is precisely the gap that let `memorial-hermann-tmc` sit at `status: "seeded"` with zero rows in the database. That gate is `verify-db.js` plus `smoke.js` from the sequence in the entry above.
- **Silver records the ruleset that produced it.** The column maps and promotion rules are *our interpretation*, not CMS's data -- "these CPT-labeled codes are actually HCPCS Level II" is a judgment call this pipeline makes on the hospital's behalf. If `DEFAULT_PROMOTIONS` changes, every existing silver artifact silently means something different with no record of which ruleset produced which rows. For a public site where someone may eventually dispute a specific published price, that provenance is not academic. Cheapest version: write the git SHA (or a hash of the effective rules) into the silver sidecar at parse time.
- **Gold is a versioned build output, never hand-edited.** This is the same conclusion as the immutable-artifact decision in the entry above; medallion just supplies the name and the reason.

**Overkill, explicitly:** all of the tooling. Delta Lake, Iceberg, a catalog, separate storage tiers per layer, CDC/streaming ingest -- no. Nine hospitals, ~8M rows, one SQLite file, one small Fly machine. CMS publishes files roughly annually, not as a stream. The layer discipline transfers; the lakehouse platform does not.

**On Fly, and why this consolidates Phase 3:** bronze belongs in object storage rather than on any one machine's disk, and Fly's Tigris is S3-compatible with native integration. That means the worker that fetched a file publishes its bronze once, and production or any other worker pulls from there -- and `aws s3 cp` brings multipart upload, resume, and checksums for free, which retires both the hand-rolled chunk-splitting from 2026-10-13 and the laptop-in-the-critical-path problem in a single move. So gold-as-versioned-artifact and bronze-to-object-storage stop being two separate Phase 3 items and become one layer-discipline change. Bronze across the current nine hospitals is on the order of 10GB (UT Southwestern alone is 1.48GB raw), growing by roughly that much per refresh cycle; at about $0.02/GB/month the storage cost is negligible.

**Status:** Agreed in principle 2026-10-13. Folds into Phase 3 of the sequence in "Production data deploys" above rather than being separate work. Bronze retention is the piece with the strongest independent justification -- it's the only layer that can't be rebuilt, and two concrete losses have already happened -- so it's worth doing even if the rest slips.

### Worker reset via checkpoints: restore timing, and what a readiness check can actually check

**Context:** 2026-10-13, a plan for the Sprite endstate (drafted separately, see the "Worker/Reconciler Pipeline v2" artifact): take a clean `sprite checkpoint create` after setup, run one hospital through the normal worker/reconciler flow, restore the worker to the clean checkpoint as a new reconciler step, and gate the next hospital behind a `scripts/worker-ready.js` fail-stop check (raw/parsed empty, disk headroom, on `main` and clean, better-sqlite3 loads, SenseLab responds, timed write test within range of a recorded baseline). Then record whether SenseLab sign-in survived the restore and whether write speed held across back-to-back hospitals, and only then move to two workers in parallel. Destroy a worker only when the queue is empty.

The shape is right and it attacks the recurring I/O degradation directly -- reset to a known-good state rather than diagnosing why a Sprite got slow. Four things to settle before building it:

- **Restore at the *start* of the next hospital, not the end of the previous one.** On the morning of 2026-10-13, worker-1's session had died overnight *after* completing parse and QA but *before* committing anything -- the complete, correct artifacts were recovered only because its disk was still intact. An end-of-cycle auto-restore would have destroyed exactly that evidence had the crash landed a few minutes later. Restoring at the start of the next run gets the same clean state, keeps the forensics until they're confirmed unnecessary, and turns `worker-ready.js` into a verification *of* the restore rather than a hope about it.
- **A node script cannot verify the SenseLab MCP tools.** MCP servers are spoken to by the Claude session, not by a child node process. A script can confirm `.mcp.json` exists and that the endpoint answers, but not that *this session's* auth is live. Split it: mechanical checks in `worker-ready.js`, plus one agent-performed step in the checklist ("call `amfs_search` against `hospital-price-transparency/pipeline`; if it errors on auth, stop and re-auth"). Otherwise the readiness gate reproduces the precise failure it exists to prevent -- asserting a state it never measured.
- **Predicted answer to the sign-in question, worth confirming rather than assuming:** Claude Code's credentials live in `~/.claude.json` on the Sprite's own filesystem, so a full-filesystem checkpoint probably *does* carry the SenseLab OAuth token through a restore. If so, the checkpoint contains a live credential -- harmless for a private Sprite, worth knowing before any checkpoint gets shared or exported.
- **Drop the worker git-push requirement rather than adding a credentials check for it.** Worker-1 couldn't push at all on 2026-10-13 (no git credentials in a non-interactive `sprite exec`), and a readiness check for that would have failed at handoff time, *after* QA, which is the worst moment to discover it. If a worker's job ends at "artifacts plus a status file on disk" and the reconciler pulls both, there is no credential to check and one fewer failure mode. `sprite file pull` already moves the NDJSON that way; extend it to the manifest entry and the QA report and the branch-push step disappears.

Also: the disk-headroom threshold should be sized against the next hospital rather than fixed. UT Southwestern was 1.48GB raw to 2.7GB NDJSON; Texas Children's was a 38MB zip to 342MB CSV to 681MB NDJSON. Post-restore with `raw/` and `parsed/` empty the check is nearly moot -- it matters most in the case where a restore *didn't* happen, which is the case worth catching. Keep the write-speed baseline to a single number recorded at checkpoint-creation time with generous bounds (fail below ~50%), not a trend anyone maintains.

**Status:** Parked until Phases 1-3 of the entry above are done. Stabilize the single-worker path before multiplying it.
