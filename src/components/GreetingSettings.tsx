import { useEffect, useRef, useState } from 'react'
import { supabase, friendlyError } from '../lib/supabase'
import { useData, useHousehold, type Member } from '../lib/household'
import { banglaVoice, greetingText, speakGreeting } from '../lib/voice'
import { emit } from '../lib/events'
import { ErrorNote } from './ui'

const TITLES = ['Baba', 'Ma', 'Abbu', 'Amma']
const MAX_SECONDS = 15

function pickMime() {
  const options = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']
  return options.find((t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(t)) ?? ''
}

function MemberGreeting({ member, isMe }: { member: Member; isMe: boolean }) {
  const { greetingUrls, household } = useData()
  const { refresh } = useHousehold()
  const [recording, setRecording] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [seconds, setSeconds] = useState(0)
  const rec = useRef<MediaRecorder | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const url = greetingUrls[member.user_id] ?? null
  const text = greetingText(member.greeting_title)

  useEffect(() => () => window.clearInterval(timer.current), [])

  async function save(patch: Partial<Member>, msg: string) {
    const { error: e } = await supabase.from('household_members').update(patch).eq('household_id', household.id).eq('user_id', member.user_id)
    if (e) throw e
    emit({ type: 'saved', message: msg })
    await refresh()
  }

  async function upload(blob: Blob) {
    setBusy(true)
    setError(null)
    try {
      const type = (blob.type || 'audio/mp4').split(';')[0]
      const ext = type.includes('webm') ? 'webm' : type.includes('mpeg') ? 'mp3' : type.includes('wav') ? 'wav' : type.includes('ogg') ? 'ogg' : 'm4a'
      const path = `${household.id}/greeting/${member.user_id}-${crypto.randomUUID()}.${ext}`
      const { error: e } = await supabase.storage.from('household-audio').upload(path, blob, { contentType: type })
      if (e) throw e
      const old = member.greeting_audio_path
      await save({ greeting_audio_path: path }, `Greeting saved for ${member.display_name}`)
      if (old) await supabase.storage.from('household-audio').remove([old])
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  async function start() {
    setError(null)
    if (!navigator.onLine) return setError("You're offline. Recordings can be saved when you're connected.")
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mime = pickMime()
      const r = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
      const chunks: Blob[] = []
      r.ondataavailable = (e) => e.data.size && chunks.push(e.data)
      r.onstop = () => {
        stream.getTracks().forEach((t) => t.stop())
        window.clearInterval(timer.current)
        setRecording(false)
        if (chunks.length) void upload(new Blob(chunks, { type: r.mimeType || mime || 'audio/mp4' }))
      }
      rec.current = r
      r.start()
      setRecording(true)
      setSeconds(0)
      timer.current = window.setInterval(() => {
        setSeconds((s) => {
          if (s + 1 >= MAX_SECONDS) rec.current?.stop()
          return s + 1
        })
      }, 1000)
    } catch {
      setError('Microphone access was not allowed. You can allow it in iPhone Settings → Safari → Microphone, or upload an audio file instead.')
    }
  }

  async function remove() {
    setBusy(true)
    try {
      const old = member.greeting_audio_path
      await save({ greeting_audio_path: null }, 'Recording removed')
      if (old) await supabase.storage.from('household-audio').remove([old])
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="greet-member">
      <div className="greet-head">
        <strong>{member.display_name}{isMe ? ' (you)' : ''}</strong>
        {isMe ? (
          <select value={member.greeting_title} onChange={(e) => save({ greeting_title: e.target.value }, 'Saved').catch((err) => setError(friendlyError(err)))} aria-label="What Liyana calls you">
            {[...new Set([...TITLES, member.greeting_title])].map((t) => <option key={t} value={t}>Liyana calls me {t}</option>)}
          </select>
        ) : (
          <span className="sub">Liyana calls them {member.greeting_title}</span>
        )}
      </div>
      <p className="greet-line" lang="bn">“{text.bangla}”</p>
      <div className="greet-actions">
        {recording ? (
          <button className="btn danger" onClick={() => rec.current?.stop()}>■ Stop ({MAX_SECONDS - seconds}s)</button>
        ) : (
          <button className="btn soft" onClick={start} disabled={busy}>● {url ? 'Record again' : 'Record greeting'}</button>
        )}
        {url && !recording && (
          <button className="btn soft" onClick={() => speakGreeting({ title: member.greeting_title, audioUrl: url, pitchUp: member.greeting_pitch_up })}>▶ Play</button>
        )}
        <label className="btn ghost small upload-audio">
          Upload audio
          <input type="file" accept="audio/*" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} disabled={busy} />
        </label>
      </div>
      {url && (
        <div className="greet-actions">
          <label className="toggle small">
            <input type="checkbox" checked={member.greeting_pitch_up} onChange={(e) => save({ greeting_pitch_up: e.target.checked }, 'Saved').catch((err) => setError(friendlyError(err)))} />
            <span>Make it sound little</span>
          </label>
          <button className="btn ghost small" onClick={remove} disabled={busy}>Remove</button>
        </div>
      )}
      {busy && <p className="calc">Saving…</p>}
      <ErrorNote message={error} />
    </div>
  )
}

export function GreetingSettings() {
  const { members } = useData()
  const { session } = useHousehold()
  const [greetOn, setGreetOn] = useState(() => {
    try {
      return localStorage.getItem('liyanas-closet-greet-off') !== '1'
    } catch {
      return true
    }
  })
  const [hasVoice, setHasVoice] = useState(() => !!banglaVoice())
  useEffect(() => {
    const t = window.setTimeout(() => setHasVoice(!!banglaVoice()), 800)
    return () => window.clearTimeout(t)
  }, [])

  function toggle(on: boolean) {
    setGreetOn(on)
    try {
      localStorage.setItem('liyanas-closet-greet-off', on ? '0' : '1')
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="card form">
      <strong>Liyana’s greeting</strong>
      <p className="calc">
        Each time the app opens, Liyana says hello in Bangla after your first tap (iPhones don’t allow sound before a tap). Tap her anytime to hear it again.
        Record a voice for each parent, for example Smita records what Sunny hears. Recordings sync to both phones.
        {hasVoice ? ' Until one is recorded, this phone’s Bangla voice reads it.' : ' This phone has no Bangla text-to-speech voice, so Liyana stays quiet until a greeting is recorded.'}
      </p>
      <label className="toggle"><input type="checkbox" checked={greetOn} onChange={(e) => toggle(e.target.checked)} /><span>Greet me when the app opens (this phone)</span></label>
      {members.map((m) => <MemberGreeting key={m.user_id} member={m} isMe={m.user_id === session?.user.id} />)}
    </div>
  )
}
