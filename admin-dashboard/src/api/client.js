import axios from 'axios'

const BASE = import.meta.env.VITE_API_BASE || ''
const SUPABASE_STORAGE_KEY = 'sb-lraryzkamshicildghdv-auth-token'

function getAccessToken() {
  try {
    const raw = localStorage.getItem(SUPABASE_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed.current_session?.access_token || null
  } catch { return null }
}

function getRefreshToken() {
  try {
    const raw = localStorage.getItem(SUPABASE_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed.current_session?.refresh_token || null
  } catch { return null }
}

function decodeJwt(token) {
  try {
    const base64 = token.split('.')[1]
    const json = atob(base64.replace(/-/g, '+').replace(/_/g, '/'))
    return JSON.parse(json)
  } catch { return null }
}

function persistSession(accessToken, refreshToken) {
  const payload = decodeJwt(accessToken)
  const expiresAt = payload?.exp || Math.floor(Date.now() / 1000) + 3600

  const session = {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: 3600,
    expires_at: expiresAt,
    token_type: 'bearer',
  }

  localStorage.setItem(SUPABASE_STORAGE_KEY, JSON.stringify({
    current_session: session,
    expires_at: expiresAt,
  }))
}

const api = axios.create({ baseURL: BASE })

api.interceptors.request.use(async (config) => {
  const token = getAccessToken()
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

api.interceptors.response.use(
  (res) => res,
  async (error) => {
    const original = error.config

    if (error.response?.status === 401 && !original._retry) {
      original._retry = true

      const refreshToken = getRefreshToken()
      if (!refreshToken) {
        localStorage.removeItem(SUPABASE_STORAGE_KEY)
        window.location.href = '/admin/login'
        return Promise.reject(error)
      }

      try {
        const res = await axios.post(`${BASE}/auth/refresh`, { refresh_token: refreshToken })
        if (res.data?.success && res.data.session?.access_token) {
          persistSession(res.data.session.access_token, res.data.session.refresh_token)
          original.headers.Authorization = `Bearer ${res.data.session.access_token}`
          return api(original)
        }
      } catch {
        // refresh failed
      }

      localStorage.removeItem(SUPABASE_STORAGE_KEY)
      window.location.href = '/admin/login'
      return Promise.reject(error)
    }

    return Promise.reject(error)
  }
)

export { api }
