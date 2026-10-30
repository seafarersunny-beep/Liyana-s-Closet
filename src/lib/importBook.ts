// Turns the family's Book1.xlsx ("Master Registry" + "Baby Registry" sheets)
// into an import plan. Pure functions so the reconciliation rules are testable.

export type SheetRows = { sheet: string; data: unknown[][] }[]

export interface MasterEntry {
  no: number
  name: string
  category: string
}

export interface RegistryRow {
  no: number | null
  item: string
  priceCents: number | null
  status: string
  category: string
  qty: number
  giftedBy: string | null
  notes: string | null
}

export interface PlannedPurchase {
  import_key: string
  qty: number
  amount_cents: number
  notes: string
}

export interface PlannedItem {
  import_key: string
  name: string
  brand: string | null
  model: string | null
  category: string
  unit: string
  required_qty: number | null
  is_consumable: boolean
  low_stock_threshold: number | null
  master_no: number | null
  notes: string | null
  needs_review: boolean
  review_note: string | null
  purchases: PlannedPurchase[]
}

export interface ImportPlan {
  items: PlannedItem[]
  masterCount: number
  registryCount: number
  purchaseTotalCents: number
  warnings: string[]
}

const text = (v: unknown) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim())

export function parseWorkbook(sheets: SheetRows) {
  const warnings: string[] = []
  const find = (name: string) => sheets.find((s) => s.sheet.trim().toLowerCase() === name.toLowerCase())

  const masterSheet = find('Master Registry')
  const registrySheet = find('Baby Registry')
  if (!masterSheet) warnings.push('No "Master Registry" sheet was found.')
  if (!registrySheet) warnings.push('No "Baby Registry" sheet was found.')

  const master: MasterEntry[] = []
  let category = 'Other'
  for (const row of masterSheet?.data ?? []) {
    const a = row[0]
    const b = text(row[1])
    if (typeof a === 'number' && b) {
      master.push({ no: a, name: b, category })
    } else if (text(a).toLowerCase().startsWith('no') && b) {
      category = b // header row "No. | Feeding" carries the first category
    } else if (text(a) === '' && b) {
      category = b
    }
  }

  const registry: RegistryRow[] = []
  const rows = registrySheet?.data ?? []
  const header = rows.findIndex((r) => text(r[1]).toLowerCase() === 'item')
  if (registrySheet && header < 0) warnings.push('Could not find the header row in "Baby Registry".')
  for (const row of header >= 0 ? rows.slice(header + 1) : []) {
    const item = text(row[1])
    if (!item || /^tip:/i.test(text(row[0]))) continue
    const price = row[2]
    registry.push({
      no: typeof row[0] === 'number' ? row[0] : null,
      item,
      priceCents: typeof price === 'number' ? Math.round(price * 100) : null,
      status: text(row[3]),
      category: text(row[4]) || 'Other',
      qty: typeof row[5] === 'number' && row[5] > 0 ? Math.round(row[5]) : 1,
      giftedBy: text(row[6]) || null,
      notes: text(row[7]) || null,
    })
  }

  const nums = master.map((m) => m.no)
  const dupes = nums.filter((n, i) => nums.indexOf(n) !== i)
  if (dupes.length) warnings.push(`Master Registry repeats number(s): ${[...new Set(dupes)].join(', ')}.`)
  return { master, registry, warnings }
}

// Brands we only read when they literally appear in the name. No model guessing.
const BRANDS = [
  'Cybex', 'Baby Bjorn', 'BabyBjorn', 'Nanit', 'Grownsy', 'Eufy', 'Kendamill', 'Kigaroo', 'Babyletto',
  'Hatch', 'Silverette', 'Megafood', 'Tabby Toad', 'Wildbird', 'Mabe',
]
function brandOf(name: string) {
  const hit = BRANDS.find((b) => new RegExp(`\\b${b}\\b`, 'i').test(name))
  return hit ?? null
}

interface ConsumableRule {
  test: RegExp
  unit: string
  threshold?: number
  note?: string
}
// Things that get used up. Stock starts unknown, so none of these alert until counted.
const CONSUMABLES: ConsumableRule[] = [
  { test: /^diapers?$/i, unit: 'pieces', threshold: 20, note: 'Keep one item per diaper size (e.g. Newborn, Size 1). Add sizes with "Add another size".' },
  { test: /wipes/i, unit: 'wipes' },
  { test: /milk collection bags/i, unit: 'bags' },
  { test: /nursing pad/i, unit: 'pads' },
  { test: /formula/i, unit: 'units' },
  { test: /trash bag/i, unit: 'bags' },
  { test: /disposi?ble underwear/i, unit: 'pieces' },
]

const isDone = (status: string) => /^(done|purchased|bought|yes)$/i.test(status)

type Rule =
  | { kind: 'merge'; registry: RegExp; master: RegExp }
  | { kind: 'separate'; registry: RegExp; master: RegExp; note: string }
  | { kind: 'split'; registry: RegExp; master: RegExp; covered: string; uncovered: string; reviewNote: string }

// Hand-checked reconciliation between the two sheets.
const RULES: Rule[] = [
  {
    kind: 'split',
    registry: /stroller/i,
    master: /stroller\s*&\s*car seat/i,
    covered: 'stroller',
    uncovered: 'Car seat',
    reviewNote:
      'Master list #30 says "Stroller & car seat". The recorded Cybex purchase is "Stroller & Cot", which does not confirm a car seat. Please confirm whether a car seat is still needed.',
  },
  {
    kind: 'separate',
    registry: /bottle/i,
    master: /more bottles/i,
    note: 'These are the bottles you already bought. "More bottles" (#1) stays on the list as still needed.',
  },
  { kind: 'merge', registry: /bouncer/i, master: /bouncer/i },
  { kind: 'merge', registry: /nanit/i, master: /nanit/i },
  { kind: 'merge', registry: /diaper caddy/i, master: /diaper caddy/i },
]

