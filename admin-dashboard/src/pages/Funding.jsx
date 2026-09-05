import { useState, useEffect, useCallback } from 'react'
import { api } from '../api/client'
import { useToast } from '../components/Toast'
import { Loader2, Search, X, ShieldCheck, Ban, RefreshCw, Wallet, ChevronLeft, ChevronRight, AlertTriangle, CheckCircle2, Clock, TrendingDown } from 'lucide-react'
import { fmtLagos } from '../lib/format'

const fmt = (n) => '₦' + Number(n || 0).toLocaleString('en-NG')

function methodLabel(m) {
  const v = String(m || '').toLowerCase()
  if (v.includes('transfer')) return 'Bank Transfer'
  if (v.includes('ussd')) return 'USSD'
  if (v.includes('card')) return 'Card'
  if (v.includes('bank')) return 'Bank Transfer'
  return m || 'Card'
}

function StatusPill({ status }) {
  const s = (status || '').toLowerCase()
  if (s === 'success') {
    return <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold border bg-emerald-900/50 text-emerald-300 border-emerald-700"><CheckCircle2 size={12} /> Confirmed</span>
  }
  if (s === 'failed') {
    return <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold border bg-red-900/50 text-red-300 border-red-700"><X size={12} /> Failed</span>
  }
  return <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold border bg-amber-900/50 text-amber-300 border-amber-700"><Clock size={12} /> Pending</span>
}

