import { useMemo, useState, type FormEvent } from 'react'
import { supabase, newRequestId, friendlyError } from '../lib/supabase'
import { useAction } from '../lib/actions'
import { useData, useHousehold, type Item, type Purchase } from '../lib/household'
import { money, parseMoney, todayNY } from '../lib/format'
import { emit } from '../lib/events'
import { ErrorNote, Field, ItemPhoto } from './ui'

const UNITS = ['item', 'pieces', 'packs', 'sets', 'bottles', 'bags', 'wipes', 'pads', 'units', 'oz', 'containers']

export function PurchaseForm({ item, onDone }: { item: Item; onDone: () => void }) {
  const { members } = useData()
  const { session } = useHousehold()
  const [request] = useState(newRequestId) // same id on retries → never double-counted
  const [packs, setPacks] = useState('1')
  const [perPack, setPerPack] = useState(item.is_consumable ? '' : '1')
  const [amount, setAmount] = useState('')
  const [dated, setDated] = useState(true)
  const [date, setDate] = useState(todayNY())
  const [retailer, setRetailer] = useState('')
  const [buyer, setBuyer] = useState(session?.user.id ?? '')
  const [notes, setNotes] = useState('')
  const { run, busy, error, setError } = useAction()

  const packN = parseInt(packs, 10)
  const perN = parseInt(perPack || '1', 10)
  const qty = packN > 0 && perN > 0 ? packN * perN : 0

  async function submit(e: FormEvent) {
    e.preventDefault()
    const cents = parseMoney(amount)
    if (!qty) return setError('Enter how many you bought')
    if (cents == null) return setError('Enter the total amount paid, like 35 or 35.49')
    if (dated && !date) return setError('Pick a date or choose "No date"')
    const r = await run(
      () =>
        supabase.rpc('record_purchase', {
          p_item_id: item.id, p_qty: qty, p_amount_cents: cents, p_request: request,
          p_purchased_on: dated ? date : null, p_retailer: retailer, p_buyer_user_id: buyer || null,
          p_buyer_label: buyer ? null : 'Not recorded', p_notes: notes,
          p_pack_count: item.is_consumable ? packN : null, p_units_per_pack: item.is_consumable ? perN : null,
        }),
      { success: `Purchase saved · ${money(cents)}`, stock: item.is_consumable },
    )
    if (r) onDone()
  }

  return (
    <form onSubmit={submit} className="form">
      {item.is_consumable ? (
        <div className="row-2">
          <Field label="Packs">
            <input inputMode="numeric" value={packs} onChange={(e) => setPacks(e.target.value.replace(/\D/g, ''))} />
          </Field>
          <Field label={`${item.unit} per pack`}>
            <input inputMode="numeric" value={perPack} placeholder="e.g. 120" onChange={(e) => setPerPack(e.target.value.replace(/\D/g, ''))} />
          </Field>
        </div>
      ) : (
        <Field label={`How many (${item.unit})`}>
          <input inputMode="numeric" value={packs} onChange={(e) => setPacks(e.target.value.replace(/\D/g, ''))} />
        </Field>
      )}
      {item.is_consumable && qty > 0 && (
        <p className="calc">Adds <strong>{qty} {item.unit}</strong> to stock{item.stock_qty != null ? ` (${item.stock_qty} → ${item.stock_qty + qty})` : ''}.</p>
      )}
      <Field label="Total paid (incl. tax & shipping)">
        <input inputMode="decimal" value={amount} placeholder="$0.00" onChange={(e) => setAmount(e.target.value)} />
      </Field>
      <div className="seg">
        <button type="button" className={dated ? 'on' : ''} onClick={() => setDated(true)}>Has a date</button>
        <button type="button" className={!dated ? 'on' : ''} onClick={() => setDated(false)}>No date</button>
      </div>
      {dated ? (
        <Field label="Purchase date">
          <input type="date" value={date} max={todayNY()} onChange={(e) => setDate(e.target.value)} />
        </Field>
      ) : (
        <p className="calc">Undated purchases count in all-time spending only, not this week or month.</p>
      )}
      <div className="row-2">
        <Field label="Store">
          <input value={retailer} onChange={(e) => setRetailer(e.target.value)} placeholder="Target, Amazon…" />
        </Field>
        <Field label="Bought by">
          <select value={buyer} onChange={(e) => setBuyer(e.target.value)}>
            {members.map((m) => (
              <option key={m.user_id} value={m.user_id}>{m.display_name}</option>
            ))}
            <option value="">Not recorded</option>
          </select>
        </Field>
      </div>
      <Field label="Notes">
        <input value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <ErrorNote message={error} />
      <button className="btn primary big" disabled={busy}>{busy ? 'Saving…' : 'Save purchase'}</button>
    </form>
  )
}

