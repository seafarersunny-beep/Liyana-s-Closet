import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabase'

export type Status = 'needed' | 'partial' | 'purchased' | 'gifted'
export type StockLevel = 'ok' | 'low' | 'out' | 'unknown'

export interface Item {
  id: string
  household_id: string
  name: string
  brand: string | null
  model: string | null
  size: string | null
  color: string | null
  category: string
  unit: string
  required_qty: number | null
  is_consumable: boolean
  stock_qty: number | null
  low_stock_threshold: number | null
  estimated_price_cents: number | null
  photo_path: string | null
  photo_url: string | null
  photo_source_url: string | null
  photo_source_name: string | null
  notes: string | null
  needs_review: boolean
  review_note: string | null
  master_no: number | null
  import_key: string | null
  archived_at: string | null
  version: number
  updated_at: string
  updated_by: string | null
  purchased_qty: number
  gifted_qty: number
  acquired_qty: number
  spent_cents: number
  purchase_count: number
  undated_purchase_count: number
  status: Status
  stock_level: StockLevel
}

export interface Purchase {
  id: string
  item_id: string
  qty: number
  pack_count: number | null
  units_per_pack: number | null
  purchased_on: string | null
  amount_cents: number
  retailer: string | null
  buyer_user_id: string | null
  buyer_label: string | null
  notes: string | null
  source: string
  voided_at: string | null
  version: number
  created_by: string | null
  created_at: string
}

export interface Gift {
  id: string
  item_id: string
  qty: number
  received_on: string | null
  giver: string | null
  notes: string | null
  voided_at: string | null
  created_by: string | null
  created_at: string
}

export interface Member {
  user_id: string
  display_name: string
  role: string
  greeting_title: string | null
  greeting_audio_path: string | null
  greeting_pitch_up: boolean
}

export interface Household {
  id: string
  name: string
  monthly_budget_cents: number | null
  version: number
}

export interface Summary {
  today: string
  week_start: string
  month_start: string
  week_cents: number
  month_cents: number
  all_time_cents: number
  undated_cents: number
  undated_count: number
  purchase_count: number
  monthly_budget_cents: number | null
  by_category: { category: string; cents: number; count: number }[]
  by_month: { month: string; cents: number }[]
  gifts_count: number
}

export interface Estimate {
  item_id: string
  per_day: number
  days_remaining: number | null
  sufficient: boolean
  basis: string
  events: number
}

export interface Snapshot {
  household: Household
  members: Member[]
  items: Item[]
  purchases: Purchase[]
  gifts: Gift[]
  summary: Summary
  estimates: Estimate[]
  photoUrls: Record<string, string>
  greetingUrls: Record<string, string>
  loadedAt: string
}

type SyncState = 'loading' | 'live' | 'connecting' | 'offline' | 'error'

interface Ctx {
  session: Session | null
  authReady: boolean
  membership: { household_id: string; display_name: string } | null | undefined
  data: Snapshot | null
  fromCache: boolean
  sync: SyncState
  error: string | null
  refresh: () => Promise<void>
  refreshMembership: () => Promise<void>
}

const HouseholdContext = createContext<Ctx | null>(null)
const CACHE_KEY = 'liyanas-closet-cache-v1'

