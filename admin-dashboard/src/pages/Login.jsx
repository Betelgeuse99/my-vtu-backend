import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../components/Toast'
import { Shield, ArrowRight, Loader2, Mail, Lock } from 'lucide-react'

const API_BASE = import.meta.env.VITE_API_URL || ''

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const { signInWithToken } = useAuth()
  const toast = useToast()
  const navigate = useNavigate()

  const handleLogin = async (e) => {
    e.preventDefault()
    if (!email.trim() || !password.trim()) {
      return toast.error('Email and password are required')
    }

    setLoading(true)
    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password: password.trim() })
      })

      if (!res.ok) {
        const text = await res.text()
        let msg = 'Login failed'
        try { msg = JSON.parse(text).message || msg } catch {}
        throw new Error(msg)
      }

      const json = await res.json()

      if (!json.success) {
        throw new Error(json.message || 'Login failed')
      }

      const sessionToken = json.session?.access_token
      if (!sessionToken) {
        throw new Error('No session token returned — check your credentials')
      }

      // Verify admin access
      const adminRes = await fetch(`${API_BASE}/api/v2/admin/stats`, {
        headers: { Authorization: `Bearer ${sessionToken}` }
      })

      if (!adminRes.ok) {
        const adminText = await adminRes.text()
        let adminMsg = 'Your account does not have admin access'
        try { adminMsg = JSON.parse(adminText).message || adminMsg } catch {}
        throw new Error(adminMsg)
      }

      signInWithToken(sessionToken, json.session?.refresh_token)
      toast.success(`Welcome back, ${json.user?.full_name || 'Admin'}!`)
      navigate('/')
    } catch (err) {
      toast.error(err.message || 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-brand-600/20 border border-brand-500/20 mb-4">
            <Shield size={32} className="text-brand-400" />
          </div>
          <h1 className="text-2xl font-bold text-gray-100">Dreamhatcher Admin</h1>
          <p className="text-sm text-gray-500 mt-1">Sign in to manage your VTU platform</p>
        </div>

        <form onSubmit={handleLogin} className="card space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-400 mb-1.5">Email</label>
            <div className="relative">
              <Mail size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="admin@dreamhatchertech.com"
                className="input pl-10"
                autoFocus
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-400 mb-1.5">Password</label>
            <div className="relative">
              <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="••••••••"
                className="input pl-10"
              />
            </div>
          </div>

          <button type="submit" disabled={loading || !email.trim() || !password.trim()} className="btn-primary w-full justify-center">
            {loading ? (
              <><Loader2 size={16} className="animate-spin" /> Signing in…</>
            ) : (
              <>Sign In <ArrowRight size={16} /></>
            )}
          </button>
        </form>
      </div>
    </div>
  )
}
