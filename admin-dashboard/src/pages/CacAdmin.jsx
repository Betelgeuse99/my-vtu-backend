import { useState, useEffect } from 'react'
import { readStoredSession } from '../context/AuthContext'
import { Building2, Download, Trash2, RefreshCw, ChevronDown, ChevronUp, Eye, X } from 'lucide-react'
import { buildCacPdf, cacPdfFilename, CAC_TYPE_LABELS } from '../lib/cacPdf'

const SUPABASE_URL = 'https://lraryzkamshicildghdv.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxyYXJ5emthbXNoaWNpbGRnaGR2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU1MjQ4NDgsImV4cCI6MjEwMTEwMDg0OH0.243GADB6pgndKWrmWOco2AOK7vjzR7VAMdLu57QXkeQ'

function authHeaders() {
  const s = readStoredSession()
  return { 'Authorization': `Bearer ${s?.access_token || ''}`, 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json' }
}

// Admins must see EVERY submission (web signed-in users AND the Android app).
// cac_submissions has row-level security that hides other people's rows from a
// normal token, so the dashboard reads/delete through the deployed admin edge
// function (functions/v1/admin/cac), which uses the service-role client and
// gates on the admin JWT. Rows only drop to the localStorage fallback when the
// API is unreachable (offline/dev).
const CAC_API = `${SUPABASE_URL}/functions/v1/admin/cac`

async function fetchSubmissions() {
  try {
    const res = await fetch(CAC_API, { headers: authHeaders() })
    if (res.ok) {
      const body = await res.json()
      if (body?.success && Array.isArray(body.data)) return { rows: body.data, error: null }
      return { rows: [], error: body?.message || 'Malformed response from admin API.' }
    }
    const body = await res.json().catch(() => null)
    return { rows: [], error: `Admin API returned ${res.status}${body?.message ? ` — ${body.message}` : ''}.` }
  } catch (e) {
    return {
      rows: JSON.parse(localStorage.getItem('cac_submissions') || '[]'),
      error: 'Could not reach the server — showing locally cached submissions only.',
    }
  }
}

async function deleteSubmission(id) {
  try {
    // POST (not DELETE): edge functions only parse a JSON body for POST/PUT/
    // PATCH, so a DELETE body with the id was silently dropped -> "numeric
    // submission id is required". The id now travels in a POST body.
    const res = await fetch(`${CAC_API}/delete`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ id: Number(id) }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => null)
      throw new Error(body?.message || `Delete failed (${res.status})`)
    }
  } catch (e) {
    alert(e.message || 'Delete failed')
  }
  const local = JSON.parse(localStorage.getItem('cac_submissions') || '[]')
  localStorage.setItem('cac_submissions', JSON.stringify(local.filter(r => r.id !== id)))
}

// ---------------------------------------------------------------------------
// jsPDF helpers (jsPDF is loaded globally from admin-dashboard/index.html)
// ---------------------------------------------------------------------------
function makeDoc() {
  const J = window.jspdf?.jsPDF
  if (!J) return null
  return new J({ orientation: 'portrait', unit: 'mm', format: 'a4' })
}

function renderDoc(sub) {
  const J = window.jspdf?.jsPDF
  if (!J) throw new Error('PDF library is still loading — please try again.')
  return buildCacPdf(sub, () => new J({ orientation: 'portrait', unit: 'mm', format: 'a4' }))
}

