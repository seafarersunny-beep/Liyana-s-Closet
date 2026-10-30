// Ask AI: answers questions about this household's own records (English or Bangla).
// Numbers come from database functions; Claude only explains them. Claude can
// *propose* a change, which the app shows for the parent to confirm. Nothing is
// written here.
import Anthropic from 'npm:@anthropic-ai/sdk@1.3.0'
import { asMember, handle, HttpError, json } from '../_shared/household.ts'

const MODEL = Deno.env.get('ANTHROPIC_MODEL') ?? 'claude-opus-5-5'

const SYSTEM = `You are the helper inside "Liyana's Closet", a private baby registry, inventory and spending app for one family (parents Sunny and Smita, baby Liyana).

Rules:
- Answer only from the HOUSEHOLD RECORDS provided in the user turn. They are computed by the app's database and are authoritative. Do not invent items, prices, dates, stock counts or usage rates.
- Quote totals exactly as given (they are USD, already summed). Do not re-add or estimate spending yourself. If a figure needed for the answer is not in the records, say that it is not recorded.
- Purchases without a date are "undated": they count in all-time spending but not in this week or this month. Mention undated spending when someone asks about weekly or monthly totals and undated purchases exist.
- Stock of null means unknown, not zero. Never call an unknown-stock item out of stock.
- For "how long will X last", use only usage_estimates entries where sufficient is true, state the basis text, and call it an estimate. If there is not enough usage history, say so and suggest logging daily usage.
- Reply in the language of the question: Bangla (বাংলা) if the question is in Bangla, otherwise English. Keep item names as recorded.
- Be warm, short and practical. Use short lists for multiple items.
- If the parent asks you to record or change something (log usage, add a purchase, record a gift, set or correct stock), call the propose_change tool with the exact item_id from the records. Say that they need to tap Confirm; never say the change is already saved. Do not propose a change they did not ask for.`

const PROPOSE: Anthropic.Beta.BetaTool = {
  name: 'propose_change',
  description:
    'Propose one inventory or purchase change for the parent to confirm in the app. Only use when they explicitly asked to record or change something.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['action', 'item_id', 'qty', 'amount_cents', 'date', 'retailer', 'giver', 'summary'],
    properties: {
      action: { type: 'string', enum: ['log_usage', 'record_purchase', 'record_gift', 'set_stock'] },
      item_id: { type: 'string', description: 'id of the item from the records' },
      qty: { type: 'integer', description: 'quantity in the item unit (e.g. 120 diapers, not 1 pack)' },
      amount_cents: { type: ['integer', 'null'], description: 'total paid in cents for record_purchase, else null' },
      date: { type: ['string', 'null'], description: 'YYYY-MM-DD if the parent gave one, else null. Never guess.' },
      retailer: { type: ['string', 'null'] },
      giver: { type: ['string', 'null'] },
      summary: { type: 'string', description: 'one-line description shown on the confirm card, in the language of the question' },
    },
  },
}

