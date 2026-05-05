import { formatPrice, formatPayer, formatPlan, formatMethodology } from '../utils/format';
import Tooltip from './Tooltip';

const BORDER_COLORS = [
  'border-l-blue-500',
  'border-l-emerald-500',
  'border-l-purple-500',
  'border-l-amber-500',
  'border-l-rose-500',
  'border-l-cyan-500',
];

const METHODOLOGY_TOOLTIPS = {
  'Fee Schedule': 'Fixed price per procedure — most directly comparable across hospitals',
  'Case Rate': 'Bundled payment for the entire episode, may include supplies and implants',
  '% of Charges': "Rate is calculated as a percentage of the hospital's list price",
  'Per Diem': 'Daily rate — total cost depends on length of stay',
};

// Settings render in this order; rates tagged BOTH appear in their own group
// in the All view, or merged into the active filter.
const SETTING_ORDER = ['OUTPATIENT', 'INPATIENT', 'BOTH'];
const SETTING_LABELS = {
  OUTPATIENT: 'Outpatient',
  INPATIENT: 'Inpatient',
  BOTH: 'Both Settings',
};

function normalize(s) {
  return (s || '').toUpperCase();
}

// Group rates by normalized setting, preserving SETTING_ORDER.
function groupBySetting(rates) {
  const groups = { OUTPATIENT: [], INPATIENT: [], BOTH: [], UNKNOWN: [] };
  for (const r of rates) {
    const s = normalize(r.setting);
    (groups[s] ?? groups.UNKNOWN).push(r);
  }
  return SETTING_ORDER.map((key) => ({ key, label: SETTING_LABELS[key], rates: groups[key] }))
    .filter((g) => g.rates.length > 0)
    .concat(groups.UNKNOWN.length ? [{ key: 'UNKNOWN', label: 'Unspecified', rates: groups.UNKNOWN }] : []);
}

export default function HospitalCard({ hospital, rates, cashRange, medicareReference, expectedDays, hospitalName, colorIndex = 0 }) {
  const borderColor = BORDER_COLORS[colorIndex % BORDER_COLORS.length];
  const hasSpecificPayer = rates._filtered;

  return (
    <div className={`bg-white border border-gray-200 ${borderColor} border-l-4 rounded-lg p-5`}>
      {/* Hospital name + prominent cash price */}
      <div className="flex items-start justify-between gap-4">
        <h3 className="font-semibold text-gray-900 text-base">{hospitalName}</h3>
        <CashPriceBadge range={cashRange} />
      </div>

      {!hasSpecificPayer ? (
        <SummaryView rates={rates} medicareReference={medicareReference} />
      ) : (
        <FilteredView rates={rates} medicareReference={medicareReference} expectedDays={expectedDays} />
      )}
    </div>
  );
}

function CashPriceBadge({ range }) {
  if (range == null) {
    return (
      <Tooltip text="This hospital hasn't posted a self-pay rate for this procedure">
        <div className="text-right flex-shrink-0">
          <div className="text-xs text-gray-400 uppercase tracking-wide">Cash Price</div>
          <div className="text-sm text-gray-400 italic">Not posted</div>
        </div>
      </Tooltip>
    );
  }
  const { min, max } = range;
  const isRange = min !== max;
  const tooltipText = isRange
    ? "Hospital posted multiple self-pay tiers for this procedure — showing the range"
    : "The price a self-pay or uninsured patient would pay";
  return (
    <Tooltip text={tooltipText}>
      <div className="text-right flex-shrink-0">
        <div className="text-xs text-emerald-700 uppercase tracking-wide font-medium">Cash Price</div>
        <div className="text-lg font-semibold text-emerald-700">
          {isRange ? `${formatPrice(min)} – ${formatPrice(max)}` : formatPrice(min)}
        </div>
      </div>
    </Tooltip>
  );
}

