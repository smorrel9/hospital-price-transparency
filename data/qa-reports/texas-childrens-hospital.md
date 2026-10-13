# QA report: texas-childrens-hospital

Date: 2026-10-13
Source: `741100555_texas-childrens-hospital_standardcharges.csv` (tall layout), parsed by `scripts/parse-csv.js` with a per-hospital column-map override at `data/column-maps/texas-childrens-hospital.json`.

## Context: the column-map override

Pre-flight/schema-mapping found that `code|3`'s CPT-labeled bucket was a mixed bag: 20% of raw "CPT"-labeled codes (65,508 of 328,167, per the override file's notes) were actually letter+4-digit HCPCS Level II shapes (e.g. `C1713`, `P9017`) -- the mirror image of the known BSW/Houston Methodist bug (which mislabels HCPCS *as* CPT; here CPT was mislabeled *as* HCPCS-shaped codes in the wrong direction -- genuine HCPCS codes sitting under a CPT label). The override adds a `CPT -> HCPCS` promotion for codes matching `^[A-Z]\d{4}$`. This report specifically re-verifies that fix against the full parsed output, not just the override file's own claims.

## Summary

| # | Check | Result | Verdict |
|---|---|---|---|
| 1 | Row survival rate | 1,432,826 / 1,432,826 raw rows kept (100%, 2 metadata rows skipped) -- matches parsed NDJSON line count exactly (`wc -l` = 1,432,826) | **PASS** |
| 2 | code_type distribution + promotion-fix verification | HCPCS 999,699 (69.8%) / CPT 263,957 (18.4%) / RC 93,096 (6.5%) / NDC 57,814 (4.0%) / APR-DRG 15,972 (1.1%) / MS-DRG 2,288 (0.2%) -- shape-verified, see detail below | **PASS** (one cosmetic flag, non-blocking) |
| 3 | Price sanity | 0 negative values across all 5 rate fields; spot-checked CPT codes in-range; top outlier is a real CAR-T drug | **PASS** |
| 4 | Null-rate check | 29 / 1,432,826 rows (0.00%) have all five rate fields null | **PASS** |
| 5 | Cross-hospital code overlap | CPT: 2,656 / 2,657 distinct codes (99.96%) also seen elsewhere; HCPCS: 790 / 798 (99.0%) also seen elsewhere | **PASS** |
| 6 | Payer name hygiene | 22 distinct payer_name values, all clean | **PASS** |

## Detail

### 1. Row survival rate

Raw parse log: 1,432,826 / 1,432,826 data rows kept, 2 metadata rows skipped (100% survival). Confirmed against `wc -l data/parsed/texas-childrens-hospital.ndjson` = 1,432,826 -- exact match, no silent drop. This is consistent with the 100% survival seen at memorial-hermann-tmc and utsw-dallas; no BSW-style collapse.

### 2. code_type distribution and promotion-fix verification

Raw tally (`jq -r .code_type ... | sort | uniq -c`):

```
 999699 HCPCS
 263957 CPT
  93096 RC
  57814 NDC
  15972 APR-DRG
   2288 MS-DRG
```

RC/NDC/CDM are dropped at seed time (`seed-db.js` `KEEP_CODE_TYPES`), leaving a healthy CPT/HCPCS/APR-DRG/MS-DRG split post-seed -- no zero-CPT gap (the Houston Methodist failure mode) and no single-type domination.

Shape verification against the three points requested:

**(1) Codes now labeled HCPCS actually look like HCPCS.** 798 distinct HCPCS-labeled codes; 795 (99.6%) match the letter+4-digit shape (`^[A-Z]\d{4}$`), e.g. `C1713` ("2.7MM CORT SCR, 14MM" -- an orthopedic screw/anchor supply code) and `P9017` are both present and correctly labeled HCPCS post-fix -- confirmed these are exactly the kind of supply/implant codes the override's notes describe. The remaining 3 distinct codes are `j9075`, `j3490`, `j2997` -- lowercase duplicates of valid uppercase HCPCS J-codes (chemo/drug codes) that already exist in the data in uppercase form (e.g. `J9075` appears 7,374 times vs. `j9075`'s 81). This is a raw-file casing inconsistency, not a mislabeling -- only 203 of 999,699 HCPCS rows (0.02%) are affected. **Flagging as a minor, non-blocking cosmetic issue**: downstream code lookups/joins should be case-insensitive or this could fragment the same drug code into two entries in the UI.

**(2) Codes still labeled CPT are genuinely CPT-shaped.** 2,657 distinct CPT-labeled codes: 2,640 (99.4%) are 5-digit-numeric (true CPT), and 17 (0.6%) are Category III/PLA alphanumeric codes matching `^\d{4}[A-Z]$` (digits-then-letter, e.g. `0509T`, `0141U`, `0020M`, `0232T`, `0087U` -- confirmed present and correctly still CPT). **0 of 2,657** distinct CPT-labeled codes match the HCPCS-shape pattern (`^[A-Z]\d{4}$`) -- i.e. no leftover under-correction.

**(3) No over/under-correction.** The promotion regex (`^[A-Z]\d{4}$`) and the genuine Category III/PLA shape (`^\d{4}[A-Z]$`, letter *last* not first) are disjoint by construction, and the data confirms it in practice: all 17 Category III/PLA codes stayed correctly classified as CPT, and separately, spot-checking `C1713`/`P9017` confirms they were correctly moved to HCPCS. No evidence of over-correction (true CPT codes wrongly reclassified) or under-correction (HCPCS-shaped codes left under CPT).

### 3. Price sanity

Zero negative values across `gross_charge`, `cash_price`, `negotiated_rate`, `min_negotiated`, `max_negotiated` (full-file scan, all 1,432,826 rows).

