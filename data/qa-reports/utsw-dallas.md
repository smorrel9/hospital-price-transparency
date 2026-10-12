# QA report: utsw-dallas

Date: 2026-10-12
Source: `753175630_the-university-of-texas-southwestern-medical-center-at-dallas_standardcharges.csv`, CMS v3.0.0 **tall** layout, 30 columns (29 mapped, `additional_payer_notes` dropped as expected) -- parsed by `scripts/parse-csv.js`. Pre-flight (2026-10-11) came back clean: 97.5%+ code-type match across RC/CDM/HCPCS/CPT/NDC/CDT/MS-DRG/APR-DRG on a 9,051-row sample, so the `schema-mapper` step was skipped.

Note on method: `data/prices.db` has not been seeded for this hospital yet (per the task), so these checks were run directly against `data/parsed/utsw-dallas.ndjson` with `jq`, plus a raw-CSV cross-check (via `csv.reader`, header rows only + a couple of column-tally passes) to explain one code-selection question raised below. Baseline comparisons use the other hospitals' own parsed NDJSON files (no DB row data existed for them to query either in this pass).

## Checks

| Check | Result | Verdict |
|---|---|---|
| Row survival rate | 5,431,906 rows in / 5,431,906 kept (100%) | PASS |
| code_type distribution | HCPCS 3,079,142 (56.7%) / RC 1,358,626 (25.0%) / CPT 958,814 (17.7%) / MS-DRG 14,573 / CDM 8,474 / APR-DRG 6,660 / CDT 5,617 / NDC 0 | PASS (see note) |
| Price sanity -- negatives | 0 rows with any negative `gross_charge`/`cash_price`/`negotiated_rate`/`min_negotiated`/`max_negotiated` | PASS |
| Price sanity -- common-code spot check | See table below | PASS |
| Null-rate (all 5 rate fields null) | 0 / 5,431,906 (0%) | PASS |
| Cross-hospital CPT overlap | 10,010 / 10,490 (95.4%) of standard 5-digit numeric CPT codes also appear at ascension-seton-austin, dell-seton-austin, or bsw-austin | PASS |
| Payer name hygiene | 26 distinct values, top 20 listed below, all clean | PASS |

## Row survival rate (detail)

Raw-row count from the parse log (5,431,906) exactly matches rows kept in the NDJSON -- no drop at all, let alone a BSW-style collapse. As a sanity check against the other hospitals already in the manifest, `wc -l` on raw vs. parsed shows the same small, explainable gap everywhere (header row + a couple of blank/metadata lines, not real row loss):

| Hospital | raw `wc -l` | parsed `wc -l` | gap |
|---|---|---|---|
| utsw-dallas | 5,431,909 | 5,431,906 | 3 |
| bsw-austin | 1,479,911 | 1,479,908 | 3 |
| ascension-seton-austin | 15,568,445 | 15,568,442 | 3 |

Same constant gap (3) across every hospital checked, including the one with the known BSW mislabeling history -- no anomaly here.

## code_type distribution (detail)

HCPCS dominates (56.7%) over CPT (17.7%), which is a bigger skew than the other CSV hospital on hand (bsw-austin: HCPCS 41.5% / CPT 38.6%). This looked like it could be the BSW-pattern mislabeling bug at first glance, so it was checked directly:

- **0 of 3,079,142 HCPCS-labeled codes are purely 5-digit numeric** (the shape that indicates a mislabeled CPT code and triggers the default promotion rule in `parse-csv.js`). Every HCPCS code is properly alphanumeric Level II format.
- The skew is explained by volume, not mislabeling: 2,533,527 of the 3,079,142 HCPCS rows (82%) are **C-codes** (OPPS device/supply pass-through codes), e.g. `C1713 SCREW BN 4MM 48MM AXSOS 3 TI LCK ST NS`, `C1601 BRONCHOSCOPE FLEX...`, `C1052 PURASTAT 3ML`. UT Southwestern/Clements is a large academic surgical/transplant/oncology hospital with heavy implant and device billing, which plausibly drives far more C-code line items (fanned out across payer/plan combinations) than a community hospital like BSW Austin would generate. Only 346 distinct C-codes account for all 2.5M rows -- this is a payer/plan fan-out effect on a modest set of real codes, not a parsing artifact.
- **Zero NDC-labeled rows survived to the output**, despite the raw file containing ~376k rows with a genuine 11-digit NDC code in one of the secondary code slots (`code|2`/`code|3`). This is expected: `selectCode()` in `scripts/parse-csv.js` ranks code types by priority (`CPT`/`HCPCS` > `MS-DRG`/`APR-DRG` > `RC` > `CDM`, everything else -- including `NDC` -- falls to the lowest priority), and every one of those rows also carries a higher-priority HCPCS/RC/CDM code for the same line item, so the NDC code never wins. Consistent with the product's purpose (CPT/HCPCS procedure lookup, not drug-NDC lookup), not a bug.
- **Latent code note, not a UTSW-specific flag:** `selectCode()` only inspects `code|1`, `code|2` (`rev_code`), and `code|3` (`hcpcs_code`) when picking the best code -- it never inspects `code|4` (`ndc_code`), even though `COLUMN_MAP` explicitly maps `code|4`/`code|4|type` for exactly this purpose. For UTSW this has zero observed effect: a full-file tally of the raw CSV's four `code|N|type` columns shows `code|4|type` is empty in 5,291,364 of 5,431,906 rows and `CDM` (lowest priority) in the rest -- it would never have outranked slot 1-3 anyway, and the arithmetic reconciles exactly (code|1|type tallies plus the handful of CDT-outranked-by-RC rows equal the final output's code_type tallies 1-for-1). Worth fixing before a future hospital puts a real CPT/HCPCS code in slot 4, since that would silently never be selected -- but it is not a reason to hold UTSW.

