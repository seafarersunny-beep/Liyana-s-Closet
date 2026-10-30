import { useEffect, useRef } from 'react'
import { HashRouter, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { HouseholdProvider, useHousehold } from './lib/household'
import { backendConfigured } from './lib/supabase'
import { emit } from './lib/events'
import { sound } from './lib/sound'
import { AuthScreen, SetupScreen } from './screens/Auth'
import { HomeScreen, useProgress } from './screens/Home'
import { ItemScreen, RegistryScreen } from './screens/Registry'
import { InventoryScreen, useAlerts } from './screens/Inventory'
import { SpendingScreen } from './screens/Spending'
import { AskAIScreen } from './screens/AskAI'
import { SettingsScreen } from './screens/Settings'
import { ImportScreen } from './screens/Import'
import { Mascot } from './components/Mascot'
import { Celebration, SyncBadge, Toaster } from './components/ui'

const NAV = [
  { to: '/', label: 'Home', icon: '⌂' },
  { to: '/registry', label: 'Registry', icon: '✿' },
  { to: '/inventory', label: 'Inventory', icon: '▤' },
  { to: '/spending', label: 'Spending', icon: '$' },
  { to: '/ai', label: 'AI', icon: '✦' },
]

function BottomNav() {
  const { out, low } = useAlerts()
  return (
    <nav className="bottom-nav" aria-label="Main">
      {NAV.map((n) => (
        <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => (isActive ? 'active' : '')} onClick={() => sound.tap()}>
          <span className="nav-icon" aria-hidden="true">{n.icon}</span>
          <span>{n.label}</span>
          {n.to === '/inventory' && out.length + low.length > 0 && <span className="nav-dot" aria-label={`${out.length + low.length} alerts`}>{out.length + low.length}</span>}
        </NavLink>
      ))}
    </nav>
  )
}

// Celebrate registry milestones once per device as they are reached.
function Milestones() {
  const { pct, total } = useProgress()
  const prev = useRef<number | null>(null)
  useEffect(() => {
    if (!total) return
    if (prev.current != null && pct > prev.current) {
      const hit = [25, 50, 75, 100].filter((m) => prev.current! < m && pct >= m).pop()
      if (hit) {
        let seen: number[] = []
        try {
          seen = JSON.parse(localStorage.getItem('liyanas-closet-milestones') ?? '[]')
        } catch {
          /* ignore */
        }
        if (!seen.includes(hit)) {
          emit({ type: 'milestone', message: hit === 100 ? 'Everything is ready for Liyana! 🎀' : `${hit}% of the registry is ready!` })
          try {
            localStorage.setItem('liyanas-closet-milestones', JSON.stringify([...seen, hit]))
          } catch {
            /* ignore */
          }
        }
      }
    }
    prev.current = pct
  }, [pct, total])
  return null
}

function Shell() {
  const loc = useLocation()
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [loc.pathname])
  return (
    <div className="app">
      <SyncBadge />
      <div className="top-bar">
        <span className="top-brand"><Mascot size={30} react={false} /> Liyana’s Closet</span>
        <NavLink to="/settings" className="icon-btn" aria-label="Settings">⚙</NavLink>
      </div>
      <main key={loc.pathname} className="page">
        <Routes>
          <Route path="/" element={<HomeScreen />} />
          <Route path="/registry" element={<RegistryScreen />} />
          <Route path="/item/:id" element={<ItemScreen />} />
          <Route path="/inventory" element={<InventoryScreen />} />
          <Route path="/spending" element={<SpendingScreen />} />
          <Route path="/ai" element={<AskAIScreen />} />
          <Route path="/settings" element={<SettingsScreen />} />
          <Route path="/import" element={<ImportScreen />} />
          <Route path="/join" element={<Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <BottomNav />
      <Milestones />
    </div>
  )
}

function Gate() {
  const { authReady, session, membership, data, error } = useHousehold()
  if (!backendConfigured) {
    return (
      <div className="auth">
        <Mascot size={110} />
        <h1 className="brand">Liyana’s Closet</h1>
        <div className="card"><strong>Not connected to a backend yet</strong><p className="calc">Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (see README). Without them nothing can be saved or shared.</p></div>
      </div>
    )
  }
  if (!authReady) return <Splash text="Opening…" />
  if (!session) return <AuthScreen />
  if (membership === undefined && !data) return <Splash text="Finding your family…" />
  if (membership === null) return <SetupScreen />
  if (!data) return error ? <Splash text={`Could not load your records: ${error}`} retry /> : <Splash text="Loading your registry…" />
  return <Shell />
}

function Splash({ text, retry }: { text: string; retry?: boolean }) {
  return (
    <div className="auth splash">
      <Mascot size={110} />
      <p className="tagline">{text}</p>
      {retry && <button className="btn primary" onClick={() => window.location.reload()}>Try again</button>}
    </div>
  )
}

export default function App() {
  return (
    <HouseholdProvider>
      <HashRouter>
        <Gate />
      </HashRouter>
      <Toaster />
      <Celebration />
    </HouseholdProvider>
  )
}
