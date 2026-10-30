// Integration tests against a real Supabase stack (`npx supabase start`).
// Covers arithmetic, undated spending, privacy, duplicates, concurrency, photos, alerts.
import { beforeAll, describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { existsSync } from 'node:fs'
import readXlsx from 'read-excel-file/node'
import { buildImportPlan } from '../src/lib/importBook'

const URL = process.env.SUPABASE_TEST_URL ?? 'http://127.0.0.1:54321'
const ANON = process.env.SUPABASE_TEST_ANON_KEY!
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY!
const BOOK = process.env.BOOK1_PATH
const run = !!ANON && !!SERVICE

const admin = run ? createClient(URL, SERVICE, { auth: { persistSession: false } }) : (null as never)
const uid = () => crypto.randomUUID()
const stamp = Date.now()

async function userClient(name: string) {
  const email = `${name}.${stamp}@example.test`
  const password = `pw-${uid()}`
  const { error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (error) throw error
  const c = createClient(URL, ANON, { auth: { persistSession: false } })
  const { data, error: e2 } = await c.auth.signInWithPassword({ email, password })
  if (e2) throw e2
  return { c, id: data.user!.id, email }
}

const ok = <T>(r: { data: T; error: unknown }) => {
  if (r.error) throw r.error
  return r.data
}

async function itemByKey(c: SupabaseClient, key: string) {
  return ok(await c.from('item_overview').select('*').eq('import_key', key).single()) as Record<string, any>
}

describe.skipIf(!run)('household backend', () => {
  let sunny: Awaited<ReturnType<typeof userClient>>
  let smita: Awaited<ReturnType<typeof userClient>>
  let outsider: Awaited<ReturnType<typeof userClient>>
  let hh: string
  let otherHh: string
  let diaperId: string

  beforeAll(async () => {
    sunny = await userClient('sunny')
    smita = await userClient('smita')
    outsider = await userClient('outsider')
    hh = ok(await sunny.c.rpc('create_household', { p_name: "Liyana's Closet", p_display_name: 'Sunny' })) as string
    otherHh = ok(await outsider.c.rpc('create_household', { p_name: 'Other family', p_display_name: 'Other' })) as string
  })

  it('invites a partner with a single-use token and no shared password', async () => {
    const token = ok(await sunny.c.rpc('create_invite', {})) as string
    expect(token).toMatch(/^[0-9a-f]{48}$/)
    // stored only as a hash
    const inv = ok(await sunny.c.from('household_invites').select('*')) as any[]
    expect(JSON.stringify(inv)).not.toContain(token)
    expect(ok(await smita.c.rpc('accept_invite', { p_token: token, p_display_name: 'Smita' }))).toBe(hh)
    // replay by the same person is harmless; by someone else is refused
    expect(ok(await smita.c.rpc('accept_invite', { p_token: token, p_display_name: 'Smita' }))).toBe(hh)
    const reuse = await outsider.c.rpc('accept_invite', { p_token: token, p_display_name: 'X' })
    expect(reuse.error?.message).toMatch(/already been used|already belong/)
    const bad = await outsider.c.rpc('accept_invite', { p_token: 'nope', p_display_name: 'X' })
    expect(bad.error?.message).toMatch(/invalid or has expired/)
    const members = ok(await smita.c.from('household_members').select('display_name')) as any[]
    expect(members.map((m) => m.display_name).sort()).toEqual(['Smita', 'Sunny'])
  })

  it('stops a member from promoting themselves or editing protected household fields', async () => {
    const promote = await smita.c.from('household_members').update({ role: 'owner' }).eq('user_id', smita.id)
    expect(promote.error).toBeTruthy()
    ok(await smita.c.from('household_members').update({ display_name: 'Smita' }).eq('user_id', smita.id))
    const forge = await smita.c.from('households').update({ created_by: smita.id }).eq('id', hh)
    expect(forge.error).toBeTruthy()
    const kick = await smita.c.rpc('remove_member', { p_user_id: sunny.id })
    expect(kick.error?.message).toMatch(/Only the household owner/)
  })

  it.skipIf(!BOOK || !existsSync(BOOK ?? ''))('imports Book1.xlsx once, with $1,490 undated', async () => {
    const plan = buildImportPlan((await readXlsx(BOOK!)) as never)
    const payload = { fingerprint: `sha256-test-${stamp}`, file_name: 'Book1.xlsx', items: plan.items }
    const res = ok(await sunny.c.rpc('import_registry', { p_payload: payload })) as any
    expect(res).toMatchObject({ already_imported: false, items: 60, purchases: 5 })
    const again = ok(await smita.c.rpc('import_registry', { p_payload: payload })) as any
    expect(again.already_imported).toBe(true)
    // a re-saved copy of the file (different fingerprint) still cannot duplicate rows
    const copy = ok(await smita.c.rpc('import_registry', { p_payload: { ...payload, fingerprint: `copy-${stamp}` } })) as any
    expect(copy).toMatchObject({ items: 0, purchases: 0, skipped: 60 })

    const s = ok(await smita.c.rpc('spending_summary', {})) as any
    expect(s.all_time_cents).toBe(149000)
    expect(s.undated_cents).toBe(149000)
    expect(s.undated_count).toBe(5)
    expect(s.week_cents).toBe(0)
    expect(s.month_cents).toBe(0)
    expect(s.by_month).toEqual([])

    expect((await itemByKey(sunny.c, 'master:30:stroller')).status).toBe('purchased')
    expect((await itemByKey(sunny.c, 'master:30:car-seat')).status).toBe('needed')
    expect((await itemByKey(sunny.c, 'master:1')).status).toBe('needed')
    const diaper = await itemByKey(sunny.c, 'master:17')
    expect(diaper.stock_qty).toBeNull()
    expect(diaper.stock_level).toBe('unknown') // unknown stock: no false zero-stock warning
    diaperId = diaper.id
  })

  it('keeps household data private from other families', async () => {
    const items = ok(await outsider.c.from('items').select('id')) as any[]
    expect(items).toHaveLength(0)
    const purchases = ok(await outsider.c.from('purchases').select('id')) as any[]
    expect(purchases).toHaveLength(0)
    const hhs = ok(await outsider.c.from('households').select('id')) as any[]
    expect(hhs.map((h) => h.id)).toEqual([otherHh])
    // cannot write into our household
    const ins = await outsider.c.from('items').insert({ household_id: hh, name: 'Intruder' })
    expect(ins.error).toBeTruthy()
    const { data: anyItem } = await sunny.c.from('items').select('id').limit(1).single()
    const buy = await outsider.c.rpc('record_purchase', {
      p_item_id: anyItem!.id, p_qty: 1, p_amount_cents: 100, p_request: uid(),
    })
    expect(buy.error?.message).toMatch(/Not a member/)
    const upd = await outsider.c.from('items').update({ name: 'hacked' }).eq('id', anyItem!.id).select()
    expect(upd.data ?? []).toHaveLength(0)
    // anonymous visitors see nothing
    const anon = createClient(URL, ANON, { auth: { persistSession: false } })
    expect(ok(await anon.from('items').select('id'))).toHaveLength(0)
  })

  it('does the diaper arithmetic: buy 120 for $35, use 8, 112 left, $35 spent', async () => {
    if (!diaperId) {
      diaperId = (ok(await sunny.c.from('items').insert({
        household_id: hh, name: 'Diaper', unit: 'pieces', is_consumable: true, low_stock_threshold: 20,
        category: 'Diapering',
      }).select().single()) as any).id
    }
    const before = ok(await sunny.c.rpc('spending_summary', {})) as any
    const today = before.today as string
    ok(await sunny.c.rpc('record_purchase', {
      p_item_id: diaperId, p_qty: 120, p_pack_count: 1, p_units_per_pack: 120, p_amount_cents: 3500,
      p_request: uid(), p_purchased_on: today, p_retailer: 'Target', p_buyer_user_id: sunny.id,
    }))
    ok(await smita.c.rpc('log_usage', { p_item_id: diaperId, p_qty: 8, p_request: uid() }))
    const d = ok(await sunny.c.from('item_overview').select('*').eq('id', diaperId).single()) as any
    expect(d.stock_qty).toBe(112)
    expect(d.spent_cents).toBe(3500)
    const after = ok(await sunny.c.rpc('spending_summary', {})) as any
    expect(after.all_time_cents - before.all_time_cents).toBe(3500)
    expect(after.week_cents - before.week_cents).toBe(3500)
    expect(after.month_cents - before.month_cents).toBe(3500)
    expect(after.undated_cents).toBe(before.undated_cents)
  })

  it('rejects packs that do not add up, future dates, and negative stock', async () => {
    const r1 = await sunny.c.rpc('record_purchase', {
      p_item_id: diaperId, p_qty: 1, p_pack_count: 1, p_units_per_pack: 120, p_amount_cents: 3500, p_request: uid(),
    })
    expect(r1.error?.message).toMatch(/packs × units/)
    const r2 = await sunny.c.rpc('record_purchase', {
      p_item_id: diaperId, p_qty: 1, p_amount_cents: 1, p_request: uid(), p_purchased_on: '2999-01-01',
    })
    expect(r2.error?.message).toMatch(/future/)
    const r3 = await sunny.c.rpc('log_usage', { p_item_id: diaperId, p_qty: 1000, p_request: uid() })
    expect(r3.error?.message).toMatch(/Not enough stock/)
    const direct = await sunny.c.from('items').update({ stock_qty: 9999 }).eq('id', diaperId)
    expect(direct.error?.message).toMatch(/Stock can only change/)
    const d = ok(await sunny.c.from('items').select('stock_qty').eq('id', diaperId).single()) as any
    expect(d.stock_qty).toBe(112)
  })

  it('corrections and gifts change stock but never spending', async () => {
    const s0 = ok(await sunny.c.rpc('spending_summary', {})) as any
    ok(await sunny.c.rpc('correct_stock', { p_item_id: diaperId, p_new_qty: 110, p_expected_stock: 112, p_request: uid() }))
    ok(await smita.c.rpc('record_gift', { p_item_id: diaperId, p_qty: 40, p_request: uid(), p_giver: 'Grandma' }))
    const d = ok(await sunny.c.from('item_overview').select('*').eq('id', diaperId).single()) as any
    expect(d.stock_qty).toBe(150)
    expect(d.gifted_qty).toBe(40)
    const s1 = ok(await sunny.c.rpc('spending_summary', {})) as any
    expect(s1.all_time_cents).toBe(s0.all_time_cents)
    expect(s1.gifts_count).toBe(s0.gifts_count + 1)
  })

  it('ignores duplicate submissions of the same action', async () => {
    const req = uid()
    const args = { p_item_id: diaperId, p_qty: 5, p_request: req }
    const results = await Promise.all([sunny.c.rpc('log_usage', args), sunny.c.rpc('log_usage', args), smita.c.rpc('log_usage', args)])
    const dupFlags = results.map((r) => (r.error ? 'error' : (r.data as any).duplicate))
    // exactly one applied; others are duplicates (or lost the unique race)
    expect(dupFlags.filter((x) => x === false)).toHaveLength(1)
    const d = ok(await sunny.c.from('items').select('stock_qty').eq('id', diaperId).single()) as any
    expect(d.stock_qty).toBe(145)

    const preq = uid()
    const pargs = { p_item_id: diaperId, p_qty: 10, p_amount_cents: 500, p_request: preq }
    ok(await sunny.c.rpc('record_purchase', pargs))
    const again = ok(await sunny.c.rpc('record_purchase', pargs)) as any
    expect(again.duplicate).toBe(true)
    const rows = ok(await sunny.c.from('purchases').select('id').eq('client_request_id', preq)) as any[]
    expect(rows).toHaveLength(1)
  })

  it('applies simultaneous usage from both phones without losing either', async () => {
    const before = (ok(await sunny.c.from('items').select('stock_qty').eq('id', diaperId).single()) as any).stock_qty
    await Promise.all(Array.from({ length: 10 }, (_, i) =>
      (i % 2 ? sunny : smita).c.rpc('log_usage', { p_item_id: diaperId, p_qty: 1, p_request: uid() })))
    const after = (ok(await sunny.c.from('items').select('stock_qty').eq('id', diaperId).single()) as any).stock_qty
    expect(after).toBe(before - 10)
  })

  it('refuses stale corrections and stale edits instead of overwriting', async () => {
    const cur = (ok(await sunny.c.from('items').select('stock_qty, version').eq('id', diaperId).single()) as any)
    const stale = await smita.c.rpc('correct_stock', {
      p_item_id: diaperId, p_new_qty: 1, p_expected_stock: cur.stock_qty + 3, p_request: uid(),
    })
    expect(stale.error?.message).toMatch(/changed to/)
    // two edits from the same starting version: second one updates 0 rows
    const a = ok(await sunny.c.from('items').update({ notes: 'from Sunny' }).eq('id', diaperId).eq('version', cur.version).select()) as any[]
    const b = ok(await smita.c.from('items').update({ notes: 'from Smita' }).eq('id', diaperId).eq('version', cur.version).select()) as any[]
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(0)
  })

  it('corrects purchase dates so undated spending moves into the right month', async () => {
    const p = ok(await sunny.c.from('purchases').select('*').is('purchased_on', null).limit(1).single()) as any
    const s0 = ok(await sunny.c.rpc('spending_summary', {})) as any
    ok(await smita.c.rpc('update_purchase', {
      p_purchase_id: p.id, p_expected_version: p.version, p_qty: p.qty, p_amount_cents: p.amount_cents,
      p_purchased_on: s0.month_start, p_retailer: p.retailer, p_buyer_user_id: null, p_buyer_label: p.buyer_label, p_notes: p.notes,
    }))
    const s1 = ok(await sunny.c.rpc('spending_summary', {})) as any
    expect(s1.undated_cents).toBe(s0.undated_cents - p.amount_cents)
    expect(s1.month_cents).toBe(s0.month_cents + p.amount_cents)
    expect(s1.all_time_cents).toBe(s0.all_time_cents)
    const stale = await sunny.c.rpc('update_purchase', {
      p_purchase_id: p.id, p_expected_version: p.version, p_qty: p.qty, p_amount_cents: 1,
      p_purchased_on: null, p_retailer: null, p_buyer_user_id: null, p_buyer_label: null, p_notes: null,
    })
    expect(stale.error?.message).toMatch(/changed by someone else/)
  })

  it('computes week/month boundaries in New York time with Monday weeks', async () => {
    // Sunday 2026-11-01: week started Monday 2026-10-26, month started 2026-11-01
    const s = ok(await sunny.c.rpc('spending_summary', { p_today: '2026-11-01' })) as any
    expect(s.week_start).toBe('2026-10-26')
    expect(s.month_start).toBe('2026-11-01')
  })

  it('raises low/out alerts once per crossing and clears them after restock', async () => {
    const item = ok(await sunny.c.from('items').insert({
      household_id: hh, name: 'Wipes test', unit: 'wipes', is_consumable: true, low_stock_threshold: 20, category: 'Diapering',
    }).select().single()) as any
    const outbox = async () => (ok(await admin.from('notification_outbox').select('level').eq('item_id', item.id).order('created_at')) as any[]).map((r) => r.level)
    const level = async () => (ok(await sunny.c.from('item_overview').select('stock_level').eq('id', item.id).single()) as any).stock_level
    expect(await level()).toBe('unknown')
    ok(await sunny.c.rpc('set_starting_stock', { p_item_id: item.id, p_qty: 30, p_request: uid() }))
    expect(await level()).toBe('ok')
    ok(await sunny.c.rpc('log_usage', { p_item_id: item.id, p_qty: 10, p_request: uid() })) // 20 -> low (<= threshold)
    expect(await level()).toBe('low')
    ok(await smita.c.rpc('log_usage', { p_item_id: item.id, p_qty: 5, p_request: uid() })) // 15, still low: no new alert
    expect(await outbox()).toEqual(['low'])
    ok(await smita.c.rpc('log_usage', { p_item_id: item.id, p_qty: 15, p_request: uid() })) // 0 -> out
    expect(await level()).toBe('out')
    ok(await sunny.c.rpc('record_purchase', { p_item_id: item.id, p_qty: 80, p_amount_cents: 400, p_request: uid() }))
    expect(await level()).toBe('ok')
    ok(await sunny.c.rpc('log_usage', { p_item_id: item.id, p_qty: 61, p_request: uid() })) // 19 -> low again
    expect(await outbox()).toEqual(['low', 'out', 'low'])
    // claim is atomic: a second claimer gets nothing
    const [a, b] = await Promise.all([
      admin.rpc('claim_notifications', { p_household: hh }), admin.rpc('claim_notifications', { p_household: hh }),
    ])
    const total = (a.data as any[]).filter((r) => r.item_id === item.id).length + (b.data as any[]).filter((r) => r.item_id === item.id).length
    expect(total).toBe(3)
    // clients cannot read the outbox or claim
    expect(ok(await sunny.c.from('notification_outbox').select('id'))).toHaveLength(0)
    expect((await sunny.c.rpc('claim_notifications', { p_household: hh })).error).toBeTruthy()
  })

  it('estimates days remaining only from real usage history', async () => {
    const item = ok(await sunny.c.from('items').insert({
      household_id: hh, name: 'Estimate test', unit: 'pieces', is_consumable: true, category: 'Diapering',
    }).select().single()) as any
    ok(await sunny.c.rpc('set_starting_stock', { p_item_id: item.id, p_qty: 100, p_request: uid() }))
    const s = ok(await sunny.c.rpc('spending_summary', {})) as any
    const day = (n: number) => new Date(Date.parse(s.today) - n * 86400000).toISOString().slice(0, 10)
    ok(await sunny.c.rpc('log_usage', { p_item_id: item.id, p_qty: 8, p_request: uid(), p_used_on: day(0) }))
    let est = (ok(await sunny.c.rpc('usage_estimates')) as any[]).find((e) => e.item_id === item.id)
    expect(est.sufficient).toBe(false)
    expect(est.days_remaining).toBeNull()
    ok(await sunny.c.rpc('log_usage', { p_item_id: item.id, p_qty: 8, p_request: uid(), p_used_on: day(1) }))
    ok(await sunny.c.rpc('log_usage', { p_item_id: item.id, p_qty: 8, p_request: uid(), p_used_on: day(2) }))
    est = (ok(await sunny.c.rpc('usage_estimates')) as any[]).find((e) => e.item_id === item.id)
    expect(est.sufficient).toBe(true)
    expect(Number(est.per_day)).toBe(8)
    expect(Number(est.days_remaining)).toBe(9.5) // 76 left / 8 per day
    expect(est.basis).toMatch(/24 pieces used across 3 entries over 3 days/)
  })

  it('stores photos only inside the household folder', async () => {
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))
    const path = `${hh}/${diaperId}/${uid()}.png`
    ok(await sunny.c.storage.from('item-photos').upload(path, png, { contentType: 'image/png' }))
    const signed = ok(await smita.c.storage.from('item-photos').createSignedUrl(path, 60)) as any
    const res = await fetch(signed.signedUrl)
    expect(res.status).toBe(200)
    expect((await outsider.c.storage.from('item-photos').createSignedUrl(path, 60)).error).toBeTruthy()
    expect((await outsider.c.storage.from('item-photos').upload(`${hh}/x/${uid()}.png`, png, { contentType: 'image/png' })).error).toBeTruthy()
    ok(await sunny.c.from('items').update({ photo_path: path }).eq('id', diaperId))
  })

  it('lets parents record each other\'s greeting but only rename themselves', async () => {
    ok(await smita.c.from('household_members').update({ greeting_title: 'Ma' }).eq('user_id', smita.id))
    const rename = await smita.c.from('household_members').update({ display_name: 'X' }).eq('user_id', sunny.id)
    expect(rename.error).toBeTruthy()
    const clip = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])
    const path = `${hh}/greeting/${uid()}.m4a`
    ok(await smita.c.storage.from('household-audio').upload(path, clip, { contentType: 'audio/mp4' }))
    ok(await smita.c.from('household_members').update({ greeting_audio_path: path }).eq('user_id', sunny.id))
    const row = ok(await sunny.c.from('household_members').select('greeting_audio_path, greeting_title').eq('user_id', sunny.id).single()) as any
    expect(row.greeting_audio_path).toBe(path)
    expect(row.greeting_title).toBe('Baba')
    expect((await outsider.c.storage.from('household-audio').createSignedUrl(path, 60)).error).toBeTruthy()
    const outsiderEdit = await outsider.c.from('household_members').update({ greeting_audio_path: null }).eq('user_id', sunny.id).select()
    expect(outsiderEdit.data ?? []).toHaveLength(0)
  })

  it('archives items without erasing purchase history', async () => {
    const before = ok(await sunny.c.rpc('spending_summary', {})) as any
    const del = await sunny.c.from('items').delete().eq('id', diaperId).select()
    expect(del.data ?? []).toHaveLength(0)
    ok(await sunny.c.from('items').update({ archived_at: new Date().toISOString() }).eq('id', diaperId))
    const after = ok(await sunny.c.rpc('spending_summary', {})) as any
    expect(after.all_time_cents).toBe(before.all_time_cents)
    const log = ok(await smita.c.from('activity_log').select('summary, actor').eq('entity_id', diaperId)) as any[]
    expect(log.some((l) => /Archived/.test(l.summary))).toBe(true)
  })
})
