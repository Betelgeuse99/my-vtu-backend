import axios from 'axios'

const BASE = import.meta.env.VITE_API_BASE || ''
const STORAGE_KEY = 'sb-lraryzkamshicildghdv-auth-token'

function decodeJwt(token) {
  try {
    const base64 = token.split('.')[1]
    const json = atob(base64.replace(/-/g, '+').replace(/_/g, '/'))
    return JSON.parse(json)
  } catch { return null }
}

function readSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw).current_session || null
  } catch { return null }
}

function persistSession(accessToken, refreshToken, existingUser) {
  const payload = decodeJwt(accessToken)
  const expiresAt = payload?.exp || Math.floor(Date.now() / 1000) + 3600

  const user = existingUser || {
    id: payload?.sub || '',
    email: payload?.email || '',
    aud: payload?.aud || 'authenticated',
    role: payload?.role || 'authenticated',
    app_metadata: {},
    user_metadata: {},
    identities: [],
    created_at: '',
    updated_at: '',
  }

  const session = {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: 3600,
    expires_at: expiresAt,
    token_type: 'bearer',
    provider_token: null,
    provider_refresh_token: null,
    user,
  }

  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    current_session: session,
    expires_at: expiresAt,
  }))
}

const api = axios.create({ baseURL: BASE })

api.interceptors.request.use(async (config) => {
  const s = readSession()
  if (s?.access_token) config.headers.Authorization = `Bearer ${s.access_token}`
  return config
})

api.interceptors.response.use(
  (res) => res,
  async (error) => {
    const original = error.config

    if (error.response?.status === 401 && !original._retry) {
      original._retry = true

      const s = readSession()
      const refreshToken = s?.refresh_token
      if (!refreshToken) {
        localStorage.removeItem(STORAGE_KEY)
        window.location.href = '/admin/login'
        return Promise.reject(error)
      }

      try {
        const res = await axios.post(`${BASE}/auth/refresh`, { refresh_token: refreshToken })
        if (res.data?.success && res.data.session?.access_token) {
          persistSession(res.data.session.access_token, res.data.session.refresh_token, s?.user)
          original.headers.Authorization = `Bearer ${res.data.session.access_token}`
          return api(original)
        }
      } catch {}

      localStorage.removeItem(STORAGE_KEY)
      window.location.href = '/admin/login'
      return Promise.reject(error)
    }

    return Promise.reject(error)
  }
)

export { api }
