import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

const AuthContext = createContext(null)

const IDLE_TIMEOUT_MS = 20 * 60 * 1000
const ACTIVITY_EVENTS = ['mousedown', 'keydown', 'click', 'touchstart', 'scroll']

// Decode a JWT payload (no verification — just reading the exp claim)
function decodeJwt(token) {
  try {
    const base64 = token.split('.')[1]
    const json = atob(base64.replace(/-/g, '+').replace(/_/g, '/'))
    return JSON.parse(json)
  } catch { return null }
}

// Write a Supabase session into localStorage in the exact format the JS
// client expects, so getSession() finds it on the next page load and
// onAuthStateChange fires INITIAL_SESSION.
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

  const container = {
    current_session: session,
    expires_at: expiresAt,
  }

  // Supabase JS v2 storage key: sb-<project-ref>-auth-token
  const projectRef = 'lraryzkamshicildghdv'
  localStorage.setItem(`sb-${projectRef}-auth-token`, JSON.stringify(container))
}

function clearPersistedSession() {
  const projectRef = 'lraryzkamshicildghdv'
  localStorage.removeItem(`sb-${projectRef}-auth-token`)
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [session, setSession] = useState(null)
  const [authReady, setAuthReady] = useState(false)
  const navigate = useNavigate()

  // ── 1. Hydrate: try Supabase's own storage first, then check expiry ──
  useEffect(() => {
    let lastActivity = Date.now()

    // Check if we have a persisted session (written by persistSession above)
    const projectRef = 'lraryzkamshicildghdv'
    const raw = localStorage.getItem(`sb-${projectRef}-auth-token`)
    if (raw) {
      try {
        const parsed = JSON.parse(raw)
        const s = parsed.current_session
        if (s?.access_token) {
          // Check if expired
          const expiresAt = parsed.expires_at || s.expires_at || 0
          const now = Math.floor(Date.now() / 1000)
          if (expiresAt > now) {
            // Session is valid — set it
            setSession(s)
            setUser(decodeJwt(s.access_token))
            setAuthReady(true)

            // Let Supabase client know about this session too
            // (best-effort, won't make API calls if CORS blocks it)
            supabase.auth.getSession().catch(() => {})
          } else {
            // Session expired — clear it
            clearPersistedSession()
            setAuthReady(true)
          }
        } else {
          setAuthReady(true)
        }
      } catch {
        setAuthReady(true)
      }
    } else {
      setAuthReady(true)
    }

    // ── Idle-logout ──
    const markActive = () => { lastActivity = Date.now() }
    ACTIVITY_EVENTS.forEach(e => window.addEventListener(e, markActive, { passive: true }))

    const checkIdle = setInterval(() => {
      if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
        clearPersistedSession()
        setSession(null)
        setUser(null)
        navigate('/login')
      }
    }, 30_000)

    return () => {
      ACTIVITY_EVENTS.forEach(e => window.removeEventListener(e, markActive))
      clearInterval(checkIdle)
    }
  }, [navigate])

  // ── 2. Sign in via backend (server-side Supabase auth, no CORS) ──
  const signIn = useCallback(async (email, password) => {
    const API_BASE = import.meta.env.VITE_API_BASE || ''

    // Backend handles supabase.auth.signInWithPassword() with the service
    // role key — no CORS issues since it's server-to-server.
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
    if (!accessToken) throw new Error('No session returned from server')

    // Verify admin access
    const adminRes = await fetch(`${API_BASE}/api/v2/admin/stats`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!adminRes.ok) {
      throw new Error('Your account does not have admin access')
    }

    // Persist to Supabase's localStorage format so getSession() works
    // on page refresh. No supabase.auth.setSession() call — avoids CORS.
    persistSession(accessToken, refreshToken)

    const s = {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: body.session.expires_in || 3600,
      expires_at: body.session.expires_at || Math.floor(Date.now() / 1000) + 3600,
      token_type: 'bearer',
    }

    setSession(s)
    setUser(decodeJwt(accessToken))

    return body
  }, [])

  // ── 3. Sign out ──
  const signOut = useCallback(async () => {
    clearPersistedSession()
    setSession(null)
    setUser(null)
    navigate('/login')
  }, [navigate])

  // ── 4. Token refresh (called by client.js on 401) ──
  const refreshSession = useCallback(async () => {
    const API_BASE = import.meta.env.VITE_API_BASE || ''

    if (!session?.refresh_token) throw new Error('No refresh token')

    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    })

    if (!res.ok) {
      clearPersistedSession()
      setSession(null)
      setUser(null)
      throw new Error('Session expired — please sign in again')
    }

    const body = await res.json()
    if (!body.success || !body.session?.access_token) {
      throw new Error('Session refresh failed')
    }

    persistSession(body.session.access_token, body.session.refresh_token)

    const s = {
      access_token: body.session.access_token,
      refresh_token: body.session.refresh_token,
      expires_in: body.session.expires_in || 3600,
      expires_at: body.session.expires_at || Math.floor(Date.now() / 1000) + 3600,
      token_type: 'bearer',
    }

    setSession(s)
    setUser(decodeJwt(body.session.access_token))

    return body.session.access_token
  }, [session])

  return (
    <AuthContext.Provider value={{ user, session, authReady, signIn, signOut, refreshSession }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
