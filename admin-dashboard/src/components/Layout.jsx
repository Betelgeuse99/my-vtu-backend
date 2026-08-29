import { NavLink, Outlet } from 'react-router-dom'
import { LayoutDashboard, Users, ArrowLeftRight, Wifi, LogOut, Shield, Menu, Router, ChevronsLeft, ChevronsRight } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useState } from 'react'

const navItems = [
  { to: '/',            icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/providers',   icon: Router,          label: 'Providers' },
  { to: '/users',       icon: Users,            label: 'Users' },
  { to: '/transactions', icon: ArrowLeftRight,  label: 'Transactions' },
  { to: '/plans',       icon: Wifi,             label: 'Plans' },
]

const STORAGE_KEY = 'dreamhatcher.admin.sidebar'

export default function Layout() {
  const { signOut } = useAuth()
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEY) === 'collapsed' } catch { return false }
  })
  const [mobileOpen, setMobileOpen] = useState(false)

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev
      try { localStorage.setItem(STORAGE_KEY, next ? 'collapsed' : 'expanded') } catch {}
      return next
    })
  }

  const handleLogout = () => signOut()

  const navLinkClass = ({ isActive }) =>
    `flex items-center ${collapsed ? 'justify-center px-0 mx-2' : 'gap-3 px-4 mx-2'} py-2.5 rounded-lg text-sm font-medium transition-all ${
      isActive
        ? 'bg-brand-50 text-brand-700 border border-brand-200'
        : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
    }`

  const Sidebar = () => (
    <nav className="flex flex-col gap-1 h-full">
      {/* Brand */}
      <div className={`flex items-center ${collapsed ? 'justify-center' : 'justify-between'} gap-2 px-3 py-4 mb-2`}>
        <div className="flex items-center gap-3 min-w-0">
          <div className="p-2 rounded-lg bg-brand-500 shrink-0">
            <Shield size={22} className="text-white" />
          </div>
          {!collapsed && (
            <div className="min-w-0">
              <h1 className="text-base font-bold text-gray-900 leading-tight truncate">Dreamhatcher</h1>
              <p className="text-[11px] text-brand-600 uppercase tracking-wider font-medium">Admin Panel</p>
            </div>
          )}
        </div>
        {!collapsed && (
          <button
            onClick={toggleCollapsed}
            className="p-1 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-all"
            title="Collapse sidebar"
          >
            <ChevronsLeft size={18} />
          </button>
        )}
      </div>

      {/* Nav */}
      {navItems.map(({ to, icon: Icon, label }) => (
        <NavLink
          key={to}
          to={to}
          end={to === '/'}
          onClick={() => setMobileOpen(false)}
          className={navLinkClass}
          title={collapsed ? label : undefined}
        >
          <Icon size={18} className="shrink-0" />
          {!collapsed && label}
        </NavLink>
      ))}

      {/* Footer */}
      <div className="mt-auto pt-4 border-t border-gray-200 mx-4 space-y-1">
        <button
          onClick={toggleCollapsed}
          className={`flex items-center ${collapsed ? 'justify-center px-0' : 'gap-3 px-3'} w-full py-2.5 rounded-lg text-sm text-gray-500 hover:text-gray-700 hover:bg-gray-100 transition-all`}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <ChevronsRight size={18} /> : <ChevronsLeft size={18} />}
          {!collapsed && 'Collapse'}
        </button>
        <button
          onClick={handleLogout}
          className={`flex items-center ${collapsed ? 'justify-center px-0' : 'gap-3 px-3'} w-full py-2.5 rounded-lg text-sm text-gray-500 hover:text-red-600 hover:bg-red-50 transition-all`}
          title="Sign Out"
        >
          <LogOut size={18} />
          {!collapsed && 'Sign Out'}
        </button>
      </div>
    </nav>
  )

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Desktop sidebar — collapsible to an icon rail so the content area widens */}
      <aside
        className={`hidden lg:flex flex-col bg-white border-r border-gray-200 shrink-0 transition-[width] duration-300 ease-in-out ${
          collapsed ? 'w-[68px]' : 'w-64'
        }`}
      >
        <Sidebar />
      </aside>

      {/* Mobile sidebar overlay (always full width) */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" onClick={() => setMobileOpen(false)}>
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" />
          <aside className="relative w-64 h-full bg-white border-r border-gray-200 shadow-2xl" onClick={e => e.stopPropagation()}>
            <Sidebar />
          </aside>
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile top bar */}
        <header className="lg:hidden flex items-center justify-between px-4 py-3 bg-white border-b border-gray-200">
          <button onClick={() => setMobileOpen(true)} className="text-gray-500 hover:text-gray-700">
            <Menu size={22} />
          </button>
          <h1 className="text-sm font-semibold text-gray-800">Dreamhatcher Admin</h1>
          <button onClick={handleLogout} className="text-gray-500 hover:text-red-600">
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
