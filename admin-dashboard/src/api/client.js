// Centralized API client for the admin dashboard.
// Reads the auth token from localStorage and forwards it on every request.

const BASE = import.meta.env.VITE_API_BASE || ''

class ApiClient {
  _token = localStorage.getItem('admin_token') || ''

  set token(t) {
    this._token = t
    if (t) localStorage.setItem('admin_token', t)
    else localStorage.removeItem('admin_token')
  }

  get token() {
    return this._token
  }

  async _fetch(method, path, body, retries = 1) {
    const headers = { 'Content-Type': 'application/json' }
    if (this._token) headers['Authorization'] = `Bearer ${this._token}`

    // Retry once on network errors / 5xx / 429 — Render's free tier sleeps
    // and the first wake-up request can fail or crawl; a single retry hides
    // most of that flakiness from the UI.
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(BASE + path, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
        })
        const json = await res.json().catch(() => ({}))
        if (!res.ok) {
          if (attempt < retries && (res.status >= 500 || res.status === 429)) continue
          throw new Error(json.message || `HTTP ${res.status}`)
        }
        return json
      } catch (err) {
        if (attempt < retries && !(err instanceof Error && /^HTTP 4/.test(err.message))) continue
        throw err
      }
    }
  }

  // Auth
  login(token) { this.token = token }
  logout()     { this.token = '' }

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

  // ── Provider routing ─────────────────────────────────────────
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
