import { getPrefs } from './prefs'

// Gentle synthesized sounds: no audio files, nothing autoplays, quiet by design.
let ctx: AudioContext | null = null
function audio() {
  if (getPrefs().muted) return null
  try {
    ctx ??= new AudioContext()
    if (ctx.state === 'suspended') void ctx.resume()
    return ctx
  } catch {
    return null
  }
}

function tone(freq: number, start: number, dur: number, gain = 0.05, type: OscillatorType = 'sine') {
  const a = audio()
  if (!a) return
  const t = a.currentTime + start
  const osc = a.createOscillator()
  const g = a.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freq, t)
  g.gain.setValueAtTime(0, t)
  g.gain.linearRampToValueAtTime(gain, t + 0.015)
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  osc.connect(g).connect(a.destination)
  osc.start(t)
  osc.stop(t + dur + 0.05)
}

let lastTap = 0
export const sound = {
  tap() {
    const now = performance.now()
    if (now - lastTap < 80) return // avoid rapid repeats
    lastTap = now
    tone(880, 0, 0.06, 0.02, 'triangle')
  },
  success() {
    tone(784, 0, 0.35, 0.04) // G5
    tone(1047, 0.09, 0.45, 0.035) // C6
  },
  milestone() {
    ;[523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.11, 0.6, 0.035))
  },
  // a soft, bubbly little giggle
  giggle() {
    ;[880, 1175, 988, 1319, 1175].forEach((f, i) => tone(f, i * 0.07, 0.12, 0.03, 'sine'))
  },
  error() {
    tone(330, 0, 0.18, 0.03, 'triangle')
  },
}
