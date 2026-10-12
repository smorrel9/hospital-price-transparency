# Decision log

Open questions worth parking rather than deciding on the spot -- things to think on, not bugs (`known-issues.md`) or backlog items (`hospital-queue.md`).

## Open

### Extend the "fixed boundary, judgment on everything else" framing to hospital-discovery and schema-mapper?

**Context:** `data-qa`'s instructions got rewritten after a live incident (2026-10-11) -- it re-scanned a 1.48GB raw CSV with a slow Python loop instead of the already-parsed NDJSON, retrying the same approach for 36 minutes. Fix drew an explicit line: the hard boundary (report anomalies, don't fix, don't decide to proceed) stays exactly as strict, but tooling/data-source/when-to-change-approach choices are now explicitly its judgment call, not something to ask permission for.

**Question:** `hospital-discovery` and `schema-mapper` haven't shown an analogous problem -- no observed incident, just symmetry with the fix just made. Worth adding the same explicit "here's what's fixed, everything else is your judgment" framing to those two as well, or leave them as-is until something actually comes up?

**Status:** Open -- wanted to think on it rather than decide immediately.