Spot-checked common CPT codes against cash price, same order of magnitude as negotiated rates in every case:

| Code | Description | gross | cash | negotiated_rate (sample payers) |
|---|---|---|---|---|
| 99213 (office visit, est. pt, L3) | facility | $1,056 | $707.52 | Aetna $675.84, BCBS MCD $369.60 |
| 99213 | non-facility | $192 | $128.64 | Aetna $122.88 |
| 99214 (office visit, est. pt, L4) | facility | $1,747 | $1,170.49 | Aetna $1,118.08 |
| 85025 (CBC w/auto diff) | | $179-212 | $119.93-142.04 | Aetna $114.56-135.68, BCBS MCD $62.65 |
| 80053 (metabolic panel) | | $1,054-1,079 | $706.18-722.93 | Aetna $674.56-690.56, BCBS MCD $368.90-377.65 |

(The two price tiers for 99213/99214 reflect facility vs. non-facility rate schedules, which is expected and not an anomaly.)

Highest outlier: `Q2042` (TISAGENLECLEUCEL / Kymriah, CAR-T cell therapy) -- gross $1,452,145, cash $972,937.15, max negotiated $1,379,537.75. This is a real, extremely expensive pediatric oncology drug (Texas Children's is a major pediatric cancer center), and the order of magnitude matches the CAR-T outlier already seen and confirmed-plausible at Memorial Hermann (negotiated rate up to $771,347 for the MS-DRG version). Not an error.

205 rows (96 NDC, 109 RC -- both dropped at seed time) have `negotiated_rate: 0`, all tracing to `$0.01` gross-charge pharmacy per-unit line items rounding to `$0` under a percentage-based discount methodology -- the same explainable pattern documented at other hospitals, not a mapping bug.

### 4. Null-rate check

Only 29 of 1,432,826 rows (0.00%) have all five rate fields null -- far below the 90% threshold that would indicate a column-mapping failure. Healthy.

### 5. Cross-hospital code overlap

No `data/prices.db` exists in this environment yet, so this check ran against the other hospitals' own parsed NDJSON files that are currently on disk: `bsw-austin`, `memorial-hermann-tmc`, and `utsw-dallas` (a mix of Austin/Houston/Dallas, tall-CSV, covering both a hospital with a known CPT/HCPCS mislabeling fix of its own (bsw-austin) and a clean baseline (memorial-hermann-tmc)). `houston-methodist`, `md-anderson-houston`, `st-davids-austin`, `ascension-seton-austin`, and `dell-seton-austin` were either not present as parsed NDJSON on disk (likely cleaned up post-seed) or were skipped for the two largest files (ascension-seton-austin at 7.7GB, dell-seton-austin at 6.9GB) since the 3-hospital sample already gave a decisive result.

- **CPT overlap**: 2,656 of Texas Children's 2,657 distinct CPT codes (99.96%) also appear at one of the 3 sampled hospitals. The single TCH-only code, `83542` ("chromatography/MS nondrug analyte, qual/quant"), is a plausible specialized lab test, not a red flag.
- **HCPCS overlap** (checked as an extra sanity pass specifically because the promotion rule moved codes *into* this bucket): 790 of 798 distinct HCPCS codes (99.0%) also appear at one of the 3 sampled hospitals.

Both overlap rates are at or above the healthy baseline already established for this pipeline (Houston Methodist's post-fix CPT overlap was 99.4%; MD Anderson's was ~96%). This is strong, independent corroboration that the column-map promotion fixed the labeling without collateral damage -- a mislabeling bug of this kind is exactly what would otherwise show up as a cross-hospital overlap collapse (per the BSW incident).

### 6. Payer name hygiene

22 distinct `payer_name` values, top 20 by row count:

```
Cigna (207,158), First Care Health Plan (140,449), First Health (138,104),
Community Health Choice (104,910), Blue Cross Blue Shield (103,548),
Driscoll Children's Health Plan MCD (71,720), Aetna (69,635),
Multiplan (69,052), HealthSmart (69,052), Galaxy Health Network (69,052),
Evolutions Healthcare (69,052), Cook Children's Health Plan (69,052),
Blue Cross Blue Shield MCD (36,699), Molina MCD (35,849),
United Healthcare MCD (35,847), United Healthcare CHIP (35,847),
Community First Health Plan MCD (35,847), KelseyCare (34,516),
United Healthcare (27,231), Superior CHIP (10,116)
```

No empty strings, no literal `"NULL"`/`"N/A"`, no null `payer_name` rows found in a full-file scan. The `MCD`/`CHIP` suffixes are a consistent, intentional naming convention distinguishing Medicaid/CHIP managed-care products from commercial plans under the same payer (e.g. "Blue Cross Blue Shield" vs. "Blue Cross Blue Shield MCD") -- not typo-fragmentation. Clean.

## Recommendation

**Proceed to seed.** All six checks pass. The column-map promotion fix for the reverse-direction CPT/HCPCS mislabeling was independently re-verified against the full parsed output (not just the override file's own claims) on all three points requested: HCPCS-labeled codes are correctly shaped (99.6%, with a trivial 0.02%-of-rows casing quirk), CPT-labeled codes are genuinely CPT-shaped (5-digit numeric + Category III/PLA, 100%), and there is no evidence of over- or under-correction. Cross-hospital CPT and HCPCS overlap are both ~99%+, which is the strongest available confirmation that this fix didn't repeat the BSW-style collapse in either direction.

One non-blocking item for whoever seeds: 203 rows (0.02% of HCPCS rows) carry lowercase HCPCS codes (`j9075`, `j3490`, `j2997`) that duplicate existing uppercase codes (`J9075`, `J3490`, `J2997`) -- worth a case-normalization pass at some point so the UI doesn't show the same drug code twice, but not worth holding the seed for.
