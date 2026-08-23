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

export default function Dashboard() {
  const [stats, setStats] = useState(null)
  const [providers, setProviders] = useState(null)
  const [loading, setLoading] = useState(true)
  const toast = useToast()

  const fetchStats = async () => {
    setLoading(true)
    try {
      const [statsRes, providersRes] = await Promise.allSettled([
        api.getStats(),
        api.getProviders(),
      ])
      if (statsRes.status === 'fulfilled') setStats(statsRes.value.data)
      else toast.error(statsRes.reason?.message || 'Failed to load stats')
      if (providersRes.status === 'fulfilled') setProviders(providersRes.value.data)
    } catch (err) {
      toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchStats() }, [])

  const fmt = (n) => '₦' + Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 0 })

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-100">Dashboard</h1>
          <p className="text-sm text-gray-500 mt-1">Platform overview and provider status</p>
        </div>
        <button onClick={fetchStats} className="btn-secondary" disabled={loading}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
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
              sub="Alrahuzdata vendor credit"
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
        </>
      ) : null}
    </div>
  )
}
