import type { Snapshot } from './household'
import { memberName } from './household'

function csv(rows: (string | number | null | undefined)[][]) {
  return rows.map((r) => r.map((v) => {
    const s = v == null ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }).join(',')).join('\n')
}

export function download(name: string, body: string, type: string) {
  const blob = new Blob([body], { type })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 2000)
}

export function purchasesCsv(d: Snapshot) {
  const items = new Map(d.items.map((i) => [i.id, i]))
  return csv([
    ['purchase_date', 'item', 'category', 'size', 'quantity', 'unit', 'amount_usd', 'retailer', 'buyer', 'notes', 'status'],
    ...d.purchases.map((p) => {
      const i = items.get(p.item_id)
      return [p.purchased_on ?? 'undated', i?.name, i?.category, i?.size, p.qty, i?.unit, (p.amount_cents / 100).toFixed(2), p.retailer,
        memberName(d.members, p.buyer_user_id) ?? p.buyer_label, p.notes, p.voided_at ? 'removed' : 'active']
    }),
  ])
}

export function itemsCsv(d: Snapshot) {
  return csv([
    ['name', 'brand', 'model', 'size', 'color', 'category', 'status', 'required', 'acquired', 'gifted', 'stock', 'unit', 'alert_at', 'spent_usd', 'estimated_usd', 'archived', 'notes'],
    ...d.items.map((i) => [i.name, i.brand, i.model, i.size, i.color, i.category, i.status, i.required_qty, i.acquired_qty, i.gifted_qty,
      i.stock_qty ?? 'unknown', i.unit, i.low_stock_threshold, (i.spent_cents / 100).toFixed(2),
      i.estimated_price_cents != null ? (i.estimated_price_cents / 100).toFixed(2) : '', i.archived_at ? 'yes' : '', i.notes]),
  ])
}

