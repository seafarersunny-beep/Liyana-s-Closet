// Sends queued low/out-of-stock alerts as Web Push to every subscribed phone in
// the household. The app calls this after each stock change. Each alert is
// claimed atomically, so two phones calling at once cannot double-send.
import webpush from 'npm:web-push@3.6.7'
import { asMember, handle, HttpError, json, serviceClient } from '../_shared/household.ts'

Deno.serve(handle(async (req) => {
  if (req.method !== 'POST') throw new HttpError(405, 'POST only')
  const member = await asMember(req)
  const pub = Deno.env.get('VAPID_PUBLIC_KEY')
  const priv = Deno.env.get('VAPID_PRIVATE_KEY')
  const subject = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@example.com'
  if (!pub || !priv) {
    return json({ configured: false, sent: 0, message: 'Background push is not set up (missing VAPID keys).' })
  }
  webpush.setVapidDetails(subject, pub, priv)

  const admin = serviceClient()
  const { data: subs, error: subErr } = await admin.from('push_subscriptions').select('*').eq('household_id', member.householdId)
  if (subErr) throw new HttpError(500, 'Could not read subscriptions')
  if (!subs?.length) return json({ configured: true, sent: 0, message: 'No phones have turned on background alerts yet.' })

  const { data: alerts, error } = await admin.rpc('claim_notifications', { p_household: member.householdId })
  if (error) throw new HttpError(500, 'Could not read alerts')

  let sent = 0
  for (const a of alerts ?? []) {
    const payload = JSON.stringify({ title: a.title, body: a.body, tag: `stock-${a.item_id}`, url: '/inventory?alerts=1' })
    const results: unknown[] = []
    for (const s of subs) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 86400, urgency: 'normal' })
        sent++
        results.push({ sub: s.id, ok: true })
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode
        results.push({ sub: s.id, ok: false, status })
        if (status === 404 || status === 410) await admin.from('push_subscriptions').delete().eq('id', s.id)
      }
    }
    await admin.from('notification_outbox').update({ sent_at: new Date().toISOString(), result: results }).eq('id', a.id)
  }
  return json({ configured: true, sent, alerts: alerts?.length ?? 0 })
}))
