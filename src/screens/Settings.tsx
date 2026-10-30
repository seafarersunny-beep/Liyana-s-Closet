import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase, friendlyError, vapidPublicKey } from '../lib/supabase'
import { clearCache, useData, useHousehold } from '../lib/household'
import { setPrefs, usePrefs } from '../lib/prefs'
import { formatWhen } from '../lib/format'
import { download, itemsCsv, purchasesCsv } from '../lib/export'
import { todayNY } from '../lib/format'
import { emit } from '../lib/events'
import { ErrorNote } from '../components/ui'
import { GreetingSettings } from '../components/GreetingSettings'

export function ExportButtons() {
  const d = useData()
  const day = todayNY()
  return (
    <div className="export-buttons">
      <button className="btn soft" onClick={() => download(`liyanas-closet-purchases-${day}.csv`, purchasesCsv(d), 'text/csv')}>Purchases (CSV)</button>
      <button className="btn soft" onClick={() => download(`liyanas-closet-items-${day}.csv`, itemsCsv(d), 'text/csv')}>Items (CSV)</button>
      <button className="btn soft" onClick={() => download(`liyanas-closet-backup-${day}.json`, JSON.stringify({ exported_at: new Date().toISOString(), household: d.household, members: d.members, items: d.items, purchases: d.purchases, gifts: d.gifts }, null, 2), 'application/json')}>Full backup (JSON)</button>
    </div>
  )
}

const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true

function urlB64ToUint8Array(base64: string) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4)
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

function PushSettings() {
  const { household } = useData()
  const { session } = useHousehold()
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
  const [state, setState] = useState<'unknown' | 'on' | 'off'>('unknown')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!supported) return
    navigator.serviceWorker.ready.then((reg) => reg.pushManager.getSubscription()).then((s) => setState(s ? 'on' : 'off')).catch(() => setState('off'))
  }, [supported])

  async function enable() {
    setBusy(true)
    setError(null)
    try {
      // Permission is requested only now, after the parent opted in.
      const perm = await Notification.requestPermission()
      if (perm !== 'granted') throw new Error('Notifications were not allowed. You can change this in iPhone Settings → Notifications → Liyana’s Closet.')
      const reg = await navigator.serviceWorker.ready
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(vapidPublicKey!) }))
      const j = sub.toJSON()
      const { error: e } = await supabase.from('push_subscriptions').upsert(
        { household_id: household.id, user_id: session!.user.id, endpoint: j.endpoint!, p256dh: j.keys!.p256dh, auth: j.keys!.auth, user_agent: navigator.userAgent.slice(0, 200) },
        { onConflict: 'endpoint' },
      )
      if (e) throw e
      setState('on')
      emit({ type: 'saved', message: 'Background alerts on for this phone' })
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }
  async function disable() {
    setBusy(true)
    try {
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.getSubscription()
      if (sub) {
        await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint)
        await sub.unsubscribe()
      }
      setState('off')
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card form">
      <strong>Stock alerts</strong>
      <p className="calc">In-app alerts (badges and the alert list) always work. Background notifications are optional and need extra setup.</p>
      {!vapidPublicKey ? (
        <div className="notice">Background push is not set up on the server yet (missing VAPID keys). In-app alerts still work.</div>
      ) : !supported ? (
        <div className="notice">{isStandalone() ? 'This device does not support web push.' : 'On iPhone, background alerts work only after adding the app to your Home Screen (iOS 16.4 or later). Open it from the Home Screen icon, then turn this on.'}</div>
      ) : state === 'on' ? (
        <>
          <p className="ok-note">Background alerts are on for this phone.</p>
          <button className="btn ghost" onClick={disable} disabled={busy}>Turn off on this phone</button>
        </>
      ) : (
        <button className="btn primary" onClick={enable} disabled={busy}>{busy ? 'Setting up…' : 'Turn on background alerts'}</button>
      )}
      <ErrorNote message={error} />
    </div>
  )
}

