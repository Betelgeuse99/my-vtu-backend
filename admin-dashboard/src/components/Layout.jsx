import { NavLink, Outlet } from 'react-router-dom'
import { LayoutDashboard, Users, ArrowLeftRight, Wifi, LogOut, Menu, Router, ChevronsLeft, ChevronsRight, Building2 } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import ThemeToggle from './ThemeToggle'
import { useState } from 'react'

const navItems = [
  { to: '/',            icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/providers',   icon: Router,          label: 'Providers' },
  { to: '/users',       icon: Users,            label: 'Users' },
  { to: '/transactions', icon: ArrowLeftRight,  label: 'Transactions' },
  { to: '/plans',       icon: Wifi,             label: 'Plans' },
  { to: '/cac',         icon: Building2,        label: 'CAC' },
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
        ? 'bg-brand-900/50 text-brand-300 border border-brand-700'
        : 'text-gray-400 hover:text-gray-100 hover:bg-slate-700/50'
    }`

  const Sidebar = () => (
    <nav className="flex flex-col gap-1 h-full">
      {/* Brand */}
      <div className={`flex items-center ${collapsed ? 'justify-center' : 'justify-between'} gap-2 px-3 py-4 mb-2`}>
        <div className="flex items-center gap-3 min-w-0">
          <img src={`${import.meta.env.BASE_URL}dhtlogo.png`} alt="Dreamhatcher Logo" className="w-9 h-9 object-contain shrink-0" />
          {!collapsed && (
            <div className="min-w-0">
              <h1 className="text-base font-bold text-slate-100 leading-tight truncate">Dreamhatcher</h1>
              <p className="text-[11px] text-brand-600 uppercase tracking-wider font-medium">Admin Panel</p>
            </div>
          )}
        </div>
        {!collapsed && (
          <button
            onClick={toggleCollapsed}
            className="p-1 rounded-lg text-gray-400 hover:text-gray-200 hover:bg-slate-700 transition-all"
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
      <div className="mt-auto pt-4 border-t border-slate-700 mx-4 space-y-1">
        <ThemeToggle
          showLabel={!collapsed}
          iconSize={18}
          className={`flex items-center ${collapsed ? 'justify-center px-0' : 'gap-3 px-3'} w-full py-2.5 rounded-lg text-sm text-gray-400 hover:text-gray-200 hover:bg-slate-700 transition-all`}
        />
        <button
          onClick={toggleCollapsed}
          className={`flex items-center ${collapsed ? 'justify-center px-0' : 'gap-3 px-3'} w-full py-2.5 rounded-lg text-sm text-gray-400 hover:text-gray-200 hover:bg-slate-700 transition-all`}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <ChevronsRight size={18} /> : <ChevronsLeft size={18} />}
          {!collapsed && 'Collapse'}
        </button>
        <button
          onClick={handleLogout}
          className={`flex items-center ${collapsed ? 'justify-center px-0' : 'gap-3 px-3'} w-full py-2.5 rounded-lg text-sm text-gray-400 hover:text-red-400 hover:bg-red-900/30 transition-all`}
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
        className={`hidden lg:flex flex-col bg-slate-800 border-r border-slate-700 shrink-0 transition-[width] duration-300 ease-in-out ${
          collapsed ? 'w-[68px]' : 'w-64'
        }`}
      >
        <Sidebar />
      </aside>

      {/* Mobile sidebar overlay (always full width) */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" onClick={() => setMobileOpen(false)}>
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" />
          <aside className="relative w-64 h-full bg-slate-800 border-r border-slate-700 shadow-2xl" onClick={e => e.stopPropagation()}>
            <Sidebar />
          </aside>
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile top bar */}
        <header className="lg:hidden flex items-center justify-between px-4 py-3 bg-slate-800 border-b border-slate-700">
          <button onClick={() => setMobileOpen(true)} className="text-gray-400 hover:text-gray-200">
            <Menu size={22} />
          </button>
          <h1 className="text-sm font-semibold text-slate-100">Dreamhatcher Admin</h1>
          <div className="flex items-center gap-2">
            <ThemeToggle showLabel={false} iconSize={18} className="p-2 rounded-lg text-gray-400 hover:text-gray-200 hover:bg-slate-700 transition-all" />
            <button onClick={handleLogout} className="text-gray-400 hover:text-red-400">
              <LogOut size={18} />
            </button>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-4 lg:p-8">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
