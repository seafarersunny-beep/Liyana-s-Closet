import { useEffect, useRef, useState } from 'react'
import { onAppEvent } from '../lib/events'
import { usePrefs } from '../lib/prefs'
import { sound } from '../lib/sound'
import { speakGreeting } from '../lib/voice'

// Liyana: an original, symbolic cartoon (not a likeness). Warm brown hair, a tiny
// lavender bow, peach outfit, friendly smile. Blinks, waves now and then, and
// does a happy hop when something is saved.
export function Mascot({ size = 96, mood: forcedMood, react = true, tappable = true, onTapped }: { size?: number; mood?: 'happy' | 'idle'; react?: boolean; tappable?: boolean; onTapped?: () => void }) {
  const { reduced } = usePrefs()
  const [happy, setHappy] = useState(false)
  const [waving, setWaving] = useState(false)
  const [hearts, setHearts] = useState<number[]>([])
  const happyTimer = useRef<number | undefined>(undefined)

  // Tap Liyana: she says her greeting (or giggles if no voice is available).
  async function tap() {
    setHappy(true)
    setWaving(true)
    window.clearTimeout(happyTimer.current)
    happyTimer.current = window.setTimeout(() => {
      setHappy(false)
      setWaving(false)
    }, 1800)
    const id = Date.now()
    setHearts((h) => [...h.slice(-5), id])
    window.setTimeout(() => setHearts((h) => h.filter((x) => x !== id)), 1400)
    onTapped?.()
    const r = await speakGreeting()
    if (r === 'no-voice' || r === 'blocked') sound.giggle()
  }

  useEffect(() => {
    if (!react) return
    let t: number | undefined
    const off = onAppEvent((e) => {
      if (e.type === 'saved' || e.type === 'milestone') {
        setHappy(true)
        window.clearTimeout(t)
        t = window.setTimeout(() => setHappy(false), 1600)
      }
    })
    return () => {
      off()
      window.clearTimeout(t)
    }
  }, [react])

  useEffect(() => {
    if (reduced) return
    let t: number
    const schedule = () => {
      t = window.setTimeout(() => {
        setWaving(true)
        window.setTimeout(() => setWaving(false), 1800)
        schedule()
      }, 9000 + Math.random() * 9000)
    }
    // a hello wave shortly after appearing
    const first = window.setTimeout(() => {
      setWaving(true)
      window.setTimeout(() => setWaving(false), 1800)
    }, 900)
    schedule()
    return () => {
      window.clearTimeout(t)
      window.clearTimeout(first)
    }
  }, [reduced])

  const isHappy = forcedMood === 'happy' || happy
  const art = (
    <svg
      className={`mascot ${isHappy ? 'is-happy' : ''} ${waving ? 'is-waving' : ''}`}
      width={size}
      height={size}
      viewBox="0 0 120 120"
      role="img"
      aria-label="Liyana, the app's cartoon mascot"
    >
      <g className="mascot-body">
        {/* outfit */}
        <path d="M30 118c0-22 13-34 30-34s30 12 30 34z" fill="#F5B595" />
        <path d="M48 88c4 5 20 5 24 0" stroke="#E79A78" strokeWidth="2.4" fill="none" strokeLinecap="round" />
        <circle cx="60" cy="100" r="2.2" fill="#FFF3E8" />
        <circle cx="60" cy="109" r="2.2" fill="#FFF3E8" />
        {/* left arm resting */}
        <path d="M33 104c-4-6-3-12 2-15" stroke="#F5B595" strokeWidth="9" strokeLinecap="round" fill="none" />
        <circle cx="34" cy="106" r="5.2" fill="#F3CFB3" />
        {/* waving arm */}
        <g className="mascot-arm">
          <path d="M86 92c6-4 9-10 9-17" stroke="#F5B595" strokeWidth="9" strokeLinecap="round" fill="none" />
          <circle cx="95" cy="72" r="5.6" fill="#F3CFB3" />
        </g>
        {/* head */}
        <circle cx="60" cy="52" r="31" fill="#F3CFB3" />
        {/* hair */}
        <path d="M29 52c-1-20 13-34 31-34s32 13 31 32c-6-9-15-14-25-15-3 5-9 8-16 8 3-2 4-5 4-8-10 2-19 9-25 17z" fill="#8A5636" />
        <path d="M58 20c-2-6 3-10 7-8-4 1-5 4-3 8z" fill="#8A5636" />
        {/* bow */}
        <g transform="translate(76 25) rotate(18)">
          <g className="mascot-bow">
          <path d="M0 0l-9-6v12z" fill="#C3B1E1" />
          <path d="M0 0l9-6v12z" fill="#C3B1E1" />
          <circle r="2.8" fill="#A994CF" />
        </g>
        </g>
        {/* cheeks */}
        <ellipse cx="42" cy="62" rx="5.5" ry="3.6" fill="#F2A7A0" opacity=".55" />
        <ellipse cx="78" cy="62" rx="5.5" ry="3.6" fill="#F2A7A0" opacity=".55" />
        {/* eyes */}
        {isHappy ? (
          <g stroke="#3F2E28" strokeWidth="2.6" fill="none" strokeLinecap="round">
            <path d="M44 53q4-5 8 0" />
            <path d="M68 53q4-5 8 0" />
          </g>
        ) : (
          <g className="mascot-eyes">
            <ellipse cx="48" cy="53" rx="3.6" ry="4.4" fill="#3F2E28" />
            <ellipse cx="72" cy="53" rx="3.6" ry="4.4" fill="#3F2E28" />
            <circle cx="49.3" cy="51.4" r="1.2" fill="#fff" />
            <circle cx="73.3" cy="51.4" r="1.2" fill="#fff" />
          </g>
        )}
        {/* smile */}
        <path d={isHappy ? 'M51 64q9 10 18 0z' : 'M52 65q8 6 16 0'} stroke="#B5615A" strokeWidth="2.4" fill={isHappy ? '#E9867E' : 'none'} strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </svg>
  )
  if (!tappable) return art
  return (
    <button type="button" className="mascot-tap" onClick={tap} aria-label="Tap Liyana to hear her say hello" style={{ width: size, height: size }}>
      {art}
      {hearts.map((h, i) => (
        <span key={h} className="heart-pop" style={{ left: `${30 + ((h + i * 23) % 40)}%` }} aria-hidden="true">♥</span>
      ))}
    </button>
  )
}
