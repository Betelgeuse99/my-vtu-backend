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

function formatBusinessName(name) {
  if (!name) return ''
  // Official CAC style: ALL CAPS, no abbreviations, proper business name formatting
  const stopWords = ['AND', 'OF', 'THE', 'FOR', 'TO', 'IN', 'ON', 'AT', 'BY', 'WITH']
  return name
    .toUpperCase()
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .map((word, i) => {
      // Always capitalize first and last word
      if (i === 0 || i === name.toUpperCase().trim().split(/\s+/).length - 1) return word
      // Keep stop words lowercase unless first/last
      if (stopWords.includes(word) && word.length <= 3) return word.toLowerCase()
      return word
    })
    .join(' ')
}

function formatPersonName(p) {
  if (!p) return ''
  return [p.surname, p.firstName, p.otherName].filter(Boolean).join(' ').toUpperCase()
}

function downloadPdf(sub) {
  const { jsPDF } = window.jspdf || {}
  if (!jsPDF) { alert('PDF library loading… try again.'); return }
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
  const regType = sub.registration_type || 'business_name'

  // Official CAC registration type labels
  const typeLabels = {
    business_name: 'BUSINESS NAME REGISTRATION',
    private_company: 'PRIVATE COMPANY LIMITED BY SHARES (LTD)',
    public_company: 'PUBLIC COMPANY LIMITED BY SHARES (PLC)',
    guarantee_company: 'COMPANY LIMITED BY GUARANTEE (LTD/GTE)',
    unlimited_company: 'UNLIMITED COMPANY (ULT)',
    incorporated_trustees: 'INCORPORATED TRUSTEES (NGO / ASSOCIATION)'
  }
  const typeLabel = typeLabels[regType] || 'REGISTRATION'

  // Official CAC form numbers per type
  const formNumbers = {
    business_name: 'Form CAC 1.1A',
    private_company: 'Form CAC 1.1',
    public_company: 'Form CAC 1.1',
    guarantee_company: 'Form CAC 1.1',
    unlimited_company: 'Form CAC 1.1',
    incorporated_trustees: 'Form CAC 1.1C'
  }
  const formNumber = formNumbers[regType] || 'Form CAC 1.1'

  const W = doc.internal.pageSize.getWidth()
  const H = doc.internal.pageSize.getHeight()
  const MARGIN = 15
  const CONTENT_W = W - MARGIN * 2
  let y = 0

  // Official CAC color scheme
  const cGreen = [0, 100, 0]       // CAC green
  const cGreenLight = [230, 245, 230]
  const cDark = [20, 30, 48]
  const cGold = [180, 150, 50]
  const cLine = [180, 185, 195]
  const cLightBg = [248, 250, 252]
  const cWhite = [255, 255, 255]

  function checkPage(needed) {
    if (y + (needed || 30) > H - 20) {
      doc.addPage()
      y = 20
      drawPageHeader()
    }
  }

  function drawPageHeader() {
    // Green top bar
    doc.setFillColor(...cGreen)
    doc.rect(0, 0, W, 8, 'F')
    // Gold accent line
    doc.setFillColor(...cGold)
    doc.rect(0, 8, W, 1, 'F')
    // CAC Title
    doc.setTextColor(...cDark)
    doc.setFontSize(13)
    doc.setFont('helvetica', 'bold')
    doc.text('CORPORATE AFFAIRS COMMISSION', MARGIN, 16)
    doc.setFontSize(8)
    doc.setFont('helvetica', 'normal')
    doc.setTextColor(80, 85, 100)
    doc.text('Federal Republic of Nigeria', MARGIN, 20)
    // Form number on right
    doc.setFontSize(8)
    doc.setFont('helvetica', 'bold')
    doc.setTextColor(...cGreen)
    doc.text(formNumber, W - MARGIN, 16, { align: 'right' })
    doc.setFontSize(7)
    doc.setFont('helvetica', 'normal')
    doc.setTextColor(100, 105, 120)
    doc.text(`Ref: ${sub.id || '—'}`, W - MARGIN, 20, { align: 'right' })
    // Separator line
    doc.setDrawColor(...cGreen)
    doc.setLineWidth(0.5)
    doc.line(MARGIN, 23, W - MARGIN, 23)
    y = 28
  }

  function drawFormTitle() {
    checkPage(35)
    // Form title banner
    doc.setFillColor(...cGreen)
    doc.roundedRect(MARGIN, y, CONTENT_W, 14, 2, 2, 'F')
    doc.setTextColor(...cWhite)
    doc.setFontSize(11)
    doc.setFont('helvetica', 'bold')
    doc.text(typeLabel, W / 2, y + 9, { align: 'center' })
    y += 18
    // Business name in official format
    const businessName = formatBusinessName(sub.proposed_name || '')
    if (businessName) {
      doc.setFontSize(12)
      doc.setFont('helvetica', 'bold')
      doc.setTextColor(...cDark)
      doc.text(businessName, W / 2, y + 3, { align: 'center' })
      y += 7
      // Underline
      doc.setDrawColor(...cGold)
      doc.setLineWidth(0.8)
      const nameW = doc.getTextWidth(businessName) + 10
      doc.line((W - nameW) / 2, y, (W + nameW) / 2, y)
      y += 5
    }
    // Date and submission info
    doc.setFontSize(7)
    doc.setFont('helvetica', 'normal')
    doc.setTextColor(100, 105, 120)
    const dateStr = sub.created_at ? new Date(sub.created_at).toLocaleDateString('en-NG', { year: 'numeric', month: 'long', day: 'numeric' }) : '—'
    doc.text(`Date of Application: ${dateStr}`, MARGIN, y)
    doc.text(`Status: PRE-REGISTRATION`, W - MARGIN, y, { align: 'right' })
    y += 6
    // Thin separator
    doc.setDrawColor(...cLine)
    doc.setLineWidth(0.2)
    doc.line(MARGIN, y, W - MARGIN, y)
    y += 5
  }

  function sectionTitle(num, label) {
    checkPage(18)
    // Green accent bar + section title
    doc.setFillColor(...cGreen)
    doc.rect(MARGIN, y, 2.5, 6, 'F')
    doc.setFontSize(9.5)
    doc.setFont('helvetica', 'bold')
    doc.setTextColor(...cDark)
    doc.text(`${num}. ${label.toUpperCase()}`, MARGIN + 5, y + 4.2)
    // Underline
    doc.setDrawColor(...cGreen)
    doc.setLineWidth(0.3)
    doc.line(MARGIN, y + 7.5, W - MARGIN, y + 7.5)
    y += 11
  }

  function field(label, value, opts = {}) {
    if (!value || value === 'N/A' || value === 'null' || value === 'undefined') return
    checkPage(10)
    const { bold = false, indent = 0, labelW = 42 } = opts
    const x = MARGIN + indent
    // Label
    doc.setFontSize(7.5)
    doc.setFont('helvetica', 'normal')
    doc.setTextColor(90, 95, 110)
    doc.text(label + ':', x, y)
    // Value
    doc.setFont('helvetica', bold ? 'bold' : 'normal')
    doc.setTextColor(30, 35, 50)
    const lines = doc.splitTextToSize(String(value), CONTENT_W - indent - labelW - 4)
    doc.text(lines, x + labelW, y)
    y += lines.length * 3.8 + 1.5
  }

  function fieldRow(label1, val1, label2, val2) {
    if (val1) field(label1, val1, { labelW: 38 })
    if (val2) field(label2, val2, { indent: CONTENT_W / 2, labelW: 38 })
  }

  function personBlock(title, p, idx) {
    if (!p || (!p.surname && !p.firstName)) return
    checkPage(35)
    // Person card background
    doc.setFillColor(...cLightBg)
    doc.roundedRect(MARGIN, y - 2, CONTENT_W, 20, 1.5, 1.5, 'F')
    // Card border
    doc.setDrawColor(...cLine)
    doc.setLineWidth(0.2)
    doc.roundedRect(MARGIN, y - 2, CONTENT_W, 20, 1.5, 1.5, 'S')
    // Title
    doc.setFontSize(8)
    doc.setFont('helvetica', 'bold')
    doc.setTextColor(...cGreen)
    doc.text(`${title}${idx !== undefined ? ' ' + (idx + 1) : ''}`.trim(), MARGIN + 3, y + 3)
    y += 6
    // Name (full, uppercase)
    const fullName = formatPersonName(p)
    field('Full Name', fullName, { indent: 3, labelW: 32 })
    // ID & DOB row
    fieldRow('NIN / ID', p.nin, 'Date of Birth', p.dob)
    // Gender & Nationality
    fieldRow('Gender', p.gender, 'Nationality', p.nationality)
    // Occupation
    if (p.occupation) field('Occupation', p.occupation, { indent: 3, labelW: 32 })
    // Phone & Email
    fieldRow('Phone', p.phone, 'Email', p.email)
    // Address
    if (p.resAddress) field('Residential Address', p.resAddress, { indent: 3, labelW: 42 })
    y += 4
  }

  function shareholderBlock(s, idx) {
    if (!s || (!s.surname && !s.firstName)) return
    checkPage(18)
    doc.setFillColor(...cLightBg)
    doc.roundedRect(MARGIN, y - 2, CONTENT_W, 14, 1.5, 1.5, 'F')
    doc.setDrawColor(...cLine)
    doc.setLineWidth(0.2)
    doc.roundedRect(MARGIN, y - 2, CONTENT_W, 14, 1.5, 1.5, 'S')
    doc.setFontSize(8)
    doc.setFont('helvetica', 'bold')
    doc.setTextColor(...cGreen)
    doc.text(`Shareholder ${idx + 1}`, MARGIN + 3, y + 3)
    y += 6
    const fullName = formatPersonName(s)
    field('Name', fullName, { indent: 3, labelW: 30 })
    fieldRow('Shares Allotted', s.allotted, 'NIN', s.nin)
    if (s.resAddress) field('Address', s.resAddress, { indent: 3, labelW: 30 })
    y += 3
  }

  function drawFooter() {
    const pages = doc.internal.getNumberOfPages()
    for (let i = 1; i <= pages; i++) {
      doc.setPage(i)
      // Footer bar
      doc.setFillColor(...cGreen)
      doc.rect(0, H - 8, W, 8, 'F')
      doc.setFontSize(6)
      doc.setTextColor(220, 225, 235)
      doc.text(`Dreamhatcher VTU — ${typeLabel} — Page ${i} of ${pages}`, W / 2, H - 4, { align: 'center' })
      // Page border
      doc.setDrawColor(...cLine)
      doc.setLineWidth(0.2)
      doc.rect(MARGIN / 2, 3, W - MARGIN, H - 6, 'S')
    }
  }

  // ================================================================
  //  BUILD THE PDF
  // ================================================================
  doc.addPage()
  drawPageHeader()
  drawFormTitle()

  // --- PAGE 1: IDENTITY & LOCATION ---
  sectionTitle(1, 'Company / Business Identity')
  field('Registration Type', typeLabel, { bold: true })
  field('Proposed Name', formatBusinessName(sub.proposed_name || ''))
  if (sub.alt_name) field('Alternative Name', formatBusinessName(sub.alt_name))
  field('Nature of Business / Objects', sub.nature_of_business)

  sectionTitle(2, 'Contact Details')
  fieldRow('Official Email', sub.email, 'Phone Number', sub.phone)

  sectionTitle(3, 'Registered Office Address')
  field('Address', sub.registered_address)
  if (sub.head_office_address && sub.head_office_address !== sub.registered_address) {
    field('Head Office Address', sub.head_office_address)
  }

  // --- TYPE-SPECIFIC SECTIONS ---

  if (regType === 'business_name') {
    // Business Name: Proprietor + Business Type
    if (sub.business_type) {
      sectionTitle(4, 'Business Type')
      field('Type', sub.business_type, { bold: true })
      if (sub.prop_commencement) field('Proposed Date of Commencement', sub.prop_commencement)
    }
    if (sub.proprietor?.surname || sub.proprietor?.firstName) {
      const nextSection = (sub.business_type) ? 5 : 4
      sectionTitle(nextSection, 'Proprietor Details')
      personBlock('Proprietor', sub.proprietor)
    }
  }

  if (['private_company', 'public_company', 'unlimited_company'].includes(regType)) {
    // Directors
    if (sub.directors?.length) {
      sectionTitle(4, 'Details of Directors')
      sub.directors.forEach((d, i) => personBlock('Director', d, i))
    }
    // Shareholders
    if (sub.shareholders?.length) {
      const shNum = sub.directors?.length ? 5 : 4
      sectionTitle(shNum, 'Details of Shareholders')
      sub.shareholders.forEach((s, i) => shareholderBlock(s, i))
    }
    // Share Capital
    if (sub.shares?.authCapital) {
      const capNum = (sub.directors?.length ? 1 : 0) + (sub.shareholders?.length ? 1 : 0) + 4
      sectionTitle(capNum, 'Share Capital')
      field('Authorized Share Capital', `N${sub.shares.authCapital}`)
      field('Issued Share Capital', `N${sub.shares.issuedCapital}`)
      if (sub.shares.capitalWords) field('Amount in Words', sub.shares.capitalWords)
      fieldRow('Class of Shares', sub.shares.shareClass, 'Nominal Value', sub.shares.nominalValue ? `N${sub.shares.nominalValue}` : '')
      if (sub.shares.sharesDivided) field('Divided Into', `${sub.shares.sharesDivided} shares`)
    }
    // PSC
    if (sub.pscs?.length) {
      let pscNum = 4
      if (sub.directors?.length) pscNum++
      if (sub.shareholders?.length) pscNum++
      if (sub.shares?.authCapital) pscNum++
      sectionTitle(pscNum, 'Persons with Significant Control (PSC)')
      sub.pscs.forEach((p, i) => {
        personBlock('PSC', p, i)
        if (p.pep || p.directShares || p.directVoting) {
          checkPage(10)
          y -= 1
          if (p.pep) field('PEP Status', p.pep, { indent: 6, labelW: 30 })
          if (p.directShares) field('Direct Shares', p.directShares, { indent: 6, labelW: 30 })
          if (p.directVoting) field('Direct Voting', p.directVoting, { indent: 6, labelW: 30 })
          y += 2
        }
      })
    }
    // Secretary
    if (sub.secretary?.surname || sub.secretary?.firstName) {
      let secNum = 4
      if (sub.directors?.length) secNum++
      if (sub.shareholders?.length) secNum++
      if (sub.shares?.authCapital) secNum++
      if (sub.pscs?.length) secNum++
      sectionTitle(secNum, 'Company Secretary')
      personBlock('Secretary', sub.secretary)
    }
  }

  if (regType === 'guarantee_company') {
    // Directors
    if (sub.directors?.length) {
      sectionTitle(4, 'Details of Directors')
      sub.directors.forEach((d, i) => personBlock('Director', d, i))
    }
    // Members
    if (sub.shareholders?.length) {
      const memNum = sub.directors?.length ? 5 : 4
      sectionTitle(memNum, 'Details of Members')
      sub.shareholders.forEach((s, i) => {
        checkPage(18)
        doc.setFillColor(...cLightBg)
        doc.roundedRect(MARGIN, y - 2, CONTENT_W, 14, 1.5, 1.5, 'F')
        doc.setDrawColor(...cLine)
        doc.setLineWidth(0.2)
        doc.roundedRect(MARGIN, y - 2, CONTENT_W, 14, 1.5, 1.5, 'S')
        doc.setFontSize(8)
        doc.setFont('helvetica', 'bold')
        doc.setTextColor(...cGreen)
        doc.text(`Member ${i + 1}`, MARGIN + 3, y + 3)
        y += 6
        const fullName = formatPersonName(s)
        field('Name', fullName, { indent: 3, labelW: 30 })
        fieldRow('NIN', s.nin, 'Shares / Interest', s.allotted)
        if (s.resAddress) field('Address', s.resAddress, { indent: 3, labelW: 30 })
        y += 3
      })
    }
    // Guarantee Details
    if (sub.guarantee?.amount || sub.guarantee?.purpose) {
      let gNum = 4
      if (sub.directors?.length) gNum++
      if (sub.shareholders?.length) gNum++
      sectionTitle(gNum, 'Guarantee Details')
      field('Guarantee Amount', `N${sub.guarantee.amount}`)
      if (sub.guarantee.purpose) field('Purpose of Formation', sub.guarantee.purpose)
    }
    // Secretary
    if (sub.secretary?.surname || sub.secretary?.firstName) {
      let secNum = 4
      if (sub.directors?.length) secNum++
      if (sub.shareholders?.length) secNum++
      if (sub.guarantee?.amount) secNum++
      sectionTitle(secNum, 'Company Secretary')
      personBlock('Secretary', sub.secretary)
    }
  }

  if (regType === 'incorporated_trustees') {
    if (sub.trustees?.length) {
      sectionTitle(4, 'Details of Trustees')
      sub.trustees.forEach((t, i) => personBlock('Trustee', t, i))
    }
  }

  // --- COMPLIANCE / FILING SECTION ---
  let compNum = 4
  if (regType === 'business_name') {
    if (sub.business_type) compNum++
    if (sub.proprietor?.surname || sub.proprietor?.firstName) compNum++
  } else if (regType === 'incorporated_trustees') {
    if (sub.trustees?.length) compNum++
  } else {
    if (sub.directors?.length) compNum++
    if (sub.shareholders?.length) compNum++
    if (sub.shares?.authCapital || sub.guarantee?.amount) compNum++
    if (sub.pscs?.length) compNum++
    if (sub.secretary?.surname || sub.secretary?.firstName) compNum++
  }

  if (sub.compliance?.surname || sub.compliance?.firstName) {
    sectionTitle(compNum, 'Statement of Compliance / Filing Agent')
    const compName = formatPersonName(sub.compliance)
    field('Name of Deponent', compName)
    fieldRow('Phone', sub.compliance.phone, 'Email', sub.compliance.email)
    if (sub.compliance.address) field('Address', sub.compliance.address)
  }

  if (sub.additional?.restrictionReason) {
    sectionTitle(compNum + 1, 'Additional Information')
    field('Reason for Address Restriction', sub.additional.restrictionReason)
  }

  // --- DECLARATION ---
  checkPage(25)
  y += 3
  doc.setDrawColor(...cGreen)
  doc.setLineWidth(0.3)
  doc.line(MARGIN, y, W - MARGIN, y)
  y += 5
  doc.setFontSize(7.5)
  doc.setFont('helvetica', 'italic')
  doc.setTextColor(80, 85, 100)
  const declText = 'I hereby certify that the information provided herein is true and correct to the best of my knowledge. This application is made in compliance with the requirements of the Companies and Allied Matters Act (CAMA) 2020.'
  const declLines = doc.splitTextToSize(declText, CONTENT_W)
  doc.text(declLines, MARGIN, y)
  y += declLines.length * 3.5 + 6
  // Signature line
  doc.setDrawColor(...cDark)
  doc.setLineWidth(0.3)
  doc.line(MARGIN, y, MARGIN + 60, y)
  doc.line(W / 2 + 10, y, W - MARGIN, y)
  y += 4
  doc.setFontSize(7)
  doc.setFont('helvetica', 'normal')
  doc.setTextColor(100, 105, 120)
  doc.text('Signature / Stamp of Deponent', MARGIN, y)
  doc.text('Date', W / 2 + 10, y)

  drawFooter()
  doc.save(`${(sub.proposed_name || 'CAC').replace(/[^a-zA-Z0-9]/g, '_')}_CAC_Registration.pdf`)
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
