import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import readXlsxFile from 'read-excel-file/browser'
import { supabase, friendlyError } from '../lib/supabase'
import { useData, useHousehold } from '../lib/household'
import { buildImportPlan, type ImportPlan } from '../lib/importBook'
import { money } from '../lib/format'
import { emit } from '../lib/events'
import { ErrorNote } from '../components/ui'

async function sha256(buf: ArrayBuffer) {
  const h = await crypto.subtle.digest('SHA-256', buf)
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function ImportScreen() {
  const { items } = useData()
  const { refresh } = useHousehold()
  const nav = useNavigate()
  const [plan, setPlan] = useState<ImportPlan | null>(null)
  const [file, setFile] = useState<{ name: string; fingerprint: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)

  const existingKeys = useMemo(() => new Set(items.map((i) => i.import_key).filter(Boolean)), [items])
  const fresh = plan?.items.filter((i) => !existingKeys.has(i.import_key)) ?? []
  const freshSpend = fresh.flatMap((i) => i.purchases).reduce((s, p) => s + p.amount_cents, 0)

  async function pick(f: File) {
    setError(null)
    setResult(null)
    setPlan(null)
    try {
      const buf = await f.arrayBuffer()
      const sheets = await readXlsxFile(new Blob([buf]))
      const p = buildImportPlan(sheets as never)
      if (!p.masterCount && !p.registryCount) throw new Error('No "Master Registry" or "Baby Registry" rows were found in this file.')
      setPlan(p)
      setFile({ name: f.name, fingerprint: await sha256(buf) })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That file could not be read. Is it an .xlsx file?')
    }
  }

  async function doImport() {
    if (!plan || !file || busy) return
    if (!navigator.onLine) return setError("You're offline. Import needs a connection.")
    setBusy(true)
    setError(null)
    try {
      const { data, error: e } = await supabase.rpc('import_registry', { p_payload: { fingerprint: file.fingerprint, file_name: file.name, items: plan.items } })
      if (e) throw e
      if (data.already_imported) {
        setResult('This exact file was already imported, so nothing was added.')
      } else {
        setResult(`Imported ${data.items} items and ${data.purchases} purchases.${data.skipped ? ` Skipped ${data.skipped} already in the app.` : ''}`)
        emit({ type: 'milestone', message: 'Your registry is in! ✿' })
      }
      await refresh()
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  const review = plan?.items.filter((i) => i.needs_review) ?? []
  const withPurchases = plan?.items.filter((i) => i.purchases.length) ?? []

  return (
    <div className="screen">
      <button className="back" onClick={() => nav(-1)}>‹ Back</button>
      <header className="screen-head"><h1>Import</h1></header>
      <p className="calc">Choose your Book1.xlsx. We read the “Master Registry” and “Baby Registry” sheets, show a preview, and only save when you tap Import. Importing the same rows twice never duplicates them.</p>
      <label className="upload-drop">
        <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => e.target.files?.[0] && pick(e.target.files[0])} />
        <span>{file ? `Selected: ${file.name}` : 'Choose spreadsheet (.xlsx)'}</span>
      </label>
      <ErrorNote message={error} />
      {plan && (
        <div className="preview">
          <div className="tiles">
            <div className="tile"><span>Master list</span><strong>{plan.masterCount}</strong><em>numbered entries</em></div>
            <div className="tile"><span>Purchases</span><strong>{withPurchases.length}</strong><em>{money(plan.purchaseTotalCents)} total</em></div>
            <div className="tile wide"><span>New to add</span><strong>{fresh.length} items</strong><em>{money(freshSpend)} spending · {plan.items.length - fresh.length} already in the app</em></div>
          </div>
          {plan.warnings.map((w) => <div key={w} className="notice">{w}</div>)}
          <h2 className="section-title">Purchases found (no dates in the file)</h2>
          <ul className="list compact">
            {withPurchases.map((i) => (
              <li key={i.import_key}><div>{i.name}<div className="sub">{i.category}{i.master_no ? ` · matches master #${i.master_no}` : ' · separate item'}</div></div><span className="amt">{money(i.purchases[0].amount_cents)}</span></li>
            ))}
          </ul>
          <p className="calc">These count in all-time spending only. Add dates later from Spending to place them in a week or month.</p>
          {review.length > 0 && (
            <>
              <h2 className="section-title">Please confirm after import</h2>
              <ul className="list compact">{review.map((i) => <li key={i.import_key}><div><strong>{i.name}</strong><div className="sub">{i.review_note}</div></div></li>)}</ul>
            </>
          )}
          <details className="card">
            <summary>All {plan.items.length} items</summary>
            <ul className="list compact">
              {plan.items.map((i) => (
                <li key={i.import_key} className={existingKeys.has(i.import_key) ? 'voided' : ''}>
                  <div>{i.master_no ? `#${i.master_no} ` : ''}{i.name}<div className="sub">{i.category}{i.is_consumable ? ` · tracks stock (${i.unit})` : ''}{existingKeys.has(i.import_key) ? ' · already imported' : ''}</div></div>
                </li>
              ))}
            </ul>
          </details>
          {result ? (
            <>
              <p className="ok-note">{result}</p>
              <button className="btn primary big" onClick={() => nav('/registry')}>Open registry</button>
            </>
          ) : (
            <button className="btn primary big" onClick={doImport} disabled={busy || fresh.length === 0}>
              {busy ? 'Importing…' : fresh.length === 0 ? 'Everything is already imported' : `Import ${fresh.length} items`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
