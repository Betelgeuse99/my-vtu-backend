import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabaseClient'

const AuthContext = createContext(null)

const SUPABASE_STORAGE_KEY = 'sb-lraryzkamshicildghdv-auth-token'

function decodeJwt(token) {
  try {
    const base64 = token.split('.')[1]
    const json = atob(base64.replace(/-/g, '+').replace(/_/g, '/'))
    return JSON.parse(json)
  } catch { return null }
}

function writeToSupabaseStorage(accessToken, refreshToken) {
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

  return session
}

function clearSupabaseStorage() {
  localStorage.removeItem(SUPABASE_STORAGE_KEY)
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let mounted = true

    supabase.auth.getSession().then(({ data: { session: s } }) => {
      if (!mounted) return
      setSession(s)
      setUser(s?.user ?? null)
      setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, s) => {
        if (!mounted) return
        setSession(s)
        setUser(s?.user ?? null)
        setLoading(false)
      }
    )

    return () => {
      mounted = false
      subscription.unsubscribe()
    }
  }, [])

  const signIn = useCallback(async (email, password) => {
    const API_BASE = import.meta.env.VITE_API_BASE || ''

    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })

    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.message || 'Login failed')
    }

    const body = await res.json()
    if (!body.success) throw new Error(body.message || 'Login failed')

    const accessToken = body.session?.access_token
    const refreshToken = body.session?.refresh_token
    if (!accessToken) throw new Error('No session returned')

    const s = writeToSupabaseStorage(accessToken, refreshToken)
    setSession(s)
    setUser(decodeJwt(accessToken))

    return body
  }, [])

  const signOut = useCallback(async () => {
    clearSupabaseStorage()
    setSession(null)
    setUser(null)
    await supabase.auth.signOut()
  }, [])

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
