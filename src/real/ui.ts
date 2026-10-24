/** Everything on the real-route page outside the 3D view: instruments, navigation, controls, coach and results. */
import { DEG, MPHF, TAU } from '../constants';
import type { CarAudio } from '../audio';
import type { CoachKind, RunResult } from '../sim';
import { SIGNS, signImg, type SignSpec } from '../signs';
import type { RealWorld } from './world';
import type { CardKey, RouteHooks, RouteSim } from './sim';

const el = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`Missing #${id}`);
  return e as T;
};
const SVG_NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag: string, attrs: Record<string, string | number>, parent?: Element): SVGElement => {
  const e = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  if (parent) parent.append(e);
  return e;
};
const LABEL: Record<CoachKind, string> = { good: 'Good', warn: 'Tip', bad: 'Violation', info: 'Mission', sign: 'Sign' };

/** Sign cards: the rule behind each control the route passes, and where the data comes from. */
const CARDS: Record<Exclude<CardKey, 'speed'>, { name: string; text: string; spec: () => SignSpec }> = {
  stop: {
    name: 'Stop sign',
    text: 'Come to a complete stop behind the line, or before the crosswalk if there is no line. Yield to people crossing and to cross traffic, then go.',
    spec: () => SIGNS.stopSign(),
  },
  signal: {
    name: 'Traffic signal',
    text: 'On red, stop behind the white line. Yellow means red is coming: stop if you safely can. Signal timing here is simulated; the signal locations are real.',
    spec: () => SIGNS.signalAhead(),
  },
  crosswalk: {
    name: 'Marked crosswalk',
    text: 'Massachusetts law requires you to stop for anyone in a crosswalk on your half of the road, or approaching it from the other half.',
    spec: () => SIGNS.pedWarn(),
  },
  rail: {
    name: 'Railroad crossing',
    text: 'Slow down, look and listen both ways. Only cross when you can clear the tracks completely, and never stop on them.',
    spec: () => SIGNS.crossbuck(),
  },
  bikebox: {
    name: 'Bike box',
    text: 'The green box ahead of the stop line is for cyclists. On red, stop behind it, not in it, and never turn right across it on red.',
    spec: () => SIGNS.plaque(['STOP HERE', 'ON RED'], '#FFFFFF', 0.9, 0.9),
  },
  bikes: {
    name: 'Bike lane on your right',
    text: 'Never drive or park in a bike lane. Before turning right, check your right mirror and over your right shoulder (hold E): cyclists going straight have priority.',
    spec: () => SIGNS.plaque(['BIKE', 'LANE'], '#FFFFFF', 0.9, 0.9),
  },
};

export class RouteUI implements RouteHooks {
  paused = false;
  private sim!: RouteSim;
  private world!: RealWorld;
  private audio!: CarAudio;
  private toastTimer = 0;
  private cardTimer = 0;
  private readonly mini = el<HTMLCanvasElement>('mini');
  private readonly mctx = this.mini.getContext('2d')!;

  attach(sim: RouteSim, world: RealWorld, audio: CarAudio): void {
    this.sim = sim;
    this.world = world;
    this.audio = audio;
    this.buildGauge();
    this.bindControls();
    this.renderRules();
    el('attribution').textContent = `Map data ${sim.route.data.attribution}.`;
  }

  /** The scoring table under the drive, for the current view's categories. */
  renderRules(): void {
    const rules = el('score-rules');
    rules.innerHTML = '';
    for (const c of this.sim.categories) rules.append(this.catRow(c.label, `${c.weight} pts`, 1, c.what));
  }

  restart(): void {
    this.sim.restart();
    this.world.applyLighting('day');
    this.world.resetView(this.sim.player.pose.h);
    el('result').hidden = true;
    el('card-pop').classList.remove('show');
    if (this.paused) this.setPause(false);
    el('prompt').hidden = false;
    el('prompt-sub').textContent = this.sim.photo
      ? 'The car follows the route. Gas/Brake for speed, Z / X to signal, hold Q / E to look before turns.'
      : 'Follow the NAV arrows. Z / X signal left / right, hold Q / E to check over your shoulder.';
  }

