import { useState } from 'react';
import SearchBar from './SearchBar';
import ResultsTable from './ResultsTable';
import PriceCard from './PriceCard';

export default function App() {
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedCode, setSelectedCode] = useState(null);
  const [query, setQuery] = useState('');

  async function handleSearch(q, setting) {
    setQuery(q);
    setSelectedCode(null);
    setError(null);
    setLoading(true);

    try {
      const params = new URLSearchParams({ q, limit: 100 });
      if (setting) params.set('setting', setting);
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

  return (
    <div className="min-h-screen">
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-6xl mx-auto px-4 py-6">
          <h1 className="text-2xl font-bold text-gray-900">
            Hospital Price Lookup
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Ascension Seton Medical Center Austin — CMS price transparency data
          </p>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6">
        <SearchBar onSearch={handleSearch} loading={loading} />

        {error && (
          <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
            {error}
          </div>
        )}

        {selectedCode ? (
          <PriceCard code={selectedCode} onBack={() => setSelectedCode(null)} />
        ) : (
          <ResultsTable
            results={results}
            query={query}
            loading={loading}
            onSelectCode={setSelectedCode}
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
