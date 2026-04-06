import { useState, useRef, useEffect, useCallback } from 'react';

export default function AutocompleteSearch({ onSelect }) {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [hasSearched, setHasSearched] = useState(false);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const timerRef = useRef(null);

  const fetchSuggestions = useCallback(async (q) => {
    if (!q.trim()) {
      setSuggestions([]);
      setOpen(false);
      setHasSearched(false);
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`/api/autocomplete?q=${encodeURIComponent(q.trim())}&limit=10`);
      const data = await res.json();
      setSuggestions(data.suggestions || []);
      setOpen(true);
      setHasSearched(true);
      setActiveIndex(-1);
    } catch {
      setSuggestions([]);
    } finally {
      setLoading(false);
    }
  }, []);

  function handleChange(e) {
    const val = e.target.value;
    setQuery(val);

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => fetchSuggestions(val), 300);
  }

  function handleSelect(suggestion) {
    setQuery(suggestion.friendly_name || suggestion.original_description);
    setOpen(false);
    setSuggestions([]);
    onSelect(suggestion.code);
  }

  function handleKeyDown(e) {
    if (!open || suggestions.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((prev) => (prev < suggestions.length - 1 ? prev + 1 : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((prev) => (prev > 0 ? prev - 1 : suggestions.length - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIndex >= 0 && activeIndex < suggestions.length) {
        handleSelect(suggestions[activeIndex]);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  // Scroll active item into view
  useEffect(() => {
    if (activeIndex >= 0 && listRef.current) {
      const item = listRef.current.children[activeIndex];
      if (item) item.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex]);

  // Close on click outside
  useEffect(() => {
    function handleClickOutside(e) {
      if (inputRef.current && !inputRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Cleanup timer
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <div className="relative" ref={inputRef}>
      <input
        type="text"
        value={query}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onFocus={() => {
          if (suggestions.length > 0) setOpen(true);
        }}
        placeholder="Search procedures — e.g. knee replacement, MRI, colonoscopy"
        className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
      />
      {loading && (
        <div className="absolute right-3 top-1/2 -translate-y-1/2">
          <div className="w-4 h-4 border-2 border-gray-300 border-t-blue-500 rounded-full animate-spin" />
        </div>
      )}

      {open && (
        <div className="absolute z-40 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-80 overflow-y-auto">
          {suggestions.length > 0 ? (
            <ul ref={listRef} role="listbox">
              {suggestions.map((s, i) => (
                <li
                  key={s.code}
                  role="option"
                  aria-selected={i === activeIndex}
                  className={`px-4 py-3 cursor-pointer border-b border-gray-50 last:border-0 ${
                    i === activeIndex
                      ? 'bg-blue-50'
                      : 'hover:bg-gray-50'
                  }`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    handleSelect(s);
                  }}
                  onMouseEnter={() => setActiveIndex(i)}
                >
                  <div className="font-medium text-sm text-gray-900">
                    {s.friendly_name || s.original_description}
                  </div>
                  <div className="text-xs text-gray-400 mt-0.5">
                    <span className="font-mono">{s.code}</span>
                    {s.code_type && (
                      <span className="ml-2 text-gray-400">{s.code_type}</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ) : hasSearched ? (
            <div className="px-4 py-3 text-sm text-gray-400">No matches</div>
          ) : null}
        </div>
      )}
    </div>
  );
}
