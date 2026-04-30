export default function SettingToggle({ selected, onSelect, available }) {
  const options = [
    { value: 'ALL', label: 'All Settings' },
    { value: 'OUTPATIENT', label: 'Outpatient' },
    { value: 'INPATIENT', label: 'Inpatient' },
  ];

  return (
    <div className="space-y-1">
      <div className="text-sm font-medium text-gray-600">Care setting</div>
      <div className="flex flex-wrap gap-2">
        {options.map(({ value, label }) => {
          const isActive = selected === value;
          const disabled = value !== 'ALL' && !available[value];
          return (
            <button
              key={value}
              onClick={() => !disabled && onSelect(value)}
              disabled={disabled}
              className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-blue-600 text-white'
                  : disabled
                  ? 'bg-gray-50 text-gray-300 cursor-not-allowed'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
              title={disabled ? 'No rates posted for this setting' : undefined}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
