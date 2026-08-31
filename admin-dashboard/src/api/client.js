import axios from 'axios'
import { readStoredSession, writeStoredSession, clearStoredSession } from '../context/AuthContext'

const BASE = import.meta.env.VITE_API_BASE || ''

const api = axios.create({ baseURL: BASE })

api.interceptors.request.use((config) => {
  const s = readStoredSession()
  if (s?.access_token) config.headers.Authorization = `Bearer ${s.access_token}`
  return config
})

api.interceptors.response.use(
  (res) => res,
  async (error) => {
    const original = error.config

    // The dashboard only calls admin-gated endpoints; a 403 means the signed-in
    // account is not an admin — drop the session and bounce to login instead of
    // showing a wall of errors.
    if (error.response?.status === 403) {
      clearStoredSession()
      window.location.hash = '#/login'
      return Promise.reject(error)
    }

    if (error.response?.status === 401 && !original._retry) {
      original._retry = true

      const s = readStoredSession()
      if (!s?.refresh_token) {
        clearStoredSession()
        window.location.hash = '#/login'
        return Promise.reject(error)
      }

      try {
        const res = await axios.post(`${BASE}/auth/refresh`, { refresh_token: s.refresh_token })
        if (res.data?.success && res.data.session?.access_token) {
          writeStoredSession({
            ...s,
            access_token: res.data.session.access_token,
            refresh_token: res.data.session.refresh_token || s.refresh_token,
            ...(res.data.session.expires_at ? { expires_at: res.data.session.expires_at } : {}),
          })
          original.headers.Authorization = `Bearer ${res.data.session.access_token}`
          return api(original)
        }
        throw new Error('Refresh failed')
      } catch {
        clearStoredSession()
        window.location.hash = '#/login'
        return Promise.reject(error)
      }
    }

    return Promise.reject(error)
  }
)

export { api }
