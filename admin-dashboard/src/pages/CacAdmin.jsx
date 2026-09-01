import { useState, useEffect } from 'react'
import { readStoredSession } from '../context/AuthContext'
import { Building2, Download, Trash2, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react'

const SUPABASE_URL = 'https://lraryzkamshicildghdv.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxyYXJ5emthbXNoaWNpbGRnaGR2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU1MjQ4NDgsImV4cCI6MjEwMTEwMDg0OH0.243GADB6pgndKWrmWOco2AOK7vjzR7VAMdLu57QXkeQ'

function authHeaders() {
  const s = readStoredSession()
  return { 'Authorization': `Bearer ${s?.access_token || ''}`, 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json' }
}

async function fetchSubmissions() {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/cac_submissions?order=created_at.desc,id.desc&limit=200`, { headers: authHeaders() })
    if (res.ok) return await res.json()
  } catch {}
  return JSON.parse(localStorage.getItem('cac_submissions') || '[]')
}

async function deleteSubmission(id) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/cac_submissions?id=eq.${id}`, { method: 'DELETE', headers: authHeaders() })
  } catch {}
  const local = JSON.parse(localStorage.getItem('cac_submissions') || '[]')
  localStorage.setItem('cac_submissions', JSON.stringify(local.filter(r => r.id !== id)))
}

function downloadPdf(sub) {
  const { jsPDF } = window.jspdf || {}
  if (!jsPDF) { alert('PDF library loading… try again.'); return }
  const doc = new jsPDF()
  doc.setFontSize(14)
  doc.text('CAC PRE-REGISTRATION SUMMARY', 14, 15)
  doc.setFontSize(9)
  doc.text(`Type: ${sub.registration_type?.replace(/_/g, ' ') || 'N/A'}`, 14, 21)
  doc.text(`Company: ${(sub.proposed_name || '').toUpperCase()}`, 14, 26)
  doc.text(`Submitted: ${sub.created_at || ''}`, 14, 31)

  const rows = [
    ['Basic', `Name: ${sub.proposed_name}\nAlt: ${sub.alt_name || 'N/A'}\nEmail: ${sub.email} | Phone: ${sub.phone}\nNature: ${sub.nature_of_business}`],
    ['Address', `Registered: ${sub.registered_address}\nHead: ${sub.head_office_address}`],
  ]
  if (sub.proprietor?.surname) rows.push(['Proprietor', `${sub.proprietor.surname} ${sub.proprietor.firstName} | NIN: ${sub.proprietor.nin}`])
  if (sub.directors?.length) rows.push(['Directors', sub.directors.map((d, i) => `Dir ${i + 1}: ${d.surname} ${d.firstName} | NIN: ${d.nin}`).join('\n')])
  if (sub.shareholders?.length) rows.push(['Shareholders', sub.shareholders.map((s, i) => `SH ${i + 1}: ${s.surname} ${s.firstName} | ${s.allotted} shares`).join('\n')])
  if (sub.shares?.authCapital) rows.push(['Share Capital', `Auth: ₦${sub.shares.authCapital}\nIssued: ₦${sub.shares.issuedCapital}\nClass: ${sub.shares.shareClass}`])
  if (sub.pscs?.length) rows.push(['PSC', sub.pscs.map((p, i) => `PSC ${i + 1}: ${p.surname} ${p.firstName} | PEP: ${p.pep}`).join('\n')])
  if (sub.trustees?.length) rows.push(['Trustees', sub.trustees.map((t, i) => `T ${i + 1}: ${t.surname} ${t.firstName} | NIN: ${t.nin}`).join('\n')])
  if (sub.secretary?.surname) rows.push(['Secretary', `${sub.secretary.surname} ${sub.secretary.firstName} | NIN: ${sub.secretary.nin}`])
  if (sub.compliance) rows.push(['Compliance', `${sub.compliance.surname} ${sub.compliance.firstName} | ${sub.compliance.phone}`])

  doc.autoTable({
    startY: 35, head: [['Section', 'Details']], body: rows, theme: 'striped',
    headStyles: { fillColor: [77, 107, 254] },
    columnStyles: { 0: { cellWidth: 40, fontStyle: 'bold' }, 1: { cellWidth: 140 } },
    styles: { fontSize: 7.5, cellPadding: 2.5 },
  })
  doc.save(`${(sub.proposed_name || 'CAC').replace(/[^a-zA-Z0-9]/g, '_')}_CAC.pdf`)
}

