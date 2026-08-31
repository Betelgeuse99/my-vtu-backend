import { Sun, Moon } from 'lucide-react'
import { useTheme } from '../context/ThemeContext'

/**
 * Dark/light theme toggle. Renders in the style of .btn-secondary by default
 * (icon + label) so it sits naturally next to the Refresh button. Pass a custom
 * className / showLabel to embed it elsewhere (sidebar, mobile top bar).
 */
export default function ThemeToggle({
  showLabel = true,
  iconSize = 14,
  className = 'btn-secondary',
}) {
  const { theme, toggle } = useTheme()
  const isDark = theme === 'dark'
  const label = isDark ? 'Light' : 'Dark'

  return (
    <button
      type="button"
      onClick={toggle}
      className={className}
      title={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
    >
      {isDark ? <Sun size={iconSize} /> : <Moon size={iconSize} />}
      {showLabel && <span className="hidden sm:inline">{label}</span>}
    </button>
  )
}
