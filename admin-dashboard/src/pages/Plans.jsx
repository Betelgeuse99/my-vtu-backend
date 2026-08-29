import { useState, useEffect, useCallback } from 'react'
import { api } from '../api/client'
import { useToast } from '../components/Toast'
import ConfirmModal from '../components/ConfirmModal'
import { Loader2, Save, Wifi, ToggleLeft, ToggleRight } from 'lucide-react'

const networkNames = { 1: 'MTN', 2: 'Glo', 3: 'Airtel', 4: '9mobile' }

function EditRow({ plan, onSave, onCancel, provider }) {
  const [price, setPrice] = useState(plan.retail_price || '')
  const [alrPrice, setAlrPrice] = useState(plan.alrahuz_retail_price ?? '')
  const [active, setActive] = useState(plan.is_active)
  const [saving, setSaving] = useState(false)
  const toast = useToast()

  const handleSave = async () => {
    const numPrice = Number(price)
    if (isNaN(numPrice) || numPrice <= 0) return toast.error('Enter a valid retail price')
    const buys = [Number(plan.buy_price || 0), Number(plan.alrahuz_buy_price || 0)]
    const maxBuy = Math.max(...buys)
    if (numPrice < maxBuy) return toast.error('Retail price must be ≥ highest buy price')

    let alrOverride = null
    if (alrPrice !== '' && alrPrice !== null) {
      alrOverride = Number(alrPrice)
      if (isNaN(alrOverride)) return toast.error('Alrahuz retail must be a number')
      if (alrOverride > 0 && Number(plan.alrahuz_buy_price || 0) > 0 && alrOverride < Number(plan.alrahuz_buy_price)) {
        return toast.error('Alrahuz retail must be ≥ Alrahuz buy price')
      }
    }

    setSaving(true)
    try {
      await api.post('/api/v2/admin/plans/update-price', { plan_id: plan.row_id || plan.id, retail_price: numPrice, is_active: active, alrahuz_retail_price: alrOverride })
      toast.success('Plan updated successfully')
      onSave()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <tr className="table-row bg-brand-50/50">
      <td className="px-5 py-3">
        <p className="font-medium text-gray-800">{plan.volume}</p>
        <p className="text-xs text-gray-500">{plan.validity}</p>
      </td>
      {provider === 'bigisub' ? (
        <>
          <td className="px-5 py-3 text-xs text-gray-500 font-mono">{plan.bigi_plan_id ? `#${plan.bigi_plan_id}` : '—'}</td>
          <td className="px-5 py-3 font-mono text-xs text-gray-500">₦{Number(plan.buy_price || 0).toLocaleString()}</td>
        </>
      ) : (
        <>
          <td className="px-5 py-3 text-xs text-gray-500 font-mono">{plan.alrahuz_plan_id ? `#${plan.alrahuz_plan_id}` : '—'}</td>
          <td className="px-5 py-3 font-mono text-xs text-gray-500">
            {plan.alrahuz_buy_price != null ? `₦${Number(plan.alrahuz_buy_price).toLocaleString()}` : '—'}
          </td>
        </>
      )}
      <td className="px-5 py-3">
        <div className="flex items-center gap-2">
          <span className="text-gray-400 text-sm">₦</span>
          <input
            type="number"
            value={price}
            onChange={e => setPrice(e.target.value)}
            className="input !w-28 !py-1.5"
            autoFocus
          />
        </div>
      </td>
      {provider === 'alrahuz' && (
        <td className="px-5 py-3">
          {plan.alrahuz_plan_id ? (
            <div className="flex items-center gap-2">
              <span className="text-gray-400 text-sm">₦</span>
              <input
                type="number"
                value={alrPrice}
                onChange={e => setAlrPrice(e.target.value)}
                placeholder="same"
                className="input !w-24 !py-1.5"
              />
            </div>
          ) : <span className="text-xs text-gray-400">—</span>}
        </td>
      )}
      <td className="px-5 py-3">
        <button onClick={() => setActive(!active)} className="transition-colors">
          {active ? (
            <ToggleRight size={24} className="text-emerald-500" />
          ) : (
            <ToggleLeft size={24} className="text-gray-300" />
          )}
        </button>
      </td>
      <td className="px-5 py-3 text-right">
        <div className="flex gap-2 justify-end">
          <button onClick={onCancel} className="btn-secondary !px-3 !py-1.5 !text-xs">Cancel</button>
          <button onClick={handleSave} disabled={saving} className="btn-primary !px-3 !py-1.5 !text-xs">
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
            Save
          </button>
        </div>
      </td>
    </tr>
  )
}

function ProviderTable({ plans, provider, editingId, setEditingId, onSave, loading }) {
  const isBigi = provider === 'bigisub'
  const providerLabel = isBigi ? 'Bigisub' : 'Alrahuz'
  const headerColor = isBigi ? 'text-brand-600' : 'text-purple-600'
  const bgColor = isBigi ? 'bg-brand-50' : 'bg-purple-50'
  const borderColor = isBigi ? 'border-brand-200' : 'border-purple-200'

  return (
    <div className="space-y-3">
      <div className={`flex items-center gap-2 px-1`}>
        <div className={`w-1.5 h-5 rounded-full ${isBigi ? 'bg-brand-500' : 'bg-purple-500'}`} />
        <h3 className={`text-sm font-bold ${headerColor}`}>{providerLabel} Plans</h3>
        <span className="text-xs text-gray-400">— fetched from {providerLabel} API</span>
      </div>

      <div className="card overflow-hidden !p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-gray-500 text-xs uppercase tracking-wider">
                <th className="px-5 py-3">Plan</th>
                <th className="px-5 py-3">{providerLabel} ID</th>
                <th className="px-5 py-3">{providerLabel} Buy Price</th>
                <th className="px-5 py-3">Retail Price</th>
                {provider === 'alrahuz' && (
                  <th className="px-5 py-3" title="Optional per-provider selling price when routed to Alrahuz; empty = same as Retail Price">Alrahuz Retail</th>
                )}
                <th className="px-5 py-3">Active</th>
                <th className="px-5 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={provider === 'alrahuz' ? 7 : 6} className="px-5 py-12 text-center text-gray-500">
                  <Loader2 size={20} className="animate-spin mx-auto mb-2 text-brand-500" /> Loading {providerLabel} plans…
                </td></tr>
              ) : plans.length === 0 ? (
                <tr><td colSpan={provider === 'alrahuz' ? 7 : 6} className="px-5 py-12 text-center text-gray-500">
                  <Wifi size={24} className="mx-auto mb-2 text-gray-300" /> No {providerLabel} plans available
                </td></tr>
              ) : (
                plans.map(plan => {
                  if (editingId === plan.id) {
                    return (
                      <EditRow
                        key={plan.id}
                        plan={plan}
                        provider={provider}
                        onSave={() => { setEditingId(null); onSave() }}
                        onCancel={() => setEditingId(null)}
                      />
                    )
                  }
                  return (
                    <tr key={plan.row_id || plan.id} className="table-row">
                      <td className="px-5 py-3">
                        <p className="font-medium text-gray-800">{plan.volume}</p>
                        <p className="text-xs text-gray-500">{plan.validity}</p>
                      </td>
                      {isBigi ? (
                        <>
                          <td className="px-5 py-3 text-xs text-gray-500 font-mono">{plan.bigi_plan_id ? `#${plan.bigi_plan_id}` : '—'}</td>
                          <td className="px-5 py-3 font-mono text-xs text-gray-500">₦{Number(plan.buy_price || 0).toLocaleString()}</td>
                        </>
                      ) : (
                        <>
                          <td className="px-5 py-3 text-xs text-gray-500 font-mono">{plan.alrahuz_plan_id ? `#${plan.alrahuz_plan_id}` : '—'}</td>
                          <td className="px-5 py-3 font-mono text-xs text-gray-500">
                            {plan.alrahuz_buy_price != null ? `₦${Number(plan.alrahuz_buy_price).toLocaleString()}` : '—'}
                          </td>
                        </>
                      )}
                      <td className="px-5 py-3 font-mono text-sm text-gray-800">₦{Number(plan.retail_price || 0).toLocaleString()}</td>
                      {provider === 'alrahuz' && (
                        <td className="px-5 py-3 font-mono text-xs">
                          {plan.alrahuz_plan_id
                            ? (plan.alrahuz_retail_price != null
                              ? <span className="text-purple-600">₦{Number(plan.alrahuz_retail_price).toLocaleString()}</span>
                              : <span className="text-gray-400" title="Uses the shared retail price">= retail</span>)
                            : '—'}
                        </td>
                      )}
                      <td className="px-5 py-3">
                        {plan.is_active ? (
                          <span className="inline-flex items-center gap-1 text-xs text-emerald-600">
                            <ToggleRight size={16} /> Active
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs text-gray-400">
                            <ToggleLeft size={16} /> Inactive
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-right">
                        <button
                          onClick={() => setEditingId(plan.id)}
                          className="btn-secondary !px-3 !py-1.5 !text-xs"
                        >
                          Edit
                        </button>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

export default function Plans() {
  const [plans, setPlans] = useState([])
  const [network, setNetwork] = useState(1)
  const [loading, setLoading] = useState(true)
  const [editingId, setEditingId] = useState(null)
  const [provider, setProvider] = useState('bigisub')
  const toast = useToast()

  const fetchPlans = useCallback(async () => {
    setLoading(true)
    setEditingId(null)
    try {
      const res = await api.get(`/api/v2/vtu/data/plans?network=${network}`)
      setPlans(res.data.data || [])
      if (res.data.provider) setProvider(res.data.provider)
    } catch (err) {
      toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }, [network])

  useEffect(() => { fetchPlans() }, [network])

  const bigisubPlans = plans.filter(p => p.bigi_plan_id)
  const alrahuzPlans = plans.filter(p => p.alrahuz_plan_id)

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Data Plans</h1>
          <p className="text-sm text-gray-500 mt-1">
            Manage retail pricing and availability
          </p>
        </div>

        {/* Network switcher */}
        <div className="flex gap-2 bg-gray-100 p-1 rounded-xl border border-gray-200">
          {Object.entries(networkNames).map(([id, name]) => (
            <button
              key={id}
              onClick={() => setNetwork(Number(id))}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                network === Number(id)
                  ? 'bg-brand-600 text-white shadow-sm'
                  : 'text-gray-500 hover:text-gray-700 hover:bg-white'
              }`}
            >
              {name}
            </button>
          ))}
        </div>
      </div>

      {/* Active route indicator */}
      <div className="flex items-center gap-2 text-sm text-gray-500">
        <span>Active route:</span>
        <span className={`font-medium ${provider === 'alrahuz' ? 'text-purple-600' : 'text-brand-600'}`}>
          {provider === 'alrahuz' ? 'Alrahuzdata' : 'Bigisub'}
        </span>
        <span className="text-gray-400">(change in Provider Routing)</span>
      </div>

      {/* Bigisub Plans Table */}
      <ProviderTable
        plans={bigisubPlans}
        provider="bigisub"
        editingId={editingId}
        setEditingId={setEditingId}
        onSave={fetchPlans}
        loading={loading}
      />

      {/* Alrahuz Plans Table */}
      <ProviderTable
        plans={alrahuzPlans}
        provider="alrahuz"
        editingId={editingId}
        setEditingId={setEditingId}
        onSave={fetchPlans}
        loading={loading}
      />
    </div>
  )
}