## Price sanity (detail)

No negative values anywhere. Spot-checked the 5 most frequent CPT codes in the file plus a few common E&M/lab codes against gross/cash/negotiated/min/max for internal consistency (cash ≈ half of gross, negotiated falls inside [min, max]):

| Code | Description | gross | cash | negotiated (sample) | min | max |
|---|---|---|---|---|---|---|
| 88360 | Tumor IHC, manual | 153 | 114.75 | 107.10-147.97 | 31.78 | 147.97 |
| 86353 | Lymphocyte transformation | 200 | 150 | 108.57-130 | 5 | 180 |
| 87070 | Bacterial culture | 132 | 66 | 107.05-109.56 | 7.24 | 116.16 |
| 80299 | Quant drug assay | 130 | 97.5 | 10.57-117 | 5 | 117 |
| 99213 | Office visit, established | 565 | 282.5 | 101.41-617.76 | 203.82 | 497.2 |

All in plausible ranges for a hospital-based (facility-fee-inclusive) chargemaster -- no $0 or $1,000,000+ outliers on common codes. The two highest absolute values in the whole file (`negotiated_rate`/`max_negotiated` = $8,295,000 on `C9399`/`J3590` "unclassified drugs or biologics," and `gross_charge`/`cash_price` ≈ $2.05M/$1.03M on `Q2056` ciltacabtagene autoleucel, a CAR-T cell therapy) are both legitimate: unclassified-drug codes have no fixed unit of service so wide variance is expected, and CAR-T list prices genuinely run into seven figures. Not flagged.

## Null-rate (detail)

0 of 5,431,906 rows have all five rate fields null. Breakdown of which fields are populated:

| Pattern (gross, cash, negotiated, min, max) | Rows |
|---|---|
| present, present, **null**, present, present | 2,750,161 |
| present, present, present, present, present | 2,398,059 |
| **null, null**, present, present, present | 283,582 |
| null, null, null, present, present | 104 |

Nowhere near the >90% all-null threshold that would indicate a charge-column mapping failure.

## Cross-hospital CPT overlap (detail)

UTSW has 12,254 distinct CPT codes total, noticeably more than any Austin hospital on hand (bsw-austin: 7,584; ascension-seton-austin and dell-seton-austin: 10,101 each) -- expected for a large academic medical center with Category II/III and PLA codes the community hospitals don't bill. Restricting to standard 5-digit numeric Category I codes (the fairest comparison, since Category II/III/PLA codes are legitimately institution-specific) gives **10,010 / 10,490 = 95.4%** overlap with the union of the three other CSV hospitals' CPT codes -- in line with Houston Methodist (99.4%) and MD Anderson (96%), and far above a BSW-style near-zero overlap. The raw (unrestricted) overlap of 83.5% is lower only because of that Category II/III/PLA tail (1,764 of the 12,254 codes, e.g. `0001F`, `0002U`, `0006M`), which is expected, not a red flag.

## Payer name hygiene (detail)

26 distinct `payer_name` values total (small, tidy list -- no fragmentation risk). Top 20 by row count:

```
749720 Blue Cross Blue Shield
589134 United Healthcare
304769 Aetna
286298 Wellpoint
286295 Superior
286295 Molina
270982 United Behavioral Health
150004 United Options Nexus
143969 Procare
143969 Humana
142465 United Healthcare W500
142326 Parkland
142326 Aetna Better Health
140933 Superior Ambetter Exchange
140770 Coventry
140550 Cigna
139980 HealthFirst
139972 HealthSmart
138755 Maestro Health/Fort Worth Firefighters
137507 PHCS
```

No empty strings, no literal `"NULL"`/`"N/A"` text, and no obvious duplicate-with-typo pairs. Entries like `QuikTrip` and `Rockwall County` further down the list are self-funded employer plans, not junk data -- normal for a hospital price-transparency file. `United Healthcare` vs. `United Healthcare W500` and `Aetna` vs. `Aetna Better Health` are distinct real plan families (not typos), but worth keeping in mind for Phase 2 payer normalization per `database-architecture.md` -- not fixed here.

## Recommendation

**Proceed to seed.** Every check passes, and the one thing that looked concerning at first glance (HCPCS dominance) traces to a real, explainable cause (C-code device/supply fan-out at a large surgical academic hospital) rather than the BSW/Houston-Methodist mislabeling pattern -- confirmed by the 0%-mislabeled-numeric-HCPCS check and by a healthy 95.4% Category-I CPT overlap with the other hospitals. The one latent gap worth a follow-up ticket (`selectCode()` in `scripts/parse-csv.js` never considers the `code|4`/`ndc_code` slot) has zero measured effect on UTSW's output and shouldn't hold this hospital, but should be fixed before onboarding a hospital whose file actually relies on that slot.
