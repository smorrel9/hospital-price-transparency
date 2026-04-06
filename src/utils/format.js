/**
 * Format a number as USD currency.
 */
export function formatPrice(value) {
  if (value == null) return '--';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(value);
}

/**
 * Clean up payer names for display.
 * e.g. "AETNA ACO PPO" -> "Aetna ACO PPO"
 */
export function formatPayer(name) {
  if (!name) return 'Self-Pay / Uninsured';
  return name
    .split(' ')
    .map(word => {
      // Keep common abbreviations uppercase
      if (['PPO', 'HMO', 'EPO', 'POS', 'ACO', 'BCBS', 'CHI', 'MC'].includes(word)) return word;
      if (word.length <= 2) return word;
      return word.charAt(0) + word.slice(1).toLowerCase();
    })
    .join(' ');
}

/**
 * Clean up plan names — strip internal prefixes like "3438_"
 */
export function formatPlan(name) {
  if (!name) return '';
  return name.replace(/^\d+_/, '');
}

/**
 * Format methodology for display.
 */
export function formatMethodology(method) {
  if (!method) return '';
  const map = {
    'FEE SCHEDULE': 'Fee Schedule',
    'CASE RATE': 'Case Rate',
    'PERCENT OF TOTAL BILLED CHARGES': '% of Charges',
    'PER DIEM': 'Per Diem',
    'OTHER': 'Other',
  };
  return map[method] || method.charAt(0) + method.slice(1).toLowerCase();
}