function FamilySettings() {
  const { members } = useData()
  const { session } = useHousehold()
  const [invites, setInvites] = useState<{ id: string; created_at: string; expires_at: string; accepted_at: string | null; revoked_at: string | null }[]>([])
  const [link, setLink] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isOwner = members.find((m) => m.user_id === session?.user.id)?.role === 'owner'

  const load = () => supabase.from('household_invites').select('id,created_at,expires_at,accepted_at,revoked_at').order('created_at', { ascending: false }).limit(5).then(({ data }) => setInvites(data ?? []))
  useEffect(() => {
    void load()
  }, [])

  async function create() {
    setBusy(true)
    setError(null)
    try {
      const { data, error: e } = await supabase.rpc('create_invite', {})
      if (e) throw e
      setLink(`${window.location.origin}${window.location.pathname}#/join?invite=${data}`)
      void load()
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }
  async function share() {
    if (!link) return
    try {
      if (navigator.share) await navigator.share({ title: "Join Liyana's Closet", text: "Join our family on Liyana's Closet. Create your own account with this link:", url: link })
      else {
        await navigator.clipboard.writeText(link)
        emit({ type: 'saved', message: 'Invite link copied' })
      }
    } catch {
      /* share cancelled */
    }
  }
  async function revoke(id: string) {
    await supabase.rpc('revoke_invite', { p_invite_id: id })
    void load()
  }
  async function remove(uid: string) {
    const { error: e } = await supabase.rpc('remove_member', { p_user_id: uid })
    if (e) setError(friendlyError(e))
  }

  return (
    <div className="card form">
      <strong>Family</strong>
      <ul className="list compact">
        {members.map((m) => (
          <li key={m.user_id}>
            <div>{m.display_name}{m.user_id === session?.user.id ? ' (you)' : ''}<div className="sub">{m.role === 'owner' ? 'Started the household' : 'Parent'}</div></div>
            {isOwner && m.user_id !== session?.user.id && <button className="btn ghost small" onClick={() => remove(m.user_id)}>Remove</button>}
          </li>
        ))}
      </ul>
      <p className="calc">Invite your partner with a private link. They create their own login; passwords are never shared. Links work once and expire in 7 days.</p>
      {link ? (
        <div className="invite-box">
          <code>{link}</code>
          <button className="btn primary" onClick={share}>Share link</button>
        </div>
      ) : (
        <button className="btn primary" onClick={create} disabled={busy}>{busy ? 'Creating…' : 'Create invite link'}</button>
      )}
      {invites.length > 0 && (
        <ul className="list compact">
          {invites.map((i) => (
            <li key={i.id}>
              <div className="sub">Created {formatWhen(i.created_at)} · {i.accepted_at ? 'accepted' : i.revoked_at ? 'revoked' : new Date(i.expires_at) < new Date() ? 'expired' : 'open'}</div>
              {!i.accepted_at && !i.revoked_at && new Date(i.expires_at) > new Date() && <button className="btn ghost small" onClick={() => revoke(i.id)}>Revoke</button>}
            </li>
          ))}
        </ul>
      )}
      <ErrorNote message={error} />
    </div>
  )
}

function Activity() {
  const { members } = useData()
  const [rows, setRows] = useState<{ id: number; summary: string; actor: string | null; created_at: string }[]>([])
  useEffect(() => {
    supabase.from('activity_log').select('id,summary,actor,created_at').order('created_at', { ascending: false }).limit(30).then(({ data }) => setRows(data ?? []))
  }, [])
  return (
    <div className="card">
      <strong>Recent activity</strong>
      <ul className="list compact">
        {rows.map((r) => (
          <li key={r.id}><div>{r.summary}<div className="sub">{members.find((m) => m.user_id === r.actor)?.display_name ?? 'Someone'} · {formatWhen(r.created_at)}</div></div></li>
        ))}
      </ul>
    </div>
  )
}

export function SettingsScreen() {
  const prefs = usePrefs()
  const { session } = useHousehold()
  return (
    <div className="screen">
      <header className="screen-head"><h1>Settings</h1></header>
      <FamilySettings />
      <GreetingSettings />
      <PushSettings />
      <div className="card form">
        <strong>Sound & motion (this phone)</strong>
        <label className="toggle"><input type="checkbox" checked={!prefs.muted} onChange={(e) => setPrefs({ muted: !e.target.checked })} /><span>Gentle sounds</span></label>
        <label className="toggle"><input type="checkbox" checked={prefs.reduced} onChange={(e) => setPrefs({ reduceMotion: e.target.checked })} /><span>Reduce motion{prefs.reduceMotion == null ? ' (following iPhone setting)' : ''}</span></label>
        {prefs.reduceMotion != null && <button className="btn ghost small" onClick={() => setPrefs({ reduceMotion: null })}>Follow iPhone setting</button>}
      </div>
      <div className="card form">
        <strong>Data</strong>
        <Link className="btn soft" to="/import">Import spreadsheet</Link>
        <ExportButtons />
      </div>
      <div className="card form">
        <strong>Install on iPhone</strong>
        <ol className="steps">
          <li>Open this app’s link in <b>Safari</b>.</li>
          <li>Tap the <b>Share</b> button, then <b>Add to Home Screen</b>.</li>
          <li>Open Liyana’s Closet from the new Home Screen icon. It runs full screen.</li>
        </ol>
        <p className="calc">This is a web app installed from Safari. It is separate from the App Store.</p>
      </div>
      <Activity />
      <div className="card form">
        <span className="sub">Signed in as {session?.user.email}</span>
        <button className="btn ghost" onClick={async () => { clearCache(); await supabase.auth.signOut() }}>Sign out</button>
      </div>
    </div>
  )
}
