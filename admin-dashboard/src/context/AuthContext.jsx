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

  // ── 1. Hydrate session from Supabase storage + subscribe ──
  useEffect(() => {
    let lastActivity = Date.now()

    // getSession() reads from Supabase's own localStorage key.
    // Returns immediately if cached, no network call.
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s)
      setUser(s?.user ?? null)
      setAuthReady(true)
    })

    // Fires on SIGNED_IN, SIGNED_OUT, TOKEN_REFRESHED, INITIAL_SESSION
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, s) => {
        setSession(s)
        setUser(s?.user ?? null)
        setAuthReady(true)
      }
    )

    // ── Idle-logout ──
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
    }
  }, [navigate])

  // ── 2. Sign in via Supabase directly, then verify admin ──
  const signIn = useCallback(async (email, password) => {
    const API_BASE = import.meta.env.VITE_API_BASE || ''

    // Authenticate directly against Supabase Auth (uses the anon key).
    // No backend round-trip — Supabase handles password verification.
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    })
    if (error) throw error
    if (!data?.session?.access_token) {
      throw new Error('No session returned from Supabase')
    }

    // Verify this user has admin access via our backend
    const adminRes = await fetch(`${API_BASE}/api/v2/admin/stats`, {
      headers: { Authorization: `Bearer ${data.session.access_token}` },
    })
    if (!adminRes.ok) {
      const body = await adminRes.json().catch(() => ({}))
      // Sign out from Supabase since this user is not an admin
      await supabase.auth.signOut()
      throw new Error(body.message || 'Your account does not have admin access')
    }

    return data
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
