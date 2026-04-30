import { formatPrice } from '../utils/format';
import Tooltip from './Tooltip';

const SETTING_NOTES = {
  ALL: 'Hospitals also bill separate facility fees (APC for outpatient, DRG-based for inpatient) — already included in the negotiated rates shown for each hospital.',
  OUTPATIENT: 'For hospital outpatient procedures, Medicare also pays a separate APC facility fee to the hospital — already included in the negotiated rates shown for each hospital.',
  INPATIENT: 'For inpatient stays, Medicare pays the hospital separately via DRG-based bundled payment — already included in the negotiated rates shown for each hospital.',
};

export default function MedicareBanner({ medicare, selectedSetting = 'ALL' }) {
  if (!medicare) return null;

  // For hospital-billed procedures, Medicare pays the physician the PFS
  // facility_rate — the hospital component is paid separately (APC for
  // outpatient, DRG for inpatient). nonfac_rate is for office-based
  // (non-hospital) settings, which doesn't apply to this dataset.
  const rate = medicare.facility_rate;
  if (!rate || rate <= 0) return null;

  const settingNote = SETTING_NOTES[selectedSetting] || SETTING_NOTES.ALL;

  return (
    <div className="bg-green-50 border border-green-200 rounded-lg px-5 py-4 flex items-start justify-between gap-4">
      <div className="flex-1">
        <div className="flex items-center gap-2">
          <span className="text-green-700 font-semibold text-sm">Medicare Professional Fee</span>
          <Tooltip
            text={`Official CMS ${medicare.source} rate for ${medicare.locality} (${medicare.year}). This is what Medicare pays the physician. ${settingNote}`}
          >
            <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-green-200 text-green-700 text-xs cursor-help">
              ?
            </span>
          </Tooltip>
        </div>
        <div className="text-xs text-gray-500 mt-0.5">
          {medicare.locality} &middot; Physician fee &middot; CY {medicare.year}
        </div>
        <div className="text-xs text-green-800 mt-1.5 italic">
          Physician fee only — hospital facility/DRG payment is billed separately and is included in the negotiated rates below.
        </div>
      </div>
      <div className="text-2xl font-bold text-green-700 flex-shrink-0">{formatPrice(rate)}</div>
    </div>
  );
}
