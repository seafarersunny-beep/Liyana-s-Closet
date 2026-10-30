import { getPrefs } from './prefs'

// Liyana's greeting. Real audio only: a clip a parent recorded, or the phone's
// own Bangla text-to-speech voice if it has one. Browsers (iOS especially)
// only allow sound after a tap, so callers must invoke this from a tap.

const BN_TITLES: Record<string, string> = { baba: 'বাবা', ma: 'মা', abbu: 'আব্বু', amma: 'আম্মা', papa: 'পাপা', mama: 'মামা' }

export interface Greeting {
  title: string
  audioUrl: string | null
  pitchUp: boolean
}

let current: Greeting = { title: 'Baba', audioUrl: null, pitchUp: true }
export function setGreeting(g: Greeting) {
  current = g
}
export function getGreeting() {
  return current
}

export function greetingText(title = current.title) {
  const bn = BN_TITLES[title.trim().toLowerCase()] ?? title
  return {
    bangla: `হ্যালো ${bn}, আমি তোমার ছোট্ট লিয়ানা, আর আমি তোমাকে ভালোবাসি`,
    roman: `Hello ${title}, ami tomar chotto Liyana, r ami tomake valobashi`,
  }
}

export function banglaVoice(): SpeechSynthesisVoice | null {
  if (!('speechSynthesis' in window)) return null
  const voices = window.speechSynthesis.getVoices()
  return voices.find((v) => v.lang.toLowerCase().startsWith('bn')) ?? null
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
  const voice = banglaVoice()
  if (!voice) return 'no-voice'
  const u = new SpeechSynthesisUtterance(greetingText(g.title).bangla)
  u.voice = voice
  u.lang = voice.lang
  u.pitch = 1.6
  u.rate = 0.95
  window.speechSynthesis.cancel()
  window.speechSynthesis.speak(u)
  busyUntil = performance.now() + 1500
  return 'played'
}