async function loadRecords(db: Awaited<ReturnType<typeof asMember>>['db']) {
  const [items, spending, estimates, purchases, members] = await Promise.all([
    db.from('item_overview')
      .select('id,name,brand,model,size,color,category,unit,required_qty,acquired_qty,purchased_qty,gifted_qty,status,is_consumable,stock_qty,low_stock_threshold,stock_level,estimated_price_cents,spent_cents,needs_review,review_note,notes')
      .is('archived_at', null).order('category').limit(400),
    db.rpc('spending_summary', {}),
    db.rpc('usage_estimates'),
    db.from('purchases').select('item_id,qty,amount_cents,purchased_on,retailer,buyer_label,created_at')
      .is('voided_at', null).order('created_at', { ascending: false }).limit(30),
    db.from('household_members').select('user_id,display_name'),
  ])
  for (const r of [items, spending, estimates, purchases, members]) {
    if (r.error) throw new HttpError(500, 'Could not read household records')
  }
  const dollars = (c: number | null) => (c == null ? null : `$${(c / 100).toFixed(2)}`)
  const s = spending.data as Record<string, any>
  return {
    today_new_york: s.today,
    spending: {
      this_week: dollars(s.week_cents),
      week_starts_monday: s.week_start,
      this_month: dollars(s.month_cents),
      all_time: dollars(s.all_time_cents),
      undated_total: dollars(s.undated_cents),
      undated_purchase_count: s.undated_count,
      monthly_budget: dollars(s.monthly_budget_cents),
      by_category: (s.by_category as any[]).map((c) => ({ category: c.category, total: dollars(c.cents), purchases: c.count })),
      by_month: (s.by_month as any[]).map((m) => ({ month: m.month, total: dollars(m.cents) })),
    },
    needed: (items.data as any[]).filter((i) => i.status === 'needed' || i.status === 'partial')
      .map((i) => ({ id: i.id, name: i.name, category: i.category, status: i.status, required: i.required_qty, acquired: i.acquired_qty, estimated_price: dollars(i.estimated_price_cents), needs_review: i.review_note })),
    low_or_out_of_stock: (items.data as any[]).filter((i) => i.stock_level === 'low' || i.stock_level === 'out')
      .map((i) => ({ id: i.id, name: i.name, stock: i.stock_qty, unit: i.unit, threshold: i.low_stock_threshold, level: i.stock_level })),
    usage_estimates: estimates.data,
    items: (items.data as any[]).map((i) => ({
      id: i.id, name: i.name, brand: i.brand, size: i.size, category: i.category, status: i.status,
      consumable: i.is_consumable, stock: i.stock_qty, unit: i.unit, spent: dollars(i.spent_cents),
    })),
    recent_purchases: purchases.data,
    members: members.data,
  }
}

Deno.serve(handle(async (req) => {
  if (req.method !== 'POST') throw new HttpError(405, 'POST only')
  const member = await asMember(req)
  const body = await req.json().catch(() => ({}))
  const question = String(body.question ?? '').trim().slice(0, 1000)
  const history = Array.isArray(body.history) ? body.history.slice(-6) : []
  if (!question) throw new HttpError(400, 'Ask a question')

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) {
    return json({ connected: false, error: 'Generative AI is not connected. Add ANTHROPIC_API_KEY to the Supabase function secrets.' }, 503)
  }

  const records = await loadRecords(member.db)
  const client = new Anthropic({ apiKey })
  const messages: Anthropic.Beta.BetaMessageParam[] = []
  for (const h of history) {
    if ((h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string' && h.content.trim()) {
      messages.push({ role: h.role, content: h.content.slice(0, 2000) })
    }
  }
  messages.push({
    role: 'user',
    content: `HOUSEHOLD RECORDS (asked by ${member.name}):\n${JSON.stringify(records)}\n\nQUESTION:\n${question}`,
  })

  let response: Anthropic.Beta.BetaMessage
  try {
    // Server-side fallback: if the model declines, the API retries on its default fallback.
    response = await client.beta.messages.create({
      model: MODEL,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      max_tokens: 4000,
      system: SYSTEM,
      output_config: { effort: 'low' },
      tools: [PROPOSE],
      messages,
    })
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new HttpError(502, 'The AI key was rejected. Check ANTHROPIC_API_KEY.')
    if (e instanceof Anthropic.RateLimitError) throw new HttpError(429, 'The AI service is busy. Try again in a minute.')
    if (e instanceof Anthropic.APIError) throw new HttpError(502, `The AI service returned an error (${e.status}).`)
    throw new HttpError(502, 'Could not reach the AI service.')
  }

  if (response.stop_reason === 'refusal') {
    return json({ connected: true, answer: "Sorry, I can't help with that one.", proposal: null, model: response.model })
  }

  const answer = response.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map((b) => b.text).join('\n').trim()
  const tool = response.content.find((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use' && b.name === 'propose_change')
  let proposal = null
  if (tool) {
    const p = tool.input as Record<string, any>
    const item = records.items.find((i) => i.id === p.item_id)
    // Only pass through proposals that point at a real item of this household.
    if (item && Number.isInteger(p.qty) && p.qty >= 0) {
      proposal = { ...p, item_name: item.name, unit: item.unit }
    }
  }
  return json({
    connected: true,
    answer: answer || (proposal ? 'Here is the change I can make. Tap Confirm to save it.' : ''),
    proposal,
    model: response.model,
    usage: { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens },
  })
}))