// ---------------------------------------------------------------------------
// Preview modal — shows the exact PDF that will be downloaded
// ---------------------------------------------------------------------------
function PreviewModal({ sub, onClose }) {
  const [pdfUrl, setPdfUrl] = useState(null)
  const [doc, setDoc] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let objectUrl = null
    try {
      const d = renderDoc(sub)
      setDoc(d)
      objectUrl = URL.createObjectURL(d.output('blob'))
      setPdfUrl(objectUrl)
    } catch (e) {
      setError(e.message || String(e))
    }
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [sub])

  const download = () => {
    try {
      const d = doc || renderDoc(sub)
      d.save(cacPdfFilename(sub))
    } catch (e) {
      alert(e.message || String(e))
    }
  }

  const type = (sub.registration_type || '').replace(/_/g, ' ')
  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-3 sm:p-6" onClick={onClose}>
      <div className="bg-white dark:bg-slate-900 w-full max-w-4xl h-[92vh] rounded-2xl flex flex-col overflow-hidden shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 dark:border-slate-700">
          <div className="min-w-0">
            <p className="font-bold text-sm text-slate-800 dark:text-slate-100 truncate">{sub.proposed_name || 'Unnamed'}</p>
            <p className="text-xs text-slate-500 dark:text-slate-400 capitalize">{type}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={download} className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold flex items-center gap-1.5">
              <Download size={15} /> Download PDF
            </button>
            <button onClick={onClose} className="p-2 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-500 hover:text-slate-700 dark:hover:text-slate-200" title="Close">
              <X size={18} />
            </button>
          </div>
        </div>
        <div className="flex-1 bg-slate-100 dark:bg-slate-950">
          {pdfUrl && !error ? (
            <iframe title="CAC form preview" src={pdfUrl} className="w-full h-full" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-sm text-slate-500 px-6 text-center">
              {error ? `Could not generate PDF — ${error}` : 'Generating PDF…'}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Submission card
// ---------------------------------------------------------------------------
const TYPE_PILLS = {
  business_name: 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300',
  private_company: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  public_company: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300',
  guarantee_company: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  unlimited_company: 'bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-900/40 dark:text-fuchsia-300',
  incorporated_trustees: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
}

function SubmissionCard({ sub, onPreview }) {
  const [open, setOpen] = useState(false)
  const type = (sub.registration_type || '').replace(/_/g, ' ')
  const pill = TYPE_PILLS[sub.registration_type] || TYPE_PILLS.business_name
  const prettyType = (CAC_TYPE_LABELS[sub.registration_type] || type)

  const download = (e) => {
    e.stopPropagation()
    try {
      renderDoc(sub).save(cacPdfFilename(sub))
    } catch (err) {
      alert(err.message || String(err))
    }
  }

  return (
    <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between p-4 text-left hover:bg-slate-50 dark:hover:bg-slate-700/50 transition">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center shrink-0">
            <Building2 size={18} className="text-blue-600 dark:text-blue-400" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="font-bold text-sm text-slate-800 dark:text-slate-100 truncate">{sub.proposed_name || 'Unnamed'}</p>
              <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full uppercase tracking-wide shrink-0 ${pill}`}>{prettyType.split(' ')[0]}</span>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 capitalize">{sub.email || ''} • {sub.phone || ''}</p>
            <p className="text-[11px] text-slate-400 dark:text-slate-500">{sub.created_at || ''}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button onClick={(e) => { e.stopPropagation(); onPreview(sub) }} className="p-2 rounded-lg bg-sky-100 dark:bg-sky-900/30 text-sky-600 dark:text-sky-400 hover:bg-sky-200" title="View PDF">
            <Eye size={16} />
          </button>
          <button onClick={download} className="p-2 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-200" title="Download PDF">
            <Download size={16} />
          </button>
          <button onClick={(e) => {
            e.stopPropagation()
            const name = sub.proposed_name || 'this submission'
            const typed = window.prompt(`This permanently deletes "${name}" from the dashboard AND the Supabase table.\n\nType DELETE to confirm.`)
            if (typed === 'DELETE') deleteSubmission(sub.id).then(() => window.location.reload())
          }} className="p-2 rounded-lg bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 hover:bg-red-200" title="Delete">
            <Trash2 size={16} />
          </button>
          {open ? <ChevronUp size={16} className="text-slate-400" /> : <ChevronDown size={16} className="text-slate-400" />}
        </div>
      </button>
      {open && (
        <div className="px-4 pb-4 border-t border-slate-100 dark:border-slate-700 pt-3 space-y-2 text-xs">
          <D k="Type" v={prettyType} />
          <D k="Nature of Business" v={sub.nature_of_business} />
          <D k="Principal Activity" v={sub.additional?.principalActivity} />
          <D k="Specific Activity" v={sub.additional?.specificActivity} />
          {Array.isArray(sub.additional?.objects) && <D k="Objects of Memorandum" v={sub.additional.objects.filter(Boolean).map((o, i) => `${i + 1}. ${o}`).join('\n')} />}
          {Array.isArray(sub.additional?.witnesses) && sub.additional.witnesses.filter(w => w?.surname || w?.firstName).length > 0 && <D k="Witnesses" v={sub.additional.witnesses.filter(w => w?.surname || w?.firstName).map((w, i) => `${i + 1}. ${w.surname} ${w.firstName}`).join(', ')} />}
          <D k="Registered Address" v={sub.registered_address} />
          {sub.head_office_address !== sub.registered_address && <D k="Head Office" v={sub.head_office_address} />}
          {sub.business_type && <D k="Business Type" v={`${sub.business_type}${(sub.additional?.propCommencement || sub.prop_commencement) ? ` — commences ${sub.additional?.propCommencement || sub.prop_commencement}` : ''}`} />}
          {sub.proprietor?.surname && <D k="Proprietor" v={`${sub.proprietor.surname} ${sub.proprietor.firstName} — NIN: ${sub.proprietor.nin}`} />}
          {sub.directors?.length > 0 && <D k="Directors" v={sub.directors.map((d, i) => `${i + 1}. ${d.surname} ${d.firstName} (${d.nin})`).join(', ')} />}
          {sub.shareholders?.length > 0 && <D k="Shareholders / Members" v={sub.shareholders.map((s, i) => `${i + 1}. ${s.surname} ${s.firstName}${s.allotted ? ` (${s.allotted} shares)` : ''}`).join(', ')} />}
          {sub.shares?.authCapital && <D k="Share Capital" v={`₦${sub.shares.authCapital} auth / ₦${sub.shares.issuedCapital} issued — ${sub.shares.capitalWords || ''}`} />}
          {sub.pscs?.length > 0 && <D k="PSCs" v={sub.pscs.map((p, i) => `${i + 1}. ${p.surname} ${p.firstName}${p.pep === 'Yes' ? ' (PEP)' : ''}`).join(', ')} />}
          {sub.trustees?.length > 0 && <D k="Trustees" v={sub.trustees.map((t, i) => `${i + 1}. ${t.surname} ${t.firstName}`).join(', ')} />}
          {sub.secretary?.surname && <D k="Secretary" v={`${sub.secretary.surname} ${sub.secretary.firstName}`} />}
          {sub.compliance?.surname && <D k="Compliance" v={`${sub.compliance.surname} ${sub.compliance.firstName} — ${sub.compliance.phone}`} />}
          {sub.additional?.restrictionReason && <D k="Restriction" v={sub.additional.restrictionReason} />}
        </div>
      )}
    </div>
  )
}

function D({ k, v }) {
  if (!v) return null
  return <div className="flex gap-2"><span className="text-slate-500 dark:text-slate-400 shrink-0 w-36 font-medium">{k}</span><span className="text-slate-700 dark:text-slate-200 break-all">{v}</span></div>
}

export default function CacAdmin() {
  const [subs, setSubs] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [previewSub, setPreviewSub] = useState(null)

  const load = async () => {
    setLoading(true)
    const { rows, error } = await fetchSubmissions()
    setSubs(rows)
    setError(error)
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 dark:text-slate-100">CAC Registrations</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">{subs.length} submission(s)</p>
        </div>
        <button onClick={load} className="p-2 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition" title="Refresh">
          <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>
      {error && (
        <div className="rounded-xl border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 px-4 py-3 text-xs text-amber-700 dark:text-amber-300">
          <p className="font-semibold mb-1">Could not load all submissions</p>
          <p>{error}</p>
          <p className="mt-1 opacity-80">The admin list reads through the deployed <code className="font-mono">admin</code> edge function (<code className="font-mono">GET /cac</code>). Make sure that function has been redeployed from <code className="font-mono">supabase/functions/admin</code> (the <code className="font-mono">deploy-functions</code> GitHub Action does this automatically on push).</p>
        </div>
      )}
      {loading ? (
        <div className="text-center py-16 text-slate-400 text-sm">Loading…</div>
      ) : subs.length === 0 ? (
        <div className="text-center py-16 text-slate-400">
          <Building2 size={40} className="mx-auto mb-3 opacity-40" />
          <p className="text-sm">No CAC submissions yet.</p>
        </div>
      ) : (
        <div className="space-y-3">{subs.map(sub => <SubmissionCard key={sub.id} sub={sub} onPreview={setPreviewSub} />)}</div>
      )}
      {previewSub && <PreviewModal sub={previewSub} onClose={() => setPreviewSub(null)} />}
    </div>
  )
}
