// Centralized API client for the admin dashboard.
// Reads the auth token from localStorage and forwards it on every request.
// Handles Supabase's 1h access-token expiry transparently: a refresh token
// is stored alongside and exchanged via /auth/refresh whenever a call 401s.

const BASE = import.meta.env.VITE_API_BASE || ''

class ApiClient {
  _token = localStorage.getItem('admin_token') || ''
  _refresh = localStorage.getItem('admin_refresh') || ''
  _refreshing = null
  _lastRefreshFailed = false

  set token(t) {
    this._token = t
    if (t) localStorage.setItem('admin_token', t)
    else localStorage.removeItem('admin_token')
  }

  get token() {
    return this._token
  }

  set refresh(t) {
    this._refresh = t
    if (t) localStorage.setItem('admin_refresh', t)
    else localStorage.removeItem('admin_refresh')
  }

  get refresh() {
    return this._refresh
  }

  get isSessionValid() {
    return !this._lastRefreshFailed
  }

  login(token, refreshToken) {
    this.token = token
    this.refresh = refreshToken || ''
    this._lastRefreshFailed = false
  }

  logout() {
    this.token = ''
    this.refresh = ''
  }

  /** Exchange the stored refresh token for a fresh session. */
  async _doRefresh() {
    if (!this._refresh) throw new Error('Session expired — please sign in again')
    // Coalesce concurrent refreshes into one request
    this._refreshing = this._refreshing || (async () => {
      const res = await fetch(BASE + '/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: this._refresh }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        // Refresh failed — mark session invalid but DO NOT clear tokens.
        // Clearing tokens would redirect to login and wipe the dashboard.
        // The dashboard keeps showing cached data instead.
        this._lastRefreshFailed = true
        throw new Error(json.message || 'Session expired — please sign in again')
      }
      this.login(json.session.access_token, json.session.refresh_token)
      return true
    })()
    try {
      return await this._refreshing
    } finally {
      this._refreshing = null
    }
  }

  async _fetch(method, path, body, retries = 1, refreshed = false) {
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

        // Access token expired — refresh once and replay the request
        if (res.status === 401 && !refreshed && this._refresh) {
          await this._doRefresh()
          return this._fetch(method, path, body, retries, true)
        }

        const json = await res.json().catch(() => ({}))
        if (!res.ok) {
          if (attempt < retries && (res.status >= 500 || res.status === 429)) continue
          throw new Error(json.message || `HTTP ${res.status}`)
        }
        return json
      } catch (err) {
        if (
          attempt < retries &&
          !(err instanceof Error && /^HTTP 4/.test(err.message)) &&
          !(err instanceof Error && err.message.includes('sign in'))
        ) continue
        throw err
      }
    }
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
