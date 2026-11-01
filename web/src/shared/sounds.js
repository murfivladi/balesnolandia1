// Звуки кассы на WebAudio — без файлов: пик сканера, одобрение, отказ, ящик.
let ctx = null;
function ac() {
  if (!ctx) {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    ctx = new C();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function tone(freq, start, dur, { type = 'square', gain = 0.08 } = {}) {
  const a = ac();
  if (!a) return;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(gain, a.currentTime + start);
  g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + start + dur);
  o.connect(g).connect(a.destination);
  o.start(a.currentTime + start);
  o.stop(a.currentTime + start + dur + 0.02);
}

export const sound = {
  beep: () => tone(2400, 0, 0.09),
  approve: () => { tone(880, 0, 0.12, { type: 'sine', gain: 0.15 }); tone(1320, 0.13, 0.2, { type: 'sine', gain: 0.15 }); },
  decline: () => { tone(220, 0, 0.25, { type: 'sawtooth', gain: 0.12 }); tone(180, 0.27, 0.35, { type: 'sawtooth', gain: 0.12 }); },
  drawer: () => {
    const a = ac();
    if (!a) return;
    const len = a.sampleRate * 0.25;
    const buf = a.createBuffer(1, len, a.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (len / 6));
    const src = a.createBufferSource();
    const g = a.createGain();
    g.gain.value = 0.25;
    src.buffer = buf;
    src.connect(g).connect(a.destination);
    src.start();
    tone(1800, 0.22, 0.25, { type: 'triangle', gain: 0.1 });
  },
  click: () => tone(1200, 0, 0.03, { type: 'square', gain: 0.03 }),
};
