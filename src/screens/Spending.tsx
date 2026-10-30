import { useMemo, useState, type FormEvent } from 'react'
import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { supabase } from '../lib/supabase'
import { useAction } from '../lib/actions'
import { memberName, useData } from '../lib/household'
import { formatDate, money, moneyShort, monthLabel, parseMoney } from '../lib/format'
import { Empty, ErrorNote, Field, Sheet } from '../components/ui'
import { EditPurchaseForm } from '../components/forms'
import { ExportButtons } from './Settings'

const BAR = '#3E8C55' // validated: lightness band, chroma floor, 3:1 on the cream surface

function Tip({ active, payload, label }: { active?: boolean; payload?: { value: number }[]; label?: string }) {
  if (!active || !payload?.length) return null
  return <div className="chart-tip"><strong>{label}</strong><span>{money(payload[0].value)}</span></div>
}

export function SpendingScreen() {
  const data = useData()
  const { summary: s, purchases, items, members, household } = data
  const [filter, setFilter] = useState<'all' | 'undated' | 'month'>('all')
  const [editing, setEditing] = useState<string | null>(null)
  const [budgetOpen, setBudgetOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])
  const active = purchases.filter((p) => !p.voided_at)
  const list = active.filter((p) =>
    filter === 'undated' ? !p.purchased_on : filter === 'month' ? !!p.purchased_on && p.purchased_on >= s.month_start && p.purchased_on <= s.today : true,
  )
  const cat = s.by_category.map((c) => ({ name: c.category, cents: c.cents }))
  const months = s.by_month.slice(-8).map((m) => ({ name: monthLabel(m.month), cents: m.cents }))
  const budget = s.monthly_budget_cents
  const pct = budget ? Math.min(100, (s.month_cents / budget) * 100) : 0
  const editingP = active.find((p) => p.id === editing)

  return (
    <div className="screen">
      <header className="screen-head"><h1>Spending</h1><button className="btn soft small" onClick={() => setExportOpen(true)}>Export</button></header>
      <div className="tiles">
        <div className="tile"><span>This week</span><strong>{moneyShort(s.week_cents)}</strong><em>since Mon {formatDate(s.week_start).replace(/, \d{4}$/, '')}</em></div>
        <div className="tile"><span>This month</span><strong>{moneyShort(s.month_cents)}</strong><em>{new Date(s.month_start + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })}</em></div>
        <div className="tile wide"><span>All time</span><strong>{moneyShort(s.all_time_cents)}</strong><em>{s.purchase_count} purchases · gifts not included</em></div>
      </div>
      {s.undated_count > 0 && (
        <button className="notice undated-box" onClick={() => setFilter('undated')}>
          <strong>{money(s.undated_cents)} has no purchase date</strong>
          <span>{s.undated_count} purchase{s.undated_count === 1 ? '' : 's'} count in all-time only, not in any week or month. Tap to add dates.</span>
        </button>
      )}
      <div className="card budget">
        <div className="budget-head">
          <strong>Monthly budget</strong>
          <button className="link" onClick={() => setBudgetOpen(true)}>{budget ? 'Change' : 'Set a budget'}</button>
        </div>
        {budget ? (
          <>
            <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={budget} aria-valuenow={s.month_cents}><div style={{ width: `${pct}%` }} className={s.month_cents > budget ? 'over' : ''} /></div>
            <p className="calc">{money(s.month_cents)} of {money(budget)} · {s.month_cents > budget ? `${money(s.month_cents - budget)} over` : `${money(budget - s.month_cents)} left`} (dated purchases only)</p>
          </>
        ) : <p className="calc">Optional. Helps you see this month at a glance.</p>}
      </div>

      <h2 className="section-title">By category</h2>
      {cat.length === 0 ? <p className="calc">No spending yet.</p> : (
        <div className="card chart">
          <ResponsiveContainer width="100%" height={Math.max(120, cat.length * 38)}>
            <BarChart data={cat} layout="vertical" margin={{ left: 4, right: 64, top: 4, bottom: 4 }} barCategoryGap={6}>
              <XAxis type="number" hide />
              <YAxis type="category" dataKey="name" width={104} tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: '#6b5a52' }} />
              <Tooltip content={<Tip />} cursor={{ fill: 'rgba(62,140,85,.08)' }} />
              <Bar dataKey="cents" fill={BAR} radius={[0, 4, 4, 0]} barSize={18} isAnimationActive={!document.documentElement.classList.contains('reduce-motion')}>
                <LabelList dataKey="cents" position="right" formatter={(v: unknown) => moneyShort(Number(v))} style={{ fontSize: 12, fill: '#4a3b35' }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      <h2 className="section-title">By month</h2>
      {months.length === 0 ? <p className="calc">Monthly charts appear once purchases have dates.{s.undated_count ? ' Undated spending is not placed in any month.' : ''}</p> : (
        <div className="card chart">
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={months} margin={{ left: 0, right: 8, top: 18, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="#efe4d8" />
              <XAxis dataKey="name" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: '#6b5a52' }} />
              <YAxis hide />
              <Tooltip content={<Tip />} cursor={{ fill: 'rgba(62,140,85,.08)' }} />
              <Bar dataKey="cents" fill={BAR} radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={!document.documentElement.classList.contains('reduce-motion')}>
                <LabelList dataKey="cents" position="top" formatter={(v: unknown) => moneyShort(Number(v))} style={{ fontSize: 10, fill: '#4a3b35' }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      <h2 className="section-title">Purchase history</h2>
      <div className="chips">
        {(['all', 'month', 'undated'] as const).map((f) => (
          <button key={f} className={`chip ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f)}>{f === 'all' ? 'All' : f === 'month' ? 'This month' : 'No date'}</button>
        ))}
      </div>
      {list.length === 0 ? <Empty title="No purchases here" /> : (
        <ul className="list">
          {list.map((p) => {
            const it = itemById.get(p.item_id)
            return (
              <li key={p.id} onClick={() => setEditing(p.id)}>
                <div>
                  <strong>{it?.name ?? 'Item'}</strong>
                  <div className="sub">
                    {p.purchased_on ? formatDate(p.purchased_on) : <span className="badge undated">No date · tap to add</span>}
                    {' · '}{p.qty} {it?.unit}{p.retailer ? ` · ${p.retailer}` : ''} · {memberName(members, p.buyer_user_id) ?? p.buyer_label ?? 'Buyer not recorded'}
                  </div>
                </div>
                <span className="amt">{money(p.amount_cents)}</span>
              </li>
            )
          })}
        </ul>
      )}
      <p className="calc center">Times in New York · weeks start Monday · USD</p>
      <Sheet open={!!editingP} onClose={() => setEditing(null)} title="Edit purchase">
        {editingP && itemById.get(editingP.item_id) && <EditPurchaseForm purchase={editingP} item={itemById.get(editingP.item_id)!} onDone={() => setEditing(null)} />}
      </Sheet>
      <Sheet open={exportOpen} onClose={() => setExportOpen(false)} title="Export data"><ExportButtons /></Sheet>
      <Sheet open={budgetOpen} onClose={() => setBudgetOpen(false)} title="Monthly budget">
        <BudgetForm current={household.monthly_budget_cents} version={household.version} id={household.id} onDone={() => setBudgetOpen(false)} />
      </Sheet>
    </div>
  )
}

function BudgetForm({ current, version, id, onDone }: { current: number | null; version: number; id: string; onDone: () => void }) {
  const [v, setV] = useState(current != null ? (current / 100).toFixed(0) : '')
  const { run, busy, error, setError } = useAction()
  async function submit(e: FormEvent) {
    e.preventDefault()
    const cents = v.trim() ? parseMoney(v) : null
    if (v.trim() && cents == null) return setError('Enter an amount like 500')
    const r = await run(async () => {
      const res = await supabase.from('households').update({ monthly_budget_cents: cents }).eq('id', id).eq('version', version).select('id')
      if (!res.error && !(res.data ?? []).length) return { data: null, error: { message: 'Your partner just changed the budget. Close and try again.' } }
      return res
    }, { success: cents ? 'Budget saved' : 'Budget removed' })
    if (r) onDone()
  }
  return (
    <form className="form" onSubmit={submit}>
      <Field label="Budget per month (USD)" hint="Leave empty to turn off">
        <input inputMode="decimal" value={v} onChange={(e) => setV(e.target.value)} placeholder="$500" />
      </Field>
      <ErrorNote message={error} />
      <button className="btn primary big" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
    </form>
  )
}
