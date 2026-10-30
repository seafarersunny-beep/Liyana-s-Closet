import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { onAppEvent, type AppEvent } from '../lib/events'
import { sound } from '../lib/sound'
import type { Item, StockLevel, Status } from '../lib/household'
import { useHousehold } from '../lib/household'
import { formatWhen } from '../lib/format'

export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', key)
    document.body.classList.add('sheet-open')
    ref.current?.focus()
    return () => {
      document.removeEventListener('keydown', key)
      document.body.classList.remove('sheet-open')
    }
  }, [open, onClose])
  if (!open) return null
  return createPortal(
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" />
        <div className="sheet-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>,
    document.body,
  )
}

const STATUS_LABEL: Record<Status, string> = { needed: 'Needed', partial: 'Partly acquired', purchased: 'Purchased', gifted: 'Gifted' }
export function StatusBadge({ status }: { status: Status }) {
  return <span className={`badge status-${status}`}>{STATUS_LABEL[status]}</span>
}

export function StockBadge({ level }: { level: StockLevel }) {
  if (level === 'low') return <span className="badge stock-low">Low stock</span>
  if (level === 'out') return <span className="badge stock-out">Out of stock</span>
  return null
}

export function StockBar({ item }: { item: Item }) {
  if (item.stock_qty == null) return <div className="stock-unknown">Stock not counted yet</div>
  const ref = Math.max(item.stock_qty, (item.low_stock_threshold ?? 0) * 3, 1)
  const pct = Math.min(100, (item.stock_qty / ref) * 100)
  const thr = item.low_stock_threshold != null ? Math.min(100, (item.low_stock_threshold / ref) * 100) : null
  return (
    <div className={`stock-bar level-${item.stock_level}`} aria-label={`${item.stock_qty} ${item.unit} left`}>
      <div className="stock-fill" style={{ width: `${pct}%` }} />
      {thr != null && <div className="stock-threshold" style={{ left: `${thr}%` }} title={`Alert at ${item.low_stock_threshold}`} />}
    </div>
  )
}

const CATEGORY_ICON: Record<string, string> = {
  Feeding: '🍼', Diapering: '🧷', Sleeping: '🌙', 'Baby Gears': '🚼', Bathing: '🛁', 'Health & Safety': '🩺',
  Clothing: '👚', Playing: '🧸', Postpartum: '🌷', Travel: '🚗', Nursery: '🏡', Monitoring: '📷',
}
export const categoryIcon = (c: string) => CATEGORY_ICON[c] ?? '🎀'

export function ItemPhoto({ item, url, size = 'md' }: { item: Item; url?: string; size?: 'sm' | 'md' | 'lg' }) {
  const [broken, setBroken] = useState(false)
  const src = url ?? item.photo_url ?? null
  if (src && !broken) {
    return <img className={`photo photo-${size}`} src={src} alt={item.name} loading="lazy" onError={() => setBroken(true)} referrerPolicy="no-referrer" />
  }
  return (
    <div className={`photo photo-${size} photo-empty`} aria-label="No product photo yet">
      <span className="photo-icon">{categoryIcon(item.category)}</span>
      <span className="photo-note">{broken ? 'Photo link broken' : 'No photo yet'}</span>
    </div>
  )
}

export function Checkmark() {
  return (
    <svg className="checkmark" viewBox="0 0 52 52" aria-hidden="true">
      <circle className="checkmark-circle" cx="26" cy="26" r="23" fill="none" />
      <path className="checkmark-check" fill="none" d="M15 27l7 7 15-16" />
    </svg>
  )
}

// Toasts: an animated checkmark after the server confirms a save, or an honest error.
export function Toaster() {
  const [toasts, setToasts] = useState<(AppEvent & { id: number })[]>([])
  useEffect(
    () =>
      onAppEvent((e) => {
        const id = Date.now() + Math.random()
        setToasts((t) => [...t.slice(-2), { ...e, id }])
        window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), e.type === 'error' ? 6000 : 2400)
      }),
    [],
  )
  return (
    <div className="toaster" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.type}`}>
          {t.type === 'error' ? <span className="toast-x">!</span> : <Checkmark />}
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  )
}

export function Celebration() {
  const [msg, setMsg] = useState<string | null>(null)
  useEffect(
    () =>
      onAppEvent((e) => {
        if (e.type !== 'milestone') return
        setMsg(e.message)
        sound.milestone()
        window.setTimeout(() => setMsg(null), 3200)
      }),
    [],
  )
  if (!msg) return null
  return (
    <div className="celebration" aria-live="polite">
      {Array.from({ length: 18 }, (_, i) => (
        <span key={i} className="confetti" style={{ left: `${(i * 37) % 100}%`, animationDelay: `${(i % 6) * 0.12}s` }}>
          {['❤', '✿', '★'][i % 3]}
        </span>
      ))}
      <div className="celebration-card">{msg}</div>
    </div>
  )
}

export function SyncBadge() {
  const { sync, fromCache, data } = useHousehold()
  const [online, setOnline] = useState(navigator.onLine)
  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])
  if (!online || sync === 'offline') {
    return (
      <div className="sync sync-offline" role="status">
        Offline · showing what was last synced{data ? ` ${formatWhen(data.loadedAt)}` : ''}. Changes can't be saved until you're back online.
      </div>
    )
  }
  if (fromCache) return <div className="sync sync-warn" role="status">Showing saved copy from {data ? formatWhen(data.loadedAt) : 'earlier'} · reconnecting…</div>
  if (sync === 'error') return <div className="sync sync-warn" role="status">Having trouble reaching the server · retrying</div>
  if (sync === 'connecting') return <div className="sync sync-quiet" role="status">Connecting to live sync…</div>
  return null
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-dot">✿</div>
      <h3>{title}</h3>
      {children}
    </div>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  )
}

export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <p className="error-note" role="alert">
      {message}
    </p>
  )
}
