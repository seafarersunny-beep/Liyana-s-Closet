import { useEffect, useState } from 'react'
import { Mascot } from './Mascot'
import { usePrefs } from '../lib/prefs'
import { greetingText, speakGreeting, type Greeting, type SpeakResult } from '../lib/voice'

const KEY = 'liyanas-closet-greeted'

export function shouldGreet() {
  try {
    return !sessionStorage.getItem(KEY) && localStorage.getItem('liyanas-closet-greet-off') !== '1'
  } catch {
    return true
  }
}

// Shown once each time the app is opened. iPhones only allow sound after a tap,
// so Liyana waits for the first tap before she speaks.
export function Welcome({ name, greeting, onDone }: { name: string; greeting: Greeting; onDone: () => void }) {
  const { muted, reduced } = usePrefs()
  const [spoken, setSpoken] = useState(false)
  const [result, setResult] = useState<SpeakResult | null>(null)
  const [leaving, setLeaving] = useState(false)
  const text = greetingText(greeting.title)

  useEffect(() => {
    try {
      sessionStorage.setItem(KEY, '1')
    } catch {
      /* ignore */
    }
  }, [])

  function finish() {
    if (reduced) return onDone()
    setLeaving(true)
    window.setTimeout(onDone, 380)
  }

  async function hello() {
    if (spoken) return finish()
    setSpoken(true)
    const r = await speakGreeting(greeting)
    setResult(r)
  }

  return (
    <div className={`welcome ${leaving ? 'leaving' : ''}`} onClick={hello} role="dialog" aria-label="Liyana says hello">
      <div className="welcome-sparkles" aria-hidden="true">
        {Array.from({ length: 14 }, (_, i) => (
          <span key={i} style={{ left: `${(i * 41) % 100}%`, top: `${(i * 67) % 90}%`, animationDelay: `${(i % 7) * 0.35}s` }}>✦</span>
        ))}
      </div>
      <div className="welcome-mascot">
        <Mascot size={210} mood={spoken ? 'happy' : undefined} tappable={false} />
      </div>
      <div className={`speech ${spoken ? 'show' : ''}`} lang="bn">
        <p className="speech-bn">{text.bangla}</p>
        <p className="speech-roman">{text.roman}</p>
      </div>
      {!spoken ? (
        <button className="btn primary big welcome-btn" onClick={(e) => { e.stopPropagation(); void hello() }}>
          {muted ? 'Say hi to Liyana' : 'Tap to hear Liyana'} ♥
        </button>
      ) : (
        <>
          {result === 'no-voice' && <p className="welcome-note">No voice yet. Record Liyana’s greeting in Settings and it will play here on both phones.</p>}
          {result === 'muted' && <p className="welcome-note">Sound is off. Turn on gentle sounds in Settings to hear her.</p>}
          {result === 'blocked' && <p className="welcome-note">The greeting couldn’t play on this phone. Check the ringer switch and volume.</p>}
          <button className="btn primary big welcome-btn" onClick={(e) => { e.stopPropagation(); finish() }}>Open {name}’s Closet</button>
        </>
      )}
      <button className="btn ghost welcome-skip" onClick={(e) => { e.stopPropagation(); onDone() }}>Skip</button>
    </div>
  )
}
