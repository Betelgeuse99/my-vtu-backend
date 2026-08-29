import React from 'react'

// ------------------------------------------------------------------
// CARRIER BADGE — the single seam that abstracts the upstream VTU gateway
// ("bigisub" / "alrahuz") out of the admin UI.
//
// The backend stores the END-USER carrier name (MTN, AIRTEL, GLO, 9MOBILE,
// DSTV, GOTV, ...) in transactions.provider. This component sanitizes any
// raw value (including legacy "bigisub"/"alrahuz" rows or vendor labels)
// down to the carrier, then renders a brand-colored monogram chip for it.
// Unknown / empty providers render a neutral chip instead of a vendor name.
// ------------------------------------------------------------------

// Keyword sanitizer: maps ANY upstream string to the canonical carrier.
function sanitizeCarrier(raw) {
  const s = String(raw || '').trim()
  if (!s) return null
  const key = s.toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (key.includes('9MOBILE') || key.includes('ETISALAT')) return '9MOBILE'
  if (key.includes('GOTV')) return 'GOTV'
  if (key.includes('DSTV')) return 'DSTV'
  if (key.includes('STARTIMES') || key.includes('STAR TIMES')) return 'STARTIMES'
  if (key.includes('SHOWMAX')) return 'SHOWMAX'
  if (key.includes('AIRTEL')) return 'AIRTEL'
  if (key.includes('MTN')) return 'MTN'
  if (key.includes('GLO')) return 'GLO'
  if (key.includes('ELECTRIC')) return s.toUpperCase() // DisCo
  return null
}

// Brand color per carrier (chip background / text / border).
const BRANDS = {
  MTN:      { bg: 'bg-yellow-50',   text: 'text-yellow-700', border: 'border-yellow-200', glyph: 'M' },
  AIRTEL:   { bg: 'bg-red-50',      text: 'text-red-700',    border: 'border-red-200',    glyph: 'A' },
  GLO:      { bg: 'bg-emerald-50',  text: 'text-emerald-700',border: 'border-emerald-200',glyph: 'G' },
  '9MOBILE':{ bg: 'bg-lime-50',     text: 'text-lime-700',   border: 'border-lime-200',   glyph: '9' },
  GOTV:     { bg: 'bg-orange-50',   text: 'text-orange-700', border: 'border-orange-200', glyph: 'G' },
  DSTV:     { bg: 'bg-sky-50',      text: 'text-sky-700',    border: 'border-sky-200',    glyph: 'D' },
  STARTIMES:{ bg: 'bg-violet-50',   text: 'text-violet-700', border: 'border-violet-200', glyph: 'S' },
  SHOWMAX:  { bg: 'bg-fuchsia-50',  text: 'text-fuchsia-700',border: 'border-fuchsia-200',glyph: 'S' },
}

export default function CarrierBadge({ provider }) {
  const carrier = sanitizeCarrier(provider)
  if (!carrier) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] uppercase tracking-wide font-medium bg-gray-100 text-gray-500 border border-gray-200">
        —
      </span>
    )
  }
  const brand = BRANDS[carrier] || {
    bg: 'bg-gray-100', text: 'text-gray-600', border: 'border-gray-200', glyph: carrier.charAt(0),
  }
  return (
    <span className={`inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded-md border ${brand.bg} ${brand.border}`}>
      <span className={`w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-black ${brand.text} ${brand.bg}`}>
        {brand.glyph}
      </span>
      <span className={`text-[10px] uppercase tracking-wide font-medium ${brand.text}`}>{carrier}</span>
    </span>
  )
}
