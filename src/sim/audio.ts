export class SimAudio {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private muffle!: BiquadFilterNode;
  private engGain!: GainNode;
  private engFilter!: BiquadFilterNode;
  private whine: OscillatorNode[] = [];
  private whineGain!: GainNode;
  private windGain!: GainNode;
  private windFilter!: BiquadFilterNode;
  private rumbleGain!: GainNode;
  private gearGain!: GainNode;
  private noiseBuf!: AudioBuffer;
  private lastCallout = 99999;
  enabled = true;

  start() {
    if (this.ctx) { this.ctx.resume(); return; }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain(); this.master.gain.value = 0.55;
    this.muffle = ctx.createBiquadFilter(); this.muffle.type = "lowpass"; this.muffle.frequency.value = 18000;
    this.muffle.connect(this.master); this.master.connect(ctx.destination);
    // brown noise buffer
    const len = ctx.sampleRate * 4;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
    this.noiseBuf = buf;
    const white = ctx.createBuffer(1, len, ctx.sampleRate);
    const wd = white.getChannelData(0);
    for (let i = 0; i < len; i++) wd[i] = Math.random() * 2 - 1;
    const loop = (b: AudioBuffer) => { const s = ctx.createBufferSource(); s.buffer = b; s.loop = true; s.start(); return s; };
    // engine roar
    this.engFilter = ctx.createBiquadFilter(); this.engFilter.type = "lowpass"; this.engFilter.frequency.value = 400; this.engFilter.Q.value = 0.7;
    this.engGain = ctx.createGain(); this.engGain.gain.value = 0;
    loop(buf).connect(this.engFilter); this.engFilter.connect(this.engGain); this.engGain.connect(this.muffle);
    // fan whine
    this.whineGain = ctx.createGain(); this.whineGain.gain.value = 0;
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.Q.value = 6; bp.frequency.value = 2000;
    for (const detune of [0, 7]) {
      const o = ctx.createOscillator(); o.type = "sawtooth"; o.frequency.value = 300; o.detune.value = detune; o.connect(bp); o.start(); this.whine.push(o);
    }
    bp.connect(this.whineGain); this.whineGain.connect(this.muffle);
    // wind
    this.windFilter = ctx.createBiquadFilter(); this.windFilter.type = "bandpass"; this.windFilter.Q.value = 0.5; this.windFilter.frequency.value = 500;
    this.windGain = ctx.createGain(); this.windGain.gain.value = 0;
    loop(white).connect(this.windFilter); this.windFilter.connect(this.windGain); this.windGain.connect(this.master);
    // runway rumble
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 90;
    this.rumbleGain = ctx.createGain(); this.rumbleGain.gain.value = 0;
    loop(buf).connect(lp); lp.connect(this.rumbleGain); this.rumbleGain.connect(this.master);
    // gear motor/airflow
    const gb = ctx.createBiquadFilter(); gb.type = "bandpass"; gb.frequency.value = 180; gb.Q.value = 2;
    this.gearGain = ctx.createGain(); this.gearGain.gain.value = 0;
    loop(white).connect(gb); gb.connect(this.gearGain); this.gearGain.connect(this.master);
  }

  update(p: { n1: number; ias: number; gs: number; onGround: boolean; gearMoving: boolean; gearDown: boolean; inside: boolean; reverser: number; spoilers: number }) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const on = this.enabled ? 1 : 0;
    const n = Math.max(0, (p.n1 - 0.18) / 0.82);
    this.engGain.gain.setTargetAtTime(on * (0.12 + n * 0.9 + p.reverser * 0.4) * (p.inside ? 0.45 : 1), t, 0.1);
    this.engFilter.frequency.setTargetAtTime(250 + n * 1600 + p.reverser * 600, t, 0.2);
    this.whine.forEach((o, i) => o.frequency.setTargetAtTime((180 + p.n1 * 2600) * (i ? 1.5 : 1), t, 0.25));
    this.whineGain.gain.setTargetAtTime(on * (0.012 + p.n1 * 0.035) * (p.inside ? 0.35 : 1), t, 0.2);
    const w = Math.min(1.5, p.ias / 150);
    this.windGain.gain.setTargetAtTime(on * (w * w * 0.16 + (p.gearDown ? w * 0.04 : 0) + p.spoilers * w * 0.06), t, 0.3);
    this.windFilter.frequency.setTargetAtTime(300 + p.ias * 8, t, 0.3);
    this.rumbleGain.gain.setTargetAtTime(on * (p.onGround ? Math.min(1, p.gs / 40) * 0.9 : 0), t, 0.08);
    this.gearGain.gain.setTargetAtTime(on * (p.gearMoving ? 0.12 : 0), t, 0.3);
    this.muffle.frequency.setTargetAtTime(p.inside ? 1800 : 18000, t, 0.2);
  }

  thump(strength: number) {
    const ctx = this.ctx; if (!ctx || !this.enabled) return;
    const s = ctx.createBufferSource(); s.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 160;
    const g = ctx.createGain(); g.gain.setValueAtTime(Math.min(2.5, strength), ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.7);
    s.connect(f); f.connect(g); g.connect(this.master); s.start(); s.stop(ctx.currentTime + 0.8);
    // tire chirp
    const o = ctx.createOscillator(); o.type = "triangle"; o.frequency.setValueAtTime(900, ctx.currentTime); o.frequency.exponentialRampToValueAtTime(300, ctx.currentTime + 0.25);
    const og = ctx.createGain(); og.gain.setValueAtTime(0.08, ctx.currentTime); og.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    o.connect(og); og.connect(this.master); o.start(); o.stop(ctx.currentTime + 0.35);
  }

  say(text: string) {
    if (!this.enabled || !("speechSynthesis" in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.15; u.pitch = 0.7; u.volume = 0.9;
    window.speechSynthesis.speak(u);
  }

  /** Airbus-style radio altitude callouts */
  callouts(aglFt: number, vs: number, onGround: boolean) {
    if (onGround || vs > 0) { if (aglFt > 1100 || onGround) this.lastCallout = 99999; return; }
    const marks = [1000, 500, 100, 50, 40, 30, 20, 10];
    for (const m of marks) {
      if (aglFt <= m && this.lastCallout > m) {
        this.lastCallout = m;
        this.say(m === 1000 ? "one thousand" : m === 500 ? "five hundred" : m === 100 ? "one hundred" : String(m));
        if (m === 10) setTimeout(() => this.say("retard"), 500);
        break;
      }
    }
  }
}
