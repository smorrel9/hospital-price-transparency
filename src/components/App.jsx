import { useState, useEffect } from 'react';
import AutocompleteSearch from './AutocompleteSearch';
import InsurancePicker from './InsurancePicker';
import HospitalCard from './HospitalCard';
import MedicareBanner from './MedicareBanner';
import SettingToggle from './SettingToggle';
import Tooltip from './Tooltip';
const HOSPITAL_NAMES = {
  'ascension-seton-austin': 'Ascension Seton Medical Center Austin',
  'dell-seton-austin': 'Dell Seton Medical Center at UT Austin',
  'bsw-austin': 'Baylor Scott & White Medical Center Austin',
  'st-davids-austin': "St. David's Medical Center Austin",
};

// Normalize free-text setting values from hospital files (some lowercase, some upper).
export function normalizeSetting(s) {
  return (s || '').toUpperCase();
}

// A rate matches the active setting filter if the filter is ALL,
// or the rate's setting equals the filter, or the rate is BOTH (applies to either).
function matchesSetting(rateSetting, filter) {
  if (filter === 'ALL') return true;
  const s = normalizeSetting(rateSetting);
  return s === filter || s === 'BOTH';
}

// Compute the Medicare reference value to compare a hospital's negotiated rate
// against. Two flavors:
//   - For DRG codes: per-hospital payment (IME/DSH vary by hospital)
//   - For CPT/HCPCS codes: single Austin-adjusted total (PFS + OPPS when payable)
// Pass hospitalId for DRG lookups; not needed for the CPT/OPPS path.
const PAYABLE_OPPS_SI = new Set(['J1', 'J2', 'T', 'S', 'V', 'Q1', 'Q2', 'Q3', 'P', 'R', 'S1', 'U']);
export function getMedicareReference(procedureData, selectedSetting, hospitalId = null) {
  if (!procedureData) return null;

  // DRG codes have per-hospital Medicare payments; the toggle doesn't gate them
  // because DRG procedures are inherently inpatient.
  const drg = procedureData.medicare_drg;
  if (drg && hospitalId && drg.by_hospital) {
    const pay = drg.by_hospital[hospitalId];
    return pay > 0 ? pay : null;
  }

  // CPT/HCPCS path — PFS + OPPS combined when the SI is payable.
  const medicare = procedureData.medicare;
  if (!medicare) return null;
  if (selectedSetting === 'INPATIENT') return null;
  const pfs = medicare.facility_rate || 0;
  const opps = medicare.opps;
  const oppsPayable = opps && PAYABLE_OPPS_SI.has(opps.status_indicator) && opps.austin_payment > 0;
  const total = pfs + (oppsPayable ? opps.austin_payment : 0);
  return total > 0 ? total : null;
}

// Cash price is stored per row and can have multiple distinct values per
// (hospital, code) when hospitals post tiered self-pay rates. Return min/max
// so we can render a range when they differ.
function findCashPriceRange(rates) {
  let min = null;
  let max = null;
  for (const r of rates) {
    const v = r.cash_price;
    if (v == null || v <= 0) continue;
    if (min == null || v < min) min = v;
    if (max == null || v > max) max = v;
  }
  return min == null ? null : { min, max };
}

