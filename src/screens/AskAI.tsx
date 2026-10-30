import { useEffect, useRef, useState, type FormEvent } from 'react'
import { supabase, newRequestId } from '../lib/supabase'
import { useAction } from '../lib/actions'
import { useData } from '../lib/household'
import { money } from '../lib/format'
import { Mascot } from '../components/Mascot'

interface Proposal {
  action: 'log_usage' | 'record_purchase' | 'record_gift' | 'set_stock'
  item_id: string
  item_name: string
  unit: string
  qty: number
  amount_cents: number | null
  date: string | null
  retailer: string | null
  giver: string | null
  summary: string
}
interface Msg {
  role: 'user' | 'assistant'
  content: string
  proposal?: Proposal | null
  requestId?: string
  state?: 'pending' | 'done' | 'dismissed'
  meta?: string
}

const SUGGESTIONS = [
  'What do we still need?',
  'How much did we spend this month?',
  'Which items are running low?',
  'Approximately how long will our diapers last?',
  'আমাদের এখনও কী কী লাগবে?',
  'এই মাসে আমরা কত খরচ করেছি?',
]

export function AskAIScreen() {
  const { items } = useData()
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [connected, setConnected] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const end = useRef<HTMLDivElement>(null)
  const { run, busy: saving } = useAction()

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth", block: "end" })
  }, [msgs, busy])

  async function ask(question: string) {
    if (!question.trim() || busy) return
    if (!navigator.onLine) return setError("You're offline. Ask AI needs a connection.")
    setError(null)
    const history = msgs.filter((m) => !m.proposal).map((m) => ({ role: m.role, content: m.content }))
    setMsgs((m) => [...m, { role: 'user', content: question }])
    setQ('')
    setBusy(true)
    try {
      const { data, error: e } = await supabase.functions.invoke('ask-ai', { body: { question, history } })
      if (e) {
        const body = await (e as { context?: Response }).context?.json?.().catch(() => null)
        if (body?.connected === false) {
          setConnected(false)
          throw new Error(body.error)
        }
        throw new Error(body?.error ?? 'The AI service could not answer right now.')
      }
      setConnected(true)
      setMsgs((m) => [...m, { role: 'assistant', content: data.answer, proposal: data.proposal, requestId: newRequestId(), state: data.proposal ? 'pending' : undefined, meta: data.model }])
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function confirm(idx: number) {
    const m = msgs[idx]
    const p = m.proposal!
    const item = items.find((i) => i.id === p.item_id)
    if (!item) return setError('That item no longer exists.')
    const call = () => {
      switch (p.action) {
        case 'log_usage':
          return supabase.rpc('log_usage', { p_item_id: p.item_id, p_qty: p.qty, p_request: m.requestId, p_used_on: p.date })
        case 'record_purchase':
          return supabase.rpc('record_purchase', { p_item_id: p.item_id, p_qty: p.qty, p_amount_cents: p.amount_cents ?? 0, p_request: m.requestId, p_purchased_on: p.date, p_retailer: p.retailer, p_buyer_label: 'Not recorded', p_source: 'ai' })
        case 'record_gift':
          return supabase.rpc('record_gift', { p_item_id: p.item_id, p_qty: p.qty, p_request: m.requestId, p_received_on: p.date, p_giver: p.giver })
        case 'set_stock':
          return item.stock_qty == null
            ? supabase.rpc('set_starting_stock', { p_item_id: p.item_id, p_qty: p.qty, p_request: m.requestId })
            : supabase.rpc('correct_stock', { p_item_id: p.item_id, p_new_qty: p.qty, p_expected_stock: item.stock_qty, p_request: m.requestId })
      }
    }
    if (p.action === 'record_purchase' && p.amount_cents == null) return setError('The amount paid is missing. Add the purchase from the item page instead.')
    const r = await run(call, { success: 'Saved after your confirmation', stock: item.is_consumable })
    if (r) setMsgs((all) => all.map((x, i) => (i === idx ? { ...x, state: 'done' } : x)))
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    void ask(q)
  }

  return (
    <div className="screen ai-screen">
      <header className="screen-head"><h1>Ask AI</h1></header>
      <div className={`ai-status ${connected === false ? 'off' : connected ? 'on' : ''}`}>
        {connected === false
          ? 'Generative AI is not connected yet. Nothing here is answered by AI until an Anthropic API key is added on the server.'
          : connected
            ? 'Connected to Claude (Anthropic). Answers use your household records; totals come from the database.'
            : 'Answers come from Claude (Anthropic) using only your household records. Each question costs a few cents of API usage.'}
      </div>
      {msgs.length === 0 && (
        <div className="ai-empty">
          <Mascot size={88} />
          <p>Ask in English or বাংলা.</p>
          <div className="chips wrap">
            {SUGGESTIONS.map((s) => <button key={s} className="chip" onClick={() => ask(s)} disabled={busy}>{s}</button>)}
          </div>
        </div>
      )}
      <div className="chat">
        {msgs.map((m, i) => (
          <div key={i} className={`bubble ${m.role}`}>
            <div className="bubble-text">{m.content}</div>
            {m.proposal && (
              <div className="proposal">
                <strong>Proposed change</strong>
                <p>{m.proposal.summary}</p>
                <p className="sub">
                  {m.proposal.item_name} · {m.proposal.qty} {m.proposal.unit}
                  {m.proposal.amount_cents != null ? ` · ${money(m.proposal.amount_cents)}` : ''}
                  {m.proposal.date ? ` · ${m.proposal.date}` : m.proposal.action === 'record_purchase' ? ' · no date' : ''}
                </p>
                {m.state === 'pending' && (
                  <div className="row-2">
                    <button className="btn primary" onClick={() => confirm(i)} disabled={saving}>{saving ? 'Saving…' : 'Confirm'}</button>
                    <button className="btn ghost" onClick={() => setMsgs((all) => all.map((x, j) => (j === i ? { ...x, state: 'dismissed' } : x)))}>Not now</button>
                  </div>
                )}
                {m.state === 'done' && <p className="ok-note">Saved.</p>}
                {m.state === 'dismissed' && <p className="sub">Not saved.</p>}
              </div>
            )}
          </div>
        ))}
        {busy && <div className="bubble assistant typing"><span /><span /><span /></div>}
        <div ref={end} />
      </div>
      {error && <p className="error-note" role="alert">{error}</p>}
      <form className="ask-bar" onSubmit={submit}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask about your registry…" aria-label="Your question" />
        <button className="btn primary" disabled={busy || !q.trim()}>Ask</button>
      </form>
    </div>
  )
}