export function HouseholdProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [authReady, setAuthReady] = useState(false)
  const [membership, setMembership] = useState<Ctx['membership']>(undefined)
  const [data, setData] = useState<Snapshot | null>(null)
  const [fromCache, setFromCache] = useState(false)
  const [sync, setSync] = useState<SyncState>('loading')
  const [error, setError] = useState<string | null>(null)
  const photoCache = useRef<Record<string, { url: string; exp: number }>>({})

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setAuthReady(true)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  const userId = session?.user.id
  const refreshMembership = useCallback(async () => {
    if (!userId) {
      setMembership(undefined)
      return
    }
    const { data: m, error: e } = await supabase.from('household_members').select('household_id, display_name').eq('user_id', userId).maybeSingle()
    if (e) {
      setError(e.message)
      setSync(navigator.onLine ? 'error' : 'offline')
      // fall back to cache when offline
      const cached = readCache(userId)
      if (cached) {
        setData(cached)
        setFromCache(true)
        setMembership({ household_id: cached.household.id, display_name: '' })
      }
      return
    }
    setMembership(m ?? null)
  }, [userId])

  useEffect(() => {
    void refreshMembership()
  }, [refreshMembership])

  const hh = membership?.household_id
  const loading = useRef<Promise<void> | null>(null)
  const refresh = useCallback(async () => {
    if (!hh || !userId) return
    if (loading.current) return loading.current
    loading.current = (async () => {
      try {
        const [house, members, items, purchases, gifts, summary, estimates] = await Promise.all([
          supabase.from('households').select('id,name,monthly_budget_cents,version').eq('id', hh).single(),
          supabase.from('household_members').select('user_id,display_name,role,greeting_title,greeting_audio_path,greeting_pitch_up').eq('household_id', hh).order('joined_at'),
          supabase.from('item_overview').select('*').eq('household_id', hh).order('category').order('name'),
          supabase.from('purchases').select('*').eq('household_id', hh).order('purchased_on', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false }),
          supabase.from('gifts').select('*').eq('household_id', hh).order('created_at', { ascending: false }),
          supabase.rpc('spending_summary', {}),
          supabase.rpc('usage_estimates'),
        ])
        const failed = [house, members, items, purchases, gifts, summary, estimates].find((r) => r.error)
        if (failed?.error) throw failed.error
        const itemRows = items.data as Item[]
        const memberRows = members.data as Member[]
        const [photoUrls, greetingUrls] = await Promise.all([signPhotos(itemRows, photoCache.current), signGreetings(memberRows)])
        const snap: Snapshot = {
          household: house.data as Household,
          members: memberRows,
          items: itemRows,
          purchases: purchases.data as Purchase[],
          gifts: gifts.data as Gift[],
          summary: summary.data as Summary,
          estimates: (estimates.data as Estimate[]) ?? [],
          photoUrls,
          greetingUrls,
          loadedAt: new Date().toISOString(),
        }
        setData(snap)
        setFromCache(false)
        setError(null)
        writeCache(userId, snap)
      } catch (e) {
        const msg = (e as Error).message
        setError(msg)
        setSync(navigator.onLine ? 'error' : 'offline')
        setData((cur) => {
          if (cur) return cur
          const cached = readCache(userId)
          if (cached) setFromCache(true)
          return cached
        })
      } finally {
        loading.current = null
      }
    })()
    return loading.current
  }, [hh, userId])

  // Live sync: any change by either parent triggers a debounced reload.
  useEffect(() => {
    if (!hh) return
    void refresh()
    let timer: number | undefined
    const bump = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => void refresh(), 250)
    }
    const channel = supabase.channel(`household-${hh}`)
    for (const table of ['items', 'purchases', 'gifts', 'stock_events', 'households', 'household_members']) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table, filter: table === 'households' ? `id=eq.${hh}` : `household_id=eq.${hh}` }, bump)
    }
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        setSync('live')
        bump() // catch anything missed while disconnected
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        setSync(navigator.onLine ? 'connecting' : 'offline')
      }
    })
    const online = () => {
      setSync('connecting')
      bump()
    }
    const offline = () => setSync('offline')
    const visible = () => document.visibilityState === 'visible' && bump()
    window.addEventListener('online', online)
    window.addEventListener('offline', offline)
    document.addEventListener('visibilitychange', visible)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('online', online)
      window.removeEventListener('offline', offline)
      document.removeEventListener('visibilitychange', visible)
      void supabase.removeChannel(channel)
    }
  }, [hh, refresh])

  const value = useMemo<Ctx>(
    () => ({ session, authReady, membership, data, fromCache, sync, error, refresh, refreshMembership }),
    [session, authReady, membership, data, fromCache, sync, error, refresh, refreshMembership],
  )
  return <HouseholdContext.Provider value={value}>{children}</HouseholdContext.Provider>
}

async function signPhotos(items: Item[], cache: Record<string, { url: string; exp: number }>) {
  const now = Date.now()
  const need = items.map((i) => i.photo_path).filter((p): p is string => !!p && !(cache[p] && cache[p].exp > now + 60_000))
  if (need.length) {
    const { data } = await supabase.storage.from('item-photos').createSignedUrls(need, 60 * 60 * 6)
    for (const r of data ?? []) {
      if (r.path && r.signedUrl) cache[r.path] = { url: r.signedUrl, exp: now + 60 * 60 * 6 * 1000 }
    }
  }
  const out: Record<string, string> = {}
  for (const i of items) if (i.photo_path && cache[i.photo_path]) out[i.id] = cache[i.photo_path].url
  return out
}

async function signGreetings(members: Member[]) {
  const paths = members.map((m) => m.greeting_audio_path).filter((p): p is string => !!p)
  const out: Record<string, string> = {}
  if (!paths.length) return out
  const { data } = await supabase.storage.from('household-audio').createSignedUrls(paths, 60 * 60 * 6)
  for (const m of members) {
    const hit = data?.find((d) => d.path === m.greeting_audio_path)
    if (hit?.signedUrl) out[m.user_id] = hit.signedUrl
  }
  return out
}

function readCache(userId: string): Snapshot | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed.userId === userId ? ({ greetingUrls: {}, ...parsed.snap } as Snapshot) : null
  } catch {
    return null
  }
}

function writeCache(userId: string, snap: Snapshot) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ userId, snap }))
  } catch {
    /* storage full or unavailable */
  }
}

export function clearCache() {
  try {
    localStorage.removeItem(CACHE_KEY)
  } catch {
    /* ignore */
  }
}

export function useHousehold() {
  const ctx = useContext(HouseholdContext)
  if (!ctx) throw new Error('HouseholdProvider missing')
  return ctx
}

export function useData() {
  const { data } = useHousehold()
  if (!data) throw new Error('Data not loaded')
  return data
}

export function memberName(members: Member[], id: string | null | undefined) {
  if (!id) return null
  return members.find((m) => m.user_id === id)?.display_name ?? 'Former member'
}
