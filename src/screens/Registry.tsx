import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAction } from '../lib/actions'
import { memberName, useData, type Item, type Status } from '../lib/household'
import { formatDate, formatWhen, money } from '../lib/format'
import { Empty, ItemPhoto, Sheet, StatusBadge, StockBadge, StockBar, categoryIcon } from '../components/ui'
import { EditPurchaseForm, GiftForm, ItemForm, PhotoPicker, PurchaseForm, StockForm, UsageForm } from '../components/forms'

export function itemSubtitle(i: Item) {
  return [i.brand, i.model, i.size && `Size ${i.size}`, i.color].filter(Boolean).join(' · ')
}

export function qtyLine(i: Item) {
  if (i.required_qty != null) return `${i.acquired_qty} of ${i.required_qty} ${i.unit === 'item' ? '' : i.unit}`.trim()
  if (i.acquired_qty) return `${i.acquired_qty} ${i.unit} acquired`
  return 'Quantity not set'
}

export function ItemCard({ item }: { item: Item }) {
  const { photoUrls } = useData()
  return (
    <Link to={`/item/${item.id}`} className={`item-card ${item.archived_at ? 'archived' : ''}`}>
      <ItemPhoto item={item} url={photoUrls[item.id]} />
      <div className="item-card-body">
        <div className="item-card-top">
          <span className="cat">{categoryIcon(item.category)} {item.category}</span>
          {item.needs_review && <span className="badge review">Please confirm</span>}
        </div>
        <h3>{item.name}</h3>
        {itemSubtitle(item) && <p className="sub">{itemSubtitle(item)}</p>}
        <div className="badges">
          <StatusBadge status={item.status} />
          <StockBadge level={item.stock_level} />
        </div>
        <div className="item-card-meta">
          <span>{qtyLine(item)}</span>
          {item.spent_cents > 0 && <span className="spent">{money(item.spent_cents)} spent</span>}
          {item.spent_cents === 0 && item.estimated_price_cents != null && <span className="est">est. {money(item.estimated_price_cents)}</span>}
        </div>
        {item.is_consumable && (
          <div className="item-card-stock">
            <StockBar item={item} />
            {item.stock_qty != null && <span>{item.stock_qty} {item.unit} left</span>}
          </div>
        )}
      </div>
    </Link>
  )
}

const STATUSES: (Status | 'all' | 'review')[] = ['all', 'needed', 'partial', 'purchased', 'gifted', 'review']
const STATUS_TEXT: Record<string, string> = { all: 'All', needed: 'Needed', partial: 'Partly', purchased: 'Purchased', gifted: 'Gifted', review: 'To confirm' }

export function RegistryScreen() {
  const { items } = useData()
  const [q, setQ] = useState('')
  const [params] = useSearchParams()
  const [status, setStatus] = useState<(typeof STATUSES)[number]>(params.get('review') ? 'review' : 'all')
  const [cat, setCat] = useState('all')
  const [showArchived, setShowArchived] = useState(false)
  const [adding, setAdding] = useState(false)
  const nav = useNavigate()

  const cats = useMemo(() => [...new Set(items.filter((i) => !i.archived_at).map((i) => i.category))].sort(), [items])
  const list = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    return items.filter((i) => {
      if (!!i.archived_at !== showArchived) return false
      if (cat !== 'all' && i.category !== cat) return false
      if (status === 'review' ? !i.needs_review : status !== 'all' && i.status !== status) return false
      const hay = [i.name, i.brand, i.model, i.size, i.color, i.category, i.notes].join(' ').toLowerCase()
      return words.every((w) => hay.includes(w))
    })
  }, [items, q, status, cat, showArchived])

  const grouped = useMemo(() => {
    const m = new Map<string, Item[]>()
    for (const i of list) m.set(i.category, [...(m.get(i.category) ?? []), i])
    return [...m.entries()]
  }, [list])

  return (
    <div className="screen">
      <header className="screen-head">
        <h1>Registry</h1>
        <button className="btn primary" onClick={() => setAdding(true)}>+ Add</button>
      </header>
      <input className="search" type="search" placeholder="Search items, brands, sizes…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="chips scroll">
        {STATUSES.map((s) => (
          <button key={s} className={`chip ${status === s ? 'on' : ''}`} onClick={() => setStatus(s)}>{STATUS_TEXT[s]}</button>
        ))}
      </div>
      <div className="chips scroll">
        <button className={`chip ${cat === 'all' ? 'on' : ''}`} onClick={() => setCat('all')}>Every category</button>
        {cats.map((c) => (
          <button key={c} className={`chip ${cat === c ? 'on' : ''}`} onClick={() => setCat(c)}>{categoryIcon(c)} {c}</button>
        ))}
      </div>
      {list.length === 0 ? (
        items.length === 0 ? (
          <Empty title="Your registry is empty">
            <p>Import your spreadsheet or add your first item.</p>
            <Link className="btn primary" to="/import">Import Book1.xlsx</Link>
          </Empty>
        ) : (
          <Empty title="Nothing matches">Try another search or filter.</Empty>
        )
      ) : (
        grouped.map(([c, its]) => (
          <section key={c}>
            <h2 className="section-title">{categoryIcon(c)} {c} <span className="count">{its.length}</span></h2>
            <div className="card-grid">{its.map((i) => <ItemCard key={i.id} item={i} />)}</div>
          </section>
        ))
      )}
      <button className="btn ghost wide" onClick={() => setShowArchived((v) => !v)}>{showArchived ? 'Back to active items' : 'Show archived items'}</button>
      <Sheet open={adding} onClose={() => setAdding(false)} title="Add an item">
        <ItemForm onDone={(id) => { setAdding(false); if (id) nav(`/item/${id}`) }} />
      </Sheet>
    </div>
  )
}

