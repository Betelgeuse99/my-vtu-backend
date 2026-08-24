import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react'
import { api } from '../api/client'
import { useNavigate } from 'react-router-dom'

const AuthContext = createContext(null)

// Auto-logout after 20 minutes of NO interaction (click/keypress/mouse move).
// Matches the reference dashboard's session-timeout behaviour.
const IDLE_TIMEOUT_MS = 20 * 60 * 1000
const ACTIVITY_EVENTS = ['mousedown', 'keydown', 'click', 'touchstart', 'scroll']

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const lastActivity = useRef(Date.now())
  const navigate = useNavigate()

  useEffect(() => {
    // Trust the stored token — the first admin API call verifies it, and a
    // stale access token is refreshed transparently by the api client.
    const token = api.token
    if (token) setUser({ token })
    setLoading(false)
  }, [])

  // ── Activity tracking + idle logout ──────────────────────────
  useEffect(() => {
    if (!user) return

    const markActive = () => { lastActivity.current = Date.now() }
    ACTIVITY_EVENTS.forEach(e => window.addEventListener(e, markActive, { passive: true }))

    const checkIdle = setInterval(() => {
      if (Date.now() - lastActivity.current > IDLE_TIMEOUT_MS) {
        api.logout()
        setUser(null)
        clearInterval(checkIdle)
        navigate('/login')
      }
    }, 30 * 1000)

    return () => {
      ACTIVITY_EVENTS.forEach(e => window.removeEventListener(e, markActive))
      clearInterval(checkIdle)
    }
  }, [user, navigate])

  const signInWithToken = useCallback((token, refreshToken) => {
    api.login(token, refreshToken)
    lastActivity.current = Date.now()
    setUser({ token })
  }, [])

  const signOut = useCallback(() => {
    api.logout()
    setUser(null)
  }, [])

  return (
    <AuthContext.Provider value={{ user, loading, signInWithToken, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
