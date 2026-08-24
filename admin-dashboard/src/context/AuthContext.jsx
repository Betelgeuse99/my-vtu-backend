import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

const AuthContext = createContext(null)

const IDLE_TIMEOUT_MS = 20 * 60 * 1000
const ACTIVITY_EVENTS = ['mousedown', 'keydown', 'click', 'touchstart', 'scroll']

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [session, setSession] = useState(null)
  const [authReady, setAuthReady] = useState(false)
  const navigate = useNavigate()

  // ── 1. Hydrate session from storage + subscribe to changes ──
  useEffect(() => {
    let idleTimer = null
    let lastActivity = Date.now()

    // Get the existing session from Supabase's internal storage.
    // This is the ONLY source of truth — no manual localStorage reads.
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s)
      setUser(s?.user ?? null)
      setAuthReady(true)
    })

    // Subscribe to ALL auth state changes: SIGNED_IN, SIGNED_OUT,
    // TOKEN_REFRESHED, etc. This fires on page refresh (storage rehydration),
    // on login, on logout, and after automatic token refresh.
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, s) => {
        setSession(s)
        setUser(s?.user ?? null)
        setAuthReady(true)
      }
    )

    // ── Idle-logout tracking ──
    const markActive = () => { lastActivity = Date.now() }
    ACTIVITY_EVENTS.forEach(e => window.addEventListener(e, markActive, { passive: true }))

    const checkIdle = setInterval(() => {
      if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
        supabase.auth.signOut()
        navigate('/login')
      }
    }, 30_000)

    return () => {
      subscription.unsubscribe()
      ACTIVITY_EVENTS.forEach(e => window.removeEventListener(e, markActive))
      clearInterval(checkIdle)
      if (idleTimer) clearTimeout(idleTimer)
    }
  }, [navigate])

  // ── 2. Sign in via backend, then set the Supabase session ──
  const signIn = useCallback(async (email, password) => {
    const API_BASE = import.meta.env.VITE_API_BASE || ''

    // Authenticate through the backend (which uses the service-role key)
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

    const { session: supabaseSession } = body
    if (!supabaseSession?.access_token) {
      throw new Error('No session returned from server')
    }

    // Verify admin access
    const adminRes = await fetch(`${API_BASE}/api/v2/admin/stats`, {
      headers: { Authorization: `Bearer ${supabaseSession.access_token}` },
    })
    if (!adminRes.ok) {
      throw new Error('Your account does not have admin access')
    }

    // Set the session in Supabase's client — this writes to
    // localStorage under the Supabase key and makes getSession()
    // return the valid session on future page loads.
    const { error } = await supabase.auth.setSession({
      access_token: supabaseSession.access_token,
      refresh_token: supabaseSession.refresh_token,
    })
    if (error) throw error

    return body
  }, [])

  // ── 3. Sign out ──
  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
    navigate('/login')
  }, [navigate])

  return (
    <AuthContext.Provider value={{ user, session, authReady, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
