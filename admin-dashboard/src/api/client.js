// API client that dynamically reads the Supabase access token from the
// client-side Supabase session on every request. Handles 401s by
// calling supabase.auth.refreshSession() and replaying the failed request.

import { supabase } from '../lib/supabase'

const BASE = import.meta.env.VITE_API_BASE || ''

class ApiClient {
  // No token state stored here — the source of truth is supabase.auth.getSession()

  async _getToken() {
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token || null
  }

  async _doRefresh() {
    const { data, error } = await supabase.auth.refreshSession()
    if (error || !data?.session) {
      throw new Error('Session expired — please sign in again')
    }
    return data.session.access_token
  }

  async _fetch(method, path, body, _retries = 1, _refreshed = false) {
    const token = await this._getToken()
    const headers = { 'Content-Type': 'application/json' }
    if (token) headers['Authorization'] = `Bearer ${token}`

    const res = await fetch(BASE + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    })

    // 401 → refresh session once, then retry
    if (res.status === 401 && !_refreshed) {
      const newToken = await this._doRefresh()
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
