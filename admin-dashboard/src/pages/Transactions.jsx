import { useState, useEffect, useCallback } from 'react'
import { api } from '../api/client'
import { useToast } from '../components/Toast'
import ConfirmModal from '../components/ConfirmModal'
import { ChevronLeft, ChevronRight, Loader2, RotateCcw, Filter } from 'lucide-react'

const statusBadge = (status) => {
  const s = (status || '').toLowerCase()
  if (s === 'successful') return <span className="badge-success">Successful</span>
  if (s === 'failed')     return <span className="badge-failed">Failed</span>
  if (s === 'refunded')   return <span className="badge-refunded">Refunded</span>
  return <span className="badge-pending">{status || '—'}</span>
}

export default function Transactions() {
  const [txns, setTxns] = useState([])
  const [pagination, setPagination] = useState({ page: 1, limit: 25, total: 0, totalPages: 1 })
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState('')
  const [typeFilter, setTypeFilter] = useState('')

  // Refund state
  const [refundTx, setRefundTx] = useState(null)
  const [refundReason, setRefundReason] = useState('')
  const [refundLoading, setRefundLoading] = useState(false)

  const toast = useToast()

  const fetchTxns = useCallback(async (page = 1) => {
    setLoading(true)
    try {
      const res = await api.getTransactions(page, 25, { status: statusFilter, service_type: typeFilter })
      setTxns(res.data || [])
      setPagination(res.pagination)
    } catch (err) {
      toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }, [statusFilter, typeFilter])

  useEffect(() => { fetchTxns(1) }, [statusFilter, typeFilter])

  const handleRefund = async () => {
    if (!refundTx) return
    if (!refundReason.trim()) return toast.error('Please provide a refund reason')

    setRefundLoading(true)
    try {
      await api.refundTransaction(refundTx.id, refundReason.trim())
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

  const fmtDate = (d) => {
    if (!d) return '—'
    return new Date(d).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-100">Transactions</h1>
        <p className="text-sm text-gray-500 mt-1">{pagination.total} total records</p>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative">
          <Filter size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
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

      <div className="card overflow-hidden !p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-left text-gray-500 text-xs uppercase tracking-wider">
                <th className="px-5 py-3">Service</th>
                <th className="px-5 py-3">User</th>
                <th className="px-5 py-3 text-right">Amount</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3">Reference</th>
                <th className="px-5 py-3">Date</th>
                <th className="px-5 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} className="px-5 py-12 text-center text-gray-500">
                  <Loader2 size={20} className="animate-spin mx-auto mb-2 text-brand-400" /> Loading…
                </td></tr>
              ) : txns.length === 0 ? (
                <tr><td colSpan={7} className="px-5 py-12 text-center text-gray-500">No transactions found</td></tr>
              ) : (
                txns.map(tx => (
                  <tr key={tx.id} className="table-row">
                    <td className="px-5 py-3">
                      <div>
                        <p className="font-medium text-gray-200 capitalize">{tx.service_type || '—'}</p>
                        <p className="text-xs text-gray-500 truncate max-w-[150px]">{tx.title}</p>
                        {tx.provider && (
                          <span className={`text-[10px] uppercase tracking-wide font-medium ${tx.provider === 'alrahuz' ? 'text-purple-400' : 'text-brand-400'}`}>
                            {tx.provider}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-5 py-3">
                      <p className="text-gray-300 text-xs">{tx.profiles?.full_name || tx.user_id?.slice(0, 8) || '—'}</p>
                      <p className="text-xs text-gray-600 truncate max-w-[120px]">{tx.profiles?.email}</p>
                    </td>
                    <td className="px-5 py-3 text-right font-mono text-gray-200">
                      ₦{Number(tx.amount || 0).toLocaleString()}
                    </td>
                    <td className="px-5 py-3">{statusBadge(tx.status)}</td>
                    <td className="px-5 py-3 text-xs text-gray-500 font-mono truncate max-w-[130px]">{tx.reference || '—'}</td>
                    <td className="px-5 py-3 text-xs text-gray-500 whitespace-nowrap">{fmtDate(tx.created_at)}</td>
                    <td className="px-5 py-3 text-right">
                      {(tx.status === 'successful' || tx.status === 'failed') && tx.service_type !== 'funding' && tx.service_type !== 'admin_adjust' && tx.service_type !== 'refund' ? (
                        <button
                          onClick={() => { setRefundTx(tx); setRefundReason('') }}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 transition-all"
                        >
                          <RotateCcw size={12} /> Refund
                        </button>
                      ) : tx.status === 'refunded' ? (
                        <span className="text-xs text-gray-600">—</span>
                      ) : null}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {pagination.totalPages > 1 && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-gray-800">
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

      {/* Refund confirmation */}
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
