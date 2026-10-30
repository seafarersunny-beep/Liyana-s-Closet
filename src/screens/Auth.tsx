import { useState, type FormEvent } from 'react'
import { supabase, friendlyError } from '../lib/supabase'
import { useHousehold } from '../lib/household'
import { Mascot } from '../components/Mascot'
import { ErrorNote, Field } from '../components/ui'

const INVITE_KEY = 'liyanas-closet-invite'

export function rememberInviteFromUrl() {
  const m = window.location.hash.match(/invite=([0-9a-f]{48})/i)
  if (m) {
    try {
      sessionStorage.setItem(INVITE_KEY, m[1])
    } catch {
      /* ignore */
    }
  }
}
function pendingInvite() {
  try {
    return sessionStorage.getItem(INVITE_KEY)
  } catch {
    return null
  }
}

export function AuthScreen() {
  const [mode, setMode] = useState<'signin' | 'signup' | 'reset'>(pendingInvite() ? 'signup' : 'signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setInfo(null)
    try {
      if (mode === 'signin') {
        const { error: err } = await supabase.auth.signInWithPassword({ email, password })
        if (err) throw err
      } else if (mode === 'signup') {
        if (password.length < 10) throw new Error('Use at least 10 characters for your password')
        const { data, error: err } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: window.location.origin + window.location.pathname } })
        if (err) throw err
        if (!data.session) setInfo('Check your email to confirm your account, then come back and sign in.')
      } else {
        const { error: err } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin + window.location.pathname + '#/settings' })
        if (err) throw err
        setInfo('If that email has an account, a reset link is on its way.')
      }
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth">
      <Mascot size={128} />
      <h1 className="brand">Liyana’s Closet</h1>
      <p className="tagline">Our little registry, closet & spending journal</p>
      {pendingInvite() && <div className="notice">You’ve been invited to join a family. Create your own account (or sign in) to accept.</div>}
      <form className="card form" onSubmit={submit}>
        <div className="seg">
          <button type="button" className={mode === 'signin' ? 'on' : ''} onClick={() => setMode('signin')}>Sign in</button>
          <button type="button" className={mode === 'signup' ? 'on' : ''} onClick={() => setMode('signup')}>Create account</button>
        </div>
        <Field label="Email">
          <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        {mode !== 'reset' && (
          <Field label="Password" hint={mode === 'signup' ? 'Your own password. Never share it, even with your partner.' : undefined}>
            <input type="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
        )}
        <ErrorNote message={error} />
        {info && <p className="info-note">{info}</p>}
        <button className="btn primary big" disabled={busy}>
          {busy ? 'One moment…' : mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Send reset link'}
        </button>
        {mode === 'signin' && <button type="button" className="btn ghost" onClick={() => setMode('reset')}>Forgot password?</button>}
      </form>
    </div>
  )
}

export function SetupScreen() {
  const { session, refreshMembership } = useHousehold()
  const [name, setName] = useState('')
  const [token, setToken] = useState(pendingInvite() ?? '')
  const [mode, setMode] = useState<'create' | 'join'>(pendingInvite() ? 'join' : 'create')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!name.trim()) return setError('Tell us your name (e.g. Sunny or Smita)')
    setBusy(true)
    setError(null)
    try {
      const t = token.trim().match(/[0-9a-f]{48}/i)?.[0] ?? token.trim()
      const { error: err } =
        mode === 'create'
          ? await supabase.rpc('create_household', { p_name: "Liyana's Closet", p_display_name: name.trim() })
          : await supabase.rpc('accept_invite', { p_token: t, p_display_name: name.trim() })
      if (err) throw err
      try {
        sessionStorage.removeItem(INVITE_KEY)
      } catch {
        /* ignore */
      }
      if (window.location.hash.startsWith('#/join')) window.location.hash = '#/'
      await refreshMembership()
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth">
      <Mascot size={110} />
      <h1 className="brand">Welcome</h1>
      <p className="tagline">Signed in as {session?.user.email}</p>
      <form className="card form" onSubmit={submit}>
        <div className="seg">
          <button type="button" className={mode === 'create' ? 'on' : ''} onClick={() => setMode('create')}>Start our family</button>
          <button type="button" className={mode === 'join' ? 'on' : ''} onClick={() => setMode('join')}>Join with invite</button>
        </div>
        <Field label="Your name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Sunny" />
        </Field>
        {mode === 'join' && (
          <Field label="Invitation link or code" hint="Your partner can create one in Settings → Family.">
            <input value={token} onChange={(e) => setToken(e.target.value)} />
          </Field>
        )}
        <ErrorNote message={error} />
        <button className="btn primary big" disabled={busy}>{busy ? 'Setting up…' : mode === 'create' ? 'Create our household' : 'Join household'}</button>
        <button type="button" className="btn ghost" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </form>
    </div>
  )
}
