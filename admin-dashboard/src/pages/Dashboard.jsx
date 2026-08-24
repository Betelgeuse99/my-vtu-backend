import { useState, useEffect, useCallback, useRef } from 'react'
import { api } from '../api/client'
import { useToast } from '../components/Toast'
import { Wallet, Users, ArrowLeftRight, TrendingDown, Loader2, RefreshCw, Zap, Wifi, Tv, Lightbulb, GraduationCap, AlertTriangle } from 'lucide-react'

const serviceIcons = {
  airtime: Zap,
  data: Wifi,
  cable: Tv,
  electricity: Lightbulb,
  epin: GraduationCap,
}

const serviceLabels = {
  airtime: 'Airtime',
  data: 'Data',
  cable: 'Cable TV',
  electricity: 'Electricity',
  epin: 'Exam PINs',
}

function StatCard({ icon: Icon, label, value, color, sub }) {
  return (
    <div className="card group hover:border-gray-700 transition-all">
      <div className="flex items-start justify-between mb-3">
        <div className={`p-2.5 rounded-xl ${color}`}>
          <Icon size={20} />
        </div>
      </div>
      <p className="text-2xl font-bold text-gray-100 tabular-nums">{value}</p>
      <p className="text-sm text-gray-500 mt-0.5">{label}</p>
      {sub && <p className="text-xs text-gray-600 mt-1">{sub}</p>}
    </div>
  )
}

