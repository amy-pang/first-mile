/** Everything on the page outside the 3D view: controls, cabin instruments, route map, trip times, coach feed and the guide. */
import { DEG, DEND, DS, DY, MPHF, ORD, RC, RH, R_IN, ROADS, RW, TAU, type Road } from './constants';
import { bikeMultiplierAt } from './bike-density';
import { CRASH_STATS } from './crash-stats';
import { roadPt } from './math';
import { poseAt } from './path';
import type { CarAudio } from './audio';
import { CATEGORIES, type CoachKind, type RunResult, type SignEventKey, type SimHooks, type Simulation } from './sim';
import { diagramRule, GUIDE_ORDER, SIGN_INFO, SIGNS, signImg } from './signs';
import { conditionsFor, fmtT, parseT, PHASE_LABEL, TRAFFIC_LABEL, WEATHER_LABEL, type Weather } from './trip';
import type { World } from './world';

interface CrashGrid {
  grid: number;
  latMin: number; latMax: number;
  lonMin: number; lonMax: number;
  all: number[];
  cyclist: number[];
  pedestrian: number[];
}

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

/**
 * World point to route-map point. The map isn't to scale: the ring is drawn larger (radius 44 for RC)
 * and the approach roads are squeezed, with the yield line at about 58 and the road starts at about 150.
 */
const toMap = (p: { x: number; y: number }): { x: number; y: number } => {
  const r = Math.hypot(p.x, p.y);
  if (r < 1e-6) return { x: 150, y: 150 };
  const k = 44 / RC;
  const m = r <= DY ? r * k : DY * k + ((r - DY) * (150 - DY * k)) / (DS - DY);
  return { x: 150 + (p.x / r) * m, y: 150 + (p.y / r) * m };
};

const LABEL: Record<CoachKind, string> = { good: 'Good', warn: 'Tip', bad: 'Violation', info: 'Mission', sign: 'Sign' };

export class UI implements SimHooks {
  private sim!: Simulation;
  private world!: World;
  private audio!: CarAudio;

  paused = false;
  private planStart = 0;
  private planDest = 2;
  private pickMode: 'start' | 'dest' = 'dest';
  private toastTimer = 0;
  private cardQueue: SignEventKey[] = [];
  private cardT = 99;
  private cardShown = false;
  private readonly guideImgs = new Map<string, HTMLImageElement>();
  private readonly mini = el<HTMLCanvasElement>('mini');
  private readonly mctx = this.mini.getContext('2d')!;
  private crashGrid: CrashGrid | null = null;
  private mapLayer: 'all' | 'cyclist' | 'pedestrian' = 'all';

  constructor() {
    this.buildGuide();
    const rules = el('score-rules');
    for (const c of CATEGORIES) rules.append(this.catRow(c.label, `${c.weight} pts`, 1, c.what));
  }

  attach(sim: Simulation, world: World, audio: CarAudio): void {
    this.sim = sim;
    this.world = world;
    this.audio = audio;
    this.planDest = sim.destIdx;
    this.buildGauge();
    this.bindControls();
    this.bindPlanner();
    this.buildCrashStats();
    this.bindMapLayerToggles();
  }

  /** Read the planned route and times, then start a fresh run. */
  restart(): void {
    const t = this.readPlanTimes();
    const sim = this.sim;
    sim.restart({
      start: sim.startIdx,
      dest: sim.destIdx,
      leave: t.ok ? t.l! : sim.trip.leave,
      arrive: t.ok ? t.a! : sim.trip.arrive,
      weather: this.planWeather(),
      ems: el<HTMLInputElement>('t-ems').checked,
    });
    this.world.applyLighting(sim.trip.phase, sim.weather);
    el('wipers').hidden = sim.weather !== 'rain';
    this.world.resetView(sim.player.pose.h);
    this.cardQueue = [];
    this.cardShown = false;
    el('card-pop').classList.remove('show');

    const R = ROADS[sim.destIdx];
    el('g-exit').textContent = `EXIT ${sim.exitNum}`;
    const sh = el('g-shield');
    sh.textContent = R.route;
    sh.className = 'shield' + (R.us ? ' us' : '');
    el('g-town').textContent = R.town;
    el('g-sub').textContent = `${ORD[sim.exitNum - 1]} exit after you enter from ${ROADS[sim.startIdx].town}${R.dir ? ` · Route ${R.route} ${R.dir.toLowerCase()}` : ''}`;
    el('trip-target').textContent = fmtT(sim.trip.arrive);
    this.exitsChanged();
    this.renderMap();
    el('result').hidden = true;
    if (this.paused) this.setPause(false);
    this.setPrompt('Hold Gas or ↑ to drive', 'Steer with ← →. Hold Q to look left, E to signal');
    el('prompt').hidden = false;
  }