function SubmissionCard({ sub }) {
  const [open, setOpen] = useState(false)
  const type = (sub.registration_type || '').replace(/_/g, ' ')
  return (
    <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between p-4 text-left hover:bg-slate-50 dark:hover:bg-slate-700/50 transition">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center shrink-0">
            <Building2 size={18} className="text-blue-600 dark:text-blue-400" />
          </div>
          <div className="min-w-0">
            <p className="font-bold text-sm text-slate-800 dark:text-slate-100 truncate">{sub.proposed_name || 'Unnamed'}</p>
            <p className="text-xs text-slate-500 dark:text-slate-400 capitalize">{type} • {sub.email} • {sub.phone}</p>
            <p className="text-[11px] text-slate-400 dark:text-slate-500">{sub.created_at || ''}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={e => { e.stopPropagation(); downloadPdf(sub) }} className="p-2 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-200" title="Download PDF"><Download size={16} /></button>
          <button onClick={e => { e.stopPropagation(); if (confirm('Delete?')) deleteSubmission(sub.id).then(() => window.location.reload()) }} className="p-2 rounded-lg bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 hover:bg-red-200" title="Delete"><Trash2 size={16} /></button>
          {open ? <ChevronUp size={16} className="text-slate-400" /> : <ChevronDown size={16} className="text-slate-400" />}
        </div>
      </button>
      {open && (
        <div className="px-4 pb-4 border-t border-slate-100 dark:border-slate-700 pt-3 space-y-2 text-xs">
          <D k="Nature of Business" v={sub.nature_of_business} />
          <D k="Registered Address" v={sub.registered_address} />
          {sub.head_office_address !== sub.registered_address && <D k="Head Office" v={sub.head_office_address} />}
          {sub.proprietor?.surname && <D k="Proprietor" v={`${sub.proprietor.surname} ${sub.proprietor.firstName} — NIN: ${sub.proprietor.nin}`} />}
          {sub.directors?.length > 0 && <D k="Directors" v={sub.directors.map((d, i) => `${i + 1}. ${d.surname} ${d.firstName} (${d.nin})`).join(', ')} />}
          {sub.shareholders?.length > 0 && <D k="Shareholders" v={sub.shareholders.map((s, i) => `${i + 1}. ${s.surname} ${s.firstName} (${s.allotted} shares)`).join(', ')} />}
          {sub.shares?.authCapital && <D k="Share Capital" v={`₦${sub.shares.authCapital} auth / ₦${sub.shares.issuedCapital} issued`} />}
          {sub.pscs?.length > 0 && <D k="PSCs" v={sub.pscs.map((p, i) => `${i + 1}. ${p.surname} ${p.firstName}`).join(', ')} />}
          {sub.trustees?.length > 0 && <D k="Trustees" v={sub.trustees.map((t, i) => `${i + 1}. ${t.surname} ${t.firstName}`).join(', ')} />}
          {sub.secretary?.surname && <D k="Secretary" v={`${sub.secretary.surname} ${sub.secretary.firstName}`} />}
          {sub.compliance && <D k="Compliance" v={`${sub.compliance.surname} ${sub.compliance.firstName} — ${sub.compliance.phone}`} />}
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

  const load = async () => { setLoading(true); setSubs(await fetchSubmissions()); setLoading(false) }
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
      {loading ? (
        <div className="text-center py-16 text-slate-400 text-sm">Loading…</div>
      ) : subs.length === 0 ? (
        <div className="text-center py-16 text-slate-400">
          <Building2 size={40} className="mx-auto mb-3 opacity-40" />
          <p className="text-sm">No CAC submissions yet.</p>
        </div>
      ) : (
        <div className="space-y-3">{subs.map(sub => <SubmissionCard key={sub.id} sub={sub} />)}</div>
      )}
    </div>
  )
}
