import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import readXlsx from 'read-excel-file/node'
import { buildImportPlan } from '../src/lib/importBook'

const BOOK = process.env.BOOK1_PATH

describe.skipIf(!BOOK || !existsSync(BOOK))('Book1.xlsx import plan', () => {
  it('reconciles the family spreadsheet', async () => {
    const sheets = (await readXlsx(BOOK!)) as never
    const plan = buildImportPlan(sheets)
    const byKey = Object.fromEntries(plan.items.map((i) => [i.import_key, i]))

    expect(plan.masterCount).toBe(58)
    expect(plan.registryCount).toBe(5)
    expect(plan.purchaseTotalCents).toBe(149000)
    // 58 master entries + car seat split + separate glass bottles
    expect(plan.items).toHaveLength(60)
    expect(plan.items.flatMap((i) => i.purchases)).toHaveLength(5)

    expect(byKey['master:30:stroller'].purchases[0].amount_cents).toBe(105000)
    expect(byKey['master:30:car-seat'].purchases).toHaveLength(0)
    expect(byKey['master:30:car-seat'].needs_review).toBe(true)
    expect(byKey['master:1'].name).toBe('More bottles')
    expect(byKey['master:1'].purchases).toHaveLength(0)
    expect(byKey['registry:4'].purchases[0].amount_cents).toBe(4000)
    expect(byKey['master:31'].name).toBe('Baby Bjorn Bouncer')
    expect(byKey['master:24'].purchases[0].amount_cents).toBe(21700)
    expect(byKey['master:15'].purchases[0].amount_cents).toBe(2300)
    expect(byKey['master:17'].is_consumable).toBe(true)
    expect(byKey['master:17'].low_stock_threshold).toBe(20)
    expect(byKey['master:58'].needs_review).toBe(true)
    expect(byKey['master:12'].category).toBe('Diapering')
    expect(byKey['master:57'].category).toBe('Postpartum')
    expect(new Set(plan.items.map((i) => i.import_key)).size).toBe(plan.items.length)
  })
})

describe('import plan basics', () => {
  it('keeps unmatched registry rows separate and flags them; non-done prices are estimates', () => {
    const plan = buildImportPlan([
      { sheet: 'Master Registry', data: [['No.', 'Feeding'], [1, 'Pacifier'], [null, 'Bathing'], [2, 'Baby towels']] },
      { sheet: 'Baby Registry', data: [['#', 'Item', 'Price', 'Purchase Status', 'Category', 'Qty'], [1, 'Mystery gadget', 12, 'Done', 'Misc', 1], [2, 'Robot', 50, 'Not yet', 'Toys', 1]] },
    ], 2)
    expect(plan.items.find((i) => i.name === 'Baby towels')!.category).toBe('Bathing')
    const g = plan.items.find((i) => i.name === 'Mystery gadget')!
    expect(g.needs_review).toBe(true)
    expect(g.purchases[0].amount_cents).toBe(1200)
    expect(plan.items.find((i) => i.name === 'Robot')!.purchases).toHaveLength(0)
    expect(plan.purchaseTotalCents).toBe(1200)
  })
})