function baseItem(m: MasterEntry): PlannedItem {
  const cons = CONSUMABLES.find((c) => c.test.test(m.name))
  return {
    import_key: `master:${m.no}`,
    name: m.name,
    brand: brandOf(m.name),
    model: null,
    category: m.category,
    unit: cons?.unit ?? 'item',
    required_qty: null,
    is_consumable: !!cons,
    low_stock_threshold: cons?.threshold ?? null,
    master_no: m.no,
    notes: cons?.note ?? null,
    needs_review: false,
    review_note: null,
    purchases: [],
  }
}

function purchaseFor(r: RegistryRow, key: string): PlannedPurchase[] {
  if (!isDone(r.status) || r.priceCents == null) return []
  return [{
    import_key: `registry:${key}`,
    qty: r.qty,
    amount_cents: r.priceCents,
    notes: `Imported from Baby Registry row ${r.no ?? '?'} ("${r.item}"). Amount paid; no purchase date recorded.`,
  }]
}

export function buildImportPlan(sheets: SheetRows, expectedMasterCount = 57): ImportPlan {
  const { master, registry, warnings } = parseWorkbook(sheets)
  const items = new Map<string, PlannedItem>()
  for (const m of master) items.set(`master:${m.no}`, baseItem(m))

  const spreadsheetCat = (r: RegistryRow) => `Spreadsheet category: ${r.category}.`

  for (const r of registry) {
    const rowKey = `${r.no ?? r.item.toLowerCase()}`
    const rule = RULES.find((x) => x.registry.test(r.item))
    const target = rule ? master.find((m) => rule.master.test(m.name)) : undefined
    const notDoneNote = !isDone(r.status) && r.priceCents != null
      ? ` Listed price $${(r.priceCents / 100).toFixed(2)} kept as an estimate, not spending.` : ''

    if (rule && target && rule.kind === 'merge') {
      const it = items.get(`master:${target.no}`)!
      it.name = r.item
      it.brand = brandOf(r.item) ?? it.brand
      it.required_qty = Math.max(it.required_qty ?? 0, r.qty)
      it.notes = [it.notes, `Master list: "${target.name}".`, spreadsheetCat(r) + notDoneNote].filter(Boolean).join(' ')
      it.purchases.push(...purchaseFor(r, rowKey))
      continue
    }

    if (rule && target && rule.kind === 'split') {
      const it = items.get(`master:${target.no}`)!
      it.import_key = `master:${target.no}:${rule.covered}`
      it.name = r.item
      it.brand = brandOf(r.item)
      it.required_qty = r.qty
      it.notes = `Covers the ${rule.covered} part of master list #${target.no} ("${target.name}"). ${spreadsheetCat(r)}${notDoneNote}`
      it.purchases.push(...purchaseFor(r, rowKey))
      items.set(`master:${target.no}:${rule.uncovered.toLowerCase().replace(/\s+/g, '-')}`, {
        ...baseItem(target),
        import_key: `master:${target.no}:${rule.uncovered.toLowerCase().replace(/\s+/g, '-')}`,
        name: rule.uncovered,
        brand: null,
        required_qty: 1,
        notes: `Split from master list #${target.no} ("${target.name}").`,
        needs_review: true,
        review_note: rule.reviewNote,
      })
      continue
    }

    // Separate item (explicit rule, or nothing on the master list matched).
    const cons = CONSUMABLES.find((c) => c.test.test(r.item))
    const unmatched = !(rule && target)
    items.set(`registry:${rowKey}`, {
      import_key: `registry:${rowKey}`,
      name: r.item,
      brand: brandOf(r.item),
      model: null,
      category: target?.category ?? r.category,
      unit: cons?.unit ?? 'item',
      required_qty: r.qty,
      is_consumable: !!cons,
      low_stock_threshold: cons?.threshold ?? null,
      master_no: null,
      notes: [rule && rule.kind === 'separate' ? rule.note : null, spreadsheetCat(r) + notDoneNote]
        .filter(Boolean).join(' '),
      needs_review: unmatched,
      review_note: unmatched ? 'From the Baby Registry sheet; no matching master-list entry was found. Please confirm.' : null,
      purchases: purchaseFor(r, rowKey),
    })
  }

  const all = [...items.values()]
  const countNote = masterCountNote(master.length, expectedMasterCount)
  if (countNote) {
    warnings.push(countNote)
    for (const it of all) {
      if (it.master_no != null && it.master_no > expectedMasterCount && !it.needs_review) {
        it.needs_review = true
        it.review_note = `You mentioned ${expectedMasterCount} master-list entries; this is #${it.master_no}. Keep it or archive it.`
      }
    }
  }
  const purchaseTotalCents = all.flatMap((i) => i.purchases).reduce((s, p) => s + p.amount_cents, 0)
  return { items: all, masterCount: master.length, registryCount: registry.length, purchaseTotalCents, warnings }
}

// Flags master entries the family asked us to double check (count mismatch).
export function masterCountNote(masterCount: number, expected = 57) {
  return masterCount === expected
    ? null
    : `The Master Registry has ${masterCount} numbered entries (you mentioned ${expected}). All ${masterCount} will be imported; review the last one if it was added later.`
}
