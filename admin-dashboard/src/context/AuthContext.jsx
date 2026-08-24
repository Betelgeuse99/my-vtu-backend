import { createContext, useContext, useState, useEffect } from 'react'

const AuthContext = createContext(null)

const STORAGE_KEY = 'dreamhatcher.admin.session'

export function readStoredSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed?.access_token) return null
    const expiresAt = parsed.expires_at || 0
    if (expiresAt * 1000 < Date.now()) return null
    return parsed
  } catch {
    return null
  }
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
    setSession(readStoredSession())
    setLoading(false)
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
      body: JSON.stringify({ email, password }),
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
