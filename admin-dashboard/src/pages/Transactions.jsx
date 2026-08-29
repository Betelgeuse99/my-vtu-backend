import { useState, useEffect, useCallback } from 'react'
import { api } from '../api/client'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../components/Toast'
import ConfirmModal from '../components/ConfirmModal'
import CarrierBadge from '../components/CarrierBadge'
import { ChevronLeft, ChevronRight, Loader2, RotateCcw, Filter, Search, X, ShieldCheck } from 'lucide-react'
import { fmtLagos } from '../lib/format'

const statusBadge = (status) => {
  const s = (status || '').toLowerCase()
  if (s === 'successful') return <span className="badge-success">Successful</span>
  if (s === 'failed')     return <span className="badge-failed">Failed</span>
  if (s === 'refunded')   return <span className="badge-refunded">Refunded</span>
  return <span className="badge-pending">{status || '—'}</span>
}

export default function Transactions() {
  const { session } = useAuth()
  const [txns, setTxns] = useState([])
  const [pagination, setPagination] = useState({ page: 1, limit: 25, total: 0, totalPages: 1 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [statusFilter, setStatusFilter] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')

  const [refundTx, setRefundTx] = useState(null)
  const [refundReason, setRefundReason] = useState('')
  const [refundLoading, setRefundLoading] = useState(false)
  const [reconciling, setReconciling] = useState(null)

  const toast = useToast()

  const fetchTxns = useCallback(async (page = 1) => {
    if (!session) return
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ page, limit: 25 })
      if (statusFilter) params.set('status', statusFilter)
      if (typeFilter) params.set('service_type', typeFilter)
      if (debouncedSearch) params.set('search', debouncedSearch)
      const res = await api.get(`/api/v2/admin/transactions?${params}`)
      setTxns(res.data.data || [])
      setPagination(res.data.pagination)
    } catch (err) {
      setError(err.message)
      if (toast) toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }, [session, statusFilter, typeFilter, debouncedSearch, toast])

  useEffect(() => {
    if (session) fetchTxns(1)
  }, [session, fetchTxns])

  useEffect(() => {
    if (!session) return
    const timer = setInterval(() => fetchTxns(pagination.page), 20_000)
    return () => clearInterval(timer)
  }, [session, fetchTxns, pagination.page])

  // Debounce the search input so we don't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 400)
    return () => clearTimeout(t)
  }, [search])

  useEffect(() => {
    if (session) fetchTxns(1)
  }, [statusFilter, typeFilter, debouncedSearch])

  const handleRefund = async () => {
    if (!refundTx) return
    if (!refundReason.trim()) return toast.error('Please provide a refund reason')

    setRefundLoading(true)
    try {
      await api.post('/api/v2/admin/transactions/refund', { transaction_id: refundTx.id, reason: refundReason.trim() })
      toast.success(`Refund of ₦${Number(refundTx.amount).toLocaleString()} processed`)
      setRefundTx(null)
      setRefundReason('')
      fetchTxns(pagination.page)
    } catch (err) {
      toast.error(err.message)
    } finally {
      setRefundLoading(false)
    }
  }

  const fmtDate = (d) => fmtLagos(d)

  const handleReconcile = async (tx) => {
    setReconciling(tx.id)
    try {
      const res = await api.post('/api/v2/admin/transactions/reconcile', { transaction_id: tx.id })
      if (toast) toast.success(res.data?.message || 'Reconciled')
      fetchTxns(pagination.page)
    } catch (err) {
      if (toast) toast.error(err.response?.data?.message || err.message)
    } finally {
      setReconciling(null)
    }
  }

  if (loading && txns.length === 0) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 size={28} className="animate-spin text-brand-500" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Transactions</h1>
        <p className="text-sm text-gray-600 mt-1">{pagination.total} total records</p>
      </div>

      <div className="flex flex-col sm:flex-row gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[220px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by email or phone number…"
            className="input pl-9 pr-8"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors"
              title="Clear search"
            >
              <X size={14} />
            </button>
          )}
        </div>
        <div className="relative">
          <Filter size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            className="input pl-9 pr-8 appearance-none cursor-pointer"
          >
            <option value="">All Statuses</option>
            <option value="successful">Successful</option>
            <option value="failed">Failed</option>
            <option value="refunded">Refunded</option>
          </select>
        </div>
        <select
          value={typeFilter}
          onChange={e => setTypeFilter(e.target.value)}
          className="input pr-8 appearance-none cursor-pointer max-w-[200px]"
        >
          <option value="">All Types</option>
          <option value="airtime">Airtime</option>
          <option value="data">Data</option>
          <option value="cable">Cable</option>
          <option value="electricity">Electricity</option>
          <option value="funding">Funding</option>
          <option value="admin_adjust">Admin Adjust</option>
          <option value="refund">Refund</option>
          <option value="recharge_pin">Recharge PIN</option>
          <option value="exam_pin">Exam PIN</option>
        </select>
      </div>

      {error && (
        <div className="px-4 py-3 rounded-lg border border-red-200 bg-red-50 text-sm text-red-600">
          {error}
        </div>
      )}

      <div className="card overflow-hidden !p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b-2 border-gray-300 bg-gray-50 text-left text-gray-700 text-xs uppercase tracking-wider">
                <th className="px-3 py-2.5 font-bold">Service</th>
                <th className="px-3 py-2.5 font-bold">User</th>
                <th className="px-3 py-2.5 font-bold">Phone</th>
                <th className="px-3 py-2.5 text-right font-bold">Amount</th>
                <th className="px-3 py-2.5 font-bold">Status</th>
                <th className="px-3 py-2.5 font-bold">Reference</th>
                <th className="px-3 py-2.5 font-bold">Date</th>
                <th className="px-3 py-2.5 text-right font-bold">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading && txns.length === 0 ? (
                <tr><td colSpan={8} className="px-3 py-12 text-center text-gray-500">
                  <Loader2 size={20} className="animate-spin mx-auto mb-2 text-brand-500" /> Loading…
                </td></tr>
              ) : txns.length === 0 ? (
                <tr><td colSpan={8} className="px-3 py-12 text-center text-gray-500">No transactions found</td></tr>
              ) : (
                txns.map(tx => (
                  <tr key={tx.id} className="table-row">
                    <td className="px-3 py-2.5">
                      <div className="min-w-0">
                        <p className="font-bold text-gray-900 capitalize">{tx.service_type || '—'}</p>
                        <p className="text-xs text-gray-600 truncate max-w-[130px]">{tx.title}</p>
                        <div className="mt-0.5"><CarrierBadge provider={tx.provider} /></div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="min-w-0">
                        <p className="text-gray-700 text-xs truncate max-w-[150px]">{tx.profiles?.full_name || tx.user_id?.slice(0, 8) || '—'}</p>
                        <p className="text-xs text-gray-400 truncate max-w-[210px]">{tx.profiles?.email || ''}</p>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-gray-600 whitespace-nowrap">{tx.recipient || '—'}</td>
                    <td className="px-3 py-2.5 text-right font-mono font-bold text-gray-900 whitespace-nowrap">
                      ₦{Number(tx.amount || 0).toLocaleString()}
                    </td>
                    <td className="px-3 py-2.5">{statusBadge(tx.status)}</td>
                    <td className="px-3 py-2.5 text-xs text-gray-500 font-mono truncate max-w-[120px]">{tx.reference || '—'}</td>
                    <td className="px-3 py-2.5 text-xs text-gray-500 whitespace-nowrap">{fmtDate(tx.created_at)}</td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap">
                      {tx.status === 'pending' ? (
                        <button
                          onClick={() => handleReconcile(tx)}
                          disabled={reconciling === tx.id}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-sky-50 hover:bg-sky-100 text-sky-600 border border-sky-200 transition-all"
                          title="Verify against provider — refunds only if delivery is disproven"
                        >
                          <ShieldCheck size={12} />
                          {reconciling === tx.id ? 'Checking…' : 'Verify'}
                        </button>
                      ) : (tx.status === 'successful' || tx.status === 'failed') && tx.service_type !== 'funding' && tx.service_type !== 'admin_adjust' && tx.service_type !== 'refund' ? (
                        <button
                          onClick={() => { setRefundTx(tx); setRefundReason('') }}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 transition-all"
                        >
                          <RotateCcw size={12} /> Refund
                        </button>
                      ) : tx.status === 'refunded' ? (
                        <span className="text-xs text-gray-400">—</span>
                      ) : null}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {pagination.totalPages > 1 && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-gray-200">
            <p className="text-xs text-gray-500">
              Page {pagination.page} of {pagination.totalPages} ({pagination.total} total)
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => fetchTxns(pagination.page - 1)}
                disabled={pagination.page <= 1}
                className="btn-secondary !px-2.5 !py-1.5"
              >
                <ChevronLeft size={14} />
              </button>
              <button
                onClick={() => fetchTxns(pagination.page + 1)}
                disabled={pagination.page >= pagination.totalPages}
                className="btn-secondary !px-2.5 !py-1.5"
              >
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
        )}
      </div>

      <ConfirmModal
        open={!!refundTx}
        title="Process Refund"
        danger
        confirmLabel="Process Refund"
        loading={refundLoading}
        onConfirm={handleRefund}
        onCancel={() => { setRefundTx(null); setRefundReason('') }}
        message={
          refundTx ? (
            <>
              Refund ₦{Number(refundTx.amount).toLocaleString()} to user {refundTx.profiles?.full_name || refundTx.user_id?.slice(0, 8)}?
              {'\n\n'}
              <input
                type="text"
                value={refundReason}
                onChange={e => setRefundReason(e.target.value)}
                placeholder="Reason for refund (required)"
                className="input mt-3"
                autoFocus
              />
            </>
          ) : ''
        }
      />
    </div>
  )
}