type Panel = null | 'edit' | 'buy' | 'use' | 'stock' | 'gift' | 'photo' | 'variant' | { purchase: string }

export function ItemScreen() {
  const { id } = useParams()
  const { items, purchases, gifts, members, photoUrls, estimates } = useData()
  const item = items.find((i) => i.id === id)
  const [panel, setPanel] = useState<Panel>(null)
  const [history, setHistory] = useState<{ id: string; kind: string; delta: number; stock_after: number; note: string | null; created_by: string | null; created_at: string; occurred_on: string }[]>([])
  const { run, busy } = useAction()
  const nav = useNavigate()

  useEffect(() => {
    if (!item?.is_consumable) return
    supabase.from('stock_events').select('id,kind,delta,stock_after,note,created_by,created_at,occurred_on').eq('item_id', item.id).order('created_at', { ascending: false }).limit(50)
      .then(({ data }) => setHistory(data ?? []))
  }, [item?.id, item?.is_consumable, item?.stock_qty])

  if (!item) return <div className="screen"><Empty title="Item not found">It may have been removed. <Link to="/registry">Back to registry</Link></Empty></div>
  const its = purchases.filter((p) => p.item_id === item.id)
  const gs = gifts.filter((g) => g.item_id === item.id && !g.voided_at)
  const est = estimates.find((e) => e.item_id === item.id)
  const close = () => setPanel(null)
  const editing = typeof panel === 'object' && panel ? its.find((p) => p.id === panel.purchase) : undefined

  const archive = () =>
    run(() => supabase.from('items').update({ archived_at: item.archived_at ? null : new Date().toISOString() }).eq('id', item.id), {
      success: item.archived_at ? 'Item restored' : 'Item archived (purchase history kept)',
    })
  const confirmReview = () => run(() => supabase.from('items').update({ needs_review: false }).eq('id', item.id), { success: 'Marked as confirmed' })

  return (
    <div className="screen item-screen">
      <button className="back" onClick={() => nav(-1)}>‹ Back</button>
      <div className="hero-photo" onClick={() => setPanel('photo')}>
        <ItemPhoto item={item} url={photoUrls[item.id]} size="lg" />
        <span className="photo-edit">{item.photo_path || item.photo_url ? 'Change photo' : 'Add photo'}</span>
      </div>
      {item.photo_source_url && <a className="source" href={item.photo_source_url} target="_blank" rel="noreferrer">Photo source: {item.photo_source_name ?? 'listing'} ↗</a>}
      <span className="cat">{categoryIcon(item.category)} {item.category}{item.master_no ? ` · Master list #${item.master_no}` : ''}</span>
      <h1 className="item-title">{item.name}</h1>
      {itemSubtitle(item) && <p className="sub">{itemSubtitle(item)}</p>}
      <div className="badges"><StatusBadge status={item.status} /><StockBadge level={item.stock_level} />{item.archived_at && <span className="badge">Archived</span>}</div>

      {item.needs_review && (
        <div className="notice review-box">
          <strong>Please confirm</strong>
          <p>{item.review_note}</p>
          <button className="btn small" onClick={confirmReview} disabled={busy}>Looks right</button>
        </div>
      )}

      <div className="stats">
        <div><span>Needed</span><strong>{item.required_qty ?? '—'}</strong></div>
        <div><span>Acquired</span><strong>{item.acquired_qty}</strong></div>
        <div><span>Spent</span><strong>{money(item.spent_cents)}</strong></div>
      </div>
      {item.estimated_price_cents != null && <p className="calc">Estimated price {money(item.estimated_price_cents)} (planning only)</p>}

      {item.is_consumable && (
        <div className="card stock-card">
          <div className="stock-head">
            <strong>{item.stock_qty == null ? 'Stock unknown' : `${item.stock_qty} ${item.unit} left`}</strong>
            <span>{item.low_stock_threshold != null ? `Alert at ${item.low_stock_threshold}` : 'No alert set'}</span>
          </div>
          <StockBar item={item} />
          {est && (
            <p className="estimate">
              {est.sufficient && est.days_remaining != null
                ? <>Estimate: about <strong>{Math.floor(est.days_remaining)} days</strong> left at {est.per_day}/day. <span>{est.basis}.</span></>
                : <>Not enough usage history for an estimate yet ({est.basis}). Log usage on at least 3 days.</>}
            </p>
          )}
        </div>
      )}

      <div className="action-grid">
        <button className="btn primary" onClick={() => setPanel('buy')}>Record purchase</button>
        {item.is_consumable && <button className="btn sage" onClick={() => setPanel('use')}>Log usage</button>}
        <button className="btn soft" onClick={() => setPanel('gift')}>Record gift</button>
        {item.is_consumable && <button className="btn soft" onClick={() => setPanel('stock')}>{item.stock_qty == null ? 'Set stock' : 'Correct stock'}</button>}
        <button className="btn soft" onClick={() => setPanel('edit')}>Edit details</button>
        <button className="btn soft" onClick={() => setPanel('variant')}>Add another size</button>
      </div>

      {item.notes && <p className="notes">{item.notes}</p>}

      <h2 className="section-title">Purchases</h2>
      {its.length === 0 ? <p className="calc">No purchases recorded.</p> : (
        <ul className="list">
          {its.map((p) => (
            <li key={p.id} className={p.voided_at ? 'voided' : ''} onClick={() => !p.voided_at && setPanel({ purchase: p.id })}>
              <div>
                <strong>{money(p.amount_cents)}</strong> · {p.qty} {item.unit}
                {p.pack_count && p.units_per_pack ? ` (${p.pack_count}×${p.units_per_pack})` : ''}
                <div className="sub">
                  {p.purchased_on ? formatDate(p.purchased_on) : <span className="badge undated">No date</span>}
                  {p.retailer ? ` · ${p.retailer}` : ''} · {memberName(members, p.buyer_user_id) ?? p.buyer_label ?? 'Buyer not recorded'}
                </div>
                {p.voided_at && <div className="sub">Removed {formatWhen(p.voided_at)}</div>}
              </div>
              {!p.voided_at && <span className="chev">Edit ›</span>}
            </li>
          ))}
        </ul>
      )}

      {gs.length > 0 && (
        <>
          <h2 className="section-title">Gifts</h2>
          <ul className="list">
            {gs.map((g) => (
              <li key={g.id}><div><strong>{g.qty} {item.unit}</strong>{g.giver ? ` from ${g.giver}` : ''}<div className="sub">{formatDate(g.received_on)}</div></div></li>
            ))}
          </ul>
        </>
      )}

      {item.is_consumable && history.length > 0 && (
        <>
          <h2 className="section-title">Stock history</h2>
          <ul className="list history">
            {history.map((h) => (
              <li key={h.id}>
                <div>
                  <strong className={h.delta < 0 ? 'neg' : 'pos'}>{h.delta > 0 ? '+' : ''}{h.delta}</strong> {h.kind} → {h.stock_after}
                  <div className="sub">{memberName(members, h.created_by) ?? 'Someone'} · {formatWhen(h.created_at)}{h.note ? ` · ${h.note}` : ''}</div>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      <button className="btn ghost wide" onClick={archive} disabled={busy}>{item.archived_at ? 'Restore item' : 'Archive item'}</button>

      <Sheet open={panel === 'buy'} onClose={close} title={`Buy ${item.name}`}><PurchaseForm item={item} onDone={close} /></Sheet>
      <Sheet open={panel === 'use'} onClose={close} title={`Used ${item.name}`}><UsageForm item={item} onDone={close} /></Sheet>
      <Sheet open={panel === 'stock'} onClose={close} title="Stock count"><StockForm item={item} onDone={close} /></Sheet>
      <Sheet open={panel === 'gift'} onClose={close} title="Record a gift"><GiftForm item={item} onDone={close} /></Sheet>
      <Sheet open={panel === 'edit'} onClose={close} title="Edit item"><ItemForm item={item} onDone={close} /></Sheet>
      <Sheet open={panel === 'photo'} onClose={close} title="Product photo"><PhotoPicker item={item} onDone={close} /></Sheet>
      <Sheet open={panel === 'variant'} onClose={close} title="Add another size">
        <ItemForm initial={{ ...item, size: '', notes: null, required_qty: null, photo_url: item.photo_url }} onDone={(nid) => { close(); if (nid) nav(`/item/${nid}`) }} />
      </Sheet>
      <Sheet open={!!editing} onClose={close} title="Edit purchase">{editing && <EditPurchaseForm purchase={editing} item={item} onDone={close} />}</Sheet>
    </div>
  )
}
