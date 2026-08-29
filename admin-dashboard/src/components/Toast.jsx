import { createContext, useContext, useState, useCallback } from 'react'
import { X, CheckCircle, AlertTriangle, Info } from 'lucide-react'

const ToastContext = createContext(null)

let toastId = 0

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])

  const remove = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  const add = useCallback((message, type = 'info', duration = 4000) => {
    const id = ++toastId
    setToasts(prev => [...prev, { id, message, type }])
    if (duration > 0) setTimeout(() => remove(id), duration)
    return id
  }, [remove])

  const toast = {
    success: (msg, dur) => add(msg, 'success', dur),
    error:   (msg, dur) => add(msg, 'error', dur ?? 5000),
    info:    (msg, dur) => add(msg, 'info', dur),
  }

  const icons = {
    success: <CheckCircle size={18} className="text-emerald-500 shrink-0" />,
    error:   <AlertTriangle size={18} className="text-red-500 shrink-0" />,
    info:    <Info size={18} className="text-blue-500 shrink-0" />,
  }

  const bgColors = {
    success: 'border-emerald-200 bg-emerald-50',
    error:   'border-red-200 bg-red-50',
    info:    'border-blue-200 bg-blue-50',
  }

  return (
    <ToastContext.Provider value={toast}>
      {children}
      {/* Toast container */}
      <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
        {toasts.map(t => (
          <div
            key={t.id}
            className={`toast-enter flex items-start gap-3 px-4 py-3 rounded-lg border shadow-xl ${bgColors[t.type] || bgColors.info}`}
          >
            {icons[t.type] || icons.info}
            <span className="text-sm text-gray-700 flex-1">{t.message}</span>
            <button onClick={() => remove(t.id)} className="text-gray-400 hover:text-gray-600 shrink-0 mt-0.5">
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within ToastProvider')
  return ctx
}
