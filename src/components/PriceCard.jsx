import { useState, useEffect } from 'react';
import { formatPrice, formatPayer, formatPlan, formatMethodology } from '../utils/format';

export default function PriceCard({ code, onBack }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    async function fetchProcedure() {
      setLoading(true);
      try {
        const res = await fetch(`/api/procedure/${encodeURIComponent(code)}`);
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Failed to load procedure');
        setData(json);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
    fetchProcedure();
  }, [code]);

  if (loading) {
    return <div className="mt-8 text-center text-gray-400 text-sm">Loading...</div>;
  }

  if (error) {
    return (
      <div className="mt-6">
        <button onClick={onBack} className="text-blue-600 text-sm mb-4">&larr; Back to results</button>
        <div className="p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">{error}</div>
      </div>
    );
  }

  const payers = Object.entries(data.payers);

  return (
    <div className="mt-6">
      <button
        onClick={onBack}
        className="text-blue-600 hover:text-blue-800 text-sm mb-4"
      >
        &larr; Back to results
      </button>

      {data.is_percentage_based && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 mb-4 text-sm text-amber-800">
          <span className="font-medium">Note:</span> This item uses percentage-based pricing.
          The dollar amounts shown are calculated as a percentage of total billed charges
          and may not reflect the actual cost you'd pay. The final price depends on the
          total charges for your visit.
        </div>
      )}

      <div className="bg-white border border-gray-200 rounded-lg p-6 mb-6">
        <h2 className="text-xl font-bold text-gray-900">{data.description}</h2>
        <div className="flex gap-4 mt-2 text-sm text-gray-500">
          <span>Code: <span className="font-mono">{data.code}</span></span>
          {data.setting && <span>Setting: {data.setting}</span>}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-4">
          <PriceStat label="Gross Charge" value={data.gross_charge} />
          <PriceStat label="Cash Price" value={data.cash_price} />
          <PriceStat label="Lowest Negotiated" value={data.min_negotiated} highlight="green" />
          <PriceStat label="Highest Negotiated" value={data.max_negotiated} highlight="red" />
        </div>
      </div>

      <h3 className="text-sm font-medium text-gray-500 mb-3">
        Payer comparison ({payers.length} payers)
      </h3>

      <div className="space-y-2">
        {payers.map(([payerName, rates]) => {
          // Show first rate per payer (typically one plan per payer in results)
          const rate = rates[0];
          return (
            <div
              key={payerName + rate.plan_name}
              className="bg-white border border-gray-200 rounded-lg px-4 py-3 flex items-center justify-between"
            >
              <div>
                <div className="font-medium text-sm text-gray-900">
                  {formatPayer(payerName)}
                </div>
                <div className="text-xs text-gray-400 mt-0.5">
                  {formatPlan(rate.plan_name)}
                  {rate.methodology && ` \u00B7 ${formatMethodology(rate.methodology)}`}
                </div>
              </div>
              <div className="text-right">
                {rate.negotiated_rate ? (
                  <span className={`text-lg font-semibold ${rate.is_percentage_based ? 'text-amber-700' : 'text-gray-900'}`}>
                    {formatPrice(rate.negotiated_rate)}
                    {rate.is_percentage_based && <span className="text-xs font-normal text-amber-600 ml-1">*</span>}
                  </span>
                ) : rate.negotiated_percentage ? (
                  <span className="text-lg font-semibold text-gray-900">
                    {rate.negotiated_percentage}%
                  </span>
                ) : (
                  <span className="text-sm text-gray-400">N/A</span>
                )}
                {rates.length > 1 && (
                  <div className="text-xs text-gray-400">{rates.length} plans</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PriceStat({ label, value, highlight }) {
  const colors = {
    green: 'text-green-700',
    red: 'text-red-700',
  };

  return (
    <div className="bg-gray-50 rounded-lg p-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-lg font-semibold mt-1 ${colors[highlight] || 'text-gray-900'}`}>
        {formatPrice(value)}
      </div>
    </div>
  );
}
