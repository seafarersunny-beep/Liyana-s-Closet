import { useSyncExternalStore } from 'react'

// Per-device preferences (sound and motion are about this phone, not the household).
type Prefs = { muted: boolean; reduceMotion: boolean | null }
const KEY = 'liyanas-closet-prefs'
let prefs: Prefs = { muted: false, reduceMotion: null }
try {
  prefs = { ...prefs, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }
} catch {
  /* storage unavailable */
}
const listeners = new Set<() => void>()
const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null
mq?.addEventListener?.('change', () => listeners.forEach((l) => l()))

export function setPrefs(p: Partial<Prefs>) {
  prefs = { ...prefs, ...p }
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs))
  } catch {
    /* ignore */
  }
  applyMotionClass()
  listeners.forEach((l) => l())
}

export function getPrefs() {
  return prefs
}

// null = follow the iPhone's Reduce Motion setting
export function motionReduced() {
  return prefs.reduceMotion ?? !!mq?.matches
}

export function applyMotionClass() {
  document.documentElement.classList.toggle('reduce-motion', motionReduced())
}

let snapshot = { ...prefs, reduced: motionReduced() }
export function usePrefs() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => {
      const next = { ...prefs, reduced: motionReduced() }
      if (next.muted !== snapshot.muted || next.reduceMotion !== snapshot.reduceMotion || next.reduced !== snapshot.reduced) snapshot = next
      return snapshot
    },
  )
}
