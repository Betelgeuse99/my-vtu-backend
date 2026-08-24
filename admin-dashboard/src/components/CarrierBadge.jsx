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
  MTN:      { bg: 'bg-yellow-500/15', text: 'text-yellow-300', border: 'border-yellow-500/30', glyph: 'M' },
  AIRTEL:   { bg: 'bg-red-500/15',    text: 'text-red-300',    border: 'border-red-500/30',    glyph: 'A' },
  GLO:      { bg: 'bg-emerald-500/15',text: 'text-emerald-300',border: 'border-emerald-500/30',glyph: 'G' },
  '9MOBILE':{ bg: 'bg-lime-500/15',   text: 'text-lime-300',   border: 'border-lime-500/30',   glyph: '9' },
  GOTV:     { bg: 'bg-orange-500/15', text: 'text-orange-300', border: 'border-orange-500/30', glyph: 'G' },
  DSTV:     { bg: 'bg-sky-500/15',    text: 'text-sky-300',    border: 'border-sky-500/30',    glyph: 'D' },
  STARTIMES:{ bg: 'bg-violet-500/15', text: 'text-violet-300', border: 'border-violet-500/30', glyph: 'S' },
  SHOWMAX:  { bg: 'bg-fuchsia-500/15',text: 'text-fuchsia-300',border: 'border-fuchsia-500/30',glyph: 'S' },
}

export default function CarrierBadge({ provider }) {
  const carrier = sanitizeCarrier(provider)
  if (!carrier) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] uppercase tracking-wide font-medium bg-gray-800/60 text-gray-400 border border-gray-700">
        —
      </span>
    )
  }
  const brand = BRANDS[carrier] || {
    bg: 'bg-gray-800/60', text: 'text-gray-300', border: 'border-gray-700', glyph: carrier.charAt(0),
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
