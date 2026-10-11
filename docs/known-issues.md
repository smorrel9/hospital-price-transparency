# Known issues / maintenance log

Running list of things found during pipeline work that aren't urgent enough to stop and fix immediately, but shouldn't get lost. Not a to-do system -- just a record so "we should look at that sometime" doesn't evaporate between sessions.

## Open

| Hospital | Issue | Found | Notes |
|---|---|---|---|
| `st-davids-austin` | `source_url` is an Azure Blob SAS-signed URL with a baked-in expiration (`si=`/`sig=` query params). It has now expired -- confirmed via a 403 when `fetch-data` tried to re-pull it on a fresh environment (the `hpt-pipeline` Sprite, 2026-10-11, since `data/raw/` is gitignored and every fresh clone starts empty). | 2026-10-11 | Needs `hospital-discovery` re-run to get a current signed URL. Not urgent -- the live site's seeded DB is unaffected, this only blocks *re-fetching* St. David's from scratch. |

## Recurring maintenance (no fixed schedule -- just don't forget this exists)

**Source URL freshness.** Most hospitals in `data/hospitals.json` use plain static URLs (MD Anderson, Houston Methodist, BSW, Ascension) that don't expire. A few -- St. David's being the first confirmed case -- use signed URLs with a time limit instead. Any hospital on a signed-URL vendor is a candidate for silently going stale. Worth periodically re-running `hospital-discovery` across the whole manifest (not just new hospitals) to catch this before it's needed urgently, rather than discovering it mid-onboarding like this time.

**CMS annual refresh.** Per `database-architecture.md`'s original roadmap note: CMS files update roughly annually. `data/hospitals.json` doesn't yet track `last_modified` from the source (only `last_fetched_at`), so there's no automated way to tell "this hospital's file has a newer version available" vs. "nothing's changed." Worth adding if/when this pipeline runs on more than a handful of hospitals.
