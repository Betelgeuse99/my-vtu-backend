import { useState, useEffect, useCallback } from 'react'
import { api } from '../api/client'
import { useToast } from '../components/Toast'
import CarrierBadge from '../components/CarrierBadge'
import { Wallet, Users, ArrowLeftRight, TrendingDown, Loader2, RefreshCw, Zap, Wifi, Tv, Lightbulb, GraduationCap, AlertTriangle, BarChart3, Banknote } from 'lucide-react'
import { fmtLagos, fmtNgn } from '../lib/format'

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

function StatCard({ icon: Icon, label, value, color, sub, highlight }) {
  return (
    <div className={`card group hover:border-gray-700 transition-all ${highlight ? 'border-brand-500/50 ring-1 ring-brand-500/30' : ''}`}>
      <div className="flex items-start justify-between mb-3">
        <div className={`p-2.5 rounded-xl ${color}`}>
          <Icon size={20} />
        </div>
      </div>
      <p className={`tabular-nums ${highlight ? 'text-3xl font-extrabold text-white' : 'text-2xl font-bold text-gray-100'}`}>{value}</p>
      <p className={`${highlight ? 'text-sm font-semibold text-gray-100 mt-0.5' : 'text-sm text-gray-500 mt-0.5'}`}>{label}</p>
      {sub && <p className={`${highlight ? 'text-xs font-medium text-gray-300 mt-1' : 'text-xs text-gray-600 mt-1'}`}>{sub}</p>}
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

const CHART_COLORS = ['#3b82f6', '#f59e0b', '#10b981', '#8b5cf6', '#ef4444', '#06b6d4', '#f97316', '#84cc16', '#64748b']

function MiniStat({ label, value }) {
  return (
    <div className="p-3 rounded-xl bg-gray-800/40 border border-gray-800">
      <p className="text-lg font-bold text-gray-100 tabular-nums">{value}</p>
      <p className="text-xs text-gray-500 mt-0.5">{label}</p>
    </div>
  )
}

/** Pure-SVG bar chart (histogram) of purchases over the last 14 days. */
function DailyBarChart({ data }) {
  const rows = data || []
  const max = Math.max(1, ...rows.map((d) => d.count || 0))
  const W = 560, H = 150, pad = 4
  const bw = (W - pad * 2) / Math.max(1, rows.length)
  return (
    <svg viewBox={`0 0 ${W} ${H + 26}`} className="w-full" preserveAspectRatio="xMidYMid meet">
      {rows.map((d, i) => {
        const h = ((d.count || 0) / max) * (H - 22)
        const x = pad + i * bw + bw * 0.18
        const w = bw * 0.64
        const y = H - h
        return (
          <g key={d.date}>
            <rect x={x} y={y} width={w} height={h} rx={3} fill="#3b82f6" className="opacity-90 hover:opacity-100 transition-opacity">
              <title>{`${d.date}: ${d.count} purchases · ₦${Number(d.amount || 0).toLocaleString()}`}</title>
            </rect>
            {(d.count || 0) > 0 && (
              <text x={x + w / 2} y={y - 4} textAnchor="middle" fontSize="9" fill="#9ca3af" className="tabular-nums">{d.count}</text>
            )}
            {i % 2 === 0 && (
              <text x={x + w / 2} y={H + 14} textAnchor="middle" fontSize="8" fill="#6b7280">{d.date.slice(5)}</text>
            )}
          </g>
        )
      })}
    </svg>
  )
}

/** Pure-SVG donut chart of the service-type breakdown. */
function DonutChart({ data }) {
  const rows = data || []
  const total = rows.reduce((s, d) => s + (d.count || 0), 0) || 1
  const R = 54, C = 2 * Math.PI * R
  let offset = 0
  return (
    <div className="flex flex-col sm:flex-row items-center gap-6">
      <svg viewBox="0 0 140 140" className="w-32 h-32 shrink-0">
        <circle cx="70" cy="70" r={R} fill="none" stroke="#1f2937" strokeWidth="15" />
        <g transform="rotate(-90 70 70)">
          {rows.map((d, i) => {
            const len = ((d.count || 0) / total) * C
            const seg = (
              <circle key={d.service_type || i} cx="70" cy="70" r={R} fill="none"
                stroke={CHART_COLORS[i % CHART_COLORS.length]} strokeWidth="15"
                strokeDasharray={`${Math.max(0, len - 1)} ${C - Math.max(0, len - 1)}`}
                strokeDashoffset={-offset} />
            )
            offset += len
            return seg
          })}
        </g>
        <text x="70" y="70" textAnchor="middle" dominantBaseline="central" fontSize="18" fontWeight="bold" fill="#f3f4f6" className="tabular-nums">{total}</text>
      </svg>
      <div className="flex-1 w-full min-w-0 space-y-1.5">
        {rows.map((d, i) => (
          <div key={d.service_type || i} className="flex items-center gap-2 text-xs">
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: CHART_COLORS[i % CHART_COLORS.length] }} />
            <span className="text-gray-400 capitalize flex-1 min-w-0 truncate">{d.service_type || '—'}</span>
            <span className="text-gray-300 font-medium tabular-nums">{d.count}</span>
            <span className="text-gray-600 tabular-nums w-10 text-right">{Math.round(((d.count || 0) / total) * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Horizontal bars for the provider / carrier breakdown. */
function ProviderBars({ data }) {
  const rows = data || []
  const max = Math.max(1, ...rows.map((d) => d.count || 0))
  return (
    <div className="space-y-2">
      {rows.map((d) => (
        <div key={d.provider} className="flex items-center gap-3">
          <span className="text-xs text-gray-400 w-28 truncate">{d.provider || '—'}</span>
          <div className="flex-1 h-4 bg-gray-800 rounded overflow-hidden">
            <div
              className="h-full rounded bg-gradient-to-r from-brand-600/70 to-brand-500/70 transition-[width] duration-300"
              style={{ width: `${Math.max(2, ((d.count || 0) / max) * 100)}%` }}
            />
          </div>
          <span className="text-xs text-gray-300 tabular-nums w-12 text-right">{d.count}</span>
          <span className="text-xs text-gray-600 tabular-nums w-24 text-right">₦{Number(d.amount || 0).toLocaleString()}</span>
        </div>
      ))}
    </div>
  )
}

export default function Dashboard() {
  const toast = useToast()

  const [stats, setStats] = useState(null)
  const [providers, setProviders] = useState(null)
  const [recent, setRecent] = useState([])
  const [charts, setCharts] = useState(null)
  const [loading, setLoading] = useState(true)
  const [errors, setErrors] = useState({})
  const [lastUpdated, setLastUpdated] = useState(null)

  const fetchData = useCallback(async () => {
    setLoading(true)

    // Each section fetched independently — one failing must never blank
    // out the others, and every failure must be visible, never swallowed.
    const [statsRes, providersRes, txRes, chartsRes] = await Promise.allSettled([
      api.get('/api/v2/admin/stats'),
      api.get('/api/v2/admin/providers'),
      api.get('/api/v2/admin/transactions?page=1&limit=8'),
      api.get('/api/v2/admin/stats/charts'),
    ])

    const newErrors = {}

    if (statsRes.status === 'fulfilled') {
      setStats(statsRes.value.data?.data ?? null)
    } else {
      newErrors.stats = statsRes.reason?.response?.data?.message || statsRes.reason?.message || 'Stats unavailable'
      console.error('[Dashboard] stats failed:', statsRes.reason?.response?.status, statsRes.reason?.message)
    }

    if (providersRes.status === 'fulfilled') {
      setProviders(providersRes.value.data?.data ?? null)
    } else {
      newErrors.providers = 'Provider routes unavailable'
      console.error('[Dashboard] providers failed:', providersRes.reason?.message)
    }

    if (txRes.status === 'fulfilled') {
      setRecent(txRes.value.data?.data ?? [])
    } else {
      newErrors.recent = txRes.reason?.response?.data?.message || 'Recent transactions unavailable'
      console.error('[Dashboard] recent transactions failed:', txRes.reason?.message)
    }

    if (chartsRes.status === 'fulfilled') {
      setCharts(chartsRes.value.data?.data ?? null)
    } else {
      newErrors.charts = chartsRes.reason?.response?.data?.message || 'Statistics charts unavailable'
      console.error('[Dashboard] charts failed:', chartsRes.reason?.message)
    }

    setErrors(newErrors)
    setLastUpdated(new Date())
    setLoading(false)
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // Live forever: poll every 15s, unconditionally, while the page is open
  useEffect(() => {
    const timer = setInterval(fetchData, 15_000)
    return () => clearInterval(timer)
  }, [fetchData])

  const fmt = (n) => '₦' + Number(n || 0).toLocaleString('en-NG')

  const statusBadge = (status) => {
    const s = (status || '').toLowerCase()
    if (s === 'successful') return <span className="badge-success">Successful</span>
    if (s === 'failed') return <span className="badge-failed">Failed</span>
    if (s === 'refunded') return <span className="badge-refunded">Refunded</span>
    return <span className="badge-pending">{status || '—'}</span>
  }

  const errorList = Object.values(errors).filter(Boolean)

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
              Updated {fmtLagos(lastUpdated, { date: false })}
            </span>
          )}
          <button onClick={fetchData} className="btn-secondary" disabled={loading}>
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      {errorList.length > 0 && (
        <div className="flex items-start gap-3 px-4 py-3 rounded-lg border border-red-500/30 bg-red-500/10">
          <AlertTriangle size={18} className="text-red-400 shrink-0 mt-0.5" />
          <div className="text-sm text-red-300 space-y-1">
            {errorList.map((e, i) => <p key={i}>{e}</p>)}
          </div>
        </div>
      )}

      {/* Stats render as soon as they exist — first load shows skeleton spinners */}
      {!stats && loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          {[0, 1, 2, 3].map(i => (
            <div key={i} className="card h-28 flex items-center justify-center">
              <Loader2 size={20} className="animate-spin text-gray-600" />
            </div>
          ))}
        </div>
      ) : stats ? (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-4">
            <StatCard
              icon={Wallet}
              label="Bigisub Balance"
              value={fmtNgn(stats.balances?.bigisub)}
              color="bg-brand-600/20 text-brand-300"
              sub="Bigisub vendor credit"
              highlight
            />
            <StatCard
              icon={Wallet}
              label="Alrahuz Balance"
              value={fmtNgn(stats.balances?.alrahuz)}
              color="bg-purple-500/15 text-purple-400"
              sub="Alrahuz data vendor credit"
            />
            <StatCard
              icon={TrendingDown}
              label="Total Wallet Liability"
              value={fmtNgn(stats.total_wallet_liability)}
              color="bg-amber-500/15 text-amber-400"
              sub="Sum of all user balances"
            />
            <StatCard
              icon={Users}
              label="Registered Users"
              value={Number(stats.total_registered_users || 0).toLocaleString()}
              color="bg-emerald-500/15 text-emerald-400"
            />
            <StatCard
              icon={Banknote}
              label="Revenue Generated"
              value={fmtNgn(stats.total_revenue)}
              color="bg-emerald-600/15 text-emerald-300"
              sub="Successful purchases only"
            />
          </div>

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

          <div className="card">
            <p className="text-sm text-gray-500">
              Total Transactions:{' '}
              <span className="text-gray-200 font-semibold">
                {Number(stats.total_transactions || 0).toLocaleString()}
              </span>
            </p>
          </div>
        </>
      ) : null}

      {/* Recent transactions — independent of stats */}
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
                <th className="px-4 py-2.5">Service</th>
                <th className="px-4 py-2.5">User</th>
                <th className="px-4 py-2.5">Phone</th>
                <th className="px-4 py-2.5 text-right">Amount</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">Provider</th>
                <th className="px-4 py-2.5">Date</th>
              </tr>
            </thead>
            <tbody>
              {loading && recent.length === 0 ? (
                <tr><td colSpan={7} className="px-5 py-8 text-center">
                  <Loader2 size={18} className="animate-spin mx-auto text-brand-400" />
                </td></tr>
              ) : recent.length === 0 ? (
                <tr><td colSpan={7} className="px-5 py-8 text-center text-gray-500 text-sm">
                  {errors.recent || 'No transactions yet'}
                </td></tr>
              ) : (
                recent.map(tx => (
                  <tr key={tx.id} className="table-row">
                    <td className="px-4 py-2.5">
                      <div className="min-w-0">
                        <p className="font-medium text-gray-200 capitalize">{tx.service_type || '—'}</p>
                        <p className="text-xs text-gray-500 truncate max-w-[150px]">{tx.title}</p>
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="min-w-0">
                        <p className="text-gray-300 text-xs truncate max-w-[160px]">{tx.profiles?.full_name || tx.user_id?.slice(0, 8) || '—'}</p>
                        <p className="text-xs text-gray-600 truncate max-w-[220px]">{tx.profiles?.email || ''}</p>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-300 whitespace-nowrap">{tx.recipient || '—'}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-gray-200 whitespace-nowrap">
                      ₦{Number(tx.amount || 0).toLocaleString()}
                    </td>
                    <td className="px-4 py-2.5">{statusBadge(tx.status)}</td>
                    <td className="px-4 py-2.5">
                      <CarrierBadge provider={tx.provider} />
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-500 whitespace-nowrap">
                      {fmtLagos(tx.created_at)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Purchase statistics — below recent transactions */}
      {charts ? (
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-semibold text-gray-100">Purchase Statistics</h2>
              <p className="text-sm text-gray-500">Last 14 days of platform activity</p>
            </div>
            <BarChart3 size={20} className="text-gray-600" />
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            <MiniStat label="Purchases" value={Number(charts.totals?.purchases || 0).toLocaleString()} />
            <MiniStat label="Volume" value={fmt(charts.totals?.volume)} />
            <MiniStat label="Successful" value={Number(charts.totals?.success || 0).toLocaleString()} />
            <MiniStat label="Failed" value={Number(charts.totals?.failed || 0).toLocaleString()} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-gray-300 mb-3">Purchases per Day</h3>
              <DailyBarChart data={charts.daily} />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-gray-300 mb-3">By Service</h3>
              <DonutChart data={charts.byService} />
            </div>
          </div>

          <div className="mt-8">
            <h3 className="text-sm font-semibold text-gray-300 mb-3">By Provider</h3>
            <ProviderBars data={charts.byProvider} />
          </div>
        </div>
      ) : loading ? (
        <div className="card h-40 flex items-center justify-center">
          <Loader2 size={20} className="animate-spin text-gray-600" />
        </div>
      ) : null}
    </div>
  )
}
