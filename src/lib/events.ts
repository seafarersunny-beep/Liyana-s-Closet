// Tiny app-wide event bus for mascot reactions and celebrations.
export type AppEvent = { type: 'saved'; message: string } | { type: 'milestone'; message: string } | { type: 'error'; message: string }
const target = new EventTarget()
export function emit(e: AppEvent) {
  target.dispatchEvent(new CustomEvent('app', { detail: e }))
}
export function onAppEvent(fn: (e: AppEvent) => void) {
  const h = (ev: Event) => fn((ev as CustomEvent<AppEvent>).detail)
  target.addEventListener('app', h)
  return () => target.removeEventListener('app', h)
}