function SummaryView({ rates }) {
  const payerNames = new Set();
  let min = Infinity;
  let max = -Infinity;

  for (const rate of rates) {
    if (rate.payer_name) payerNames.add(rate.payer_name);
    if (rate.negotiated_rate != null) {
      if (rate.negotiated_rate < min) min = rate.negotiated_rate;
      if (rate.negotiated_rate > max) max = rate.negotiated_rate;
    }
  }

  if (rates.length === 0) {
    return (
      <p className="mt-4 text-sm text-gray-400">
        No rates posted for this care setting at this hospital.
      </p>
    );
  }

  return (
    <>
      <div className="mt-4 grid grid-cols-2 gap-4">
        <SummaryCell label="Payers" value={`${payerNames.size}`} />
        <SummaryCell
          label="Rate Range"
          value={min < Infinity ? `${formatPrice(min)} - ${formatPrice(max)}` : '--'}
        />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-4 text-xs text-gray-400">
        <div>
          <span className="block text-gray-500">Min Negotiated</span>
          {formatPrice(rates[0]?.min_negotiated)}
        </div>
        <div>
          <span className="block text-gray-500">Gross Charge</span>
          {formatPrice(rates[0]?.gross_charge)}
        </div>
      </div>
    </>
  );
}

function FilteredView({ rates, medicareReference, expectedDays }) {
  const filteredRates = rates.filter((r) => r !== undefined);

  if (filteredRates.length === 0) {
    return (
      <p className="mt-4 text-sm text-gray-400">
        No matching rates for this insurer at this hospital and setting.
      </p>
    );
  }

  const groups = groupBySetting(filteredRates);
  const showHeaders = groups.length > 1;

  // Compute min/max from the visible rates, applying per-diem stay multiplication
  // when we know the typical length of stay. This keeps the range honest when
  // a hospital mixes per-diem and case-rate methodologies.
  const stayRange = computeStayRange(filteredRates, expectedDays);

  return (
    <div className="mt-4 space-y-4">
      {groups.map((group) => (
        <div key={group.key}>
          {showHeaders && (
            <div className="text-xs uppercase tracking-wide text-gray-500 font-medium mb-2">
              {group.label}
            </div>
          )}
          <div className="space-y-3">
            {group.rates.map((rate, i) => (
              <RateRow
                key={`${group.key}-${i}`}
                rate={rate}
                medicareReference={medicareReference}
                expectedDays={expectedDays}
              />
            ))}
          </div>
        </div>
      ))}

      <div className="border-t border-gray-100 pt-3 grid grid-cols-2 gap-4 text-xs text-gray-400">
        <div>
          <span className="block text-gray-500">
            {stayRange.normalized ? 'Min (est. stay)' : 'Min Negotiated'}
          </span>
          {formatPrice(stayRange.min)}
        </div>
        <div>
          <span className="block text-gray-500">
            {stayRange.normalized ? 'Max (est. stay)' : 'Max Negotiated'}
          </span>
          {formatPrice(stayRange.max)}
        </div>
      </div>
    </div>
  );
}

// Compute min/max across the visible rates, normalizing per-diem entries to
// an estimated stay total when expectedDays is known. Returns { min, max,
// normalized } where `normalized` is true if any rate was multiplied by LOS.
function computeStayRange(rates, expectedDays) {
  let min = null;
  let max = null;
  let normalized = false;
  for (const r of rates) {
    if (r.negotiated_rate == null || r.negotiated_rate <= 0) continue;
    const isPerDiem = (r.methodology || '').toUpperCase() === 'PER DIEM';
    const value = isPerDiem && expectedDays
      ? r.negotiated_rate * expectedDays
      : r.negotiated_rate;
    if (isPerDiem && expectedDays) normalized = true;
    if (min == null || value < min) min = value;
    if (max == null || value > max) max = value;
  }
  return { min, max, normalized };
}

