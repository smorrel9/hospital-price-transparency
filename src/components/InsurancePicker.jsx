import { useState, useEffect } from 'react';
import { formatPayer } from '../utils/format';

export default function InsurancePicker({ onSelect, selected }) {
  const [categories, setCategories] = useState([]);
  const [expandedCategory, setExpandedCategory] = useState(null);

  useEffect(() => {
    fetch('/api/payer-categories')
      .then((r) => r.json())
      .then((data) => setCategories(data.categories || []))
      .catch(() => {});
  }, []);

  // Preferred ordering for the category chips
  const ORDER = ['BCBS', 'Aetna', 'United', 'Cigna', 'Humana', 'Medicare', 'Medicaid', 'Other'];

  const sorted = [...categories].sort(
    (a, b) => ORDER.indexOf(a.category) - ORDER.indexOf(b.category)
  );

  function handleCategoryClick(cat) {
    if (selected?.category === cat && !selected?.payerName) {
      // Deselect
      onSelect(null);
      setExpandedCategory(null);
    } else {
      onSelect({ category: cat, payerName: null });
      setExpandedCategory(cat);
    }
  }

  function handlePayerClick(payerName) {
    if (selected?.payerName === payerName) {
      // Go back to just the category
      onSelect({ category: selected.category, payerName: null });
    } else {
      onSelect({ category: selected?.category || expandedCategory, payerName });
    }
  }

  function handleAllInsurance() {
    onSelect(null);
    setExpandedCategory(null);
  }

  const isAllSelected = !selected;
  const expandedPayers = expandedCategory
    ? sorted.find((c) => c.category === expandedCategory)?.payers || []
    : [];

  return (
    <div className="space-y-3">
      <div className="text-sm font-medium text-gray-600 mb-1">Filter by insurance</div>

      {/* Category chips */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={handleAllInsurance}
          className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
            isAllSelected
              ? 'bg-blue-600 text-white'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          All Insurance
        </button>
        {sorted.map(({ category }) => {
          const isActive = selected?.category === category;
          return (
            <button
              key={category}
              onClick={() => handleCategoryClick(category)}
              className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {category}
            </button>
          );
        })}
      </div>

      {/* Specific payer names when a category is expanded */}
      {expandedPayers.length > 0 && (
        <div className="flex flex-wrap gap-2 pl-2 border-l-2 border-blue-200">
          {expandedPayers.map(({ payer_name }) => {
            const isActive = selected?.payerName === payer_name;
            return (
              <button
                key={payer_name}
                onClick={() => handlePayerClick(payer_name)}
                className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                  isActive
                    ? 'bg-blue-500 text-white'
                    : 'bg-white border border-gray-200 text-gray-500 hover:border-blue-300 hover:text-blue-600'
                }`}
              >
                {formatPayer(payer_name)}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