export function UsageForm({ item, onDone }: { item: Item; onDone: () => void }) {
  const [request] = useState(newRequestId)
  const [qty, setQty] = useState(1)
  const [date, setDate] = useState(todayNY())
  const { run, busy, error } = useAction()
  const after = item.stock_qty != null ? item.stock_qty - qty : null
  async function submit(e: FormEvent) {
    e.preventDefault()
    const r = await run(() => supabase.rpc('log_usage', { p_item_id: item.id, p_qty: qty, p_request: request, p_used_on: date }), {
      success: `Logged ${qty} used`, stock: true,
    })
    if (r) onDone()
  }
  if (item.stock_qty == null) {
    return <p className="calc">Count what you have first (use “Set stock”), then usage can be logged.</p>
  }
  return (
    <form onSubmit={submit} className="form">
      <div className="stepper">
        <button type="button" onClick={() => setQty((q) => Math.max(1, q - 1))} aria-label="Less">−</button>
        <input inputMode="numeric" value={qty} onChange={(e) => setQty(Math.max(1, parseInt(e.target.value.replace(/\D/g, '') || '1', 10)))} aria-label="Quantity used" />
        <button type="button" onClick={() => setQty((q) => q + 1)} aria-label="More">+</button>
      </div>
      <div className="chips center">
        {[1, 2, 5, 8, 10].map((n) => (
          <button type="button" key={n} className={`chip ${qty === n ? 'on' : ''}`} onClick={() => setQty(n)}>{n}</button>
        ))}
      </div>
      <p className="calc">{after != null && after >= 0 ? `${item.stock_qty} → ${after} ${item.unit} left` : `Only ${item.stock_qty} ${item.unit} recorded`}</p>
      <Field label="Day used">
        <input type="date" value={date} max={todayNY()} onChange={(e) => setDate(e.target.value)} />
      </Field>
      <ErrorNote message={error} />
      <button className="btn primary big" disabled={busy || (after != null && after < 0)}>{busy ? 'Saving…' : `Log ${qty} ${item.unit} used`}</button>
    </form>
  )
}

export function StockForm({ item, onDone }: { item: Item; onDone: () => void }) {
  const [request] = useState(newRequestId)
  const [expected] = useState(item.stock_qty) // what this parent saw when they opened the form
  const [qty, setQty] = useState(item.stock_qty?.toString() ?? '')
  const [note, setNote] = useState('')
  const { run, busy, error, setError } = useAction()
  async function submit(e: FormEvent) {
    e.preventDefault()
    const n = parseInt(qty, 10)
    if (Number.isNaN(n) || n < 0) return setError('Enter a count of 0 or more')
    const r = await run(
      () =>
        expected == null
          ? supabase.rpc('set_starting_stock', { p_item_id: item.id, p_qty: n, p_request: request, p_note: note })
          : supabase.rpc('correct_stock', { p_item_id: item.id, p_new_qty: n, p_expected_stock: expected, p_request: request, p_note: note }),
      { success: expected == null ? 'Starting stock saved' : 'Stock corrected', stock: true },
    )
    if (r) onDone()
  }
  return (
    <form onSubmit={submit} className="form">
      <p className="calc">
        {expected == null ? 'Count what you have on hand now. This starts tracking.' : 'Corrections fix the count only. They never add spending.'}
      </p>
      <Field label={`${item.unit} on hand`}>
        <input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))} autoFocus />
      </Field>
      <Field label="Reason (optional)">
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Recounted the drawer" />
      </Field>
      <ErrorNote message={error} />
      <button className="btn primary big" disabled={busy}>{busy ? 'Saving…' : 'Save count'}</button>
    </form>
  )
}

