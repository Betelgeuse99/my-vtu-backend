import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useEffect } from 'react'
import { AuthProvider, useAuth } from './context/AuthContext'
import { ToastProvider } from './components/Toast'
import { api } from './api/client'
import Layout from './components/Layout'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Providers from './pages/Providers'
import Users from './pages/Users'
import Transactions from './pages/Transactions'
import Plans from './pages/Plans'
import { Loader2 } from 'lucide-react'

function RequireAuth({ children }) {
  const { user, authReady, refreshSession } = useAuth()

  useEffect(() => {
    if (refreshSession) api.setRefreshFunction(refreshSession)
  }, [refreshSession])

  if (!authReady) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 size={28} className="animate-spin text-brand-400" />
      </div>
    )
  }

  return user ? children : <Navigate to="/login" replace />
}

function PublicOnly({ children }) {
  const { user, authReady } = useAuth()

  if (!authReady) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 size={28} className="animate-spin text-brand-400" />
      </div>
    )
  }

  return user ? <Navigate to="/" replace /> : children
}

export default function App() {
  return (
    <BrowserRouter basename="/admin">
      <AuthProvider>
        <ToastProvider>
          <Routes>
            <Route
              path="/login"
              element={<PublicOnly><Login /></PublicOnly>}
            />
            <Route
              element={<RequireAuth><Layout /></RequireAuth>}
            >
              <Route index element={<Dashboard />} />
              <Route path="providers" element={<Providers />} />
              <Route path="users" element={<Users />} />
              <Route path="transactions" element={<Transactions />} />
              <Route path="plans" element={<Plans />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  )
}
