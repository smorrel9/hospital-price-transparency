import { formatPrice } from '../utils/format';
import Tooltip from './Tooltip';

/**
 * Persistent Medicare reference bar shown below the procedure header.
 * Shows the official CMS Medicare rate for Austin, TX as a baseline
 * so users can compare their insurance against the government rate.
 */
export default function MedicareBanner({ medicare, setting }) {
  if (!medicare) return null;

  // Use facility rate for inpatient/hospital, non-facility for outpatient/office
  const isInpatient = setting === 'INPATIENT';
  const rate = isInpatient ? medicare.facility_rate : medicare.nonfac_rate;
  const rateLabel = isInpatient ? 'Facility' : 'Non-Facility';

  if (!rate || rate <= 0) return null;

  return (
    <div className="bg-green-50 border border-green-200 rounded-lg px-5 py-4 flex items-center justify-between">
      <div>
        <div className="flex items-center gap-2">
          <span className="text-green-700 font-semibold text-sm">Medicare Rate</span>
          <Tooltip text={`Official CMS ${medicare.source} rate for ${medicare.locality} (${medicare.year}). ${rateLabel} setting. Medicare rates are set by the government and serve as a benchmark — compare your insurance rate to see if you're paying more or less.`}>
            <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-green-200 text-green-700 text-xs cursor-help">?</span>
          </Tooltip>
        </div>
        <div className="text-xs text-gray-500 mt-0.5">
          {medicare.locality} &middot; {rateLabel} &middot; CY {medicare.year}
        </div>
      </div>
      <div className="text-2xl font-bold text-green-700">
        {formatPrice(rate)}
      </div>
    </div>
  );
}
