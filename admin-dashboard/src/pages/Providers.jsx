import { useState, useEffect } from 'react'
import { api } from '../api/client'
import { useToast } from '../components/Toast'
import ConfirmModal from '../components/ConfirmModal'
import { Loader2, RefreshCw, Zap, Wifi, Tv, Lightbulb, GraduationCap, ArrowRightLeft } from 'lucide-react'

const VALID_SERVICES = ['airtime', 'data', 'cable', 'electricity', 'epin']

const serviceConfig = {
  airtime:     { icon: Zap,          label: 'Airtime',      desc: 'VTU top-ups' },
  data:        { icon: Wifi,         label: 'Data Plans',   desc: 'Internet bundles' },
  cable:       { icon: Tv,           label: 'Cable TV',     desc: 'DStv, GOtv, StarTimes' },
  electricity: { icon: Lightbulb,    label: 'Electricity',  desc: 'Meter token payments' },
  epin:        { icon: GraduationCap, label: 'Exam PINs',   desc: 'WAEC, NECO, NABTEB' },
}

function ServiceCard({ service, current, onChange, loading }) {
  const { icon: Icon, label, desc } = serviceConfig[service]
  const isBigi = current === 'bigisub'

  return (
    <div className="card hover:border-gray-700 transition-all">
      <div className="flex items-start gap-3 mb-4">
        <div className="p-2.5 rounded-xl bg-gray-800">
          <Icon size={20} className="text-gray-400" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-gray-200">{label}</h3>
          <p className="text-xs text-gray-500">{desc}</p>
        </div>
      </div>

      <div className="flex gap-2">
        {['bigisub', 'alrahuz'].map(p => (
          <button
            key={p}
            disabled={loading}
            onClick={() => onChange(service, p)}
            className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition-all border ${
              current === p
                ? p === 'bigisub'
                  ? 'bg-brand-600/20 text-brand-400 border-brand-500/30 shadow-sm shadow-brand-500/10'
                  : 'bg-purple-600/20 text-purple-400 border-purple-500/30 shadow-sm shadow-purple-500/10'
                : 'bg-gray-800/50 text-gray-500 border-gray-700 hover:text-gray-300 hover:border-gray-600'
            }`}
          >
            {p === 'bigisub' ? 'Bigisub' : 'Alrahuz'}
          </button>
        ))}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <span className="text-xs text-gray-600">Active:</span>
        <span className={`text-xs font-medium ${isBigi ? 'text-brand-400' : 'text-purple-400'}`}>
          {isBigi ? 'Bigisub' : 'Alrahuzdata'}
        </span>
      </div>
    </div>
  )
}

export default function Providers() {
  const [routes, setRoutes] = useState({})
  const [loading, setLoading] = useState(true)
  const [switching, setSwitching] = useState(false)
  const [confirmGlobal, setConfirmGlobal] = useState(null) // { provider: 'bigisub' | 'alrahuz' }
  const toast = useToast()

  const fetchRoutes = async () => {
    setLoading(true)
    try {
      const res = await api.getProviders()
      setRoutes(res.data || {})
    } catch (err) {
      toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchRoutes() }, [])

  // Determine if all services use the same provider
  const uniqueProviders = [...new Set(Object.values(routes))]
  const isGlobalMode = uniqueProviders.length === 1
  const globalProvider = isGlobalMode ? uniqueProviders[0] : null

  const handleGlobalSwitch = async (provider) => {
    setSwitching(true)
    try {
      await api.setGlobalProvider(provider)
      toast.success(`All services switched to ${provider === 'bigisub' ? 'Bigisub' : 'Alrahuzdata'}`)
      await fetchRoutes()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setSwitching(false)
      setConfirmGlobal(null)
    }
  }

  const handleServiceSwitch = async (service, provider) => {
    setSwitching(true)
    try {
      await api.setServiceRoute(service, provider)
      toast.success(`${serviceConfig[service].label} switched to ${provider === 'bigisub' ? 'Bigisub' : 'Alrahuzdata'}`)
      await fetchRoutes()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setSwitching(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-100">Provider Routing</h1>
          <p className="text-sm text-gray-500 mt-1">Control which VTU provider handles each service</p>
        </div>
        <button onClick={fetchRoutes} className="btn-secondary" disabled={loading}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 size={28} className="animate-spin text-brand-400" />
        </div>
      ) : (
        <>
          {/* Global Toggle */}
          <div className="card">
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
              <div className="flex items-center gap-3 flex-1">
                <ArrowRightLeft size={20} className="text-gray-400" />
                <div>
                  <h2 className="text-base font-semibold text-gray-100">Master Global Switch</h2>
                  <p className="text-xs text-gray-500">
                    {isGlobalMode
                      ? `All services currently routed through ${globalProvider === 'bigisub' ? 'Bigisub' : 'Alrahuzdata'}`
                      : 'Services are split across providers — use per-service overrides below'}
                  </p>
                </div>
              </div>

              <div className="flex gap-2 bg-gray-800/50 p-1 rounded-xl border border-gray-700">
                <button
                  disabled={switching}
                  onClick={() => setConfirmGlobal({ provider: 'alrahuz' })}
                  className={`px-5 py-2.5 rounded-lg text-sm font-medium transition-all ${
                    isGlobalMode && globalProvider === 'alrahuz'
                      ? 'bg-purple-600 text-white shadow-sm'
                      : 'text-gray-400 hover:text-gray-200'
                  }`}
                >
                  {switching && confirmGlobal?.provider === 'alrahuz'
                    ? <Loader2 size={14} className="animate-spin" />
                    : 'All on Alrahuzdata'}
                </button>
                <button
                  disabled={switching}
                  onClick={() => setConfirmGlobal({ provider: 'bigisub' })}
                  className={`px-5 py-2.5 rounded-lg text-sm font-medium transition-all ${
                    isGlobalMode && globalProvider === 'bigisub'
                      ? 'bg-brand-600 text-white shadow-sm'
                      : 'text-gray-400 hover:text-gray-200'
                  }`}
                >
                  {switching && confirmGlobal?.provider === 'bigisub'
                    ? <Loader2 size={14} className="animate-spin" />
                    : 'All on Bigisub'}
                </button>
              </div>
            </div>
          </div>

          {/* Per-Service Overrides */}
          <div>
            <h2 className="text-base font-semibold text-gray-100 mb-3">Per-Service Overrides</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
              {VALID_SERVICES.map(svc => (
                <ServiceCard
                  key={svc}
                  service={svc}
                  current={routes[svc] || 'bigisub'}
                  onChange={handleServiceSwitch}
                  loading={switching}
                />
              ))}
            </div>
          </div>
        </>
      )}

      {/* Global Switch Confirmation */}
      <ConfirmModal
        open={!!confirmGlobal}
        title={`Switch All Services to ${confirmGlobal?.provider === 'bigisub' ? 'Bigisub' : 'Alrahuzdata'}?`}
        message={`This will route ALL services (airtime, data, cable, electricity, exam PINs) through ${confirmGlobal?.provider === 'bigisub' ? 'Bigisub' : 'Alrahuzdata'}. Per-service overrides will be cleared.`}
        confirmLabel="Switch All"
        loading={switching}
        onConfirm={() => handleGlobalSwitch(confirmGlobal.provider)}
        onCancel={() => setConfirmGlobal(null)}
      />
    </div>
  )
}