function ProviderBadge({ provider }) {
  const isBigi = provider === 'bigisub'
  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium border ${
      isBigi
        ? 'bg-brand-500/15 text-brand-400 border-brand-500/20'
        : 'bg-purple-500/15 text-purple-400 border-purple-500/20'
    }`}>
      {isBigi ? 'Bigisub' : 'Alrahuz'}
    </span>
  )
}

const CACHE_KEY = 'dht_dashboard_cache'

function readCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null') } catch { return null }
}

function writeCache(data) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)) } catch { /* ignore */ }
}

export default function Dashboard() {
  const toast = useToast()

  // Persistent data store — lives in a ref so the fetch callback always reads
  // the latest value without needing it as a dependency. Data is NEVER set to
  // null/undefined once it has been loaded.
  const dataRef = useRef({
    stats: readCache()?.stats || {
      balances: { bigisub: 0, alrahuz: 0 },
      total_wallet_liability: 0,
      total_registered_users: 0,
      total_transactions: 0,
      active_routes: {}
    },
    providers: readCache()?.providers || null,
    recent: readCache()?.recent || [],
  })

  // Force-reactive copy for rendering
  const [renderTick, setRenderTick] = useState(0)
  const [loading, setLoading] = useState(false)
  const [sessionExpired, setSessionExpired] = useState(false)
  const [lastUpdated, setLastUpdated] = useState(null)

  const bump = useCallback(() => setRenderTick(t => t + 1), [])

  const fetchStats = useCallback(async () => {
    setLoading(true)
    try {
      const [statsRes, providersRes, txRes] = await Promise.allSettled([
        api.getStats(),
        api.getProviders(),
        api.getTransactions(1, 8),
      ])

      let anySuccess = false

      // Stats — merge into existing, never overwrite with undefined/null
      if (statsRes.status === 'fulfilled' && statsRes.value?.data) {
        const d = statsRes.value.data
        dataRef.current.stats = { ...dataRef.current.stats, ...d }
        anySuccess = true
      }

      // Providers
      if (providersRes.status === 'fulfilled' && providersRes.value?.data) {
        dataRef.current.providers = providersRes.value.data
        anySuccess = true
      }

      // Recent transactions — always replace on success (empty array is valid)
      if (txRes.status === 'fulfilled') {
        dataRef.current.recent = txRes.value?.data || []
        anySuccess = true
      }

      if (anySuccess) {
        setLastUpdated(new Date())
        writeCache({
          stats: dataRef.current.stats,
          recent: dataRef.current.recent,
        })
      }

      // Check if ALL three failed due to auth — signal session expiry
      const allRejected = [statsRes, providersRes, txRes].every(r => r.status === 'rejected')
      if (allRejected) {
        const reason = statsRes.reason?.message || ''
        if (reason.includes('sign in') || reason.includes('expired') || !api.isSessionValid) {
          setSessionExpired(true)
        }
      } else {
        setSessionExpired(false)
      }

      bump()
    } catch (err) {
      console.error('Dashboard fetch error:', err)
      if (toast) toast.error(err.message || 'Failed to refresh dashboard data')
    } finally {
      setLoading(false)
    }
  }, [toast, bump])

  // Initial fetch on mount
  useEffect(() => { fetchStats() }, [fetchStats])

  // Auto-refresh every 15 seconds
  useEffect(() => {
    const timer = setInterval(fetchStats, 15_000)
    return () => clearInterval(timer)
  }, [fetchStats])

  // Render from ref — the ref ALWAYS has data (never null)
  const { stats, providers, recent } = dataRef.current

  const fmt = (n) => '₦' + Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 0 })

  const statusBadge = (status) => {
    const s = (status || '').toLowerCase()
    if (s === 'successful') return <span className="badge-success">Successful</span>
    if (s === 'failed') return <span className="badge-failed">Failed</span>
    if (s === 'refunded') return <span className="badge-refunded">Refunded</span>
    return <span className="badge-pending">{status || '—'}</span>
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-100">Dashboard</h1>
          <p className="text-sm text-gray-500 mt-1">Platform overview and provider status</p>
        </div>
        <div className="flex items-center gap-3">
          {lastUpdated && (
            <span className="text-xs text-gray-600">
              Updated {lastUpdated.toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          )}
          <button onClick={fetchStats} className="btn-secondary" disabled={loading}>
            <RefreshCw size={14} className={loading ? 'animate-spin' : '' } />
            Refresh
          </button>
        </div>
      </div>

      {sessionExpired && (
        <div className="flex items-center gap-3 px-4 py-3 rounded-lg border border-amber-500/30 bg-amber-500/10">
          <AlertTriangle size={18} className="text-amber-400 shrink-0" />
          <div className="flex-1">
            <p className="text-sm text-amber-300 font-medium">Session expired</p>
            <p className="text-xs text-amber-400/70 mt-0.5">Showing cached data. Please sign in again for live updates.</p>
          </div>
        </div>
      )}

      {/* Provider Balance Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <StatCard
          icon={Wallet}
          label="Bigisub Balance"
          value={'₦' + Number(stats.balances?.bigisub || 0).toLocaleString('en-NG')}
          color="bg-brand-600/15 text-brand-400"
          sub="Bigisub vendor credit"
        />
        <StatCard
          icon={Wallet}
          label="Alrahuz Balance"
          value={'₦' + Number(stats.balances?.alrahuz || 0).toLocaleString('en-NG')}
          color="bg-purple-500/15 text-purple-400"
          sub="Alrahuz data vendor credit"
        />
        <StatCard
          icon={TrendingDown}
          label="Total Wallet Liability"
          value={fmt(stats.total_wallet_liability)}
          color="bg-amber-500/15 text-amber-400"
          sub="Sum of all user balances"
        />
        <StatCard
          icon={Users}
          label="Registered Users"
          value={Number(stats.total_registered_users || 0).toLocaleString()}
          color="bg-emerald-500/15 text-emerald-400"
        />
      </div>

      {/* Active Provider Routes */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-100">Active Provider Routes</h2>
            <p className="text-sm text-gray-500">Which provider handles each service</p>
          </div>
          <ArrowLeftRight size={20} className="text-gray-600" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          {Object.entries(stats.active_routes || providers || {}).map(([svc, prov]) => {
            const Icon = serviceIcons[svc] || Zap
            return (
              <div key={svc} className="flex items-center gap-3 p-3 rounded-xl bg-gray-800/40 border border-gray-800">
                <div className="p-2 rounded-lg bg-gray-700/50">
                  <Icon size={16} className="text-gray-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-gray-500">{serviceLabels[svc] || svc}</p>
                  <ProviderBadge provider={prov} />
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Quick Stats Row */}
      <div className="card">
        <p className="text-sm text-gray-500">
          Total Transactions:{' '}
          <span className="text-gray-200 font-semibold">
            {Number(stats.total_transactions || 0).toLocaleString()}
          </span>
        </p>
      </div>

      {/* Recent Transactions */}
      <div className="card overflow-hidden !p-0">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <div>
            <h2 className="text-base font-semibold text-gray-100">Recent Transactions</h2>
            <p className="text-xs text-gray-500 mt-0.5">Latest activity across the platform</p>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-left text-gray-500 text-xs uppercase tracking-wider">
                <th className="px-5 py-3">Service</th>
                <th className="px-5 py-3">User</th>
                <th className="px-5 py-3 text-right">Amount</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3">Provider</th>
                <th className="px-5 py-3">Date</th>
              </tr>
            </thead>
            <tbody>
              {recent.length === 0 ? (
                <tr><td colSpan={6} className="px-5 py-8 text-center text-gray-500 text-sm">No transactions yet</td></tr>
              ) : (
                recent.map(tx => (
                  <tr key={tx.id} className="table-row">
                    <td className="px-5 py-3">
                      <p className="font-medium text-gray-200 capitalize">{tx.service_type || '—'}</p>
                      <p className="text-xs text-gray-500 truncate max-w-[180px]">{tx.title}</p>
                    </td>
                    <td className="px-5 py-3">
                      <p className="text-gray-300 text-xs">{tx.profiles?.full_name || tx.user_id?.slice(0, 8) || '—'}</p>
                      <p className="text-xs text-gray-600 truncate max-w-[140px]">{tx.profiles?.email}</p>
                    </td>
                    <td className="px-5 py-3 text-right font-mono text-gray-200">
                      ₦{Number(tx.amount || 0).toLocaleString()}
                    </td>
                    <td className="px-5 py-3">{statusBadge(tx.status)}</td>
                    <td className="px-5 py-3">
                      {tx.provider
                        ? <span className={`text-xs font-medium ${tx.provider === 'alrahuz' ? 'text-purple-400' : 'text-brand-400'}`}>{tx.provider}</span>
                        : <span className="text-xs text-gray-600">—</span>}
                    </td>
                    <td className="px-5 py-3 text-xs text-gray-500 whitespace-nowrap">
                      {tx.created_at ? new Date(tx.created_at).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
