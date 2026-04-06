import { useState, useEffect } from 'react';
import SearchBar from './SearchBar';
import ResultsTable from './ResultsTable';
import PriceCard from './PriceCard';

const HOSPITAL_NAMES = {
  'ascension-seton-austin': 'Ascension Seton Medical Center Austin',
  'dell-seton-austin': 'Dell Seton Medical Center at UT Austin',
};

export default function App() {
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedCode, setSelectedCode] = useState(null);
  const [query, setQuery] = useState('');
  const [hospitals, setHospitals] = useState([]);

  useEffect(() => {
    fetch('/api/hospitals')
      .then(r => r.json())
      .then(data => setHospitals(data.hospitals))
      .catch(() => {});
  }, []);

  async function handleSearch(q, setting, hospital) {
    setQuery(q);
    setSelectedCode(null);
    setError(null);
    setLoading(true);

    try {
      const params = new URLSearchParams({ q, limit: 200 });
      if (setting) params.set('setting', setting);
      if (hospital) params.set('hospital', hospital);
      const res = await fetch(`/api/search?${params}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Search failed');
      setResults(data.results);
    } catch (err) {
      setError(err.message);
      setResults([]);
    } finally {
      setLoading(false);
    }
  }

  const hospitalCount = hospitals.length;
  const subtitle = hospitalCount > 1
    ? `${hospitalCount} Austin-area hospitals — CMS price transparency data`
    : 'Ascension Seton Medical Center Austin — CMS price transparency data';

  return (
    <div className="min-h-screen">
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-6xl mx-auto px-4 py-6">
          <h1 className="text-2xl font-bold text-gray-900">
            Hospital Price Lookup
          </h1>
          <p className="text-sm text-gray-500 mt-1">{subtitle}</p>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6">
        <SearchBar
          onSearch={handleSearch}
          loading={loading}
          hospitals={hospitals}
          hospitalNames={HOSPITAL_NAMES}
        />

        {error && (
          <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
            {error}
          </div>
        )}

        {selectedCode ? (
          <PriceCard
            code={selectedCode}
            onBack={() => setSelectedCode(null)}
            hospitalNames={HOSPITAL_NAMES}
          />
        ) : (
          <ResultsTable
            results={results}
            query={query}
            loading={loading}
            onSelectCode={setSelectedCode}
            hospitalNames={HOSPITAL_NAMES}
            showHospital={hospitals.length > 1}
          />
        )}
      </main>

      <footer className="border-t border-gray-200 mt-12">
        <div className="max-w-6xl mx-auto px-4 py-4 text-xs text-gray-400">
          Data sourced from CMS-mandated hospital machine-readable files.
          Prices shown are negotiated rates and may not reflect your actual cost.
        </div>
      </footer>
    </div>
  );
}
