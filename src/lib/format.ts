export const TZ = 'America/New_York'

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
const usdRound = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

export const money = (cents: number | null | undefined) => (cents == null ? '—' : usd.format(cents / 100))
export const moneyShort = (cents: number) => (cents % 100 === 0 ? usdRound.format(cents / 100) : usd.format(cents / 100))

export function parseMoney(input: string): number | null {
  const clean = input.replace(/[$,\s]/g, '')
  if (!/^\d+(\.\d{0,2})?$/.test(clean)) return null
  return Math.round(parseFloat(clean) * 100)
}

// Today's date in New York as YYYY-MM-DD.
export function todayNY(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

export function formatDate(d: string | null | undefined) {
  if (!d) return 'No date'
  const [y, m, day] = d.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

export function formatWhen(ts: string) {
  return new Date(ts).toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function monthLabel(ym: string) {
  const [y, m] = ym.split('-').map(Number)
  return `${new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })} ’${String(y).slice(2)}`
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
