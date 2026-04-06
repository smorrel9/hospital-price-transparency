import { formatPrice, formatPayer, formatMethodology } from '../utils/format';

export default function ResultsTable({ results, query, loading, onSelectCode }) {
  if (loading) {
    return (
      <div className="mt-8 text-center text-gray-400 text-sm">Searching...</div>
    );
  }

  if (!query) {
    return (
      <div className="mt-12 text-center text-gray-400">
        <p className="text-lg">Search for a procedure, service, or billing code</p>
        <p className="text-sm mt-2">
          Try "MRI", "knee replacement", "ultrasound", or a CPT code like "27447"
        </p>
      </div>
    );
  }

  if (results.length === 0) {
    return (
      <div className="mt-8 text-center text-gray-500 text-sm">
        No results for "{query}"
      </div>
    );
  }

  // Deduplicate by code+setting for the summary view — show one row per procedure,
  // with the price range across payers
  const grouped = new Map();
  for (const r of results) {
    const key = `${r.code}-${r.setting}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        code: r.code,
        code_type: r.code_type,
        description: r.description,
        setting: r.setting,
        cash_price: r.cash_price,
        gross_charge: r.gross_charge,
        min: r.min_negotiated,
        max: r.max_negotiated,
        samplePayer: r.payer_name,
        sampleRate: r.negotiated_rate,
        sampleMethodology: r.methodology,
        is_percentage_based: r.is_percentage_based,
        count: 1,
      });
    } else {
      grouped.get(key).count++;
    }
  }

  const rows = [...grouped.values()];

  return (
    <div className="mt-6">
      <p className="text-sm text-gray-500 mb-3">
        {results.length} results for "{query}"
        {rows.length < results.length && ` (${rows.length} unique procedures)`}
      </p>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-gray-500">
              <th className="pb-2 pr-4 font-medium">Procedure</th>
              <th className="pb-2 pr-4 font-medium">Code</th>
              <th className="pb-2 pr-4 font-medium">Setting</th>
              <th className="pb-2 pr-4 font-medium text-right">Cash Price</th>
              <th className="pb-2 pr-4 font-medium text-right">Min Rate</th>
              <th className="pb-2 pr-4 font-medium text-right">Max Rate</th>
              <th className="pb-2 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={`${row.code}-${row.setting}`}
                className="border-b border-gray-100 hover:bg-gray-50"
              >
                <td className="py-3 pr-4">
                  <div className="font-medium text-gray-900">
                    {row.description}
                    {row.is_percentage_based && (
                      <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 font-normal">
                        % based
                      </span>
                    )}
                  </div>
                  {row.sampleRate && !row.is_percentage_based && (
                    <div className="text-xs text-gray-400 mt-0.5">
                      e.g. {formatPayer(row.samplePayer)}: {formatPrice(row.sampleRate)}{' '}
                      ({formatMethodology(row.sampleMethodology)})
                    </div>
                  )}
                  {row.is_percentage_based && (
                    <div className="text-xs text-amber-600 mt-0.5">
                      Prices are % of total charges, not fixed dollar amounts
                    </div>
                  )}
                </td>
                <td className="py-3 pr-4">
                  <span className="font-mono text-xs">{row.code}</span>
                  {row.code_type && (
                    <span className="ml-1 text-xs text-gray-400">{row.code_type}</span>
                  )}
                </td>
                <td className="py-3 pr-4">
                  <span className={`text-xs px-2 py-0.5 rounded-full ${
                    row.setting === 'INPATIENT'
                      ? 'bg-purple-50 text-purple-700'
                      : row.setting === 'BOTH'
                      ? 'bg-blue-50 text-blue-700'
                      : 'bg-green-50 text-green-700'
                  }`}>
                    {row.setting === 'INPATIENT' ? 'Inpatient' : row.setting === 'BOTH' ? 'Both' : 'Outpatient'}
                  </span>
                </td>
                <td className="py-3 pr-4 text-right font-mono">
                  {formatPrice(row.cash_price)}
                </td>
                <td className="py-3 pr-4 text-right font-mono">
                  {formatPrice(row.min)}
                </td>
                <td className="py-3 pr-4 text-right font-mono">
                  {formatPrice(row.max)}
                </td>
                <td className="py-3 text-right">
                  <button
                    onClick={() => onSelectCode(row.code)}
                    className="text-blue-600 hover:text-blue-800 text-xs font-medium"
                  >
                    Compare payers &rarr;
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
