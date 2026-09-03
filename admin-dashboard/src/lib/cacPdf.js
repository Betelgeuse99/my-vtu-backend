// ============================================================================
// CAC green-form PDF builder.
//
// This module renders the submission detail form that an admin downloads or
// previews. The exact same layout/geometry is used by the customer web app
// (vtu-web/src/lib/cacPdf.js) so a registration produced on web, admin or
// Android is printed 1:1 — every registration type gets the sections that
// match its own contents (a Business Name never shows directors/share capital;
// a Company never shows a proprietor; Trustees show their trustees, etc).
//
// The one thing the caller injects is a jsPDF document factory, so this file
// can run against the admin dashboard's CDN jsPDF (window.jspdf) and the web
// app's bundled jsPDF with identical output.
// ============================================================================

export const CAC_TYPE_LABELS = {
  business_name: 'BUSINESS NAME REGISTRATION',
  private_company: 'PRIVATE COMPANY LIMITED BY SHARES (LTD)',
  public_company: 'PUBLIC COMPANY LIMITED BY SHARES (PLC)',
  guarantee_company: 'COMPANY LIMITED BY GUARANTEE (LTD/GTE)',
  unlimited_company: 'UNLIMITED COMPANY (ULT)',
  incorporated_trustees: 'INCORPORATED TRUSTEES (NGO / ASSOCIATION)'
}

export const CAC_FORM_NUMBERS = {
  business_name: 'Form CAC 1.1A',
  private_company: 'Form CAC 1.1',
  public_company: 'Form CAC 1.1',
  guarantee_company: 'Form CAC 1.1',
  unlimited_company: 'Form CAC 1.1',
  incorporated_trustees: 'Form CAC 1.1C'
}

export const CAC_TYPE_SHORT = {
  business_name: 'BUSINESS_NAME',
  private_company: 'LTD',
  public_company: 'PLC',
  guarantee_company: 'LTD_GTE',
  unlimited_company: 'ULT',
  incorporated_trustees: 'INC_TRUSTEES'
}

function has(v) {
  if (v === null || v === undefined) return false
  const s = String(v).trim()
  return s !== '' && s.toLowerCase() !== 'n/a' && s !== 'null' && s !== 'undefined'
}

function clean(v) {
  return v === null || v === undefined ? '' : String(v).trim()
}

// Official CAC style: ALL CAPS with small connective words kept lowercase.
export function formatBusinessName(name) {
  const raw = clean(name)
  if (!raw) return ''
  const stopWords = ['AND', 'OF', 'THE', 'FOR', 'TO', 'IN', 'ON', 'AT', 'BY', 'WITH']
  const words = raw.toUpperCase().replace(/\s+/g, ' ').trim().split(' ')
  if (words.length <= 1) return words[0] || ''
  return words
    .map((word, i) => {
      if (i === 0 || i === words.length - 1) return word
      return stopWords.includes(word) && word.length <= 3 ? word.toLowerCase() : word
    })
    .join(' ')
}

function formatPersonName(p) {
  if (!p) return ''
  return [p.surname, p.firstName, p.otherName].map(clean).filter(Boolean).join(' ').toUpperCase()
}

function money(v) {
  return has(v) ? `N${clean(v)}` : ''
}