function SummaryCard({ icon: Icon, label, count, amount, tone }) {
  const tones = {
    amber: { chip: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300', text: 'text-amber-300' },
    green: { chip: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300', text: 'text-emerald-300' },
    red: { chip: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300', text: 'text-red-300' },
  }
  const t = tones[tone] || tones.amber
  return (
    <div className="bg-slate-800 border-2 border-slate-700 rounded-xl p-5 shadow-sm">
      <div className="flex items-start justify-between mb-3">
        <div className={`p-2.5 rounded-xl ${t.chip}`}><Icon size={20} /></div>
      </div>
      <p className="text-2xl font-extrabold text-slate-100 tabular-nums">{count}</p>
      <p className="text-sm font-semibold text-slate-300 mt-1">{label}</p>
      <p className={`text-sm font-bold tabular-nums mt-1 ${t.text}`}>{amount}</p>
    </div>
  )
}

function CancelModal({ payment, onClose, onConfirm }) {
  const [reason, setReason] = useState('')
  const [loading, setLoading] = useState(false)
  const toast = useToast()

  if (!payment) return null

  const submit = async () => {
    if (!reason.trim()) return toast.error('A reason is required to close a payment')
    setLoading(true)
    try {
      await onConfirm(reason.trim())
      onClose()
      setReason('')
    } catch (err) {
      toast.error(err.response?.data?.message || err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" />
      <div className="relative w-full max-w-md bg-slate-800 border border-slate-700 rounded-2xl shadow-2xl p-6 toast-enter" onClick={e => e.stopPropagation()}>
        <button onClick={onClose} className="absolute top-4 right-4 text-slate-400 hover:text-slate-200"><X size={18} /></button>
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 rounded-lg bg-red-900/50"><Ban size={20} className="text-red-400" /></div>
          <h3 className="text-lg font-semibold text-slate-100">Close Pending Funding</h3>
        </div>
        <p className="text-sm text-slate-400 mb-5 whitespace-pre-line">
          Mark <span className="text-slate-100 font-mono font-medium">{payment.reference}</span> as failed
          ({fmt(payment.amount)})? This should only be used for abandoned checkouts that Squad
          confirms were never charged — it does <span className="text-slate-200 font-semibold">not</span> refund any money.
        </p>
        <div>
          <label className="block text-sm text-slate-400 mb-1">Reason <span className="text-red-400">*</span></label>
          <input
            type="text"
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="e.g. Customer never completed payment"
            className="input"
            autoFocus
          />
        </div>
        <div className="flex gap-3 justify-end mt-6">
          <button onClick={onClose} className="btn-secondary" disabled={loading}>Cancel</button>
          <button onClick={submit} disabled={loading} className="btn-danger">
            {loading ? 'Processing…' : 'Close Payment'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function Funding() {
  const toast = useToast()
  const [rows, setRows] = useState([])
  const [stats, setStats] = useState(null)
  const [pagination, setPagination] = useState({ page: 1, limit: 25, total: 0, totalPages: 1 })
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState('pending')
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [verifying, setVerifying] = useState(null)
  const [cancelPayment, setCancelPayment] = useState(null)

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 400)
    return () => clearTimeout(t)
  }, [search])

  const fetchPayments = useCallback(async (page = 1) => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ page, limit: 25 })
      if (statusFilter) params.set('status', statusFilter)
      if (debouncedSearch) params.set('search', debouncedSearch)
      const res = await api.get(`/admin/payments?${params}`)
      setRows(res.data.data || [])
      setPagination(res.data.pagination || { page, limit: 25, total: 0, totalPages: 1 })
      setStats(res.data.stats || null)
    } catch (err) {
      toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }, [statusFilter, debouncedSearch, toast])

  useEffect(() => { fetchPayments(1) }, [statusFilter, debouncedSearch, fetchPayments])

  // Auto-refresh so webhook confirmations surface without a manual reload.
  useEffect(() => {
    const timer = setInterval(() => fetchPayments(pagination.page), 20_000)
    return () => clearInterval(timer)
  }, [fetchPayments, pagination.page])

  const handleVerify = async (p) => {
    setVerifying(p.id)
    try {
      const res = await api.post('/admin/payments/verify', { reference: p.reference })
      if (res.data?.verified) {
        toast.success(`Payment confirmed — ₦${Number(p.amount).toLocaleString()} credited`)
      } else {
        toast.info(res.data?.message || 'Payment could not be verified')
      }
      fetchPayments(pagination.page)
    } catch (err) {
      toast.error(err.response?.data?.message || err.message)
    } finally {
      setVerifying(null)
    }
  }

  const handleCancel = async (reason) => {
    const p = cancelPayment
    const res = await api.post('/admin/payments/cancel', { reference: p.reference, reason })
    toast.success(res.data?.message || 'Payment closed')
    fetchPayments(pagination.page)
  }

  const s = stats || {}
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-100">Wallet Funding</h1>
        <p className="text-sm text-slate-400 mt-1">Squad top-up payments — confirm or close unconfirmed funding</p>
      </div>

      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-medium text-slate-500">{pagination.total} payment(s) total</span>
        </div>
        <button onClick={() => fetchPayments(pagination.page)} className="btn-secondary" disabled={loading}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {stats && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <SummaryCard icon={Clock} label="Pending — needs review" count={Number(s.pending?.count || 0).toLocaleString()} amount={fmt(s.pending?.amount)} tone="amber" />
          <SummaryCard icon={CheckCircle2} label="Confirmed (credited)" count={Number(s.success?.count || 0).toLocaleString()} amount={fmt(s.success?.amount)} tone="green" />
          <SummaryCard icon={TrendingDown} label="Failed / Closed" count={Number(s.failed?.count || 0).toLocaleString()} amount={fmt(s.failed?.amount)} tone="red" />
        </div>
      )}

      {Number(s.pending?.count || 0) > 0 && (
        <div className="flex items-start gap-3 px-4 py-3 rounded-lg border-2 border-amber-700 bg-amber-900/20">
          <AlertTriangle size={18} className="text-amber-400 shrink-0 mt-0.5" />
          <p className="text-sm text-amber-200">
            {s.pending.count} pending payment(s) worth {fmt(s.pending.amount)} have not been confirmed by the Squad webhook.
            Use <span className="font-semibold">Verify</span> to check Squad and credit the wallet if the charge succeeded, or{' '}
            <span className="font-semibold">Close</span> abandoned checkouts. The wallet is only ever credited when Squad confirms the charge.
          </p>
        </div>
      )}

      <div className="flex flex-col sm:flex-row gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[220px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by user or reference…"
            className="input pl-9 pr-8"
          />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300" title="Clear search">
              <X size={14} />
            </button>
          )}
        </div>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="input pr-8 appearance-none cursor-pointer max-w-[200px]">
          <option value="">All Statuses</option>
          <option value="pending">Pending</option>
          <option value="success">Confirmed</option>
          <option value="failed">Failed</option>
        </select>
      </div>

      <div className="card overflow-hidden !p-0 bg-slate-800 border-2 border-slate-700">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b-2 border-slate-700 bg-slate-700/50 text-left text-slate-300 text-xs uppercase tracking-wider">
                <th className="px-4 py-2.5 font-bold">User</th>
                <th className="px-4 py-2.5 font-bold">Reference</th>
                <th className="px-4 py-2.5 font-bold">Method</th>
                <th className="px-4 py-2.5 text-right font-bold">Amount</th>
                <th className="px-4 py-2.5 font-bold">Status</th>
                <th className="px-4 py-2.5 font-bold">Date</th>
                <th className="px-4 py-2.5 text-right font-bold">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-12 text-center text-slate-400">
                  <Loader2 size={20} className="animate-spin mx-auto mb-2 text-brand-400" /> Loading…
                </td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-12 text-center text-slate-400">
                  <Wallet size={26} className="mx-auto mb-2 text-slate-500" /> No payments found
                </td></tr>
              ) : (
                rows.map(p => (
                  <tr key={p.id} className="table-row">
                    <td className="px-4 py-2.5">
                      <div className="min-w-0">
                        <p className="text-slate-300 text-xs font-medium truncate max-w-[160px]">{p.profiles?.full_name || p.user_id?.slice(0, 8) || '—'}</p>
                        <p className="text-xs text-slate-400 truncate max-w-[200px]">{p.profiles?.email || ''}</p>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-slate-300 font-mono truncate max-w-[150px]">{p.reference || '—'}</td>
                    <td className="px-4 py-2.5 text-xs text-slate-300 whitespace-nowrap">{methodLabel(p.payment_method)}</td>
                    <td className="px-4 py-2.5 text-right font-mono font-bold text-slate-100 whitespace-nowrap">{fmt(p.amount)}</td>
                    <td className="px-4 py-2.5"><StatusPill status={p.status} /></td>
                    <td className="px-4 py-2.5 text-xs text-slate-300 whitespace-nowrap">{fmtLagos(p.created_at)}</td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap">
                      {p.status === 'pending' ? (
                        <div className="flex gap-2 justify-end">
                          <button
                            onClick={() => handleVerify(p)}
                            disabled={verifying === p.id}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-sky-900/50 hover:bg-sky-800/50 text-sky-300 border border-sky-700 transition-all"
                            title="Check Squad — credit wallet only if the charge succeeded"
                          >
                            <ShieldCheck size={12} />
                            {verifying === p.id ? 'Checking…' : 'Verify'}
                          </button>
                          <button
                            onClick={() => setCancelPayment(p)}
                            disabled={verifying === p.id}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-red-900/50 hover:bg-red-800/50 text-red-300 border border-red-700 transition-all"
                            title="Mark as failed — abandoned / unconfirmed checkout"
                          >
                            <Ban size={12} /> Close
                          </button>
                        </div>
                      ) : (
                        <span className="text-xs text-slate-500">—</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {pagination.totalPages > 1 && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-slate-700">
            <p className="text-xs text-slate-400">
              Page {pagination.page} of {pagination.totalPages} ({pagination.total} total)
            </p>
            <div className="flex gap-2">
              <button onClick={() => fetchPayments(pagination.page - 1)} disabled={pagination.page <= 1} className="btn-secondary !px-2.5 !py-1.5">
                <ChevronLeft size={14} />
              </button>
              <button onClick={() => fetchPayments(pagination.page + 1)} disabled={pagination.page >= pagination.totalPages} className="btn-secondary !px-2.5 !py-1.5">
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
        )}
      </div>

      <CancelModal key={cancelPayment?.id || 'none'} payment={cancelPayment} onClose={() => setCancelPayment(null)} onConfirm={handleCancel} />
    </div>
  )
}
