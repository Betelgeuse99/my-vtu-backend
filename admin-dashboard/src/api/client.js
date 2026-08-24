// API client that reads the Supabase access token from our persisted
// session and uses the injected refreshSession function on 401.

const BASE = import.meta.env.VITE_API_BASE || ''

// Project ref for Supabase localStorage key
const PROJECT_REF = 'lraryzkamshicildghdv'

function getPersistedSession() {
  try {
    const raw = localStorage.getItem(`sb-${PROJECT_REF}-auth-token`)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed.current_session || null
  } catch { return null }
}

function getAccessToken() {
  const s = getPersistedSession()
  return s?.access_token || null
}

class ApiClient {
  _refreshFn = null

  /** Called by AuthContext after sign-in to inject the refresh function. */
  setRefreshFunction(fn) {
    this._refreshFn = fn
  }

  async _fetch(method, path, body) {
    const token = getAccessToken()
    const headers = { 'Content-Type': 'application/json' }
    if (token) headers['Authorization'] = `Bearer ${token}`

    const res = await fetch(BASE + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    })

    // 401 → try refresh once, then retry the request
    if (res.status === 401 && this._refreshFn) {
      try {
        const newToken = await this._refreshFn()
        const retryHeaders = { 'Content-Type': 'application/json' }
        if (newToken) retryHeaders['Authorization'] = `Bearer ${newToken}`

        const retryRes = await fetch(BASE + path, {
          method,
          headers: retryHeaders,
          body: body ? JSON.stringify(body) : undefined,
        })

        if (!retryRes.ok) {
          const json = await retryRes.json().catch(() => ({}))
          throw new Error(json.message || `HTTP ${retryRes.status}`)
        }
        return retryRes.json()
      } catch (err) {
        throw err
      }
    }

    if (!res.ok) {
      const json = await res.json().catch(() => ({}))
      throw new Error(json.message || `HTTP ${res.status}`)
    }

    return res.json()
  }

  // ── Admin endpoints ──────────────────────────────────────────
  getStats() {
    return this._fetch('GET', '/api/v2/admin/stats')
  }

  getUsers(page = 1, limit = 20, search = '') {
    const params = new URLSearchParams({ page, limit })
    if (search) params.set('search', search)
    return this._fetch('GET', `/api/v2/admin/users?${params}`)
  }

  walletAdjust(target_user_id, amount, action, reason) {
    return this._fetch('POST', '/api/v2/admin/wallet/adjust', { target_user_id, amount, action, reason })
  }

  getTransactions(page = 1, limit = 25, filters = {}) {
    const params = new URLSearchParams({ page, limit })
    if (filters.status) params.set('status', filters.status)
    if (filters.service_type) params.set('service_type', filters.service_type)
    return this._fetch('GET', `/api/v2/admin/transactions?${params}`)
  }

  refundTransaction(transaction_id, reason) {
    return this._fetch('POST', '/api/v2/admin/transactions/refund', { transaction_id, reason })
  }

  updatePlan(plan_id, retail_price, is_active, alrahuz_retail_price) {
    const body = { plan_id, retail_price, is_active }
    if (alrahuz_retail_price !== undefined) body.alrahuz_retail_price = alrahuz_retail_price
    return this._fetch('POST', '/api/v2/admin/plans/update-price', body)
  }

  getDataPlans(network = 1) {
    return this._fetch('GET', `/api/v2/vtu/data/plans?network=${network}`)
  }

  getProviders() {
    return this._fetch('GET', '/api/v2/admin/providers')
  }

  setGlobalProvider(global_provider) {
    return this._fetch('POST', '/api/v2/admin/providers/route', { global_provider })
  }

  setServiceRoute(service, provider) {
    return this._fetch('POST', '/api/v2/admin/providers/route', { service, provider })
  }
}

export const api = new ApiClient()
