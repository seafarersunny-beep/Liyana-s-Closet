import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useData, type Item } from '../lib/household'
import { Empty, ItemPhoto, Sheet, StockBadge, StockBar } from '../components/ui'
import { StockForm, UsageForm, PurchaseForm } from '../components/forms'
import { itemSubtitle } from './Registry'

export function useAlerts() {
  const { items } = useData()
  return useMemo(() => {
    const active = items.filter((i) => !i.archived_at && i.is_consumable)
    return {
      out: active.filter((i) => i.stock_level === 'out'),
      low: active.filter((i) => i.stock_level === 'low'),
      unknown: active.filter((i) => i.stock_level === 'unknown'),
    }
  }, [items])
}

export function AlertCenter() {
  const { out, low, unknown } = useAlerts()
  if (!out.length && !low.length) {
    return (
      <div className="card alert-center calm">
        <strong>No stock alerts</strong>
        <span>{unknown.length ? `${unknown.length} item${unknown.length === 1 ? '' : 's'} not counted yet, so they can't alert.` : 'Everything tracked is above its alert level.'}</span>
      </div>
    )
  }
  return (
    <div className="card alert-center" role="region" aria-label="Stock alerts">
      <strong>Alerts</strong>
      {[...out, ...low].map((i) => (
        <Link key={i.id} to={`/item/${i.id}`} className={`alert-row level-${i.stock_level}`}>
          <span className="dot" />
          <span className="alert-name">{i.name}{i.size ? ` (${i.size})` : ''}</span>
          <span>{i.stock_level === 'out' ? 'Out' : `${i.stock_qty} left`}</span>
        </Link>
      ))}
    </div>
  )
}

export function InventoryScreen() {
  const { items, photoUrls, estimates } = useData()
  const [sheet, setSheet] = useState<{ item: Item; kind: 'use' | 'stock' | 'buy' } | null>(null)
  const list = useMemo(() => {
    const rank = { out: 0, low: 1, ok: 2, unknown: 3 }
    return items.filter((i) => !i.archived_at && i.is_consumable).sort((a, b) => rank[a.stock_level] - rank[b.stock_level] || a.name.localeCompare(b.name))
  }, [items])
  const close = () => setSheet(null)

  return (
    <div className="screen">
      <header className="screen-head"><h1>Inventory</h1></header>
      <AlertCenter />
      {list.length === 0 ? (
        <Empty title="No consumables yet">Mark an item as “Gets used up” (like diapers or wipes) to track stock.</Empty>
      ) : (
        <div className="inv-list">
          {list.map((i) => {
            const est = estimates.find((e) => e.item_id === i.id && e.sufficient)
            return (
              <div key={i.id} className={`inv-card level-${i.stock_level}`}>
                <Link to={`/item/${i.id}`} className="inv-top">
                  <ItemPhoto item={i} url={photoUrls[i.id]} size="sm" />
                  <div>
                    <h3>{i.name}</h3>
                    {itemSubtitle(i) && <p className="sub">{itemSubtitle(i)}</p>}
                    <div className="badges"><StockBadge level={i.stock_level} /></div>
                  </div>
                  <div className="inv-count">
                    {i.stock_qty == null ? <span className="unknown">?</span> : <strong>{i.stock_qty}</strong>}
                    <span>{i.unit}</span>
                  </div>
                </Link>
                <StockBar item={i} />
                {est?.days_remaining != null && <p className="estimate small">Estimate: ~{Math.floor(est.days_remaining)} days left · {est.basis}</p>}
                <div className="inv-actions">
                  {i.stock_qty == null ? (
                    <button className="btn sage" onClick={() => setSheet({ item: i, kind: 'stock' })}>Count stock</button>
                  ) : (
                    <button className="btn sage" onClick={() => setSheet({ item: i, kind: 'use' })}>− Used</button>
                  )}
                  <button className="btn soft" onClick={() => setSheet({ item: i, kind: 'buy' })}>+ Restock</button>
                </div>
              </div>
            )
          })}
        </div>
      )}
      <Sheet open={sheet?.kind === 'use'} onClose={close} title={`Used ${sheet?.item.name ?? ''}`}>{sheet?.kind === 'use' && <UsageForm item={sheet.item} onDone={close} />}</Sheet>
      <Sheet open={sheet?.kind === 'stock'} onClose={close} title="Stock count">{sheet?.kind === 'stock' && <StockForm item={sheet.item} onDone={close} />}</Sheet>
      <Sheet open={sheet?.kind === 'buy'} onClose={close} title={`Restock ${sheet?.item.name ?? ''}`}>{sheet?.kind === 'buy' && <PurchaseForm item={sheet.item} onDone={close} />}</Sheet>
    </div>
  )
}
