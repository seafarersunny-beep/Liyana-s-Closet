import { useCallback, useRef, useState } from 'react'
import { friendlyError, supabase } from './supabase'
import { useHousehold } from './household'
import { emit } from './events'
import { sound } from './sound'

// Wraps a write: blocks double taps, refuses when offline, only reports success
// after the server confirms, then refreshes and nudges background push.
export function useAction() {
  const { refresh } = useHousehold()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const running = useRef(false)

  const run = useCallback(
    async <T,>(fn: () => PromiseLike<{ data: T; error: unknown }>, opts: { success: string; stock?: boolean; quiet?: boolean } = { success: 'Saved' }) => {
      if (running.current) return null
      if (!navigator.onLine) {
        const msg = "You're offline, so nothing was saved. Try again when you're connected."
        setError(msg)
        emit({ type: 'error', message: msg })
        sound.error()
        return null
      }
      running.current = true
      setBusy(true)
      setError(null)
      try {
        const res = await fn()
        if (res.error) throw res.error
        const dup = (res.data as { duplicate?: boolean } | null)?.duplicate
        if (!opts.quiet) {
          emit({ type: 'saved', message: dup ? 'Already saved (duplicate tap ignored)' : opts.success })
          sound.success()
        }
        await refresh()
        if (opts.stock) void dispatchPush()
        return res.data
      } catch (e) {
        const msg = friendlyError(e)
        setError(msg)
        emit({ type: 'error', message: msg })
        sound.error()
        return null
      } finally {
        running.current = false
        setBusy(false)
      }
    },
    [refresh],
  )
  return { run, busy, error, setError }
}

// Ask the server to send any newly queued stock alerts to both phones.
export async function dispatchPush() {
  try {
    await supabase.functions.invoke('push-dispatch', { body: {} })
  } catch {
    /* in-app alerts still work; background push is best effort */
  }
}
