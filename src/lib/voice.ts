import { getPrefs } from './prefs'

// Liyana's greeting. Real audio only: a clip a parent recorded, or the phone's
// own English text-to-speech voice, pitched up to sound like a tiny girl. Browsers (iOS especially)
// only allow sound after a tap, so callers must invoke this from a tap.

export interface Greeting {
  title: string
  audioUrl: string | null
  pitchUp: boolean
}

// Until a parent picks a name, the parent who started the household is "Baba"
// and the invited parent is "Ammu".
export function titleFor(m: { greeting_title: string | null; role: string } | undefined) {
  return m?.greeting_title ?? (m && m.role !== 'owner' ? 'Ammu' : 'Baba')
}

let current: Greeting = { title: 'Baba', audioUrl: null, pitchUp: true }
export function setGreeting(g: Greeting) {
  current = g
}
export function getGreeting() {
  return current
}

export function greetingText(title = current.title) {
  return `Hello ${title}! I’m your little Liyana, and I love you so much!`
}

// The sweetest English voice this phone has: a female voice if one is installed.
const SWEET = /samantha|ava|allison|susan|karen|moira|tessa|fiona|serena|zira|female|google us english/i
export function englishVoice(): SpeechSynthesisVoice | null {
  if (!('speechSynthesis' in window)) return null
  const en = window.speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith('en'))
  return en.find((v) => SWEET.test(v.name) && v.lang.toLowerCase().startsWith('en-us')) ?? en.find((v) => SWEET.test(v.name)) ?? en[0] ?? null
}
// Some browsers load voices late.
if ('speechSynthesis' in window) window.speechSynthesis.onvoiceschanged = () => undefined

let playing: HTMLAudioElement | null = null
let busyUntil = 0

export type SpeakResult = 'played' | 'muted' | 'no-voice' | 'blocked' | 'busy'

export async function speakGreeting(g: Greeting = current): Promise<SpeakResult> {
  if (getPrefs().muted) return 'muted'
  if (performance.now() < busyUntil) return 'busy'
  if (g.audioUrl) {
    try {
      playing?.pause()
      const a = new Audio(g.audioUrl)
      if (g.pitchUp) {
        // a little higher and quicker, like a small child
        a.playbackRate = 1.18
        ;(a as HTMLAudioElement & { preservesPitch?: boolean; webkitPreservesPitch?: boolean }).preservesPitch = false
        ;(a as HTMLAudioElement & { webkitPreservesPitch?: boolean }).webkitPreservesPitch = false
      }
      playing = a
      busyUntil = performance.now() + 1500
      await a.play()
      return 'played'
    } catch {
      return 'blocked'
    }
  }
  const voice = englishVoice()
  if (!voice) return 'no-voice'
  const u = new SpeechSynthesisUtterance(greetingText(g.title))
  u.voice = voice
  u.lang = voice.lang
  u.pitch = 1.9 // tiny and sweet
  u.rate = 1.08 // a little excited
  u.volume = 1
  window.speechSynthesis.cancel()
  window.speechSynthesis.speak(u)
  busyUntil = performance.now() + 1500
  return 'played'
}
