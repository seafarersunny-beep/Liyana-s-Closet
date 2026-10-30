import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useData, useHousehold } from '../lib/household'
import { money, moneyShort } from '../lib/format'
import { Mascot } from '../components/Mascot'
import { AlertCenter } from './Inventory'
import { ItemCard } from './Registry'

export function useProgress() {
  const { items } = useData()
  return useMemo(() => {
    const active = items.filter((i) => !i.archived_at)
    const done = active.filter((i) => i.status === 'purchased' || i.status === 'gifted').length
    return { total: active.length, done, pct: active.length ? Math.round((done / active.length) * 100) : 0 }
  }, [items])
}

export function HomeScreen() {
  const { items, summary, members } = useData()
  const { membership } = useHousehold()
  const progress = useProgress()
  const needed = items.filter((i) => !i.archived_at && (i.status === 'needed' || i.status === 'partial'))
  const review = items.filter((i) => !i.archived_at && i.needs_review)
  const me = members.find((m) => m.display_name === membership?.display_name)?.display_name ?? membership?.display_name

  return (
    <div className="screen home">
      <section className="hero">
        <Mascot size={104} />
        <div>
          <p className="eyebrow">Hello{me ? `, ${me}` : ''}</p>
          <h1 className="brand">Liyana’s Closet</h1>
          <p className="tagline">{members.map((m) => m.display_name).join(' & ')}</p>
        </div>
      </section>

      {items.length === 0 ? (
        <div className="card cta">
          <h2>Let’s bring in your list</h2>
          <p>Import Book1.xlsx to load your master list and the purchases you’ve already made. You’ll see a preview first.</p>
          <Link className="btn primary big" to="/import">Import spreadsheet</Link>
          <Link className="btn ghost" to="/registry">Or add items by hand</Link>
        </div>
      ) : (
        <>
          <div className="card progress-card">
            <div className="progress-ring" style={{ ['--p' as string]: progress.pct }}>
              <span>{progress.pct}%</span>
            </div>
            <div>
              <strong>{progress.done} of {progress.total} ready</strong>
              <p>{needed.length} still needed</p>
            </div>
          </div>
          <div className="tiles">
            <Link to="/spending" className="tile"><span>This week</span><strong>{moneyShort(summary.week_cents)}</strong></Link>
            <Link to="/spending" className="tile"><span>This month</span><strong>{moneyShort(summary.month_cents)}</strong></Link>
            <Link to="/spending" className="tile wide"><span>All time</span><strong>{moneyShort(summary.all_time_cents)}</strong>{summary.undated_cents > 0 && <em>incl. {money(summary.undated_cents)} without dates</em>}</Link>
          </div>
          <AlertCenter />
          {review.length > 0 && (
            <Link to="/registry?review=1" className="notice review-box">
              <strong>{review.length} item{review.length === 1 ? '' : 's'} to confirm</strong>
              <span>{review.map((r) => r.name).slice(0, 3).join(', ')}{review.length > 3 ? '…' : ''}</span>
            </Link>
          )}
          {needed.length > 0 && (
            <>
              <h2 className="section-title">Still needed</h2>
              <div className="h-scroll">{needed.slice(0, 8).map((i) => <ItemCard key={i.id} item={i} />)}</div>
              <Link to="/registry" className="btn ghost wide">See full registry</Link>
            </>
          )}
        </>
      )}
    </div>
  )
}
