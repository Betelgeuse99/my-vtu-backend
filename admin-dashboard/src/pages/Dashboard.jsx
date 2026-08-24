import { useState, useEffect } from 'react'
import { api } from '../api/client'
import { useToast } from '../components/Toast'
import { Wallet, Users, ArrowLeftRight, TrendingDown, Loader2, RefreshCw, Zap, Wifi, Tv, Lightbulb, GraduationCap } from 'lucide-react'

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

// Zero‑fallback so the dashboard never stays blank if the first fetch fails.
const fallbackStats = {
  balances: { bigisub: 0, alrahuz: 0 },
  total_wallet_liability: 0,
  total_registered_users: 0,
  total_transactions: 0,
  active_routes: {}
}

export default function Dashboard() {
  // Seed from the last successful fetch (localStorage) so the numbers are
  // ALWAYS visible — even right after login or when the Render service is
  // cold-starting. Live data replaces it as soon as a fetch succeeds.
  const cached = (() => {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null') } catch { return null }
  })()
  // Start with cached data; if nothing cached yet, use a zero‑fallback so the
  // UI never stays blank while the first fetch is in flight.
  const [stats, setStats] = useState(cached?.stats || fallbackStats)
  const [providers, setProviders] = useState(cached?.providers || null)
  const [recent, setRecent] = useState(cached?.recent || [])
  // Loading only while the first fetch is pending; if we had no cache we still
  // show the fallback zeros immediately so there’s no blank screen.
  const [loading, setLoading] = useState(!cached?.stats)

  const fetchStats = async () => {
    setLoading(true)
    try {
      const [statsRes, providersRes, txRes] = await Promise.allSettled([
        api.getStats(),
        api.getProviders(),
        api.getTransactions(1, 8),
      ])

      // ── Stats ──────────────────────────────────────────────
      if (statsRes.status === 'fulfilled') {
        setStats(statsRes.value.data)
        try {
          localStorage.setItem(CACHE_KEY, JSON.stringify({
            stats: statsRes.value.data,
            recent: txRes.status === 'fulfilled' ? (txRes.value.data || []) : [],
          }))
        } catch { /* storage full/unavailable — ignore */ }
      } else if (!cached?.stats) {
        // No cached fallback either — keep the zero‑fallback we already have
      }

      // ── Providers ────────────────────────────────────────
      if (providersRes.status === 'fulfilled') setProviders(providersRes.value.data)

      // ── Recent transactions ──────────────────────────────
      if (txRes.status === 'fulfilled') setRecent(txRes.value.data || [])
    } catch (err) {
      // Never leave the dashboard completely blank — keep cached or fallback
      if (!cached?.stats) setStats(fallbackStats)
      toast.error(err.message || 'Failed to load dashboard data')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchStats() }, [])

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
        <button onClick={fetchStats} className="btn-secondary" disabled={loading}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : '' } />
          Refresh
        </button>
      </div>

      {loading && !stats ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 size={28} className="animate-spin text-brand-400" />
        </div>
      ) : stats ? (
        <>
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
        </>
      ) : null}
    </div>
  )
}