export default function App() {
  const [selectedCode, setSelectedCode] = useState(null);
  const [selectedInsurance, setSelectedInsurance] = useState(null);
  const [selectedSetting, setSelectedSetting] = useState('ALL');
  const [procedureData, setProcedureData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Fetch procedure data when a code is selected
  useEffect(() => {
    if (!selectedCode) {
      setProcedureData(null);
      return;
    }

    async function fetchProcedure() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/procedure/${encodeURIComponent(selectedCode)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to load procedure');
        setProcedureData(data);
        // Auto-pin setting to Inpatient for DRG procedures since DRGs are
        // inherently inpatient and the All/Outpatient toggles wouldn't apply.
        if (data?.medicare_drg) setSelectedSetting('INPATIENT');
      } catch (err) {
        setError(err.message);
        setProcedureData(null);
      } finally {
        setLoading(false);
      }
    }
    fetchProcedure();
  }, [selectedCode]);

  function handleCodeSelect(code) {
    setSelectedCode(code);
    setSelectedInsurance(null);
    setSelectedSetting('ALL');
  }

  // Group payers data by hospital_id
  function groupByHospital() {
    if (!procedureData?.payers) return {};

    const byHospital = {};
    for (const [payerName, rates] of Object.entries(procedureData.payers)) {
      for (const rate of rates) {
        const hid = rate.hospital_id || 'unknown';
        if (!byHospital[hid]) byHospital[hid] = [];
        byHospital[hid].push({ ...rate, payer_name: payerName });
      }
    }
    return byHospital;
  }

  // Deduplicate rates — collapse rows with same payer, plan, and rate
  function dedupeRates(rates) {
    const seen = new Set();
    return rates.filter((r) => {
      const key = `${r.payer_name}|${r.plan_name}|${r.negotiated_rate}|${r.negotiated_percentage}|${r.methodology}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // Filter rates by setting first (BOTH rates match either OUTPATIENT or INPATIENT)
  function filterBySetting(rates) {
    return rates.filter((r) => matchesSetting(r.setting, selectedSetting));
  }

  // Filter rates by selected insurance
  function filterRates(allRates) {
    const settingFiltered = filterBySetting(allRates);
    if (!selectedInsurance) return settingFiltered;

    const { category, payerName } = selectedInsurance;

    // Category matching patterns (same as server)
    const categoryPatterns = {
      BCBS: /BCBS|Blue\s*Cross|BLUE/i,
      Aetna: /AETNA|Aetna/i,
      United: /UNITED|UHC|Uhc/i,
      Cigna: /CIGNA|Cigna/i,
      Humana: /HUMANA|Humana/i,
      Medicare: /MEDICARE|Medicare/i,
      Medicaid: /MEDICAID|Medicaid|STAR|CHIP/i,
    };

    let filtered;
    if (payerName) {
      // Specific payer name
      filtered = settingFiltered.filter((r) => r.payer_name === payerName);
    } else if (category && categoryPatterns[category]) {
      // Broad category
      filtered = settingFiltered.filter((r) => categoryPatterns[category].test(r.payer_name));
    } else if (category === 'Other') {
      // "Other" — everything that doesn't match a named category
      const namedPatterns = Object.values(categoryPatterns);
      filtered = settingFiltered.filter(
        (r) => r.payer_name && !namedPatterns.some((p) => p.test(r.payer_name))
      );
    } else {
      return settingFiltered;
    }

    // Deduplicate and mark as filtered so the card knows to render in detail mode
    filtered = dedupeRates(filtered);
    filtered._filtered = true;
    return filtered;
  }

  const byHospital = groupByHospital();
  const hospitalIds = Object.keys(byHospital);

  // Determine which settings have any rates for this procedure
  const availableSettings = { OUTPATIENT: false, INPATIENT: false };
  for (const rates of Object.values(byHospital)) {
    for (const r of rates) {
      const s = normalizeSetting(r.setting);
      if (s === 'OUTPATIENT' || s === 'BOTH') availableSettings.OUTPATIENT = true;
      if (s === 'INPATIENT' || s === 'BOTH') availableSettings.INPATIENT = true;
    }
  }

  // Build procedure name tooltip
  const procedureTooltip =
    procedureData?.friendly_name &&
    procedureData.friendly_name !== procedureData.description
      ? procedureData.description
      : null;

  const codeTooltip = procedureData
    ? `CPT ${procedureData.code} — Standard billing code for this procedure across all hospitals and insurance plans`
    : null;

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-6xl mx-auto px-4 py-6">
          <h1 className="text-2xl font-bold text-gray-900">Hospital Price Lookup</h1>
          <p className="text-sm text-gray-500 mt-1">
            Compare hospital prices across Austin, TX
          </p>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        {/* Search */}
        <AutocompleteSearch onSelect={handleCodeSelect} />

        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
            {error}
          </div>
        )}

        {loading && (
          <div className="text-center text-gray-400 text-sm py-8">Loading procedure data...</div>
        )}

        {procedureData && !loading && (
          <>
            {/* Procedure header */}
            <div className="bg-white border border-gray-200 rounded-lg p-5">
              <h2 className="text-xl font-bold text-gray-900">
                <Tooltip text={procedureTooltip}>
                  {procedureData.friendly_name || procedureData.description}
                </Tooltip>
              </h2>
              <div className="flex flex-wrap gap-4 mt-2 text-sm text-gray-500">
                <span>
                  Code:{' '}
                  <Tooltip text={codeTooltip}>
                    <span className="font-mono">{procedureData.code}</span>
                  </Tooltip>
                </span>
              </div>
            </div>

            {/* Medicare reference bar */}
            <MedicareBanner
              medicare={procedureData.medicare}
              medicareDrg={procedureData.medicare_drg}
              selectedSetting={selectedSetting}
            />

            {/* Setting toggle */}
            <SettingToggle
              selected={selectedSetting}
              onSelect={setSelectedSetting}
              available={availableSettings}
            />

            {/* Insurance picker */}
            <InsurancePicker onSelect={setSelectedInsurance} selected={selectedInsurance} />

            {/* Hospital comparison cards */}
            {hospitalIds.length > 0 ? (
              <div className="grid gap-4 md:grid-cols-2">
                {hospitalIds.map((hid, i) => {
                  const allRates = byHospital[hid];
                  const rates = filterRates(allRates);
                  // Cash price ignores the setting filter so it always reflects the
                  // hospital's posted self-pay rate for this procedure.
                  const cashRange = findCashPriceRange(allRates);
                  // Medicare reference is per-hospital for DRG codes (IME/DSH vary)
                  // and shared across hospitals for CPT/OPPS codes.
                  const medicareReference = getMedicareReference(procedureData, selectedSetting, hid);
                  // For DRG codes, we know the typical stay length. Used to
                  // multiply per-diem rates so they're comparable to the
                  // Medicare stay-total, not falsely under-stated as $/day.
                  const expectedDays = procedureData?.medicare_drg?.geometric_mean_los || null;
                  return (
                    <HospitalCard
                      key={hid}
                      hospital={hid}
                      rates={rates}
                      cashRange={cashRange}
                      medicareReference={medicareReference}
                      expectedDays={expectedDays}
                      hospitalName={HOSPITAL_NAMES[hid] || hid}
                      colorIndex={i}
                    />
                  );
                })}
              </div>
            ) : (
              <div className="text-center text-gray-400 text-sm py-4">
                No hospital data available for this procedure.
              </div>
            )}
          </>
        )}

        {!selectedCode && !loading && (
          <div className="text-center text-gray-400 py-16">
            <p className="text-lg">Search for a procedure to compare hospital prices</p>
            <p className="text-sm mt-2">
              Try "MRI", "knee replacement", "colonoscopy", or a CPT code like "27447"
            </p>
          </div>
        )}
      </main>

      <footer className="border-t border-gray-200 mt-12">
        <div className="max-w-6xl mx-auto px-4 py-4 text-xs text-gray-400">
          Data sourced from CMS-mandated hospital machine-readable files. Prices shown are
          negotiated rates and may not reflect your actual cost.
        </div>
      </footer>
    </div>
  );
}
