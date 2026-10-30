// Product photo lookup and photo import.
//  - action "search": real product listings (photos + source links) from SerpAPI's
//    Google Shopping engine. The parents pick the matching model themselves.
//  - action "save": copies a chosen photo (or any direct image URL) into the
//    household's private storage so it keeps working if the shop changes it.
import { asMember, handle, HttpError, json } from '../_shared/household.ts'

const MAX_BYTES = 8 * 1024 * 1024
const TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }

function safeImageUrl(raw: string) {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new HttpError(400, 'That is not a valid link')
  }
  if (u.protocol !== 'https:') throw new HttpError(400, 'Use an https:// image link')
  const host = u.hostname
  if (host === 'localhost' || /^[\d.]+$/.test(host) || host.includes(':') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new HttpError(400, 'That address is not allowed')
  }
  return u
}

async function search(q: string) {
  const key = Deno.env.get('SERPAPI_KEY')
  if (!key) {
    return json({ connected: false, results: [], message: 'Automatic product lookup is not connected. Add a SERPAPI_KEY function secret, or upload a photo / paste an image link.' })
  }
  const url = new URL('https://serpapi.com/search.json')
  url.searchParams.set('engine', 'google_shopping')
  url.searchParams.set('q', q)
  url.searchParams.set('gl', 'us')
  url.searchParams.set('hl', 'en')
  url.searchParams.set('api_key', key)
  let res: Response
  try {
    res = await fetch(url)
  } catch {
    throw new HttpError(502, 'Could not reach the product search service')
  }
  if (!res.ok) throw new HttpError(502, `Product search failed (${res.status})`)
  const data = await res.json()
  const results = ((data.shopping_results ?? []) as any[]).slice(0, 12).map((r) => ({
    title: r.title,
    source: r.source ?? null,
    link: r.product_link ?? r.link ?? null,
    thumbnail: r.serpapi_thumbnail ?? r.thumbnail ?? null,
    price: r.price ?? null, // current listing price, shown as reference only
  })).filter((r) => r.thumbnail && r.link)
  return json({ connected: true, provider: 'Google Shopping via SerpAPI', results })
}

Deno.serve(handle(async (req) => {
  if (req.method !== 'POST') throw new HttpError(405, 'POST only')
  const member = await asMember(req)
  const body = await req.json().catch(() => ({}))

  if (body.action === 'search') {
    const q = String(body.query ?? '').trim().slice(0, 120)
    if (q.length < 2) throw new HttpError(400, 'Type a product name to search')
    return await search(q)
  }

  if (body.action === 'save') {
    const itemId = String(body.item_id ?? '')
    const { data: item } = await member.db.from('items').select('id, household_id').eq('id', itemId).maybeSingle()
    if (!item) throw new HttpError(404, 'Item not found')
    const url = safeImageUrl(String(body.image_url ?? ''))
    let res: Response
    try {
      res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'LiyanasCloset/1.0 (photo import)' } })
    } catch {
      throw new HttpError(400, 'Could not reach that image link')
    }
    if (!res.ok) throw new HttpError(400, `Could not download that image (${res.status})`)
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim()
    if (!TYPES[type]) throw new HttpError(400, 'That link is not a JPEG, PNG or WebP image')
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (bytes.byteLength > MAX_BYTES) throw new HttpError(400, 'That image is larger than 8 MB')
    const path = `${item.household_id}/${item.id}/${crypto.randomUUID()}.${TYPES[type]}`
    // Upload as the parent (storage RLS checks the household folder).
    const up = await member.db.storage.from('item-photos').upload(path, bytes, { contentType: type })
    if (up.error) throw new HttpError(500, 'Could not store the photo')
    return json({ path })
  }

  throw new HttpError(400, 'Unknown action')
}))
