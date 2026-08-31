import { createContext, useContext, useState, useEffect } from 'react'
import axios from 'axios'

const AuthContext = createContext(null)

const STORAGE_KEY = 'dreamhatcher.admin.session'

/** Reads the stored session WITHOUT the expiry check (used to decide whether a refresh is possible). */
export function readStoredSessionRaw() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed?.access_token) return null
    return parsed
  } catch {
    return null
  }
}

/** Returns the stored session only when it has not expired yet. */
export function readStoredSession() {
  const parsed = readStoredSessionRaw()
  if (!parsed) return null
  const expiresAt = parsed.expires_at || 0
  if (expiresAt * 1000 < Date.now()) return null
  return parsed
}

export function writeStoredSession(session) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session))
}

export function clearStoredSession() {
  localStorage.removeItem(STORAGE_KEY)
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const stored = readStoredSession()
    if (stored) {
      setSession(stored)
      setLoading(false)
      return () => { cancelled = true }
    }

    // Stored session expired (or missing) — if a refresh token exists, renew
    // silently instead of forcing a login. Fixes being logged out after the
    // ~1h access-token lifetime on a page reload.
    const raw = readStoredSessionRaw()
    if (raw?.refresh_token) {
      const API_BASE = import.meta.env.VITE_API_BASE || ''
      axios.post(`${API_BASE}/auth/refresh`, { refresh_token: raw.refresh_token })
        .then((res) => {
          if (cancelled) return
          if (res.data?.success && res.data.session?.access_token) {
            const s = {
              access_token: res.data.session.access_token,
              refresh_token: res.data.session.refresh_token || raw.refresh_token,
              expires_at: res.data.session.expires_at || Math.floor(Date.now() / 1000) + 3600,
              user: raw.user || {},
            }
            writeStoredSession(s)
            setSession(s)
          } else {
            clearStoredSession()
          }
        })
        .catch(() => { if (!cancelled) clearStoredSession() })
        .finally(() => { if (!cancelled) setLoading(false) })
      return () => { cancelled = true }
    }

    setLoading(false)
    return () => { cancelled = true }
  }, [])

  const user = session ? {
    id: session.user?.id || '',
    email: session.user?.email || '',
    full_name: session.user?.full_name || '',
  } : null

  const signIn = async (email, password) => {
    const API_BASE = import.meta.env.VITE_API_BASE || ''

    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, admin: true }),
    })

    const body = await res.json().catch(() => ({}))
    if (!res.ok || !body.success) {
      throw new Error(body.message || 'Login failed')
    }

    const accessToken = body.session?.access_token
    const refreshToken = body.session?.refresh_token
    if (!accessToken) throw new Error('No session returned')

    let exp = Math.floor(Date.now() / 1000) + 3600
    try {
      const payload = JSON.parse(atob(accessToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
      if (payload.exp) exp = payload.exp
    } catch {}

    const s = {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: exp,
      user: {
        id: body.user?.id || '',
        email: body.user?.email || email,
        full_name: body.user?.full_name || '',
      },
    }

    writeStoredSession(s)
    setSession(s)

    return body
  }

  const signOut = () => {
    clearStoredSession()
    setSession(null)
  }

  return (
    <AuthContext.Provider value={{ user, session, loading, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