  /* ---------- hooks ---------- */

  coach(kind: CoachKind, title: string, body: string, quiet = false): void {
    const li = document.createElement('li');
    li.className = `msg ${kind}`;
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = LABEL[kind];
    const div = document.createElement('div');
    const st = document.createElement('strong');
    st.textContent = title;
    const p = document.createElement('p');
    p.textContent = body;
    div.append(st, p);
    li.append(tag, div);
    el('feed').prepend(li);
    if (quiet) return;
    this.audio.chime(kind);
    const toast = el('toast');
    toast.className = `toast show ${kind}`;
    toast.innerHTML = '';
    const b = document.createElement('b');
    b.textContent = title;
    toast.append(b, document.createTextNode(kind === 'info' ? 'Follow the NAV arrows to MIT Sloan.' : body.replace(/ \(.*\)$/, '').split('. ')[0] + '.'));
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => toast.classList.remove('show'), 4500);
  }

  card(key: CardKey, mph?: number): void {
    const c = key === 'speed'
      ? { name: `Speed limit ${mph}`, text: `The posted limit here is ${mph} mph (from OpenStreetMap). Cambridge set most city streets to 20 mph; some main roads are 25.`, spec: () => SIGNS.speed(mph ?? 25) }
      : CARDS[key];
    el<HTMLImageElement>('cp-img').src = signImg(`real-${key}-${mph ?? ''}`, c.spec());
    el('cp-name').textContent = c.name;
    el('cp-text').textContent = c.text;
    el('card-pop').classList.add('show');
    window.clearTimeout(this.cardTimer);
    this.cardTimer = window.setTimeout(() => el('card-pop').classList.remove('show'), 7000);
    this.coach('sign', c.name, c.text, true);
  }

  scoreChanged(score: number): void {
    el('score').textContent = String(score);
  }

  signalChanged(left: boolean, right: boolean): void {
    el('b-signal-l').setAttribute('aria-pressed', left ? 'true' : 'false');
    el('b-signal').setAttribute('aria-pressed', right ? 'true' : 'false');
  }

  driveStarted(): void {
    el('prompt').hidden = true;
  }

  result(r: RunResult): void {
    const sim = this.sim;
    el('result-card').className = `result-card ${r.pass ? 'pass' : 'fail-card'}`;
    el('r-title').textContent = r.title;
    el('r-score').textContent = `Score ${sim.score} / 100 · top speed ${Math.round(sim.topMph)} mph`;
    el('r-body').textContent = r.body;
    const cats = el('r-cats');
    cats.innerHTML = '';
    for (const c of sim.breakdown()) {
      cats.append(this.catRow(c.label, `${c.got}/${c.weight}`, c.got / c.weight, c.reached ? undefined : 'Not reached: the run ended first'));
    }
    this.renderDebrief();
    el('result').hidden = false;
  }

  /* ---------- per frame ---------- */

  update(now: number): void {
    const sim = this.sim;
    const P = sim.player;
    const mph = Math.round(P.v * MPHF);
    const limit = sim.speedLimit(P.s);
    const seg = sim.route.seg(P.s);
    el('g-mph').textContent = String(mph);
    el('g-mph').setAttribute('fill', mph > limit + 2 ? '#FF6B6B' : '#E8ECEF');
    el('g-zone').textContent = `LIMIT ${limit}`;
    el('needle').setAttribute('transform', `rotate(${(-120 + (Math.min(60, P.v * MPHF) / 60) * 240).toFixed(1)} 100 84)`);
    const blink = now % 800 < 440;
    el('ind-r').setAttribute('fill', sim.signal && blink ? '#3BE07A' : '#2A3B30');
    el('ind-l').setAttribute('fill', sim.signalLeft && blink ? '#3BE07A' : '#2A3B30');
    const look = el('look-tag');
    look.textContent = sim.input.lookRight ? 'Checking right ▸' : '◂ Checking left';
    look.classList.toggle('on', sim.input.look || sim.input.lookRight);
    el('wheel').style.transform = `rotate(${this.world.cam.steer.toFixed(1)}deg)`;

    el('zone').textContent = seg.name + (seg.ref ? ` (MA ${seg.ref.replace(/^MA /, '')})` : '');
    el('zone-sub').textContent = `${seg.oneway ? 'One way' : 'Two way'} · ${seg.lanes} lane${seg.lanes > 1 ? 's' : ''} your way${seg.bike ? ' · bike lane' : ''} · ${limit} mph`;
    const left = Math.max(0, sim.route.len - P.s);
    el('dc-time').textContent = `${(left / 1609).toFixed(1)} mi`;
    el('dc-sub').textContent = 'to MIT Sloan';
    const t = sim.nextTurn(P.s);
    const nav = el('nav-next');
    if (t) {
      const d = t.s - P.s;
      const word = t.dir === 'left' ? 'Turn left' : t.dir === 'right' ? 'Turn right' : t.dir === 'bear-left' ? 'Keep left' : 'Keep right';
      nav.textContent = `${word} onto ${t.onto}`;
      el('nav-dist').textContent = d > 300 ? `in ${(d / 1609).toFixed(1)} mi` : `in ${Math.round(d * 3.281 / 10) * 10} ft`;
      el('nav-arrow').textContent = t.dir.includes('left') ? '↰' : '↱';
    } else {
      nav.textContent = 'Continue to MIT Sloan';
      el('nav-dist').textContent = `${Math.round(left * 3.281 / 10) * 10} ft`;
      el('nav-arrow').textContent = '↑';
    }
    this.drawMini(t ? t.dir : null);
  }

  /** Heading-up nav screen: nearby streets, the route ahead, other traffic. */
  private drawMini(turn: string | null): void {
    const g = this.mctx;
    const sim = this.sim;
    const W = this.mini.width;
    const H = this.mini.height;
    const k = W / 160;
    const pp = sim.player.pose;
    const cy = H * 0.68;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#0F1A14';
    g.fillRect(0, 0, W, H);
    g.translate(W / 2, cy);
    g.rotate(-this.world.cam.h - Math.PI / 2);
    g.scale(k, k);
    g.translate(-pp.x, -pp.y);
    g.strokeStyle = '#3A4149';
    g.lineCap = 'round';
    for (const r of sim.route.data.roads) {
      const near = r.pts.some(([x, y]) => Math.abs(x - pp.x) < 160 && Math.abs(y - pp.y) < 160);
      if (!near) continue;
      g.lineWidth = r.w;
      g.beginPath();
      r.pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.stroke();
    }
    g.strokeStyle = '#4C535B';
    g.lineWidth = 10;
    g.beginPath();
    for (let s = Math.max(0, sim.player.s - 120), i = 0; s < Math.min(sim.route.len, sim.player.s + 300); s += 4, i++) {
      const q = sim.route.at(s);
      if (i) g.lineTo(q.x, q.y);
      else g.moveTo(q.x, q.y);
    }
    g.stroke();
    g.strokeStyle = '#3FA9F5';
    g.lineWidth = 3.2;
    g.beginPath();
    for (let s = sim.player.s, i = 0; s < Math.min(sim.route.len, sim.player.s + 300); s += 3, i++) {
      const q = sim.route.at(s);
      if (i) g.lineTo(q.x, q.y);
      else g.moveTo(q.x, q.y);
    }
    g.stroke();
    for (const c of sim.cars) {
      if (c.isPlayer) continue;
      g.fillStyle = c.braking ? '#FF6B5B' : '#E6E9EC';
      g.beginPath();
      g.arc(c.pose.x, c.pose.y, 2.2, 0, TAU);
      g.fill();
    }
    for (const p of sim.peds) {
      g.fillStyle = p.bike ? '#3FA9F5' : '#F2B705';
      g.beginPath();
      g.arc(p.x, p.y, 1.6, 0, TAU);
      g.fill();
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#FFFFFF';
    g.beginPath();
    g.moveTo(W / 2, cy - 10);
    g.lineTo(W / 2 + 7, cy + 7);
    g.lineTo(W / 2, cy + 3);
    g.lineTo(W / 2 - 7, cy + 7);
    g.closePath();
    g.fill();
    g.font = '700 15px Overpass, sans-serif';
    g.textAlign = 'right';
    g.fillStyle = '#AEB6BD';
    g.fillText(turn ? (turn.includes('left') ? '↰ ' : '↱ ') + el('nav-dist').textContent : 'MIT Sloan', W - 10, 20);
  }

  /* ---------- results ---------- */

  private catRow(label: string, pts: string, frac: number, what?: string): HTMLLIElement {
    const li = document.createElement('li');
    li.className = frac < 0.5 ? 'low' : frac < 0.85 ? 'mid' : '';
    const name = document.createElement('span');
    name.textContent = label;
    const b = document.createElement('b');
    b.textContent = pts;
    const bar = document.createElement('i');
    const fill = document.createElement('span');
    fill.style.width = `${Math.round(frac * 100)}%`;
    bar.append(fill);
    li.append(name, b, bar);
    if (what) {
      const sm = document.createElement('small');
      sm.textContent = what;
      li.append(sm);
    }
    return li;
  }

  /** The whole route, the line you drove, and a numbered dot at every rule break. */
  private renderDebrief(): void {
    const sim = this.sim;
    const map = el('r-map');
    map.innerHTML = '';
    const pts = sim.route.data.pts;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const pad = 60;
    const sc = 280 / Math.max(x1 - x0 + pad * 2, y1 - y0 + pad * 2);
    const tx = (x: number) => 10 + (x - x0 + pad) * sc;
    const ty = (y: number) => 10 + (y - y0 + pad) * sc;
    svgEl('rect', { x: 0, y: 0, width: 300, height: 300, fill: 'var(--map-land)' }, map);
    for (const r of sim.route.data.roads) {
      svgEl('path', { d: 'M' + r.pts.map(([x, y]) => `${tx(x).toFixed(1)} ${ty(y).toFixed(1)}`).join(' L'), fill: 'none', stroke: 'var(--map-road)', 'stroke-width': 2.5, 'stroke-linecap': 'round' }, map);
    }
    const line = (p: { x: number; y: number }[], stroke: string, w: number) =>
      svgEl('path', { d: 'M' + p.map((q) => `${tx(q.x).toFixed(1)} ${ty(q.y).toFixed(1)}`).join(' L'), fill: 'none', stroke, 'stroke-width': w, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, map);
    line(pts.filter((_, i) => i % 5 === 0).map(([x, y]) => ({ x, y })), 'var(--map-casing)', 6);
    if (sim.trail.length > 1) line(sim.trail, 'var(--route)', 3.5);
    const list = el('r-marks');
    list.innerHTML = '';
    sim.marks.forEach((m, i) => {
      svgEl('circle', { cx: tx(m.x), cy: ty(m.y), r: 8, fill: 'var(--yield)', stroke: 'var(--surface)', 'stroke-width': 2 }, map);
      const n = svgEl('text', { x: tx(m.x), y: ty(m.y) + 3.5, 'text-anchor': 'middle', 'font-size': 10, 'font-weight': 900 }, map);
      n.textContent = String(i + 1);
      n.style.fill = 'var(--sign-white)';
      const li = document.createElement('li');
      li.textContent = m.title;
      list.append(li);
    });
    if (!sim.marks.length) {
      const li = document.createElement('li');
      li.className = 'clean';
      li.textContent = 'No mistakes: clean drive';
      list.append(li);
    }
  }

  /* ---------- controls ---------- */

  private buildGauge(): void {
    const g = el('ticks');
    for (let m = 0; m <= 60; m += 5) {
      const a = (-120 + (m / 60) * 240 - 90) * DEG;
      const major = m % 10 === 0;
      const r0 = major ? 46 : 50;
      svgEl('line', {
        x1: 100 + Math.cos(a) * r0, y1: 84 + Math.sin(a) * r0, x2: 100 + Math.cos(a) * 56, y2: 84 + Math.sin(a) * 56,
        stroke: m === 20 || m === 25 ? '#F2B705' : '#8B949C', 'stroke-width': major ? 2.4 : 1.2,
      }, g);
      if (major) {
        const t = svgEl('text', { x: 100 + Math.cos(a) * 37, y: 84 + Math.sin(a) * 37 + 3.5, 'text-anchor': 'middle', 'font-size': 9, fill: '#AEB6BD', 'font-family': 'Overpass Mono, monospace' }, g);
        t.textContent = String(m);
      }
    }
  }

  setPause(on: boolean): void {
    this.paused = on;
    const b = el('b-pause');
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.textContent = on ? 'Resume' : 'Pause';
  }

  private renderSound(): void {
    const b = el('b-sound');
    b.setAttribute('aria-pressed', this.audio.enabled ? 'true' : 'false');
    b.textContent = this.audio.enabled ? 'Sound on' : 'Sound off';
  }

  private bindControls(): void {
    const input = this.sim.input;
    const hold = (btn: HTMLElement, key: keyof typeof input) => {
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        input[key] = true;
        btn.classList.add('on');
        try { btn.setPointerCapture(e.pointerId); } catch { /* not supported */ }
      });
      const off = () => { input[key] = false; btn.classList.remove('on'); };
      for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) btn.addEventListener(ev, off);
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
    };
    hold(el('b-gas'), 'gas');
    hold(el('b-brake'), 'brake');
    hold(el('b-look'), 'look');
    hold(el('b-look-r'), 'lookRight');
    hold(el('b-left'), 'left');
    hold(el('b-right'), 'right');
    el('b-signal').addEventListener('click', () => this.sim.setSignal(!this.sim.signal));
    el('b-signal-l').addEventListener('click', () => this.sim.setSignalLeft(!this.sim.signalLeft));
    el('b-restart').addEventListener('click', () => this.restart());
    el('r-again').addEventListener('click', () => this.restart());
    el('b-pause').addEventListener('click', () => this.setPause(!this.paused));
    el('b-sound').addEventListener('click', () => { this.audio.setEnabled(!this.audio.enabled); this.renderSound(); });
    this.renderSound();

    const KEYS: Record<keyof typeof input, string[]> = {
      gas: ['ArrowUp', 'w', 'W'],
      brake: ['ArrowDown', 's', 'S', ' '],
      look: ['q', 'Q'],
      lookRight: ['e', 'E'],
      left: ['ArrowLeft', 'a', 'A'],
      right: ['ArrowRight', 'd', 'D'],
    };
    window.addEventListener('keydown', (e) => {
      for (const k of Object.keys(KEYS) as (keyof typeof input)[]) {
        if (KEYS[k].includes(e.key)) { input[k] = true; e.preventDefault(); return; }
      }
      if (e.repeat) return;
      if (e.key === 'z' || e.key === 'Z') this.sim.setSignalLeft(!this.sim.signalLeft);
      else if (e.key === 'x' || e.key === 'X') this.sim.setSignal(!this.sim.signal);
      else if (e.key === 'r' || e.key === 'R') this.restart();
      else if (e.key === 'p' || e.key === 'P') this.setPause(!this.paused);
      else if (e.key === 'm' || e.key === 'M') { this.audio.setEnabled(!this.audio.enabled); this.renderSound(); }
    });
    window.addEventListener('keyup', (e) => {
      for (const k of Object.keys(KEYS) as (keyof typeof input)[]) if (KEYS[k].includes(e.key)) input[k] = false;
    });
    window.addEventListener('blur', () => { for (const k of Object.keys(KEYS) as (keyof typeof input)[]) input[k] = false; });
  }
}
