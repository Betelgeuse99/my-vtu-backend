import { useState, useEffect, useCallback } from 'react'
import { api } from '../api/client'
import { useToast } from '../components/Toast'
import { Search, ChevronLeft, ChevronRight, Loader2, DollarSign, Shield, History, X, AlertTriangle, TrendingUp, TrendingDown } from 'lucide-react'
import { fmtLagos } from '../lib/format'

const fmt = (n) => '₦' + Number(n || 0).toLocaleString('en-NG')

function LedgerModal({ user, onClose }) {
  const [ledger, setLedger] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [page, setPage] = useState(1)
  const [pagination, setPagination] = useState({ page: 1, limit: 50, total: 0, totalPages: 1 })
  const toast = useToast()

  const fetchLedger = useCallback(async (p = 1) => {
    setLoading(true)
    setError(null)
    try {
      const res = await api.get(`/admin/users/ledger?user_id=${user.id}&page=${p}&limit=50`)
      setLedger(res.data)
      setPagination(res.data.pagination || { page: p, limit: 50, total: 0, totalPages: 1 })
    } catch (err) {
      setError(err.message)
      toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }, [user.id, toast])

  useEffect(() => { if (user) fetchLedger(1) }, [user, fetchLedger])

  if (!user) return null

  const summary = ledger?.summary
  const walletBalance = ledger?.wallet_balance
  const rows = ledger?.data || []

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" />
      <div className="relative w-full max-w-3xl max-h-[90vh] flex flex-col bg-slate-800 border border-slate-700 rounded-2xl shadow-2xl toast-enter" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-start justify-between gap-4 px-6 py-4 border-b border-slate-700">
          <div className="min-w-0">
            <h3 className="text-lg font-semibold text-slate-100 truncate">{user.full_name || 'User'}</h3>
            <p className="text-sm text-slate-400 truncate">{user.email}{user.phone_number ? ` · ${user.phone_number}` : ''}</p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <div className="text-right">
              <p className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold">Wallet Balance</p>
              <p className="text-lg font-extrabold text-slate-100 font-mono tabular-nums">{walletBalance === null || walletBalance === undefined ? '—' : fmt(walletBalance)}</p>
            </div>
            <button onClick={onClose} className="p-2 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-700" title="Close">
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Lifetime summary */}
        <div className="px-6 py-3 border-b border-slate-700 bg-slate-700/30 grid grid-cols-2 gap-3">
          <div className="flex items-center gap-2 text-sm">
            <TrendingUp size={15} className="text-emerald-400 shrink-0" />
            <span className="text-slate-400">Lifetime credited:</span>
            <span className="font-bold text-emerald-300 font-mono tabular-nums ml-auto">{summary ? fmt(summary.credited) : '—'}</span>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <TrendingDown size={15} className="text-red-400 shrink-0" />
            <span className="text-slate-400">Lifetime debited:</span>
            <span className="font-bold text-red-300 font-mono tabular-nums ml-auto">{summary ? fmt(summary.debited) : '—'}</span>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {ledger?.ledger_error && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-amber-700 bg-amber-900/20 text-xs text-amber-200 mb-3">
              <AlertTriangle size={14} className="shrink-0 mt-0.5" />
              <span>Wallet audit trail is not available on this database: {ledger.ledger_error}</span>
            </div>
          )}
          {error && !ledger?.ledger_error && (
            <div className="px-3 py-2 rounded-lg border border-red-700 bg-red-900/20 text-xs text-red-300 mb-3">{error}</div>
          )}

          {loading && rows.length === 0 ? (
            <div className="text-center py-14 text-slate-400 text-sm"><Loader2 size={20} className="animate-spin mx-auto mb-2 text-brand-400" /> Loading ledger…</div>
          ) : rows.length === 0 && !ledger?.ledger_error ? (
            <div className="text-center py-14 text-slate-400 text-sm">
              <History size={26} className="mx-auto mb-2 text-slate-500" />
              No wallet transactions yet for this user.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-700 text-left text-slate-400 text-xs uppercase tracking-wider">
                    <th className="px-3 py-2 font-bold">Type</th>
                    <th className="px-3 py-2 text-right font-bold">Amount</th>
                    <th className="px-3 py-2 text-right font-bold">Balance After</th>
                    <th className="px-3 py-2 font-bold">Description</th>
                    <th className="px-3 py-2 font-bold">Reference</th>
                    <th className="px-3 py-2 font-bold">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(t => (
                    <tr key={t.id} className="border-b border-slate-800/60">
                      <td className="px-3 py-2.5">
                        {t.type === 'credit' ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-emerald-900/50 text-emerald-300 border border-emerald-700"><TrendingUp size={11} /> CREDIT</span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-red-900/50 text-red-300 border border-red-700"><TrendingDown size={11} /> DEBIT</span>
                        )}
                      </td>
                      <td className={`px-3 py-2.5 text-right font-mono font-bold tabular-nums ${t.type === 'credit' ? 'text-emerald-300' : 'text-red-300'}`}>
                        {t.type === 'credit' ? '+' : '−'}{fmt(t.amount)}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-slate-300 tabular-nums">{fmt(t.balance_after)}</td>
                      <td className="px-3 py-2.5 text-xs text-slate-300 max-w-[260px]"><span className="break-words">{t.description || '—'}</span></td>
                      <td className="px-3 py-2.5 text-xs text-slate-400 font-mono truncate max-w-[140px]">{t.payment_reference || '—'}</td>
                      <td className="px-3 py-2.5 text-xs text-slate-400 whitespace-nowrap">{fmtLagos(t.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Footer pagination */}
        <div className="flex items-center justify-between px-6 py-3 border-t border-slate-700">
          <p className="text-xs text-slate-500">
            {pagination.total > 0 ? `Page ${pagination.page} of ${pagination.totalPages} · ${pagination.total} total` : 'No records'}
          </p>
          {pagination.totalPages > 1 && (
            <div className="flex gap-2">
              <button onClick={() => { setPage(page - 1); fetchLedger(page - 1) }} disabled={page <= 1} className="btn-secondary !px-2.5 !py-1.5"><ChevronLeft size={14} /></button>
              <button onClick={() => { setPage(page + 1); fetchLedger(page + 1) }} disabled={page >= pagination.totalPages} className="btn-secondary !px-2.5 !py-1.5"><ChevronRight size={14} /></button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function WalletAdjustModal({ open, user, onClose, onSuccess }) {
  const [action, setAction] = useState('credit')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [loading, setLoading] = useState(false)
  const toast = useToast()

  const handleSubmit = async () => {
    if (!amount || Number(amount) <= 0) return toast.error('Enter a valid amount')
    if (!reason.trim()) return toast.error('A reason is required for wallet adjustments')

    setLoading(true)
    try {
      await api.post('/admin/wallet/adjust', { target_user_id: user.id, amount: Number(amount), action, reason: reason.trim() })
      toast.success(`₦${Number(amount).toLocaleString()} ${action === 'credit' ? 'credited to' : 'debited from'} ${user.full_name || user.email}`)
      onSuccess()
      onClose()
      setAmount('')
      setReason('')
    } catch (err) {
      toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }

  if (!open || !user) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" />
      <div className="relative w-full max-w-md bg-slate-800 border border-slate-700 rounded-2xl shadow-2xl p-6 toast-enter" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-slate-100 mb-1">Adjust Wallet Balance</h3>
        <p className="text-sm text-slate-400 mb-5">
          {user.full_name || 'User'} — {user.email}
          <br />
          Current balance: <span className="text-slate-100 font-medium">₦{Number(user.wallet_balance || 0).toLocaleString()}</span>
        </p>

        {/* Action toggle */}
        <div className="flex gap-2 mb-4">
          {['credit', 'debit'].map(a => (
            <button
              key={a}
              onClick={() => setAction(a)}
              className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all border ${
                action === a
                  ? a === 'credit'
                    ? 'bg-emerald-50 text-emerald-600 border-emerald-200'
                    : 'bg-red-50 text-red-600 border-red-200'
                  : 'bg-slate-700 text-slate-400 border-slate-600 hover:text-slate-200'
              }`}
            >
              {a === 'credit' ? '+ Credit' : '− Debit'}
            </button>
          ))}
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-sm text-slate-400 mb-1">Amount (₦)</label>
            <input
              type="number"
              min="1"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              placeholder="0"
              className="input"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-sm text-slate-400 mb-1">Reason <span className="text-red-400">*</span></label>
            <input
              type="text"
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder="e.g. Manual correction, bonus credit"
              className="input"
            />
          </div>
        </div>

        <div className="flex gap-3 justify-end mt-6">
          <button onClick={onClose} className="btn-secondary" disabled={loading}>Cancel</button>
          <button onClick={handleSubmit} disabled={loading} className={action === 'credit' ? 'btn-success' : 'btn-danger'}>
            {loading ? 'Processing…' : `Confirm ${action === 'credit' ? 'Credit' : 'Debit'}`}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function Users() {
  const [users, setUsers] = useState([])
  const [pagination, setPagination] = useState({ page: 1, limit: 20, total: 0, totalPages: 1 })
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [adjustUser, setAdjustUser] = useState(null)
  const [ledgerUser, setLedgerUser] = useState(null)
  const toast = useToast()

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 400)
    return () => clearTimeout(t)
  }, [search])

  const fetchUsers = useCallback(async (page = 1) => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ page, limit: 20 })
      if (debouncedSearch) params.set('search', debouncedSearch)
      const res = await api.get(`/admin/users?${params}`)
      setUsers((res.data.data || []).sort((a, b) => (b.is_admin ? 1 : 0) - (a.is_admin ? 1 : 0)))
      setPagination(res.data.pagination)
    } catch (err) {
      toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }, [debouncedSearch])

  useEffect(() => { fetchUsers(1) }, [debouncedSearch])

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">Users</h1>
          <p className="text-sm text-slate-400 mt-1">{pagination.total} registered users</p>
        </div>
        <div className="relative w-full sm:w-80">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by name, email, or phone…"
            className="input pl-9"
          />
        </div>
      </div>

      <div className="card overflow-hidden !p-0 bg-slate-800 border-2 border-slate-700">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b-2 border-slate-700 bg-slate-700/50 text-left text-slate-300 text-xs uppercase tracking-wider">
                <th className="px-5 py-3 font-bold">User</th>
                <th className="px-5 py-3 font-bold">Phone</th>
                <th className="px-5 py-3 text-right font-bold">Balance</th>
                <th className="px-5 py-3 font-bold">Role</th>
                <th className="px-5 py-3 text-right font-bold">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={5} className="px-5 py-12 text-center text-slate-400">
                  <Loader2 size={20} className="animate-spin mx-auto mb-2 text-brand-400" /> Loading…
                </td></tr>
              ) : users.length === 0 ? (
                <tr><td colSpan={5} className="px-5 py-12 text-center text-slate-400">No users found</td></tr>
              ) : (
                users.map(u => (
                  <tr key={u.id} className="table-row">
                    <td className="px-5 py-3">
                      <div>
                        <p className="font-bold text-slate-100">{u.full_name || '—'}</p>
                        <p className="text-xs text-slate-400 truncate max-w-[200px]">{u.email}</p>
                      </div>
                    </td>
                    <td className="px-5 py-3 text-slate-300">{u.phone_number || '—'}</td>
                    <td className="px-5 py-3 text-right font-mono font-bold text-slate-100">
                      ₦{Number(u.wallet_balance || 0).toLocaleString()}
                    </td>
                    <td className="px-5 py-3">
                      {u.is_admin ? (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-400">
                          <Shield size={12} /> Admin
                        </span>
                      ) : (
                        <span className="text-xs text-slate-300">User</span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <div className="flex gap-2 justify-end">
                        <button
                          onClick={() => setLedgerUser(u)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-700 hover:bg-slate-600 text-slate-300 border border-slate-600 transition-all"
                          title="View wallet credit/debit history"
                        >
                          <History size={13} /> Ledger
                        </button>
                        <button
                          onClick={() => setAdjustUser(u)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-700 hover:bg-slate-600 text-slate-300 border border-slate-600 transition-all"
                        >
                          <DollarSign size={13} /> Adjust
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {pagination.totalPages > 1 && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-slate-700">
            <p className="text-xs text-slate-400">
              Page {pagination.page} of {pagination.totalPages} ({pagination.total} total)
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => fetchUsers(pagination.page - 1)}
                disabled={pagination.page <= 1}
                className="btn-secondary !px-2.5 !py-1.5"
              >
                <ChevronLeft size={14} />
              </button>
              <button
                onClick={() => fetchUsers(pagination.page + 1)}
                disabled={pagination.page >= pagination.totalPages}
                className="btn-secondary !px-2.5 !py-1.5"
              >
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
        )}
      </div>

      <WalletAdjustModal
        open={!!adjustUser}
        user={adjustUser}
        onClose={() => setAdjustUser(null)}
        onSuccess={() => fetchUsers(pagination.page)}
      />

      <LedgerModal
        user={ledgerUser}
        onClose={() => setLedgerUser(null)}
      />
    </div>
  )
}
