import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { LayoutDashboard, Users, ArrowLeftRight, Wifi, LogOut, Shield, Menu, Router } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useState } from 'react'

const navItems = [
  { to: '/',            icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/providers',   icon: Router,          label: 'Providers' },
  { to: '/users',       icon: Users,            label: 'Users' },
  { to: '/transactions', icon: ArrowLeftRight,  label: 'Transactions' },
  { to: '/plans',       icon: Wifi,             label: 'Plans' },
]

export default function Layout() {
  const { signOut } = useAuth()
  const navigate = useNavigate()
  const [mobileOpen, setMobileOpen] = useState(false)

  const handleLogout = () => {
    signOut()
    navigate('/login')
  }

  const Sidebar = () => (
    <nav className="flex flex-col gap-1">
      <div className="flex items-center gap-3 px-4 py-5 mb-2">
        <div className="p-2 rounded-lg bg-brand-600/20">
          <Shield size={22} className="text-brand-400" />
        </div>
        <div>
          <h1 className="text-base font-bold text-gray-100 leading-tight">Dreamhatcher</h1>
          <p className="text-[11px] text-gray-500 uppercase tracking-wider">Admin Panel</p>
        </div>
      </div>

      {navItems.map(({ to, icon: Icon, label }) => (
        <NavLink
          key={to}
          to={to}
          end={to === '/'}
          onClick={() => setMobileOpen(false)}
          className={({ isActive }) =>
            `flex items-center gap-3 px-4 py-2.5 mx-2 rounded-lg text-sm font-medium transition-all ${
              isActive
                ? 'bg-brand-600/15 text-brand-400 border border-brand-500/20'
                : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'
            }`
          }
        >
          <Icon size={18} />
          {label}
        </NavLink>
      ))}

      <div className="mt-auto pt-4 border-t border-gray-800 mx-4">
        <button
          onClick={handleLogout}
          className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm text-gray-400 hover:text-red-400 hover:bg-red-500/10 transition-all"
        >
          <LogOut size={18} />
          Sign Out
        </button>
      </div>
    </nav>
  )

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Desktop sidebar */}
      <aside className="hidden lg:flex w-64 flex-col bg-gray-900/80 border-r border-gray-800 shrink-0">
        <Sidebar />
      </aside>

      {/* Mobile sidebar overlay */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" onClick={() => setMobileOpen(false)}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <aside className="relative w-64 h-full bg-gray-900 border-r border-gray-800 shadow-2xl" onClick={e => e.stopPropagation()}>
            <Sidebar />
          </aside>
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile top bar */}
        <header className="lg:hidden flex items-center justify-between px-4 py-3 bg-gray-900/80 border-b border-gray-800">
          <button onClick={() => setMobileOpen(true)} className="text-gray-400 hover:text-gray-200">
            <Menu size={22} />
          </button>
          <h1 className="text-sm font-semibold text-gray-200">Dreamhatcher Admin</h1>
          <button onClick={handleLogout} className="text-gray-400 hover:text-red-400">
            <LogOut size={18} />
          </button>
        </header>

        <main className="flex-1 overflow-y-auto p-4 lg:p-8">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
