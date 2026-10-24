/**
 * Synthesised car sounds (Web Audio, no sample files): engine hum, road and wind noise, curb rumble,
 * blinker, horn, crash and coach chimes. Mixed low, like a quiet cabin, so it adds realism without
 * pulling attention from the road.
 */
import { onPavement, type CoachKind, type Simulation } from './sim';

const STORE_KEY = 'firstmile-sound';

/** Overall level. Kept well below full scale so the cabin stays calm. */
const VOLUME = 0.5;

/** Upper speed (m/s) of each gear; the engine note climbs through a gear, then drops on the shift. */
const GEARS = [6, 11, 16];

/** One wiper sweep, in milliseconds; matches the CSS wiper animation. */
export const WIPER_MS = 1400;

/** Minimum gap between coach chimes, so a burst of messages doesn't turn into a jingle. */
const CHIME_GAP = 1.5;

export class CarAudio {
  enabled = true;
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private noise!: AudioBuffer;
  private engine!: { a: OscillatorNode; b: OscillatorNode; filter: BiquadFilterNode; gain: GainNode };
  private road!: { filter: BiquadFilterNode; gain: GainNode };
  private rumble!: GainNode;
  private ambient!: GainNode;
  private rain!: GainNode;
  private siren!: { a: OscillatorNode; b: OscillatorNode; gain: GainNode; pan: StereoPannerNode | null };
  private lastWipe = 0;
  private lastBlink = false;
  private lastState = '';
  private yieldFlag = false;
  private lastChime = -Infinity;

  constructor() {
    try {
      this.enabled = localStorage.getItem(STORE_KEY) !== 'off';
    } catch {
      /* storage blocked: keep the default */
    }
  }

