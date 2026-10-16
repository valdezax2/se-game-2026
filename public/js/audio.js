// Tiny WebAudio chiptune blips. Audio is optional, so every failure is swallowed.
let ctx = null;

function tone(f0, f1, dur, type, vol) {
  try {
    ctx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(f1, t + dur);
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur);
  } catch {
    /* audio unavailable */
  }
}

const SFX = {
  shoot: [880, 440, 0.08, 'square', 0.03],
  hit: [260, 120, 0.12, 'sawtooth', 0.05],
  pickup: [660, 990, 0.14, 'triangle', 0.06],
  kill: [330, 70, 0.35, 'sawtooth', 0.06],
  start: [523, 784, 0.25, 'square', 0.04],
};

export function sfx(name) {
  const s = SFX[name];
  if (s) tone(...s);
}

// Short rising fanfare for the end of a match
export function playWin() {
  [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => tone(f, f, 0.18, 'triangle', 0.06), i * 130));
}