export function GiftForm({ item, onDone }: { item: Item; onDone: () => void }) {
  const [request] = useState(newRequestId)
  const [qty, setQty] = useState(item.is_consumable ? '' : '1')
  const [giver, setGiver] = useState('')
  const [dated, setDated] = useState(true)
  const [date, setDate] = useState(todayNY())
  const [notes, setNotes] = useState('')
  const { run, busy, error, setError } = useAction()
  async function submit(e: FormEvent) {
    e.preventDefault()
    const n = parseInt(qty, 10)
    if (!n || n < 1) return setError(`Enter how many ${item.unit} you received`)
    const r = await run(
      () => supabase.rpc('record_gift', { p_item_id: item.id, p_qty: n, p_request: request, p_received_on: dated ? date : null, p_giver: giver, p_notes: notes }),
      { success: 'Gift recorded', stock: item.is_consumable },
    )
    if (r) onDone()
  }
  return (
    <form onSubmit={submit} className="form">
      <p className="calc">Gifts add to what you have, but are not counted as household spending.</p>
      <div className="row-2">
        <Field label={`How many (${item.unit})`}>
          <input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))} />
        </Field>
        <Field label="From">
          <input value={giver} onChange={(e) => setGiver(e.target.value)} placeholder="Grandma" />
        </Field>
      </div>
      <div className="seg">
        <button type="button" className={dated ? 'on' : ''} onClick={() => setDated(true)}>Has a date</button>
        <button type="button" className={!dated ? 'on' : ''} onClick={() => setDated(false)}>No date</button>
      </div>
      {dated && (
        <Field label="Received on">
          <input type="date" value={date} max={todayNY()} onChange={(e) => setDate(e.target.value)} />
        </Field>
      )}
      <Field label="Notes">
        <input value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <ErrorNote message={error} />
      <button className="btn primary big" disabled={busy}>{busy ? 'Saving…' : 'Save gift'}</button>
    </form>
  )
}

