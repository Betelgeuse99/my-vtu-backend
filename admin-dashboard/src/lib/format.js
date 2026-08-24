// Formatting helpers for the admin dashboard.
// All timestamps render in LAGOS time (Africa/Lagos, UTC+1, West Central
// Africa) in 12-hour format — the business timezone, regardless of the
// browser's local timezone.

/**
 * Formats an ISO/date value in Africa/Lagos, 12-hour clock.
 * @param {string|Date|null} iso
 * @param {{date?:boolean, time?:boolean}} opts
 */
export function fmtLagos(iso, { date = true, time = true } = {}) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'

  const opts = { timeZone: 'Africa/Lagos', hour12: true }
  if (date) {
    opts.day = 'numeric'
    opts.month = 'short'
    opts.year = 'numeric'
  }
  if (time) {
    opts.hour = '2-digit'
    opts.minute = '2-digit'
  }
  return d.toLocaleString('en-GB', opts)
}

/** Formats a number as NGN currency. */
export function fmtNgn(n) {
  return '₦' + Number(n || 0).toLocaleString('en-NG')
}