  /** Browsers only allow audio after a user gesture, so this runs on the first key or tap. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.enabled ? VOLUME : 0;
    const comp = ctx.createDynamicsCompressor();
    this.master.connect(comp).connect(ctx.destination);

    // Brown noise: the raw material for road, wind, gravel and crash sounds.
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      d[i] = last * 3.5;
    }

    // Engine heard from inside the car: a muffled hum, not a buzz. Soft waveforms through a gentle lowpass.
    const eg = ctx.createGain();
    eg.gain.value = 0;
    const ef = ctx.createBiquadFilter();
    ef.type = 'lowpass';
    ef.Q.value = 0.7;
    const a = ctx.createOscillator();
    const b = ctx.createOscillator();
    a.type = 'triangle';
    b.type = 'sine';
    a.connect(ef);
    const bg = ctx.createGain();
    bg.gain.value = 0.6;
    b.connect(bg).connect(ef);
    ef.connect(eg).connect(this.master);
    a.start();
    b.start();
    this.engine = { a, b, filter: ef, gain: eg };

    this.road = this.loopNoise('lowpass', 400, 0);
    this.rumble = this.loopNoise('lowpass', 120, 0).gain;
    this.ambient = this.loopNoise('lowpass', 250, 0).gain;
    // Rain on the roof: a soft, high hiss.
    this.rain = this.loopNoise('highpass', 2500, 0).gain;

    // Siren: two slightly detuned voices, panned toward wherever the ambulance is.
    const sg = ctx.createGain();
    sg.gain.value = 0;
    const sf = ctx.createBiquadFilter();
    sf.type = 'lowpass';
    sf.frequency.value = 2200;
    const pan = typeof ctx.createStereoPanner === 'function' ? ctx.createStereoPanner() : null;
    const sa = ctx.createOscillator();
    const sb = ctx.createOscillator();
    sa.type = 'triangle';
    sb.type = 'sine';
    sb.detune.value = 12;
    sa.connect(sf);
    sb.connect(sf);
    sf.connect(sg);
    if (pan) sg.connect(pan).connect(this.master);
    else sg.connect(this.master);
    sa.start();
    sb.start();
    this.siren = { a: sa, b: sb, gain: sg, pan };
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    try {
      localStorage.setItem(STORE_KEY, on ? 'on' : 'off');
    } catch {
      /* storage blocked: the choice lasts for this visit */
    }
    if (on) this.unlock();
    if (this.ctx) this.master.gain.setTargetAtTime(on ? VOLUME : 0, this.ctx.currentTime, 0.05);
  }

  /** Called every frame with the simulation state. */
  update(sim: Simulation, paused: boolean, now: number, viewH: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const P = sim.player;
    const live = !paused && sim.state !== 'crashed';
    const v = live ? P.v : 0;
    const gas = live && sim.input.gas && sim.state !== 'done';
    const set = (p: AudioParam, val: number, tc = 0.08) => p.setTargetAtTime(val, t, tc);

    // Siren: wails up and down every three seconds, louder and more centred as it closes in.
    const ems = paused ? undefined : sim.ems();
    let duck = 1;
    if (ems) {
      const dx = ems.pose.x - P.pose.x;
      const dy = ems.pose.y - P.pose.y;
      const d = Math.hypot(dx, dy);
      const wail = 0.5 - 0.5 * Math.cos((now / 3000) * Math.PI * 2);
      set(this.siren.a.frequency, 700 + wail * 700, 0.03);
      set(this.siren.b.frequency, 700 + wail * 700, 0.03);
      set(this.siren.gain.gain, Math.min(0.08, 4 / Math.max(d, 1)), 0.1);
      // Positive pan is to the driver's right: bearing relative to the view heading.
      if (this.siren.pan) set(this.siren.pan.pan, Math.max(-0.9, Math.min(0.9, Math.sin(Math.atan2(dy, dx) - viewH))), 0.1);
      duck = 0.75;
    } else set(this.siren.gain.gain, 0, 0.15);

    // Engine: rpm rises through each gear and drops when it shifts up. Slow time constants keep it smooth.
    let lo = 0;
    let gear = GEARS.findIndex((top) => v < top);
    if (gear < 0) gear = GEARS.length - 1;
    if (gear > 0) lo = GEARS[gear - 1];
    const frac = Math.min(1, (v - lo) / (GEARS[gear] - lo));
    const rpm = 800 + frac * 2200 + (gas ? 300 : 0) + (gear === 0 ? 0 : 400);
    const f = rpm / 30; // firing frequency of a four-cylinder engine
    set(this.engine.a.frequency, f, 0.15);
    set(this.engine.b.frequency, f * 0.5, 0.15);
    set(this.engine.filter.frequency, 180 + rpm * (gas ? 0.12 : 0.07), 0.15);
    set(this.engine.gain.gain, live ? (gas ? 0.11 : 0.07) * duck : 0, 0.2);

    // Tyres and wind grow gently with speed.
    set(this.road.gain.gain, Math.min(0.22, v * 0.014) * duck, 0.3);
    set(this.road.filter.frequency, 300 + v * 35, 0.3);
    const offRoad = v > 0.5 && !onPavement(P.pose);
    set(this.rumble.gain, offRoad ? Math.min(0.5, 0.2 + v * 0.03) : 0, 0.05);

    // Distant traffic outside the closed windows, a little busier at rush hour.
    const busy = sim.traffic === 'rush' ? 0.05 : sim.traffic === 'moderate' ? 0.035 : 0.02;
    set(this.ambient.gain, paused ? 0 : busy, 0.8);

    // Rain and wipers: a soft thunk as the blade turns at each end of its sweep.
    const wet = sim.weather === 'rain';
    set(this.rain.gain, wet && !paused ? 0.035 : 0, 0.6);
    if (wet && !paused && now - this.lastWipe >= WIPER_MS / 2) {
      this.lastWipe = now;
      this.thunk();
    }

    // Blinker relay: a soft tick on, tock off, in step with the dashboard arrow.
    const blink = sim.signal && now % 800 < 440;
    if (sim.signal && blink !== this.lastBlink && !paused) this.click(blink ? 1100 : 850);
    this.lastBlink = blink;

    if (sim.state !== this.lastState) {
      if (sim.state === 'crashed') this.crash();
      this.lastState = sim.state;
    }
    // A circulating driver taps the horn when you cut them off.
    const y = !!sim.flags.yield;
    if (y && !this.yieldFlag) this.horn();
    this.yieldFlag = y;
  }

  /** Quiet chime for coaching messages, like a dashboard notification. */
  chime(kind: CoachKind): void {
    const ctx = this.ctx;
    if (!ctx || (kind !== 'good' && kind !== 'bad' && kind !== 'warn')) return;
    if (ctx.currentTime - this.lastChime < CHIME_GAP) return;
    this.lastChime = ctx.currentTime;
    const notes = kind === 'good' ? [660, 880] : kind === 'warn' ? [660] : [520, 440];
    notes.forEach((hz, i) => {
      const t = ctx.currentTime + i * 0.12;
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = hz;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.05, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
      o.connect(g).connect(this.master);
      o.start(t);
      o.stop(t + 0.45);
    });
  }

  private loopNoise(type: BiquadFilterType, freq: number, gain: number): { filter: BiquadFilterNode; gain: GainNode } {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(filter).connect(g).connect(this.master);
    src.start(0, Math.random() * 2);
    return { filter, gain: g };
  }

  private click(hz: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = hz;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.06, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.02);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.03);
  }

  private thunk(): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(70, t + 0.08);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.05, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.12);
  }

  private horn(): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + 0.15;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 1200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.06, t + 0.02);
    g.gain.setValueAtTime(0.06, t + 0.35);
    g.gain.linearRampToValueAtTime(0, t + 0.4);
    f.connect(g).connect(this.master);
    // Car horns are usually two notes about a third apart.
    for (const hz of [400, 500]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = hz;
      o.connect(f);
      o.start(t);
      o.stop(t + 0.45);
    }
  }

  private crash(): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(2000, t);
    f.frequency.exponentialRampToValueAtTime(150, t + 0.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.7, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + 0.8);
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(100, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.3);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.35, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    o.connect(og).connect(this.master);
    o.start(t);
    o.stop(t + 0.45);
  }
}
