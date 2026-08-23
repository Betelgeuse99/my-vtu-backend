import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { api } from '../api/client'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // On mount, if a token exists, try to validate it by hitting /health
    // or simply trust the stored token and let the first admin call verify it
    const token = api.token
    if (token) {
      setUser({ token })
    }
    setLoading(false)
  }, [])

  const signInWithToken = useCallback((token) => {
    api.login(token)
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