export function EditPurchaseForm({ purchase, item, onDone }: { purchase: Purchase; item: Item; onDone: () => void }) {
  const { members } = useData()
  const [qty, setQty] = useState(String(purchase.qty))
  const [amount, setAmount] = useState((purchase.amount_cents / 100).toFixed(2))
  const [dated, setDated] = useState(!!purchase.purchased_on)
  const [date, setDate] = useState(purchase.purchased_on ?? todayNY())
  const [retailer, setRetailer] = useState(purchase.retailer ?? '')
  const [buyer, setBuyer] = useState(purchase.buyer_user_id ?? '')
  const [notes, setNotes] = useState(purchase.notes ?? '')
  const [confirmVoid, setConfirmVoid] = useState(false)
  const { run, busy, error, setError } = useAction()

  async function save(e: FormEvent) {
    e.preventDefault()
    const cents = parseMoney(amount)
    const n = parseInt(qty, 10)
    if (cents == null || !n) return setError('Check the quantity and amount')
    const r = await run(
      () =>
        supabase.rpc('update_purchase', {
          p_purchase_id: purchase.id, p_expected_version: purchase.version, p_qty: n, p_amount_cents: cents,
          p_purchased_on: dated ? date : null, p_retailer: retailer, p_buyer_user_id: buyer || null,
          p_buyer_label: buyer ? null : purchase.buyer_label ?? 'Not recorded', p_notes: notes,
        }),
      { success: 'Purchase updated', stock: item.is_consumable },
    )
    if (r) onDone()
  }
  async function remove() {
    const r = await run(() => supabase.rpc('void_purchase', { p_purchase_id: purchase.id, p_reason: 'Removed in app' }), {
      success: 'Purchase removed (kept in history)', stock: item.is_consumable,
    })
    if (r) onDone()
  }
  return (
    <form onSubmit={save} className="form">
      <p className="calc">{item.name}</p>
      <div className="row-2">
        <Field label={`Quantity (${item.unit})`}>
          <input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))} />
        </Field>
        <Field label="Total paid">
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
      </div>
      <div className="seg">
        <button type="button" className={dated ? 'on' : ''} onClick={() => setDated(true)}>Has a date</button>
        <button type="button" className={!dated ? 'on' : ''} onClick={() => setDated(false)}>No date</button>
      </div>
      {dated && (
        <Field label="Purchase date">
          <input type="date" value={date} max={todayNY()} onChange={(e) => setDate(e.target.value)} />
        </Field>
      )}
      <div className="row-2">
        <Field label="Store">
          <input value={retailer} onChange={(e) => setRetailer(e.target.value)} />
        </Field>
        <Field label="Bought by">
          <select value={buyer} onChange={(e) => setBuyer(e.target.value)}>
            <option value="">Not recorded</option>
            {members.map((m) => (
              <option key={m.user_id} value={m.user_id}>{m.display_name}</option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Notes">
        <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <ErrorNote message={error} />
      <button className="btn primary big" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
      {confirmVoid ? (
        <div className="confirm-row">
          <span>Remove this purchase from spending? It stays in history.</span>
          <button type="button" className="btn danger" onClick={remove} disabled={busy}>Remove</button>
          <button type="button" className="btn ghost" onClick={() => setConfirmVoid(false)}>Keep</button>
        </div>
      ) : (
        <button type="button" className="btn ghost" onClick={() => setConfirmVoid(true)}>Remove purchase…</button>
      )}
    </form>
  )
}

export interface ItemDraft {
  name: string
  brand: string
  model: string
  size: string
  color: string
  category: string
  unit: string
  required_qty: string
  is_consumable: boolean
  low_stock_threshold: string
  estimated_price: string
  notes: string
}

export function draftFrom(item?: Partial<Item>): ItemDraft {
  return {
    name: item?.name ?? '',
    brand: item?.brand ?? '',
    model: item?.model ?? '',
    size: item?.size ?? '',
    color: item?.color ?? '',
    category: item?.category ?? 'Other',
    unit: item?.unit ?? 'item',
    required_qty: item?.required_qty?.toString() ?? '',
    is_consumable: item?.is_consumable ?? false,
    low_stock_threshold: item?.low_stock_threshold?.toString() ?? '',
    estimated_price: item?.estimated_price_cents != null ? (item.estimated_price_cents / 100).toFixed(2) : '',
    notes: item?.notes ?? '',
  }
}

// Create or edit an item. Edits carry the version they started from; if the
// partner saved first, nothing is overwritten and the parent is told.
export function ItemForm({ item, initial, onDone }: { item?: Item; initial?: Partial<Item>; onDone: (id?: string) => void }) {
  const { items, household } = useData()
  const [d, setD] = useState<ItemDraft>(draftFrom(item ?? initial))
  const [startVersion] = useState(item?.version)
  const { run, busy, error, setError } = useAction()
  const categories = useMemo(() => [...new Set(['Feeding', 'Diapering', 'Sleeping', 'Baby Gears', 'Bathing', 'Health & Safety', 'Clothing', 'Playing', 'Postpartum', ...items.map((i) => i.category)])].sort(), [items])
  const set = <K extends keyof ItemDraft>(k: K, v: ItemDraft[K]) => setD((x) => ({ ...x, [k]: v }))

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!d.name.trim()) return setError('Give the item a name')
    const est = d.estimated_price ? parseMoney(d.estimated_price) : null
    if (d.estimated_price && est == null) return setError('Estimated price should look like 49.99')
    const row = {
      name: d.name.trim(), brand: d.brand.trim() || null, model: d.model.trim() || null, size: d.size.trim() || null,
      color: d.color.trim() || null, category: d.category.trim() || 'Other', unit: d.unit.trim() || 'item',
      required_qty: d.required_qty ? parseInt(d.required_qty, 10) : null, is_consumable: d.is_consumable,
      low_stock_threshold: d.is_consumable && d.low_stock_threshold ? parseInt(d.low_stock_threshold, 10) : null,
      estimated_price_cents: est, notes: d.notes.trim() || null,
    }
    if (item) {
      const res = await run(async () => {
        const r = await supabase.from('items').update(row).eq('id', item.id).eq('version', startVersion!).select('id')
        if (!r.error && (r.data ?? []).length === 0) {
          return { data: null, error: { message: 'Someone else changed this item while you were editing. Close and reopen to see their changes.' } }
        }
        return r
      }, { success: 'Item updated' })
      if (res) onDone(item.id)
    } else {
      const res = await run(async () => supabase.from('items').insert({ ...row, household_id: household.id, photo_url: initial?.photo_url ?? null }).select('id').single(), { success: `${row.name} added` })
      if (res) onDone((res as { id: string }).id)
    }
  }

  return (
    <form onSubmit={submit} className="form">
      <Field label="Name">
        <input value={d.name} onChange={(e) => set('name', e.target.value)} placeholder="Diapers" autoFocus={!item} />
      </Field>
      <div className="row-2">
        <Field label="Brand"><input value={d.brand} onChange={(e) => set('brand', e.target.value)} /></Field>
        <Field label="Model"><input value={d.model} onChange={(e) => set('model', e.target.value)} /></Field>
      </div>
      <div className="row-2">
        <Field label="Size" hint={d.is_consumable ? 'One item per size, e.g. Newborn' : undefined}><input value={d.size} onChange={(e) => set('size', e.target.value)} /></Field>
        <Field label="Color"><input value={d.color} onChange={(e) => set('color', e.target.value)} /></Field>
      </div>
      <Field label="Category">
        <input list="categories" value={d.category} onChange={(e) => set('category', e.target.value)} />
        <datalist id="categories">{categories.map((c) => <option key={c} value={c} />)}</datalist>
      </Field>
      <label className="toggle">
        <input type="checkbox" checked={d.is_consumable} onChange={(e) => set('is_consumable', e.target.checked)} />
        <span>Gets used up (track stock)</span>
      </label>
      <div className="row-2">
        <Field label="Unit">
          <input list="units" value={d.unit} onChange={(e) => set('unit', e.target.value)} />
          <datalist id="units">{UNITS.map((u) => <option key={u} value={u} />)}</datalist>
        </Field>
        <Field label="Need (qty)" hint="Leave blank if not set">
          <input inputMode="numeric" value={d.required_qty} onChange={(e) => set('required_qty', e.target.value.replace(/\D/g, ''))} />
        </Field>
      </div>
      {d.is_consumable && (
        <Field label={`Alert when at or below (${d.unit})`} hint="e.g. 20 diapers">
          <input inputMode="numeric" value={d.low_stock_threshold} onChange={(e) => set('low_stock_threshold', e.target.value.replace(/\D/g, ''))} />
        </Field>
      )}
      <Field label="Estimated price (planning only)" hint="Not counted as spending">
        <input inputMode="decimal" value={d.estimated_price} onChange={(e) => set('estimated_price', e.target.value)} placeholder="$" />
      </Field>
      <Field label="Notes"><textarea rows={3} value={d.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
      <ErrorNote message={error} />
      <button className="btn primary big" disabled={busy}>{busy ? 'Saving…' : item ? 'Save changes' : 'Add item'}</button>
    </form>
  )
}