function RateRow({ rate, medicareReference, expectedDays }) {
  const methodology = formatMethodology(rate.methodology);
  const isPerDiem = methodology === 'Per Diem';
  const hasNumericRate = rate.negotiated_rate != null && rate.negotiated_rate > 0;
  const canCompare = medicareReference != null && medicareReference > 0 && hasNumericRate;

  // For per-diem rates the headline number is per-day, not a stay total. We
  // can only honestly compare it to a Medicare DRG payment if we also know
  // the typical length of stay (GMLOS), so we estimate stay total = rate × LOS.
  const perDiemStayTotal = isPerDiem && expectedDays && hasNumericRate
    ? rate.negotiated_rate * expectedDays
    : null;
  const compareValue = isPerDiem ? perDiemStayTotal : rate.negotiated_rate;
  const showVsMedicare = canCompare && (!isPerDiem || perDiemStayTotal != null);

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-gray-700">{formatPayer(rate.payer_name)}</div>
        <div className="text-xs text-gray-400 mt-0.5">
          {formatPlan(rate.plan_name)}
          {methodology && (
            <>
              {' · '}
              <Tooltip text={METHODOLOGY_TOOLTIPS[methodology]}>
                <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 text-xs">
                  {methodology}
                </span>
              </Tooltip>
            </>
          )}
        </div>
      </div>
      <div className="text-right flex-shrink-0">
        <div className="text-xl font-semibold text-gray-900">
          {hasNumericRate
            ? (
                <>
                  {formatPrice(rate.negotiated_rate)}
                  {isPerDiem && <span className="text-sm font-normal text-gray-500">/day</span>}
                </>
              )
            : rate.negotiated_percentage
            ? `${rate.negotiated_percentage}%`
            : '--'}
        </div>
        {isPerDiem && perDiemStayTotal != null && (
          <Tooltip text={`Geometric Mean Length of Stay (GMLOS) for this DRG is ${expectedDays} days per CMS — used as a typical-stay estimate.`}>
            <div className="text-xs text-gray-500 mt-0.5">
              ≈ {formatPrice(perDiemStayTotal)} for {expectedDays}d stay
            </div>
          </Tooltip>
        )}
        {showVsMedicare && (
          <VsMedicareBadge
            rate={compareValue}
            medicare={medicareReference}
            isPerDiemEstimate={isPerDiem}
            stayDays={expectedDays}
            dailyRate={rate.negotiated_rate}
          />
        )}
        {isPerDiem && !showVsMedicare && canCompare && (
          <div className="text-xs text-gray-400 mt-0.5 italic">
            Per diem — stay total depends on length
          </div>
        )}
      </div>
    </div>
  );
}

function VsMedicareBadge({ rate, medicare, isPerDiemEstimate, stayDays, dailyRate }) {
  const ratio = rate / medicare;
  const pct = Math.round((ratio - 1) * 100);
  const label = pct >= 0 ? `+${pct}% vs Medicare` : `${pct}% vs Medicare`;
  const colorClass = pct < 0
    ? 'text-emerald-600'
    : pct <= 100
    ? 'text-gray-500'
    : pct <= 300
    ? 'text-amber-600'
    : 'text-rose-600';
  const tooltip = isPerDiemEstimate
    ? `Per diem ${formatPrice(dailyRate)}/day × ${stayDays}d typical stay (GMLOS) = est. ${formatPrice(rate)}, which is ${ratio.toFixed(2)}x the Medicare payment for this DRG.`
    : `Negotiated rate is ${ratio.toFixed(2)}x the estimated total Medicare payment for this code.`;
  return (
    <Tooltip text={tooltip}>
      <div className={`text-xs mt-0.5 ${colorClass}`}>{label}</div>
    </Tooltip>
  );
}

function SummaryCell({ label, value }) {
  return (
    <div>
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-lg font-semibold text-gray-900 mt-0.5">{value}</div>
    </div>
  );
}