// Main builder ----------------------------------------------------------------
//   makeDoc: () => new jsPDF(...)  (portrait A4)
//   sub: the cac_submissions row (registration_type, proposed_name, email, …,
//        jsonb blocks already parsed: proprietor/directors/shareholders/pscs/
//        trustees/shares/guarantee/secretary/compliance/additional)
export function buildCacPdf(sub, makeDoc) {
  const doc = makeDoc()
  const regType = clean(sub.registration_type) || 'business_name'
  const typeLabel = CAC_TYPE_LABELS[regType] || 'CAC / BUSINESS REGISTRATION'
  const formNumber = CAC_FORM_NUMBERS[regType] || 'Form CAC 1.1'
  const typeShort = CAC_TYPE_SHORT[regType] || 'CAC'

  const W = doc.internal.pageSize.getWidth()
  const H = doc.internal.pageSize.getHeight()
  const ML = 14
  const CW = W - ML * 2

  const LINE = 3.5
  const cGreen = [0, 92, 0]
  const cGold = [176, 141, 40]
  const cDark = [20, 28, 46]
  const cMuted = [92, 96, 108]
  const cRule = [196, 200, 208]

  let y = 0

  function pageHeader() {
    doc.setFillColor(...cGreen)
    doc.rect(0, 0, W, 6.5, 'F')
    doc.setFillColor(...cGold)
    doc.rect(0, 6.5, W, 0.9, 'F')

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(12)
    doc.setTextColor(...cDark)
    doc.text('CORPORATE AFFAIRS COMMISSION', ML, 12.5)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(6.5)
    doc.setTextColor(...cMuted)
    doc.text('Federal Republic of Nigeria', ML, 16.5)

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(8)
    doc.setTextColor(...cGreen)
    doc.text(formNumber, W - ML, 13, { align: 'right' })
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(6.5)
    doc.setTextColor(...cMuted)
    doc.text(`Ref: ${clean(sub.id) || '\u2014'}`, W - ML, 16.5, { align: 'right' })

    doc.setDrawColor(...cGreen)
    doc.setLineWidth(0.4)
    doc.line(ML, 19, W - ML, 19)
    y = 23
  }

  function ensure(needed) {
    if (y + needed > H - 16) {
      doc.addPage()
      pageHeader()
      return true
    }
    return false
  }

  function sectionTitle(title) {
    ensure(18)
    doc.setFillColor(...cGreen)
    doc.rect(ML, y - 1, 2.2, 5.6, 'F')
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9)
    doc.setTextColor(...cDark)
    doc.text(title.toUpperCase(), ML + 4.4, y + 3.4)
    doc.setDrawColor(...cGreen)
    doc.setLineWidth(0.25)
    doc.line(ML, y + 6.8, W - ML, y + 6.8)
    y += 9.6
  }

  // Draw the multi-line value and return the number of lines rendered.
  function drawValue(text, x, baseline, vw, bold) {
    doc.setFont('helvetica', bold ? 'bold' : 'normal')
    doc.setFontSize(7)
    doc.setTextColor(...cDark)
    const lines = doc.splitTextToSize(String(text), vw)
    for (let i = 0; i < lines.length; i++) doc.text(lines[i], x, baseline + i * LINE)
    return lines.length
  }

  // One row, two label/value columns. Each cell may wrap. Returns nothing but
  // advances y by the tallest cell so text can never overlap.
  function row(l, r) {
    const colW = CW / 2
    const labelW = 32
    const vw = colW - labelW - 7

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7)
    const lLines = l && has(l.value) ? doc.splitTextToSize(clean(l.value), vw).length : 0
    const rLines = r && has(r.value) ? doc.splitTextToSize(clean(r.value), vw).length : 0
    if (lLines === 0 && rLines === 0) return

    const n = Math.max(1, lLines, rLines)
    ensure(n * LINE + 1.6)

    const place = (cell, x0) => {
      if (!cell || !has(cell.value)) return
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(6.6)
      doc.setTextColor(...cMuted)
      doc.text(`${cell.label}:`, x0, y + 2.4)
      drawValue(cell.value, x0 + labelW, y + 2.4, vw, !!cell.bold)
    }
    place(l, ML)
    place(r, ML + colW)
    y += n * LINE + 1.4
  }

  // Full-width single label/value row.
  function wideRow(label, value, opts = {}) {
    if (!has(value)) return
    const labelW = 44
    const vw = CW - labelW - 6
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7)
    const lines = doc.splitTextToSize(clean(value), vw).length
    const n = Math.max(1, lines)
    ensure(n * LINE + 1.8)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(6.6)
    doc.setTextColor(...cMuted)
    doc.text(`${label}:`, ML, y + 2.4)
    drawValue(value, ML + labelW, y + 2.4, vw, !!opts.bold)
    y += n * LINE + 1.6
  }

  const f = (label, value, opts = {}) => ({ label, value, ...opts })

  // A grouped person (director / shareholder / psc / trustee / proprietor /
  // secretary / member). Renders its own heading + rule, then compact rows.
  function person(kind, idx, p, extra) {
    if (!p) return
    const name = formatPersonName(p)
    const hasFields = Object.keys(p || {}).some((k) => has(p[k]))
    if (!name && !hasFields) return

    const heading = `${kind}${idx != null ? ` ${idx + 1}` : ''}${name ? `  \u2014  ${name}` : ''}`
    ensure(14)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(7.8)
    doc.setTextColor(...cGreen)
    const hLines = doc.splitTextToSize(heading, CW)
    for (let i = 0; i < hLines.length; i++) doc.text(hLines[i], ML, y + 2.4 + i * LINE)
    doc.setDrawColor(...cRule)
    doc.setLineWidth(0.2)
    doc.line(ML, y + hLines.length * LINE + 3.4, W - ML, y + hLines.length * LINE + 3.4)
    y += hLines.length * LINE + 6

    if (has(p.dob) || has(p.gender)) row(f('Date of Birth', p.dob), f('Gender', p.gender))
    if (has(p.nationality) || has(p.occupation)) row(f('Nationality', p.nationality), f('Occupation', p.occupation))
    if (has(p.nin) || has(p.idType)) row(f('NIN / ID No.', p.nin), f('Means of ID', p.idType))
    if (has(p.phone) || has(p.email)) row(f('Phone', p.phone), f('Email', p.email))
    if (has(p.taxResidency) || has(p.tin)) row(f('Tax Residency', p.taxResidency), f('TIN', p.tin))
    if (extra && extra.allotment) row(f('Shares Allotted', p.allotted), null)

    const addrA = has(p.address) ? clean(p.address) : ''
    const addrB = has(p.resAddress) ? clean(p.resAddress) : ''
    if (addrA && addrB && addrA !== addrB) {
      wideRow('Office Address', addrA)
      wideRow('Residential Address', addrB)
    } else if (addrA) {
      wideRow('Address', addrA)
    } else if (addrB) {
      wideRow('Residential Address', addrB)
    }

    if (has(p.countryRes) && (addrA || addrB)) {
      // countryRes shown with the address above; nothing more to add here
    } else if (has(p.countryRes)) {
      wideRow('Country of Residence', p.countryRes)
    }
  }

  // PSC-specific interest rows.
  function pscInterests(p) {
    const q = (label, v) => has(v) ? f(label, v) : null
    const a = [
      q('PEP Status', p.pep),
      q('Direct Shareholding', p.directShares),
      q('Indirect Shareholding', p.indirectShares),
      q('Direct Voting Rights', p.directVoting),
      q('Indirect Voting Rights', p.indirectVoting),
      q('Appoint/Remove Directors', p.appointDirectors),
      q('Significant Influence/Control', p.significantInfluence)
    ]
    for (let i = 0; i < a.length; i += 2) {
      const left = a[i]
      const right = i + 1 < a.length ? a[i + 1] : null
      if ((left && left.value) || (right && right.value)) row(left, right)
    }
  }

  const isCompany = ['private_company', 'public_company', 'unlimited_company'].includes(regType)
  const isGte = regType === 'guarantee_company'
  const isLtdUlt = isCompany
  const isBusinessName = regType === 'business_name'
  const isTrustees = regType === 'incorporated_trustees'

  // ==========================================================================
  // PAGE 1 — header + banner
  // ==========================================================================
  pageHeader()

  // Registration type banner
  ensure(30)
  doc.setFillColor(...cGreen)
  doc.roundedRect(ML, y, CW, 13, 2, 2, 'F')
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(10.5)
  doc.setTextColor(255, 255, 255)
  doc.text(typeLabel, W / 2, y + 8.6, { align: 'center' })
  y += 16

  const businessName = formatBusinessName(sub.proposed_name)
  if (businessName) {
    ensure(14)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(12.5)
    doc.setTextColor(...cDark)
    doc.text(businessName, W / 2, y + 3, { align: 'center' })
    const nameW = Math.min(doc.getTextWidth(businessName) + 12, CW)
    doc.setDrawColor(...cGold)
    doc.setLineWidth(0.7)
    doc.line(W / 2 - nameW / 2, y + 5.6, W / 2 + nameW / 2, y + 5.6)
    y += 10
  }

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(6.6)
  doc.setTextColor(...cMuted)
  const dateStr = sub.created_at
    ? new Date(sub.created_at).toLocaleDateString('en-NG', { year: 'numeric', month: 'long', day: 'numeric' })
    : ''
  doc.text(`Date of Application: ${dateStr || '\u2014'}`, ML, y)
  doc.text('Status: PRE-REGISTRATION', W - ML, y, { align: 'right' })
  doc.setDrawColor(...cRule)
  doc.setLineWidth(0.2)
  doc.line(ML, y + 2, W - ML, y + 2)
  y += 6

  // ==========================================================================
  // 1. IDENTITY
  // ==========================================================================
  sectionTitle('Company / Business Identity')
  wideRow('Registration Type', typeLabel, { bold: true })
  wideRow('Proposed Name', businessName)
  if (has(sub.alt_name)) wideRow('Alternative Name', formatBusinessName(sub.alt_name))
  if (isTrustees) {
    wideRow('Nature / Objects of the Association', sub.nature_of_business)
  } else {
    wideRow('Nature of Business / Objects', sub.nature_of_business)
  }
  wideRow('Email Address', sub.email)
  wideRow('Phone Number', sub.phone)

  sectionTitle('Registered Office Address')
  wideRow('Address', sub.registered_address)
  if (has(sub.head_office_address) && clean(sub.head_office_address) !== clean(sub.registered_address)) {
    wideRow('Head Office Address', sub.head_office_address)
  }

  // ==========================================================================
  // TYPE-SPECIFIC SECTIONS
  // ==========================================================================
  if (isBusinessName) {
    sectionTitle('Business Type')
    wideRow('Type of Business', sub.business_type, { bold: true })
    if (has(sub.prop_commencement)) wideRow('Proposed Date of Commencement', sub.prop_commencement)

    const proprietor = sub.proprietor || {}
    if (formatPersonName(proprietor) || Object.keys(proprietor).some((k) => has(proprietor[k]))) {
      sectionTitle('Proprietor Details')
      person('Proprietor', null, proprietor)
    }
  }

  if (isCompany || isGte) {
    const directors = Array.isArray(sub.directors) ? sub.directors : []
    const withDirectors = directors.some((d) => d && (formatPersonName(d) || Object.keys(d).some((k) => has(d[k]))))
    if (withDirectors) {
      sectionTitle('Details of Directors')
      directors.forEach((d, i) => person('Director', i, d))
    }
  }

  if (isCompany) {
    const shareholders = Array.isArray(sub.shareholders) ? sub.shareholders : []
    const withShareholders = shareholders.some((s) => s && (formatPersonName(s) || Object.keys(s).some((k) => has(s[k]))))
    if (withShareholders) {
      sectionTitle('Details of Shareholders')
      shareholders.forEach((s, i) => person('Shareholder', i, s, { allotment: true }))
    }
  }

  if (isGte) {
    const members = Array.isArray(sub.shareholders) ? sub.shareholders : []
    const withMembers = members.some((m) => m && (formatPersonName(m) || Object.keys(m).some((k) => has(m[k]))))
    if (withMembers) {
      sectionTitle('Details of Members')
      members.forEach((m, i) => person('Member', i, m, { allotment: true }))
    }
  }

  if (isCompany) {
    const shares = sub.shares || {}
    if (has(shares.authCapital) || has(shares.issuedCapital) || has(shares.capitalWords) || has(shares.shareClass)) {
      sectionTitle('Share Capital')
      row(f('Authorized Share Capital', money(shares.authCapital)), f('Issued Share Capital', money(shares.issuedCapital)))
      if (has(shares.capitalWords)) wideRow('Issued Share Capital in Words', shares.capitalWords)
      row(f('Class of Shares', shares.shareClass), f('Nominal Value per Share', money(shares.nominalValue)))
      if (has(shares.sharesDivided)) wideRow('Divided Into', `${clean(shares.sharesDivided)} shares`)
    }

    const pscs = Array.isArray(sub.pscs) ? sub.pscs : []
    const withPsc = pscs.some((p) => p && (formatPersonName(p) || Object.keys(p).some((k) => has(p[k]))))
    if (withPsc) {
      sectionTitle('Persons with Significant Control (PSC)')
      pscs.forEach((p, i) => {
        person('PSC', i, p)
        pscInterests(p || {})
      })
    }

    const secretary = sub.secretary || {}
    if (formatPersonName(secretary) || Object.keys(secretary).some((k) => has(secretary[k]))) {
      sectionTitle('Company Secretary')
      person('Secretary', null, secretary)
    }
  }

  if (isGte) {
    const guarantee = sub.guarantee || {}
    if (has(guarantee.amount) || has(guarantee.purpose)) {
      sectionTitle('Guarantee Details')
      wideRow('Guarantee Amount', money(guarantee.amount))
      if (has(guarantee.purpose)) wideRow('Purpose of Formation', guarantee.purpose)
    }

    const secretary = sub.secretary || {}
    if (formatPersonName(secretary) || Object.keys(secretary).some((k) => has(secretary[k]))) {
      sectionTitle('Company Secretary')
      person('Secretary', null, secretary)
    }
  }

  if (isTrustees) {
    const trustees = Array.isArray(sub.trustees) ? sub.trustees : []
    const withTrustees = trustees.some((t) => t && (formatPersonName(t) || Object.keys(t).some((k) => has(t[k]))))
    if (withTrustees) {
      sectionTitle('Details of Trustees')
      trustees.forEach((t, i) => person('Trustee', i, t))
    }
  }

  // ==========================================================================
  // COMPLIANCE / ADDITIONAL / DECLARATION
  // ==========================================================================
  const compliance = sub.compliance || {}
  if (Object.keys(compliance).some((k) => has(compliance[k]))) {
    sectionTitle('Statement of Compliance / Filing Details')
    const compName = [compliance.surname, compliance.firstName, compliance.otherName].map(clean).filter(Boolean).join(' ').toUpperCase()
    if (compName) wideRow('Name of Deponent', compName, { bold: true })
    row(f('Phone', compliance.phone), f('Email', compliance.email))
    if (has(compliance.address)) wideRow('Address', compliance.address)
  }

  const additional = sub.additional || {}
  if (has(additional.restrictionReason)) {
    sectionTitle('Additional Information')
    wideRow('Reason for Restriction of Residential Address', additional.restrictionReason)
  }

  // Declaration + signature
  ensure(34)
  y += 2
  doc.setDrawColor(...cGreen)
  doc.setLineWidth(0.3)
  doc.line(ML, y, W - ML, y)
  y += 6
  doc.setFont('helvetica', 'italic')
  doc.setFontSize(7)
  doc.setTextColor(...cMuted)
  const declText =
    'I hereby certify that the information provided herein is true and correct to the best of my knowledge. ' +
    'This application is made in compliance with the requirements of the Companies and Allied Matters Act (CAMA) 2020.'
  const declLines = doc.splitTextToSize(declText, CW)
  for (let i = 0; i < declLines.length; i++) doc.text(declLines[i], ML, y + i * LINE)
  y += declLines.length * LINE + 7

  ensure(18)
  doc.setDrawColor(...cDark)
  doc.setLineWidth(0.3)
  doc.line(ML, y, ML + 62, y)
  doc.line(W / 2 + 14, y, W - ML, y)
  y += 4.5
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(6.6)
  doc.setTextColor(...cMuted)
  doc.text('Signature / Stamp of Deponent', ML, y)
  doc.text('Date', W / 2 + 14, y)
  y += 10

  // Footer on every page
  const total = doc.internal.getNumberOfPages()
  for (let i = 1; i <= total; i++) {
    doc.setPage(i)
    doc.setFillColor(...cGreen)
    doc.rect(0, H - 8, W, 8, 'F')
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(6)
    doc.setTextColor(220, 225, 235)
    doc.text(`Dreamhatcher VTU  \u2014  ${typeLabel}  \u2014  Page ${i} of ${total}`, W / 2, H - 4.4, { align: 'center' })
    doc.setDrawColor(...cRule)
    doc.setLineWidth(0.2)
    doc.rect(ML / 2, 3, W - ML, H - 6, 'S')
  }

  return doc
}

export function cacPdfFilename(sub) {
  const base = formatBusinessName(sub.proposed_name) || 'CAC_Registration'
  const safe = base.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  const type = CAC_TYPE_SHORT[clean(sub.registration_type)] || 'CAC'
  return `${safe}_CAC_${type}.pdf`
}