// Photo: upload from camera/library, paste a direct image link, or search real listings.
export function PhotoPicker({ item, onDone }: { item: Item; onDone: () => void }) {
  const { photoUrls } = useData()
  const { refresh } = useHousehold()
  const [tab, setTab] = useState<'search' | 'upload' | 'link'>('search')
  const [query, setQuery] = useState([item.brand, item.name].filter(Boolean).join(' '))
  const [results, setResults] = useState<{ title: string; source: string | null; link: string; thumbnail: string; price: string | null }[] | null>(null)
  const [notConnected, setNotConnected] = useState<string | null>(null)
  const [link, setLink] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function finish(update: Partial<Item>, msg: string) {
    const { error: e } = await supabase.from('items').update(update).eq('id', item.id)
    if (e) throw e
    emit({ type: 'saved', message: msg })
    await refresh()
    onDone()
  }

  async function guarded(fn: () => Promise<void>) {
    if (busy) return
    if (!navigator.onLine) return setError("You're offline. Photos can be added when you're connected.")
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  const search = () =>
    guarded(async () => {
      const { data, error: e } = await supabase.functions.invoke('product-lookup', { body: { action: 'search', query } })
      if (e) throw new Error((await (e as { context?: Response }).context?.json?.().catch(() => null))?.error ?? 'Product search failed')
      if (!data.connected) {
        setNotConnected(data.message)
        setResults([])
        return
      }
      setResults(data.results)
    })

  const choose = (r: { thumbnail: string; link: string; source: string | null }) =>
    guarded(async () => {
      // Try to keep a private copy; fall back to linking the listing photo.
      const { data } = await supabase.functions.invoke('product-lookup', { body: { action: 'save', item_id: item.id, image_url: r.thumbnail } })
      await finish(
        { photo_path: data?.path ?? null, photo_url: data?.path ? null : r.thumbnail, photo_source_url: r.link, photo_source_name: r.source },
        'Photo saved',
      )
    })

  const upload = (file: File) =>
    guarded(async () => {
      const blob = await shrinkImage(file)
      const path = `${item.household_id}/${item.id}/${crypto.randomUUID()}.jpg`
      const { error: e } = await supabase.storage.from('item-photos').upload(path, blob, { contentType: 'image/jpeg' })
      if (e) throw e
      await finish({ photo_path: path, photo_url: null, photo_source_url: null, photo_source_name: 'Your photo' }, 'Photo uploaded')
    })

  const useLink = () =>
    guarded(async () => {
      if (!/^https:\/\//i.test(link.trim())) throw new Error('Paste an image link that starts with https://')
      const { data } = await supabase.functions.invoke('product-lookup', { body: { action: 'save', item_id: item.id, image_url: link.trim() } })
      await finish({ photo_path: data?.path ?? null, photo_url: data?.path ? null : link.trim(), photo_source_url: null, photo_source_name: 'Image link' }, 'Photo saved')
    })

  return (
    <div className="form">
      <div className="photo-preview"><ItemPhoto item={item} url={photoUrls[item.id]} size="lg" /></div>
      <div className="seg">
        <button type="button" className={tab === 'search' ? 'on' : ''} onClick={() => setTab('search')}>Find product</button>
        <button type="button" className={tab === 'upload' ? 'on' : ''} onClick={() => setTab('upload')}>Upload</button>
        <button type="button" className={tab === 'link' ? 'on' : ''} onClick={() => setTab('link')}>Image link</button>
      </div>
      {tab === 'search' && (
        <>
          <div className="search-row">
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. Cybex stroller" onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), search())} />
            <button className="btn primary" onClick={search} disabled={busy || query.trim().length < 2}>{busy ? '…' : 'Search'}</button>
          </div>
          <p className="field-hint">Pick the exact model you own. Shown prices are today's listings, not what you paid.</p>
          {notConnected && <div className="notice">{notConnected}</div>}
          {results && results.length === 0 && !notConnected && <p className="calc">No listings found. Try a more specific name.</p>}
          <div className="results">
            {results?.map((r) => (
              <div key={r.link} className="result">
                <img src={r.thumbnail} alt="" referrerPolicy="no-referrer" />
                <div className="result-text">
                  <strong>{r.title}</strong>
                  <span>{[r.source, r.price].filter(Boolean).join(' · ')}</span>
                  <a href={r.link} target="_blank" rel="noreferrer">View source ↗</a>
                </div>
                <button className="btn small" onClick={() => choose(r)} disabled={busy}>Use</button>
              </div>
            ))}
          </div>
        </>
      )}
      {tab === 'upload' && (
        <label className="upload-drop">
          <input type="file" accept="image/*" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} disabled={busy} />
          <span>{busy ? 'Uploading…' : 'Take a photo or choose from your library'}</span>
        </label>
      )}
      {tab === 'link' && (
        <>
          <Field label="Direct image link (https://…)">
            <input value={link} onChange={(e) => setLink(e.target.value)} inputMode="url" />
          </Field>
          <button className="btn primary big" onClick={useLink} disabled={busy}>{busy ? 'Saving…' : 'Use this image'}</button>
        </>
      )}
      <ErrorNote message={error} />
    </div>
  )
}

// Resize big phone photos before upload (keeps storage and data use small).
async function shrinkImage(file: File, max = 1600): Promise<Blob> {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image()
      i.onload = () => resolve(i)
      i.onerror = () => reject(new Error('That file could not be read as an image'))
      i.src = url
    })
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(img.naturalWidth * scale)
    canvas.height = Math.round(img.naturalHeight * scale)
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not process the photo'))), 'image/jpeg', 0.85))
  } finally {
    URL.revokeObjectURL(url)
  }
}