  /* ---------- SimHooks ---------- */

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
    toast.append(b);
    const line = kind === 'info'
      ? `Follow the signs for ${ROADS[this.sim.destIdx].town}.`
      : body.replace(/ \(−\d+\)$/, '').split('. ')[0] + '.';
    toast.append(document.createTextNode(line));
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => toast.classList.remove('show'), 4500);
  }

  sign(key: SignEventKey): void {
    this.cardQueue.push(key);
  }

  exitsChanged(): void {
    const ol = el('exits');
    ol.innerHTML = '';
    for (let k = 1; k <= 3; k++) {
      const R = ROADS[(this.sim.startIdx + k) % 4];
      const li = document.createElement('li');
      if (k === this.sim.exitNum) li.className = 'target';
      else if (k <= this.sim.passedCount) li.className = 'passed';
      const b = document.createElement('b');
      b.textContent = `EXIT ${k}`;
      li.append(b, this.shieldEl(R, true), document.createTextNode(R.town));
      ol.append(li);
    }
  }

  signalChanged(on: boolean): void {
    el('b-signal').setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  lightsChanged(on: boolean): void {
    el('b-lights').setAttribute('aria-pressed', on ? 'true' : 'false');
    el('ind-lights').setAttribute('fill', on ? '#3FA9F5' : '#2A3B30');
    el('ind-lights').setAttribute('stroke', on ? '#3FA9F5' : '#2A3B30');
    this.world.setHeadlights(on);
  }

  scoreChanged(score: number): void {
    el('score').textContent = String(score);
  }

  driveStarted(): void {
    el('prompt').hidden = true;
  }

  result(r: RunResult): void {
    el('result-card').className = `result-card ${r.pass ? 'pass' : 'fail-card'}`;
    el('r-title').textContent = r.title;
    el('r-score').textContent = `Score ${this.sim.score} / 100 · top speed ${Math.round(this.sim.topMph)} mph`;
    const cats = el('r-cats');
    cats.innerHTML = '';
    for (const c of this.sim.breakdown()) cats.append(this.catRow(c.label, `${c.got}/${c.weight}`, c.got / c.weight));
    el('r-body').textContent = r.body;
    this.renderDebrief();
    el('result').hidden = false;
  }

  /** One category row: name, points and a bar. */
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

  /** Post-run map: the line you drove, with a numbered dot wherever a rule was broken. */
  private renderDebrief(): void {
    const sim = this.sim;
    const map = el('r-map');
    map.innerHTML = '';
    this.drawMapBase(map);
    const at = (p: { x: number; y: number }) => {
      const q = toMap(p);
      return `${q.x.toFixed(1)} ${q.y.toFixed(1)}`;
    };
    // Only the part that fits on the 300-unit map; the far ends of the roads run off its edges.
    const pts = sim.trail.filter((p) => Math.hypot(p.x, p.y) < 210);
    if (pts.length > 1) {
      svgEl('path', {
        d: 'M' + pts.map(at).join(' L'), fill: 'none', stroke: 'var(--route)', 'stroke-width': 4,
        'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      }, map);
    }
    const list = el('r-marks');
    list.innerHTML = '';
    sim.marks.forEach((m, i) => {
      const q = toMap(m);
      const x = Math.max(10, Math.min(290, q.x));
      const y = Math.max(10, Math.min(290, q.y));
      svgEl('circle', { cx: x, cy: y, r: 10, fill: 'var(--yield)', stroke: 'var(--surface)', 'stroke-width': 2 }, map);
      const n = svgEl('text', { x, y: y + 4, 'text-anchor': 'middle', 'font-size': 11, 'font-weight': 900 }, map);
      n.textContent = String(i + 1);
      n.style.fill = 'var(--sign-white)';
      const li = document.createElement('li');
      li.textContent = m.title;
      list.append(li);
    });
    if (!sim.marks.length) {
      const li = document.createElement('li');
      li.className = 'clean';
      li.textContent = 'No mistakes: clean run';
      list.append(li);
    }
  }

  /* ---------- per-frame ---------- */

  update(dt: number, now: number): void {
    if (!this.paused) this.updateCards(dt);
    this.updateHud(now);
    this.drawMini();
    el('wheel').style.transform = `rotate(${this.world.cam.steer.toFixed(1)}deg)`;
  }

  private updateCards(dt: number): void {
    this.cardT += dt;
    const next = this.cardQueue[0];
    if (next && (!this.cardShown || this.cardT > 3.5)) {
      this.cardQueue.shift();
      this.showCard(next);
    } else if (this.cardShown && this.cardT > 7) {
      el('card-pop').classList.remove('show');
      this.cardShown = false;
    }
  }

  private showCard(key: SignEventKey): void {
    let name: string;
    let txt: string;
    let src: string;
    const sim = this.sim;
    if (key === 'exit') {
      const R = ROADS[sim.destIdx];
      name = `Exit sign: Route ${R.route} ${R.dir ? R.dir.toLowerCase() + ' ' : ''}to ${R.town}`;
      txt = 'This is your exit. Turn on your right signal now and leave at the next opening.';
      src = signImg(`exit${sim.destIdx}`, SIGNS.exitGuide(R));
    } else if (key === 'diagram') {
      name = SIGN_INFO.diagram.name;
      txt = diagramRule(sim.startIdx);
      src = signImg(`diagram${sim.startIdx}`, SIGNS.diagram(sim.startIdx));
    } else {
      const s = SIGN_INFO[key];
      name = s.name;
      txt = s.rule;
      src = signImg(key, s.spec());
    }
    el<HTMLImageElement>('cp-img').src = src;
    el('cp-name').textContent = name;
    el('cp-text').textContent = txt;
    el('card-pop').classList.add('show');
    this.cardShown = true;
    this.cardT = 0;
    this.coach('sign', name, txt, true);
  }

  private updateHud(now: number): void {
    const sim = this.sim;
    const P = sim.player;
    const mph = Math.round(P.v * MPHF);
    const zone = sim.zone();
    const zoneName = zone === 'approach' ? 'Approach' : zone === 'rotary' ? 'In the rotary' : 'Leaving';
    el('g-mph').textContent = String(mph);
    el('g-zone').textContent = zone === 'rotary' ? 'ADVISORY 20' : 'LIMIT 25';
    el('g-mph').setAttribute('fill', mph > (zone === 'rotary' ? 22 : 27) ? '#FF6B6B' : '#E8ECEF');
    el('needle').setAttribute('transform', `rotate(${(-120 + (Math.min(60, P.v * MPHF) / 60) * 240).toFixed(1)} 100 84)`);
    el('zone').textContent = zoneName;
    el('zone-sub').textContent = zone === 'rotary' ? 'Advisory 20 mph' : 'Limit 25 mph';
    el('ind-r').setAttribute('fill', sim.signal && now % 800 < 440 ? '#3BE07A' : '#2A3B30');
    el('look-tag').classList.toggle('on', sim.input.look);

    const t = sim.tripNow();
    const left = Math.round(sim.trip.arrive - t);
    const clk = el('trip-clock');
    const st = el('trip-status');
    clk.textContent = fmtT(t);
    clk.className = left < 0 ? 'late' : '';
    if (sim.state === 'ready') { st.textContent = 'Not started'; st.className = ''; }
    else if (sim.state === 'crashed') { st.textContent = 'Stopped'; st.className = 'late'; }
    else if (sim.state === 'done') { st.textContent = left >= 0 ? 'On time' : `${-left} min late`; st.className = left >= 0 ? 'ontime' : 'late'; }
    else { st.textContent = left >= 0 ? `${left} min left` : `${-left} min late`; st.className = left >= 0 ? '' : 'late'; }
    el('dc-time').textContent = fmtT(t);
    el('dc-sub').textContent = sim.state === 'ready'
      ? `Arrive by ${fmtT(sim.trip.arrive)}`
      : left >= 0 ? `${left} min to ${fmtT(sim.trip.arrive)}` : `${-left} min late`;
    el('dash-clock').classList.toggle('late', left < 0);
  }

  /** Heading-up nav screen on the centre console. */
  private drawMini(): void {
    const g = this.mctx;
    const sim = this.sim;
    const W = this.mini.width;
    const H = this.mini.height;
    const k = W / 110;
    const pp = sim.player.pose;
    const cy = H * 0.66;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#0F1A14';
    g.fillRect(0, 0, W, H);
    g.translate(W / 2, cy);
    g.rotate(-this.world.cam.h - Math.PI / 2);
    g.scale(k, k);
    g.translate(-pp.x, -pp.y);
    g.strokeStyle = '#4C535B';
    g.lineWidth = RW * 2;
    for (const r of ROADS) {
      const a = roadPt(r.phi, R_IN + 4, 0);
      const b = roadPt(r.phi, DEND + 40, 0);
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.stroke();
    }
    g.beginPath();
    g.arc(0, 0, RC, 0, TAU);
    g.lineWidth = RH * 2;
    g.stroke();
    g.fillStyle = '#2E4A33';
    g.beginPath();
    g.arc(0, 0, R_IN, 0, TAU);
    g.fill();
    if (sim.state === 'ready' || sim.state === 'driving') {
      const pth = sim.player.path;
      g.strokeStyle = '#3FA9F5';
      g.lineWidth = 2.2;
      g.beginPath();
      for (let s = sim.player.s, i = 0; s < Math.min(pth.len, pth.sOff + 40); s += 2, i++) {
        const q = poseAt(pth, s);
        if (i) g.lineTo(q.x, q.y);
        else g.moveTo(q.x, q.y);
      }
      g.stroke();
    }
    const flash = Math.floor(performance.now() / 250) % 2 === 0;
    for (const c of sim.cars) {
      if (c.isPlayer) continue;
      g.fillStyle = c.ems ? (flash ? '#FF3B3B' : '#3B7BFF') : c.braking ? '#FF6B5B' : '#E6E9EC';
      g.beginPath();
      g.arc(c.pose.x, c.pose.y, c.ems ? 2.4 : 1.6, 0, TAU);
      g.fill();
    }
    g.fillStyle = '#F2B705';
    for (const p of sim.peds) {
      g.beginPath();
      g.arc(p.x, p.y, 1.1, 0, TAU);
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
    if (sim.state === 'driving' || sim.state === 'ready') g.fillText(`Exit ${sim.exitNum} · ${ROADS[sim.destIdx].town}`, W - 10, 20);
  }

  /* ---------- controls ---------- */

  private setPrompt(title: string, sub: string): void {
    el('prompt-title').textContent = title;
    el('prompt-sub').textContent = sub;
  }

  setPause(on: boolean): void {
    this.paused = on;
    const b = el('b-pause');
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.textContent = on ? 'Resume' : 'Pause';
    if (on) {
      this.setPrompt('Paused', 'Press P or Resume to keep driving');
      el('prompt').hidden = false;
    } else if (this.sim.state === 'ready') {
      this.setPrompt('Hold Gas or ↑ to drive', 'Steer with ← →. Hold Q to look left, E to signal');
    } else {
      el('prompt').hidden = true;
    }
  }

  private setSound(on: boolean): void {
    this.audio.setEnabled(on);
    this.renderSound();
  }

  private renderSound(): void {
    const on = this.audio.enabled;
    const b = el('b-sound');
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.textContent = on ? 'Sound on' : 'Sound off';
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
    hold(el('b-left'), 'left');
    hold(el('b-right'), 'right');
    el('b-signal').addEventListener('click', () => this.sim.setSignal(!this.sim.signal));
    el('b-lights').addEventListener('click', () => this.sim.setHeadlights(!this.sim.headlights));
    el('b-restart').addEventListener('click', () => this.restart());
    el('b-pause').addEventListener('click', () => this.setPause(!this.paused));
    el('b-sound').addEventListener('click', () => this.setSound(!this.audio.enabled));
    this.renderSound();
    el('r-again').addEventListener('click', () => this.restart());

    const KEYS: Record<keyof typeof input, string[]> = {
      gas: ['ArrowUp', 'w', 'W'],
      brake: ['ArrowDown', 's', 'S', ' '],
      look: ['q', 'Q'],
      left: ['ArrowLeft', 'a', 'A'],
      right: ['ArrowRight', 'd', 'D'],
    };
    const SIG = ['e', 'E'];
    const typing = (e: KeyboardEvent) => e.target instanceof HTMLInputElement;
    window.addEventListener('keydown', (e) => {
      if (typing(e)) return;
      for (const k of Object.keys(KEYS) as (keyof typeof input)[]) {
        if (KEYS[k].includes(e.key)) { input[k] = true; e.preventDefault(); return; }
      }
      if (SIG.includes(e.key)) { if (!e.repeat) this.sim.setSignal(!this.sim.signal); e.preventDefault(); }
      else if (e.key === 'r' || e.key === 'R') this.restart();
      else if ((e.key === 'p' || e.key === 'P') && !e.repeat) this.setPause(!this.paused);
      else if ((e.key === 'm' || e.key === 'M') && !e.repeat) this.setSound(!this.audio.enabled);
      else if ((e.key === 'l' || e.key === 'L') && !e.repeat) this.sim.setHeadlights(!this.sim.headlights);
    });
    window.addEventListener('keyup', (e) => {
      for (const k of Object.keys(KEYS) as (keyof typeof input)[]) if (KEYS[k].includes(e.key)) input[k] = false;
    });
    window.addEventListener('blur', () => { input.gas = input.brake = input.look = input.left = input.right = false; });
  }

  /* ---------- route map and trip times ---------- */

  private planWeather(): Weather {
    return el<HTMLSelectElement>('t-weather').value === 'rain' ? 'rain' : 'clear';
  }

  private readPlanTimes(): { l: number | null; a: number | null; ok: boolean } {
    const l = parseT(el<HTMLInputElement>('t-leave').value);
    const a = parseT(el<HTMLInputElement>('t-arrive').value);
    return { l, a, ok: l !== null && a !== null && a > l };
  }

  private bindPlanner(): void {
    el('pick-start').addEventListener('click', () => this.setPickMode('start'));
    el('pick-dest').addEventListener('click', () => this.setPickMode('dest'));
    el('t-leave').addEventListener('input', () => this.renderConditions());
    el('t-arrive').addEventListener('input', () => this.renderConditions());
    el('t-weather').addEventListener('change', () => this.renderConditions());
    el('t-ems').addEventListener('change', () => this.renderConditions());
    el('b-drive').addEventListener('click', () => {
      if (!this.readPlanTimes().ok) {
        this.renderConditions();
        el('t-arrive').focus();
        return;
      }
      this.sim.startIdx = this.planStart;
      this.sim.destIdx = this.planDest;
      this.restart();
    });
    el('b-surprise').addEventListener('click', () => {
      this.planStart = Math.floor(Math.random() * 4);
      this.planDest = (this.planStart + 1 + Math.floor(Math.random() * 3)) % 4;
      el<HTMLSelectElement>('t-weather').value = Math.random() < 0.3 ? 'rain' : 'clear';
      el<HTMLInputElement>('t-ems').checked = Math.random() < 0.4;
      this.sim.startIdx = this.planStart;
      this.sim.destIdx = this.planDest;
      this.restart();
    });
  }

  private setPickMode(m: 'start' | 'dest'): void {
    this.pickMode = m;
    el('pick-start').setAttribute('aria-pressed', m === 'start' ? 'true' : 'false');
    el('pick-dest').setAttribute('aria-pressed', m === 'dest' ? 'true' : 'false');
  }

  private pick(i: number): void {
    if (this.pickMode === 'start') {
      this.planStart = i;
      if (this.planDest === i) this.planDest = (i + 2) % 4;
      this.setPickMode('dest');
    } else if (i === this.planStart) {
      el('route-line').textContent = 'Your destination has to be a different road from your start. Pick another road.';
      return;
    } else {
      this.planDest = i;
    }
    this.renderMap();
  }

  private renderConditions(): void {
    const { l, a, ok } = this.readPlanTimes();
    const err = el('time-err');
    const host = el('cond');
    host.innerHTML = '';
    if (!ok) {
      err.hidden = false;
      err.textContent = l === null || a === null ? 'Enter both times.' : 'Your arrival time needs to be after your departure time.';
    } else err.hidden = true;
    if (l === null) return;
    const c = conditionsFor(l);
    const chip = (t: string, cls = '') => {
      const s = document.createElement('span');
      s.className = `chip ${cls}`.trim();
      s.textContent = t;
      host.append(s);
    };
    chip(TRAFFIC_LABEL[c.traffic], c.traffic);
    chip(PHASE_LABEL[c.phase]);
    const w = this.planWeather();
    if (w === 'rain') chip(WEATHER_LABEL[w]);
    const ems = el<HTMLInputElement>('t-ems').checked;
    if (ems) chip('Ambulance on the way');
    if (ok && a !== null) chip(`${a - l} min to get there`);
    const mult = bikeMultiplierAt(l);
    if (mult > 2.5) chip(`~${mult.toFixed(1)}× typical cyclist activity`, 'warn');
    else if (mult < 0.3) chip('Low cyclist activity at this hour');
    const sim = this.sim;
    const pending = this.planStart !== sim.startIdx || this.planDest !== sim.destIdx || l !== sim.trip.leave || a !== sim.trip.arrive
      || w !== sim.weather || ems !== sim.emsPlanned;
    el('b-drive').dataset.pending = String(pending);
  }

  private renderMap(): void {
    const map = el('map');
    map.innerHTML = '';
    const mp = (phi: number, d: number, o: number) => {
      const p = roadPt(phi, d, o);
      return { x: 150 + p.x, y: 150 + p.y };
    };
    const mr = (t: number, r: number) => ({ x: 150 + Math.cos(t) * r, y: 150 + Math.sin(t) * r });

    const defs = svgEl('defs', {}, map);
    const mk = svgEl('marker', { id: 'arw', viewBox: '0 0 10 10', refX: 5, refY: 5, markerWidth: 4, markerHeight: 4, orient: 'auto' }, defs);
    svgEl('path', { d: 'M0 0 L10 5 L0 10 z', fill: 'var(--route)' }, mk);
    this.drawMapBase(map);

    // Planned route: in on the right-hand lane, counterclockwise round, out on the right-hand lane.
    const ps = ROADS[this.planStart].phi;
    const pd = ROADS[this.planDest].phi;
    const pts: { x: number; y: number }[] = [];
    for (let dd = 150; dd >= 58; dd -= 8) pts.push(mp(ps, dd, -5));
    const ta = ps - 0.38;
    let tb = pd + 0.38;
    while (tb >= ta) tb -= TAU;
    for (let k = 0; k <= 28; k++) pts.push(mr(ta - ((ta - tb) * k) / 28, 44));
    for (let dd = 58; dd <= 138; dd += 8) pts.push(mp(pd, dd, 5));
    svgEl('path', {
      d: 'M' + pts.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' L'),
      fill: 'none', stroke: 'var(--route)', 'stroke-width': 4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'marker-end': 'url(#arw)',
    }, map);

    ROADS.forEach((r, i) => {
      const a = mp(r.phi, 50, 0);
      const b = mp(r.phi, 150, 0);
      svgEl('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'road-hit' }, map).addEventListener('click', () => this.pick(i));
    });
    ROADS.forEach((r, i) => {
      const c = mp(r.phi, 106, 0);
      const w = Math.round(r.town.length * 6.6 + 38);
      const isS = i === this.planStart;
      const isD = i === this.planDest;
      const g = svgEl('g', {
        class: `pill${isS ? ' start' : ''}${isD ? ' dest' : ''}`,
        transform: `translate(${c.x.toFixed(1)} ${c.y.toFixed(1)})`,
        tabindex: 0,
        role: 'button',
        'aria-label': `${r.town}, Route ${r.route}${isS ? ', your start' : ''}${isD ? ', your destination' : ''}`,
      }, map);
      svgEl('rect', { class: 'bg', x: -w / 2, y: -12, width: w, height: 24, rx: 12 }, g);
      if (r.us) svgEl('path', { d: `M${-w / 2 + 7} -8 h16 v7 q0 7 -8 10 q-8 -3 -8 -10 z`, fill: 'var(--sign-ink)' }, g);
      else svgEl('rect', { x: -w / 2 + 7, y: -8, width: 16, height: 16, rx: 2, fill: 'var(--sign-white)', stroke: 'var(--sign-ink)', 'stroke-width': 1.6 }, g);
      const st = svgEl('text', { x: -w / 2 + 15, y: 3, 'text-anchor': 'middle', 'font-size': r.route.length > 1 ? 7.5 : 9, 'font-weight': 900 }, g);
      st.textContent = r.route;
      st.style.fill = r.us ? 'var(--sign-white)' : 'var(--sign-ink)';
      const tt = svgEl('text', { x: -w / 2 + 28, y: 4, 'font-size': 11, 'font-weight': 700 }, g);
      tt.textContent = r.town;
      if (isS || isD) {
        const tag = svgEl('text', { x: 0, y: -16, 'text-anchor': 'middle', class: 'tagtxt' }, g);
        tag.textContent = isS ? 'START' : 'DESTINATION';
        tag.style.fill = isS ? 'var(--ok)' : 'var(--route)';
      }
      g.addEventListener('click', () => this.pick(i));
      g.addEventListener('keydown', (e) => {
        const ke = e as KeyboardEvent;
        if (ke.key === 'Enter' || ke.key === ' ') {
          ke.preventDefault();
          ke.stopPropagation();
          this.pick(i);
        }
      });
    });

    const S = ROADS[this.planStart];
    const D = ROADS[this.planDest];
    const n = (this.planDest - this.planStart + 4) % 4;
    const line = el('route-line');
    line.innerHTML = '';
    const b1 = document.createElement('b');
    b1.textContent = S.town;
    const b2 = document.createElement('b');
    b2.textContent = D.town;
    line.append(b1, document.createTextNode(' → '), b2,
      document.createTextNode(`: enter from ${S.town}, take the ${ORD[n - 1]} exit (Route ${D.route}${D.dir ? ` ${D.dir.toLowerCase()}` : ''}).`));
    this.renderConditions();
  }

  /** Land, blocks, roads and the centre island, shared by the route map and the debrief map. */
  private drawMapBase(map: Element): void {
    const mp = (phi: number, d: number, o: number) => {
      const p = roadPt(phi, d, o);
      return { x: 150 + p.x, y: 150 + p.y };
    };
    svgEl('rect', { x: 0, y: 0, width: 300, height: 300, fill: 'var(--map-land)' }, map);
    for (let x = 4; x < 300; x += 26) {
      for (let y = 4; y < 300; y += 26) {
        const cx = x + 11;
        const cy = y + 11;
        if (Math.abs(cx - 150) < 24 || Math.abs(cy - 150) < 24 || Math.hypot(cx - 150, cy - 150) < 70) continue;
        const park = (x * 7 + y * 3) % 9 === 0;
        svgEl('rect', { x, y, width: 22, height: 22, rx: 3, fill: park ? 'var(--map-park)' : 'var(--map-block)' }, map);
      }
    }
    const roadLine = (stroke: string, width: number) => {
      for (const r of ROADS) {
        const a = mp(r.phi, 40, 0);
        const b = mp(r.phi, 160, 0);
        svgEl('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke, 'stroke-width': width }, map);
      }
      svgEl('circle', { cx: 150, cy: 150, r: 44, fill: 'none', stroke, 'stroke-width': width }, map);
    };
    roadLine('var(--map-casing)', 22);
    roadLine('var(--map-road)', 18);
    svgEl('circle', { cx: 150, cy: 150, r: 34, fill: 'var(--map-park)' }, map);
  }

  /* ---------- static pieces ---------- */

  private shieldEl(r: Road, small: boolean): HTMLSpanElement {
    const s = document.createElement('span');
    s.className = `shield${small ? ' sm' : ''}${r.us ? ' us' : ''}`;
    s.textContent = r.route;
    return s;
  }

  private buildGauge(): void {
    const g = document.getElementById('ticks');
    if (!g) return;
    for (let m = 0; m <= 60; m += 5) {
      const a = (-120 + (m / 60) * 240 - 90) * DEG;
      const major = m % 10 === 0;
      const r0 = major ? 46 : 50;
      svgEl('line', {
        x1: 100 + Math.cos(a) * r0, y1: 84 + Math.sin(a) * r0, x2: 100 + Math.cos(a) * 56, y2: 84 + Math.sin(a) * 56,
        stroke: m === 25 ? '#F2B705' : '#8B949C', 'stroke-width': major ? 2.4 : 1.2,
      }, g);
      if (major) {
        const t = svgEl('text', {
          x: 100 + Math.cos(a) * 37, y: 84 + Math.sin(a) * 37 + 3.5, 'text-anchor': 'middle', 'font-size': 9, fill: '#AEB6BD', 'font-family': 'Overpass Mono, monospace',
        }, g);
        t.textContent = String(m);
      }
    }
  }

  /** Sign cards in the guide below the game; images are filled once fonts are ready. */
  private buildGuide(): void {
    const host = el('signs');
    for (const key of GUIDE_ORDER) {
      const s = SIGN_INFO[key];
      const card = document.createElement('article');
      card.className = 'sign-card';
      const art = document.createElement('div');
      art.className = 'art';
      const img = document.createElement('img');
      img.alt = `${s.name} sign`;
      art.append(img);
      const body = document.createElement('div');
      const small = document.createElement('small');
      small.textContent = s.kind;
      const h4 = document.createElement('h4');
      h4.textContent = s.name;
      const p1 = document.createElement('p');
      p1.textContent = s.meaning;
      const p2 = document.createElement('p');
      p2.textContent = s.rule;
      body.append(small, h4, p1, p2);
      card.append(art, body);
      host.append(card);
      this.guideImgs.set(key, img);
    }
  }

  fillGuideImages(): void {
    for (const key of GUIDE_ORDER) {
      const img = this.guideImgs.get(key);
      if (img) img.src = signImg(key, SIGN_INFO[key].spec());
    }
  }

  /* ---------- city map ---------- */

  async loadCrashGrid(): Promise<void> {
    try {
      const res = await fetch('./crash-grid.json');
      if (res.ok) this.crashGrid = await res.json() as CrashGrid;
    } catch {
      /* no crash data; map still renders without heatmap */
    }
  }

  drawCityMap(layer: 'all' | 'cyclist' | 'pedestrian' = this.mapLayer): void {
    this.mapLayer = layer;
    const canvas = document.getElementById('city-map') as HTMLCanvasElement | null;
    if (!canvas) return;
    const g = canvas.getContext('2d');
    if (!g) return;
    const W = canvas.width;
    const H = canvas.height;

    // Bounding box for Cambridge
    const LAT_MIN = 42.353, LAT_MAX = 42.403;
    const LON_MIN = -71.159, LON_MAX = -71.069;

    const proj = (lat: number, lon: number): [number, number] => [
      (lon - LON_MIN) / (LON_MAX - LON_MIN) * W,
      H - (lat - LAT_MIN) / (LAT_MAX - LAT_MIN) * H,
    ];

    // Background
    g.fillStyle = '#0F1A14';
    g.fillRect(0, 0, W, H);

    // Heatmap
    const grid = this.crashGrid;
    if (grid) {
      const data = layer === 'cyclist' ? grid.cyclist : layer === 'pedestrian' ? grid.pedestrian : grid.all;
      const maxVal = Math.max(...data.filter((v) => v > 0));
      const GRID = grid.grid;
      const cellLat = (LAT_MAX - LAT_MIN) / GRID;
      const cellLon = (LON_MAX - LON_MIN) / GRID;
      for (let r = 0; r < GRID; r++) {
        for (let c = 0; c < GRID; c++) {
          const v = data[r * GRID + c];
          if (!v) continue;
          const norm = Math.sqrt(v) / Math.sqrt(maxVal);
          const lat = LAT_MIN + (r + 0.5) * cellLat;
          const lon = LON_MIN + (c + 0.5) * cellLon;
          const [x, y] = proj(lat, lon);
          const radius = 3 + norm * 7;
          const alpha = 0.25 + norm * 0.55;
          const color = layer === 'cyclist'
            ? `rgba(255,160,0,${alpha})`
            : layer === 'pedestrian'
            ? `rgba(200,100,255,${alpha})`
            : `rgba(255,80,80,${alpha})`;
          g.beginPath();
          g.arc(x, y, radius, 0, Math.PI * 2);
          g.fillStyle = color;
          g.fill();
        }
      }
    }

    // Practice rotary pin (near Alewife Brook / Route 2/16 cluster)
    const [px, py] = proj(42.393, -71.141);
    g.beginPath();
    g.arc(px, py, 7, 0, Math.PI * 2);
    g.fillStyle = 'rgba(242,183,5,0.9)';
    g.fill();
    g.beginPath();
    g.arc(px, py, 10, 0, Math.PI * 2);
    g.strokeStyle = '#F2B705';
    g.lineWidth = 1.5;
    g.stroke();
    g.font = '600 10px Overpass, sans-serif';
    g.fillStyle = '#E8ECEF';
    g.textAlign = 'left';
    g.fillText('Practice rotary', px + 13, py + 4);

    // North arrow
    g.fillStyle = '#AEB6BD';
    g.font = '700 9px Overpass, sans-serif';
    g.textAlign = 'center';
    g.fillText('N', W - 12, 14);
    g.beginPath();
    g.moveTo(W - 12, 18);
    g.lineTo(W - 9, 26);
    g.lineTo(W - 12, 24);
    g.lineTo(W - 15, 26);
    g.closePath();
    g.fillStyle = '#AEB6BD';
    g.fill();
  }

  private bindMapLayerToggles(): void {
    const ids: Array<['layer-all' | 'layer-cyc' | 'layer-ped', 'all' | 'cyclist' | 'pedestrian']> = [
      ['layer-all', 'all'],
      ['layer-cyc', 'cyclist'],
      ['layer-ped', 'pedestrian'],
    ];
    for (const [id, layer] of ids) {
      const btn = document.getElementById(id);
      if (!btn) continue;
      btn.addEventListener('click', () => {
        this.drawCityMap(layer);
        for (const [bid] of ids) {
          document.getElementById(bid)?.setAttribute('aria-pressed', bid === id ? 'true' : 'false');
        }
      });
    }
  }

  private buildCrashStats(): void {
    const host = document.getElementById('map-stats');
    if (!host) return;
    const stat = (value: string, label: string, cls = '') => {
      const d = document.createElement('div');
      d.className = `stat-chip${cls ? ' ' + cls : ''}`;
      const b = document.createElement('b');
      b.textContent = value;
      const s = document.createElement('span');
      s.textContent = label;
      d.append(b, s);
      host.append(d);
    };
    stat(CRASH_STATS.totalCrashes.toLocaleString(), 'Cambridge crashes on record');
    stat(`${CRASH_STATS.cyclistPct}%`, 'involve a cyclist', 'warn');
    stat(`${CRASH_STATS.pedestrianPct}%`, 'involve a pedestrian', 'warn');
    stat(`${CRASH_STATS.darkPct}%`, 'cyclist/ped crashes in low light', 'bad');
    stat('6 PM', 'peak hour for cyclist crashes');
  }
}
