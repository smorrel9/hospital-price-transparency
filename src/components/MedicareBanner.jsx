import { formatPrice } from '../utils/format';
import Tooltip from './Tooltip';

const PAYABLE_SI = new Set(['J1', 'J2', 'T', 'S', 'V', 'Q1', 'Q2', 'Q3', 'P', 'R', 'S1', 'U']);
const PACKAGED_SI = new Set(['N', 'Q4']);
const ALT_FEE_SCHEDULE_SI = new Set(['A']);
const INPATIENT_ONLY_SI = new Set(['C']);

const SI_NOTES = {
  N: 'Hospital facility cost is bundled into another service — no separate APC payment.',
  Q4: 'Conditionally packaged — facility cost may be bundled into another service.',
  A: 'Hospital portion is paid under a separate Medicare fee schedule (e.g. lab, mammography), not OPPS.',
  C: 'This procedure is paid only under inpatient PPS (DRG-based), not outpatient.',
  B: 'Not paid under outpatient PPS — paid under another methodology.',
  E1: 'Not paid by Medicare under any fee-for-service payment system.',
  E2: 'Not recognized by Medicare for outpatient hospital services.',
};

function classifySI(si) {
  if (!si) return 'unknown';
  if (PAYABLE_SI.has(si)) return 'payable';
  if (PACKAGED_SI.has(si)) return 'packaged';
  if (ALT_FEE_SCHEDULE_SI.has(si)) return 'alt_schedule';
  if (INPATIENT_ONLY_SI.has(si)) return 'inpatient_only';
  return 'not_paid';
}

export default function MedicareBanner({ medicare, selectedSetting = 'ALL' }) {
  if (!medicare) return null;

  const pfs = medicare.facility_rate || 0;
  const opps = medicare.opps;
  const oppsClass = classifySI(opps?.status_indicator);
  const oppsPayable = oppsClass === 'payable' && opps?.austin_payment > 0;
  const showOpps = selectedSetting !== 'INPATIENT' && opps != null;
  const hasPfs = pfs > 0;

  // Hide banner only when we have nothing useful to show — neither a physician
  // fee nor a payable OPPS rate.
  if (!hasPfs && !(showOpps && oppsPayable)) return null;

  const total = (hasPfs ? pfs : 0) + (showOpps && oppsPayable ? opps.austin_payment : 0);

  const headerLabel = hasPfs && oppsPayable && showOpps
    ? 'Estimated Total Medicare'
    : oppsPayable && showOpps
    ? 'Medicare Hospital Facility Fee'
    : 'Medicare Professional Fee';

  return (
    <div className="bg-green-50 border border-green-200 rounded-lg px-5 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="text-green-700 font-semibold text-sm">{headerLabel}</span>
            <Tooltip text={buildTooltip(medicare, selectedSetting, oppsClass, oppsPayable)}>
              <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-green-200 text-green-700 text-xs cursor-help">
                ?
              </span>
            </Tooltip>
          </div>
          <div className="text-xs text-gray-500 mt-0.5">
            {medicare.locality} &middot; CY {medicare.year}
            {opps?.quarter && ` · OPPS ${opps.quarter}`}
          </div>
          {showOpps && oppsPayable && (
            <div className="text-xs text-green-800 mt-1.5">
              {hasPfs && (
                <>
                  <span className="font-medium">Physician fee</span> {formatPrice(pfs)}
                  <span className="mx-1.5 text-green-600">+</span>
                </>
              )}
              <span className="font-medium">Hospital facility fee</span> {formatPrice(opps.austin_payment)}
              {!hasPfs && (
                <span className="ml-2 text-green-700 italic">(no separate physician fee for this code)</span>
              )}
              {opps.status_indicator && (
                <Tooltip text={`OPPS Status Indicator: ${opps.status_indicator}. APC ${opps.apc_code || 'n/a'}.`}>
                  <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded bg-green-100 text-green-700 text-xs cursor-help">
                    SI {opps.status_indicator}
                  </span>
                </Tooltip>
              )}
            </div>
          )}
          {showOpps && !oppsPayable && opps?.status_indicator && (
            <div className="text-xs text-green-800 mt-1.5 italic">
              {SI_NOTES[opps.status_indicator] ||
                `Status indicator ${opps.status_indicator} — see CMS OPPS rules.`}{' '}
              Showing physician fee only.
            </div>
          )}
          {(!showOpps || !opps) && (
            <div className="text-xs text-green-800 mt-1.5 italic">
              {selectedSetting === 'INPATIENT'
                ? 'Inpatient stays are paid via DRG-based bundled payments, not yet shown here. Negotiated rates already include hospital facility costs.'
                : 'Physician fee only — hospital facility fee not available for this code.'}
            </div>
          )}
        </div>
        <div className="text-right flex-shrink-0">
          <div className="text-2xl font-bold text-green-700">{formatPrice(total)}</div>
        </div>
      </div>
    </div>
  );
}

function buildTooltip(medicare, selectedSetting, oppsClass, oppsPayable) {
  const lines = [
    `CMS Physician Fee Schedule rate for ${medicare.locality} (CY ${medicare.year}).`,
  ];
  if (oppsPayable) {
    lines.push(
      `Plus the OPPS Addendum B hospital facility fee for the same code, adjusted to the Austin wage area.`,
      `This estimates total Medicare payment for an outpatient hospital procedure (physician + facility).`
    );
  } else if (oppsClass === 'packaged') {
    lines.push(
      `OPPS bundles this procedure's facility cost into another service (Status Indicator N or Q4) — no separate hospital payment.`
    );
  } else if (oppsClass === 'alt_schedule') {
    lines.push(
      `OPPS marks this code as paid under a different Medicare fee schedule (lab, mammography, etc.) rather than the outpatient PPS.`
    );
  } else if (oppsClass === 'inpatient_only') {
    lines.push(
      `OPPS marks this code as inpatient-only (Status Indicator C) — paid via DRG, not outpatient PPS.`
    );
  }
  if (selectedSetting === 'INPATIENT') {
    lines.push(
      `For inpatient stays, hospitals are paid via DRG bundled payment (case-mix adjusted) — modeling that is on our roadmap.`
    );
  }
  return lines.join(' ');
}
