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
  '% of Charges': 'Rate is calculated as a percentage of the hospital\'s list price',
  'Per Diem': 'Daily rate — total cost depends on length of stay',
};

export default function HospitalCard({ hospital, rates, hospitalName, colorIndex = 0 }) {
  const borderColor = BORDER_COLORS[colorIndex % BORDER_COLORS.length];

  // If no specific payer selected (rates is all rates for this hospital)
  // we show a summary. If a payer is selected, rates is filtered.
  const hasSpecificPayer = rates._filtered;

  if (!hasSpecificPayer) {
    // All-insurance summary mode
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

    return (
      <div className={`bg-white border border-gray-200 ${borderColor} border-l-4 rounded-lg p-5`}>
        <h3 className="font-semibold text-gray-900 text-base">{hospitalName}</h3>

        <div className="mt-3 grid grid-cols-3 gap-4">
          <SummaryCell label="Payers" value={`${payerNames.size}`} />
          <SummaryCell
            label="Rate Range"
            value={min < Infinity ? `${formatPrice(min)} - ${formatPrice(max)}` : '--'}
          />
          <SummaryCell label="Cash Price" value={formatPrice(rates[0]?.cash_price)} />
        </div>

        <div className="mt-3 grid grid-cols-3 gap-4 text-xs text-gray-400">
          <div>
            <span className="block text-gray-500">Min Negotiated</span>
            {formatPrice(rates[0]?.min_negotiated)}
          </div>
          <div>
            <span className="block text-gray-500">Max Negotiated</span>
            {formatPrice(rates[0]?.max_negotiated)}
          </div>
          <div>
            <span className="block text-gray-500">Gross Charge</span>
            {formatPrice(rates[0]?.gross_charge)}
          </div>
        </div>
      </div>
    );
  }

  // Filtered payer mode — show each matching rate as a row
  const filteredRates = rates.filter((r) => r !== undefined);

  return (
    <div className={`bg-white border border-gray-200 ${borderColor} border-l-4 rounded-lg p-5`}>
      <h3 className="font-semibold text-gray-900 text-base">{hospitalName}</h3>

      {filteredRates.length === 0 ? (
        <p className="mt-3 text-sm text-gray-400">No matching rates for this payer at this hospital.</p>
      ) : (
        <div className="mt-3 space-y-3">
          {filteredRates.map((rate, i) => {
            const methodology = formatMethodology(rate.methodology);
            return (
              <div key={i} className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-gray-700">
                    {formatPayer(rate.payer_name)}
                  </div>
                  <div className="text-xs text-gray-400 mt-0.5">
                    {formatPlan(rate.plan_name)}
                    {methodology && (
                      <>
                        {' \u00B7 '}
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
                    {rate.negotiated_rate != null
                      ? formatPrice(rate.negotiated_rate)
                      : rate.negotiated_percentage
                      ? `${rate.negotiated_percentage}%`
                      : '--'}
                  </div>
                </div>
              </div>
            );
          })}

          {/* Summary row */}
          <div className="border-t border-gray-100 pt-3 mt-3 grid grid-cols-3 gap-4 text-xs text-gray-400">
            <div>
              <span className="block text-gray-500">Cash Price</span>
              {formatPrice(filteredRates[0]?.cash_price)}
            </div>
            <div>
              <span className="block text-gray-500">Min Negotiated</span>
              {formatPrice(filteredRates[0]?.min_negotiated)}
            </div>
            <div>
              <span className="block text-gray-500">Max Negotiated</span>
              {formatPrice(filteredRates[0]?.max_negotiated)}
            </div>
          </div>
        </div>
      )}
    </div>
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
