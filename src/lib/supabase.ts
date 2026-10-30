import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const backendConfigured = !!url && !!key

// Sessions persist in this device's storage and refresh automatically, so each
// parent stays signed in on their own iPhone.
export const supabase = createClient(url ?? 'http://localhost:54321', key ?? 'missing-key', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'liyanas-closet-auth' },
  realtime: { params: { eventsPerSecond: 5 } },
})

export const vapidPublicKey = (import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined) || null

export function newRequestId() {
  return crypto.randomUUID()
}

// Turns Postgres/PostgREST errors into a sentence a parent can act on.
export function friendlyError(e: unknown): string {
  const err = e as { message?: string; code?: string } | null
  if (!navigator.onLine) return "You're offline, so this was not saved. Try again when you're connected."
  const msg = err?.message ?? String(e)
  if (/Failed to fetch|NetworkError|Load failed|fetch failed/i.test(msg)) {
    return 'Could not reach the server, so this was not saved. Check your connection and try again.'
  }
  if (err?.code === '40001') return msg
  if (/JWT|session/i.test(msg)) return 'Your sign-in expired. Please sign in again.'
  return msg
}
