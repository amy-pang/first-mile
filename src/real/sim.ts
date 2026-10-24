/**
 * The real Harvard → MIT drive: the player, traffic, cyclists and pedestrians on real Cambridge streets, and the
 * rule checks. Rules come from the OSM data (speed limits, signals, stop signs, crosswalks, bike lanes, turns);
 * signal timing and the traffic itself are simulated. No DOM or three.js in here.
 */
import { AI_COLORS, MPHF, PED_COLORS, type Pose } from '../constants';
import { pickOne, rand } from '../math';
import { PASS_SCORE, type Category, type CoachKind, type RunResult } from '../sim';
import type { Route, RouteEvent } from './data';

export const ROUTE_CATEGORIES: readonly { key: Category; label: string; weight: number; what: string }[] = [
  { key: 'yield', label: 'Right of way', weight: 30, what: 'Red lights, stop signs, people in crosswalks, never stopping on railroad tracks' },
  { key: 'speed', label: 'Speed control', weight: 20, what: 'Within the posted limit: 20 mph on most Cambridge streets, 25 on some main roads' },
  { key: 'following', label: 'Following distance', weight: 15, what: 'At least a two-second gap to the car ahead' },
  { key: 'lane', label: 'Lane position and steering', weight: 15, what: 'In your lane, right of the yellow line, out of the bike lane, steering smoothly' },
  { key: 'signals', label: 'Signals and checks', weight: 10, what: 'A turn signal before every turn, from the correct lane' },
  { key: 'blind', label: 'Checking blind spots', weight: 10, what: 'Mirror and shoulder checks before lane changes, and for cyclists before right turns' },
];

/**
 * Photo mode (real street photos as the view): the car follows the route on its own, so steering, lane keeping and
 * following distance can't be judged. The points go to what you still control.
 */
export const PHOTO_CATEGORIES: readonly { key: Category; label: string; weight: number; what: string }[] = [
  { key: 'yield', label: 'Right of way', weight: 35, what: 'Red lights, the stop sign, people in crosswalks, oncoming cars on left turns, railroad tracks' },
  { key: 'speed', label: 'Speed control', weight: 25, what: 'Within the posted limit: 20 mph on most Cambridge streets, 25 on some main roads' },
  { key: 'signals', label: 'Turn signals', weight: 20, what: 'Your turn signal on at least 100 feet before every turn' },
  { key: 'blind', label: 'Checking before turns', weight: 20, what: 'Looking the way you turn (Q left, E right), and for cyclists before turning right across a bike lane' },
];

const RATE = { speed: 2, following: 1.5, lane: 1.5 } as const;
const WHEELBASE = 2.7;
const STEER_MAX = 0.55;
const CAR_HALF = { l: 2.3, w: 0.97 };
const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

export type CardKey = 'stop' | 'signal' | 'rail' | 'bikebox' | 'speed' | 'crosswalk' | 'bikes';

export interface RouteHooks {
  coach(kind: CoachKind, title: string, body: string, quiet?: boolean): void;
  card(key: CardKey, mph?: number): void;
  scoreChanged(score: number): void;
  signalChanged(left: boolean, right: boolean): void;
  driveStarted(): void;
  result(r: RunResult): void;
}

export interface RCar {
  id: number;
  isPlayer: boolean;
  /** Distance along the route and sideways offset (right of our direction is +). */
  s: number;
  off: number;
  /** 1 travels our way, −1 is oncoming. */
  dir: 1 | -1;
  lane: number;
  v: number;
  vmax: number;
  pose: Pose;
  braking: boolean;
  color: string;
  blink: 'left' | 'right' | null;
  waitT: number;
  /** Set once the car leaves our route at an intersection: metres driven since, and which way it turns off. */
  free?: number;
  freeTurn?: number;
}

export interface RPerson {
  id: number;
  bike: boolean;
  s: number;
  off: number;
  dir: 1 | -1;
  v: number;
  color: string;
  x: number;
  y: number;
  h: number;
  /** Pedestrians: the crosswalk they're using and whether they've started across. */
  cw: number;
  committed: boolean;
  onRoad: boolean;
}

export interface Signal {
  s: number;
  end: number;
  ped: boolean;
  phase: number;
  cycle: number;
  green: number;
}

export type Light = 'green' | 'yellow' | 'red';

function carsOverlap(a: Pose, b: Pose): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  for (const h of [a.h, b.h]) {
    for (const ax of [{ x: Math.cos(h), y: Math.sin(h) }, { x: -Math.sin(h), y: Math.cos(h) }]) {
      const reach = (p: Pose) =>
        CAR_HALF.l * Math.abs(Math.cos(p.h) * ax.x + Math.sin(p.h) * ax.y) + CAR_HALF.w * Math.abs(-Math.sin(p.h) * ax.x + Math.cos(p.h) * ax.y);
      if (Math.abs(dx * ax.x + dy * ax.y) > reach(a) + reach(b)) return false;
    }
  }
  return true;
}

export class RouteSim {
  cars: RCar[] = [];
  peds: RPerson[] = [];
  player!: RCar;
  state: 'ready' | 'driving' | 'done' | 'crashed' = 'ready';
  readonly traffic = 'moderate' as const;
  readonly weather = 'clear' as const;
  signal = false;
  signalLeft = false;
  steer = 0;
  simTime = 0;
  topMph = 0;
  flags: Record<string, boolean> = {};
  lost: Record<Category, number> = { speed: 0, following: 0, lane: 0, yield: 0, signals: 0, blind: 0 };
  critical: string | null = null;
  marks: { key: string; title: string; x: number; y: number }[] = [];
  trail: { x: number; y: number }[] = [];
  readonly signals: Signal[];
  readonly input = { gas: false, brake: false, look: false, lookRight: false, left: false, right: false };

  private nextId = 1;
  private spawnT = 0;
  private bikeT = 4;
  private pedT = 3;
  private lastLook = -99;
  private lastLookRight = -99;
  private slipT: Record<string, number> = {};
  private shownScore = 100;
  /** Your sideways position, slowly filtered: moving well away from it is a lane change. */
  private anchorOff = 0;
  private laneChanges = 0;
  private stopMinV: number[] = [];
  private railT = 0;
  private cardDone = new Set<string>();
  private readonly events: RouteEvent[];

  /** Photo mode: the car stays on the route and in the right lane by itself; you control speed, signals and checks. */
  photo = false;
  private lastRailLane = 0;

  get categories(): readonly { key: Category; label: string; weight: number; what: string }[] {
    return this.photo ? PHOTO_CATEGORIES : ROUTE_CATEGORIES;
  }

  /** Where along the route a run starts, in metres (0 = Lehman Hall); set from the page's ?at= option. */
  startAt = 6;

  constructor(readonly route: Route, private readonly hooks: RouteHooks) {
    this.events = route.data.events;
    this.signals = this.events.flatMap((e) => (e.kind === 'signal'
      ? [{ s: e.s, end: e.end, ped: !!e.ped, phase: rand(0, 40), cycle: e.ped ? 50 : 40, green: e.ped ? 38 : 18 }]
      : []));
  }

  restart(): void {
    this.cars = [];
    this.peds = [];
    this.state = 'ready';
    this.simTime = 0;
    this.topMph = 0;
    this.flags = {};
    this.lost = { speed: 0, following: 0, lane: 0, yield: 0, signals: 0, blind: 0 };
    this.critical = null;
    this.marks = [];
    this.trail = [];
    this.slipT = {};
    this.shownScore = 100;
    this.laneChanges = 0;
    this.railT = 0;
    this.lastLook = this.lastLookRight = -99;
    this.cardDone.clear();
    this.stopMinV = this.events.map(() => Infinity);
    this.steer = 0;
    for (const sg of this.signals) sg.phase = rand(0, sg.cycle);
    const s0 = Math.max(6, Math.min(this.route.len - 60, this.startAt));
    const off = this.route.laneCentre(s0, 0);
    this.player = {
      id: 0, isPlayer: true, s: s0, off, dir: 1, lane: 0, v: 0, vmax: 0, pose: this.route.at(s0, off), braking: false,
      color: '#E0A50C', blink: null, waitT: 0,
    };
    this.cars.push(this.player);
    this.anchorOff = off;
    this.setSignal(false);
    this.setSignalLeft(false);
    this.hooks.scoreChanged(100);
    const d = this.route.data;
    this.hooks.coach('info', `${d.start} → ${d.goal}`,
      `A real ${(d.length / 1609).toFixed(1)}-mile drive through Harvard Square, Central Square and Kendall. Every street, lane count, speed limit, signal, stop sign, crosswalk and bike lane comes from OpenStreetMap. Follow the turn arrows on the NAV screen.`);
  }

  setSignal(on: boolean): void {
    this.signal = on;
    if (on) this.signalLeft = false;
    this.hooks.signalChanged(this.signalLeft, this.signal);
  }

  setSignalLeft(on: boolean): void {
    this.signalLeft = on;
    if (on) this.signal = false;
    this.hooks.signalChanged(this.signalLeft, this.signal);
  }

  ems(): undefined {
    return undefined;
  }

  paved(): boolean {
    const e = this.route.extent(this.player.s);
    return this.player.off > e.left - 0.6 && this.player.off < e.right + 0.6;
  }

  light(sg: Signal): Light {
    const u = (this.simTime + sg.phase) % sg.cycle;
    return u < sg.green ? 'green' : u < sg.green + 4 ? 'yellow' : 'red';
  }

  /** The next turn ahead of `s`, for navigation. */
  nextTurn(s: number): Extract<RouteEvent, { kind: 'turn' }> | null {
    for (const e of this.events) if (e.kind === 'turn' && e.s > s && e.dir !== 'straight') return e;
    return null;
  }

  speedLimit(s: number): number {
    return this.route.seg(s).mph;
  }

  /* ---------- scoring ---------- */

  get score(): number {
    const frac = this.state === 'crashed' ? clamp01(this.player.s / this.route.len) : 1;
    let total = 0;
    for (const c of this.categories) total += Math.max(0, c.weight * frac - this.lost[c.key]);
    return Math.round(total);
  }

  breakdown(): { key: Category; label: string; weight: number; got: number; what: string; reached: boolean }[] {
    const frac = this.state === 'crashed' ? clamp01(this.player.s / this.route.len) : 1;
    return this.categories.map((c) => ({ ...c, got: Math.round(Math.max(0, c.weight * frac - this.lost[c.key])), reached: frac > 0.02 }));
  }

  private lose(cat: Category, pts: number): void {
    this.lost[cat] += pts;
    const sc = this.score;
    if (sc !== this.shownScore) {
      this.shownScore = sc;
      this.hooks.scoreChanged(sc);
    }
  }

  private violate(key: string, cat: Category, pts: number, title: string, body: string, critical = false): void {
    if (this.flags[key]) return;
    this.flags[key] = true;
    this.marks.push({ key, title, x: this.player.pose.x, y: this.player.pose.y });
    if (critical && !this.critical) this.critical = title;
    this.lose(cat, pts);
    const label = this.categories.find((c) => c.key === cat)?.label ?? cat;
    this.hooks.coach('bad', title, `${body} (${pts ? `−${pts} ` : ''}${label}${critical ? ', critical error' : ''})`);
  }

  private sustained(key: string, bad: boolean, dt: number, after: number): boolean {
    this.slipT[key] = bad ? (this.slipT[key] ?? 0) + dt : 0;
    return this.slipT[key] > after && !this.flags[key];
  }

  /* ---------- simulation ---------- */

  step(dt: number): void {
    this.simTime += dt;
    this.spawn(dt);
    this.updatePeople(dt);
    for (const c of this.cars) if (!c.isPlayer) this.updateAI(c, dt);
    this.updatePlayer(dt);
    const P = this.player;
    this.cars = this.cars.filter((c) => c.isPlayer || (c.s > 0 && c.s < this.route.len - 2 && c.s > P.s - 90 && c.s < P.s + 260));
    this.peds = this.peds.filter((p) => (p.bike ? p.s < this.route.len - 2 && p.s > P.s - 60 && p.s < P.s + 200 : Math.abs(p.off) < 40));
    if (this.state === 'driving') this.checkCrash();
  }

  private laneFree(s: number, dir: 1 | -1, lane: number, gap: number): boolean {
    return !this.cars.some((c) => c.free === undefined && c.dir === dir && c.lane === lane && Math.abs(c.s - s) < gap);
  }

  private spawn(dt: number): void {
    const P = this.player;
    const R = this.route;
    this.spawnT -= dt;
    if (this.spawnT <= 0 && this.cars.length < 15) {
      this.spawnT = rand(1.2, 2.6);
      const r = Math.random();
      if (this.photo && r < 0.65) {
        // In photo mode the real photos already show the traffic around you.
      } else if (r < 0.45) {
        // Traffic ahead of you.
        const s = P.s + rand(70, 140);
        const lanes = R.seg(s).lanes;
        const lane = Math.floor(Math.random() * lanes);
        if (s < R.len - 30 && this.laneFree(s, 1, lane, 18)) this.addCar(s, 1, lane, rand(0.85, 1.0));
      } else if (r < 0.65) {
        // A faster car coming up behind you in another lane, so mirror checks matter.
        const lanes = R.seg(P.s).lanes;
        if (lanes > 1 && P.v > 3) {
          const lane = P.lane === 0 ? 1 : 0;
          const s = P.s - rand(22, 40);
          if (s > 0 && this.laneFree(s, 1, lane, 14)) this.addCar(s, 1, lane, 1.05, P.v + 3);
        }
      } else {
        // Oncoming traffic on two-way streets. It belongs to the street you're on, so if your next turn comes first,
        // it enters at that intersection rather than coming round the corner from the street you'll turn onto.
        let s = P.s + rand(110, 200);
        const t = this.nextTurn(P.s);
        if (t && t.s < s) s = t.s - 3 - P.s > 60 ? t.s - 3 : -1;
        const g = R.seg(s);
        if (s > 0 && !g.oneway && s < R.len - 10) {
          const lane = Math.floor(Math.random() * g.opp);
          if (this.laneFree(s, -1, lane, 20)) this.addCar(s, -1, lane, rand(0.85, 1.0));
        }
      }
    }
    this.bikeT -= dt;
    if (this.bikeT <= 0) {
      this.bikeT = rand(3, 7);
      // Cyclists in the bike lane, more of them just before right turns.
      const turn = this.nextTurn(P.s);
      const s = turn && turn.dir === 'right' && turn.s - P.s < 140 && Math.random() < 0.7 ? P.s - rand(10, 18) : P.s + rand(40, 110);
      const e = R.extent(s);
      if (s > 0 && s < R.len - 20 && e.bike > 0) {
        this.peds.push({
          id: this.nextId++, bike: true, s, off: e.right - e.bike / 2, dir: 1, v: rand(4.5, 6.5), color: pickOne(PED_COLORS),
          x: 0, y: 0, h: 0, cw: -1, committed: true, onRoad: false,
        });
        this.peds[this.peds.length - 1].off = e.right - e.bike * 0.35;
      }
    }
    this.pedT -= dt;
    if (this.pedT <= 0) {
      this.pedT = rand(2.5, 5);
      // Someone about to use an unsignalised crosswalk you're approaching.
      const cws = this.events.map((e, i) => ({ e, i })).filter(({ e }) => e.kind === 'crosswalk' && e.s > P.s + 30 && e.s < P.s + 110);
      if (cws.length && Math.random() < 0.6) {
        const { e, i } = pickOne(cws);
        if (!this.peds.some((p) => p.cw === i)) {
          const x = R.extent(e.s);
          const dir: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
          this.peds.push({
            id: this.nextId++, bike: false, s: e.s, off: dir === 1 ? x.left - 2.5 : x.right + 2.5, dir, v: rand(1.3, 1.7),
            color: pickOne(PED_COLORS), x: 0, y: 0, h: 0, cw: i, committed: false, onRoad: false,
          });
        }
      }
    }
  }

  private addCar(s: number, dir: 1 | -1, lane: number, speedK: number, v?: number): void {
    const R = this.route;
    const off = dir === 1 ? R.laneCentre(s, lane) : -(R.data.laneW * (lane + 0.5));
    const vmax = (R.seg(s).mph / MPHF) * speedK;
    this.cars.push({
      id: this.nextId++, isPlayer: false, s, off, dir, lane, v: v ?? vmax * 0.8, vmax, pose: R.at(s, off), braking: false,
      color: pickOne(AI_COLORS), blink: null, waitT: 0,
    });
  }

  /** Distance to the next place this car must stop (red/yellow light, stop sign, someone in a crosswalk). */
  private stopDistance(c: RCar): number {
    let best = Infinity;
    const ahead = (at: number) => (c.dir === 1 ? at - c.s : c.s - at);
    for (const sg of this.signals) {
      const line = c.dir === 1 ? sg.s : sg.end;
      const d = ahead(line) - 2.4;
      if (d < -1 || d > 80) continue;
      const L = this.light(sg);
      if (L === 'red' || (L === 'yellow' && d > (c.v * c.v) / 6)) best = Math.min(best, d);
    }
    this.events.forEach((e, i) => {
      const d = ahead(e.s) - 2.4;
      if (d < -1 || d > 60) return;
      if (e.kind === 'stop' && c.dir === 1 && c.waitT < 1.5) best = Math.min(best, d);
      if (e.kind === 'crosswalk' && this.peds.some((p) => p.cw === i && p.onRoad)) best = Math.min(best, d - 1);
    });
    return best;
  }

  private updateAI(c: RCar, dt: number): void {
    const R = this.route;
    if (c.free !== undefined) {
      const h = c.pose.h + (c.free < 18 ? (c.freeTurn ?? 0) * 0.08 * c.v * dt : 0);
      c.pose = { x: c.pose.x + Math.cos(h) * c.v * dt, y: c.pose.y + Math.sin(h) * c.v * dt, h };
      c.free += c.v * dt;
      c.braking = false;
      c.blink = null;
      if (c.free > 60) c.s = -1;
      return;
    }
    const g = R.seg(c.s);
    let target = c.vmax;
    if (c.dir === -1 && g.oneway) { c.s = -1; return; }
    // Oncoming cars stay on their own street: they never follow our route backwards round a corner.
    if (c.dir === -1 && this.events.some((e) => e.kind === 'turn' && e.dir !== 'straight' && c.s - e.s > 0 && c.s - e.s < 4)) { c.s = -1; return; }
    // Lanes: where ours ends ahead, merge, but only into a free gap; otherwise slow down and wait for one.
    const laneOff = (k: number) => (c.dir === 1 ? R.laneCentre(c.s, k) : -(R.data.laneW * (k + 0.5)));
    const lanesAt = (s: number) => { const q = R.seg(s); return c.dir === 1 ? q.lanes : Math.max(1, q.opp); };
    const lanes = lanesAt(c.s);
    if (c.lane >= lanes) c.lane = lanes - 1;
    // Cars not in the lane for our route's turn, or in a turn-only lane that ends at an intersection,
    // leave the route there: they carry straight on along the other street.
    if (c.dir === 1) {
      const turn = this.events.find((e) => e.kind === 'turn' && (e.dir === 'left' || e.dir === 'right') && e.s - c.s > 0 && e.s - c.s < 5);
      if (turn && turn.kind === 'turn' && (turn.dir === 'left' ? c.lane !== lanes - 1 : c.lane !== 0)) { c.free = 0; c.freeTurn = 0; return; }
      // A turn-only lane ending at a signal: left lanes turn left onto the cross street, right lanes turn right.
      if (lanesAt(c.s + 5) <= c.lane && this.signals.some((sg) => Math.abs(sg.s - c.s) < 25)) { c.free = 0; c.freeTurn = c.lane > 0 ? -1 : 1; return; }
    }
    const atJunction = this.events.some((e) => (e.kind === 'turn' || e.kind === 'signal') && Math.abs(e.s - (c.s + 30 * c.dir)) < 25);
    const ahead = lanesAt(c.s + 30 * c.dir);
    if (c.lane >= ahead && !atJunction) {
      const k = ahead - 1;
      const to = laneOff(k);
      const free = !this.cars.some((o) => o !== c && o.free === undefined && o.dir === c.dir && Math.abs(o.off - to) < 1.8 && (o.s - c.s) * c.dir > -10 && (o.s - c.s) * c.dir < 8);
      if (free) c.lane = k;
      else {
        // No gap yet: ease off gradually, coming to a stop before the lane actually runs out.
        let end = 30;
        for (let d = 0; d <= 30; d += 3) if (lanesAt(c.s + d * c.dir) <= c.lane) { end = d; break; }
        target = Math.min(target, c.vmax * 0.6, Math.sqrt(2 * 2.2 * Math.max(0, end - 4)));
      }
    }
    const want = laneOff(c.lane);
    c.off += Math.max(-1.2 * dt, Math.min(1.2 * dt, want - c.off));
    c.blink = Math.abs(want - c.off) > 0.4 ? ((want - c.off) * c.dir > 0 ? 'right' : 'left') : null;
    // Lights, stop signs and crosswalks.
    const stop = this.stopDistance(c);
    if (stop < Infinity) target = Math.min(target, Math.sqrt(Math.max(0, 2 * 3.2 * Math.max(0, stop))));
    if (stop < 1.5 && c.v < 0.3) c.waitT += dt;
    else if (stop === Infinity) c.waitT = 0;
    // The car ahead in the same lane (including you).
    let gap = Infinity;
    for (const o of this.cars) {
      if (o === c || o.free !== undefined || o.dir !== c.dir || (Math.abs(o.off - c.off) > 1.7 && Math.abs(o.off - want) > 1.7)) continue;
      const d = (o.s - c.s) * c.dir;
      if (d > 0 && d < gap) gap = d;
    }
    for (const p of this.peds) {
      if (!p.bike || c.dir !== 1 || Math.abs(p.off - c.off) > 1.5) continue;
      const d = p.s - c.s;
      if (d > 0 && d < gap) gap = d;
    }
    if (gap < Infinity) target = Math.min(target, Math.max(0, (gap - 6) / 1.6));
    c.braking = target < c.v - 0.3 || c.v < 0.2;
    c.v = c.v < target ? Math.min(target, c.v + 2.4 * dt) : Math.max(target, c.v - 6.5 * dt);
    c.s += c.v * dt * c.dir;
    const p = R.at(c.s, c.off);
    c.pose = c.dir === 1 ? p : { x: p.x, y: p.y, h: p.h + Math.PI };
  }

  private updatePeople(dt: number): void {
    const R = this.route;
    for (const p of this.peds) {
      if (p.bike) {
        const e = R.extent(p.s);
        if (e.bike === 0) { p.s = -1; continue; }
        p.off = e.right - e.bike * 0.35;
        // Cyclists hold back rather than ride into a car that is already across the bike lane in front of them.
        const blocked = this.cars.some((c) => c.dir === 1 && c.s - p.s > 0 && c.s - p.s < 7 && Math.abs(c.off - p.off) < 2);
        if (!blocked) p.s += p.v * dt;
      } else {
        const e = R.extent(p.s);
        const atEdge = p.dir === 1 ? p.off >= e.left - 1.2 : p.off <= e.right + 1.2;
        if (!p.committed && atEdge) {
          // Wait for a car that's too close to stop.
          // Only step out when every approaching car has room to stop.
          const near = this.cars.some((c) => {
            const d = (p.s - c.s) * c.dir;
            return d > -3 && d < 8 + c.v * 1.5 + (c.v * c.v) / 8 && c.v > 0.5;
          });
          if (near) { this.place(p); continue; }
          p.committed = true;
        }
        p.off += p.dir * p.v * dt;
        p.onRoad = p.off > e.left - 0.3 && p.off < e.right + 0.3;
        if (p.dir * p.off > 14) p.off = 99;
      }
      this.place(p);
    }
  }

  private place(p: RPerson): void {
    const q = this.route.at(Math.max(0, p.s), p.off);
    p.x = q.x;
    p.y = q.y;
    p.h = p.bike ? q.h : q.h + (p.dir * Math.PI) / 2;
  }

  /* ---------- the player ---------- */

  private updatePlayer(dt: number): void {
    const P = this.player;
    const inp = this.input;
    if (this.state === 'ready' && inp.gas) {
      this.state = 'driving';
      this.hooks.driveStarted();
    }
    if (this.state === 'crashed') { P.v = 0; return; }
    let acc: number;
    if (this.state === 'done') acc = -3;
    else if (this.state === 'ready') acc = -4;
    else acc = inp.brake ? -7.5 : inp.gas ? 3.0 : -0.6;
    if (!this.paved() && P.v > 4) acc = Math.min(acc, -5);
    P.v = Math.max(0, Math.min(16, P.v + acc * dt));
    const s0 = P.s;
    if (this.photo) {
      // On rails along the route: the rightmost lane, or the leftmost before a left turn on a multi-lane street.
      P.s = Math.min(this.route.len - 0.5, P.s + P.v * dt);
      const t = this.nextTurn(P.s);
      const lanes = this.route.extent(P.s).lanes;
      P.lane = t && t.dir.includes('left') && t.s - P.s < 90 ? lanes - 1 : 0;
      // Track the lane centre closely as the road tapers; only a move into the turn lane is a slow slide.
      const want = this.route.laneCentre(P.s, P.lane);
      const rate = P.lane === this.lastRailLane ? 6 : 1.2;
      if (Math.abs(want - P.off) < 0.3) this.lastRailLane = P.lane;
      P.off += Math.max(-rate * dt, Math.min(rate * dt, want - P.off));
      P.pose = this.route.at(P.s, P.off);
      this.steer = 0;
    } else this.steer3d(P, dt);
    if (inp.look) this.lastLook = this.simTime;
    if (inp.lookRight) this.lastLookRight = this.simTime;
    if (this.state !== 'driving') return;
    this.checkStep(P, s0, dt);
  }

  /** Free steering for the 3D view. */
  private steer3d(P: RCar, dt: number): void {
    const inp = this.input;
    // Bicycle model: the arrow keys turn the front wheels, which straighten when released.
    const dir = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
    const lim = STEER_MAX / (1 + P.v * 0.12);
    const rate = dir ? 1.4 : 3;
    this.steer += Math.max(-rate * dt, Math.min(rate * dt, dir * lim - this.steer));
    this.steer = Math.max(-lim, Math.min(lim, this.steer));
    const p = P.pose;
    p.h += ((P.v * Math.tan(this.steer)) / WHEELBASE) * dt;
    p.x += Math.cos(p.h) * P.v * dt;
    p.y += Math.sin(p.h) * P.v * dt;
    const loc = this.route.locate(p, P.s);
    P.s = loc.s;
    P.off = loc.off;
  }

  private checkStep(P: RCar, s0: number, dt: number): void {
    const p = P.pose;
    const s1 = P.s;
    const f0 = s0 + 2.2;
    const f1 = s1 + 2.2;
    this.topMph = Math.max(this.topMph, P.v * MPHF);
    const tail = this.trail[this.trail.length - 1];
    if (!tail || Math.hypot(tail.x - p.x, tail.y - p.y) > 2) this.trail.push({ x: p.x, y: p.y });
    this.cards(s1);
    this.checkEvents(P, f0, f1, dt);
    this.assess(P, dt);
    if (this.state !== 'driving') return;
    if (Math.abs(P.off) > 30) {
      this.crash('lost');
      return;
    }
    if (s1 > this.route.len - 10) this.finish();
  }

  /** Sign cards a little before each kind of control, the first time it comes up (speed limits every time). */
  private cards(s: number): void {
    this.events.forEach((e, i) => {
      const key = `${i}`;
      if (this.cardDone.has(key)) return;
      const lead = e.kind === 'speed' ? 0 : e.kind === 'rail' ? 90 : 55;
      if (s < e.s - lead || s > e.s) return;
      this.cardDone.add(key);
      if (e.kind === 'speed') {
        if (this.route.seg(e.s + 1).s1 - e.s > 80) this.hooks.card('speed', e.mph);
      } else if (e.kind === 'stop' || e.kind === 'rail' || e.kind === 'bikebox') this.hooks.card(e.kind);
      else if ((e.kind === 'signal' || e.kind === 'crosswalk') && !this.cardDone.has(e.kind)) {
        this.cardDone.add(e.kind);
        this.hooks.card(e.kind);
      }
    });
    if (!this.cardDone.has('bikes') && this.route.extent(s).bike > 0) {
      this.cardDone.add('bikes');
      this.hooks.card('bikes');
    }
  }

  /** One-off rules at the controls along the route. */
  private checkEvents(P: RCar, f0: number, f1: number, dt: number): void {
    const crossed = (x: number) => f0 < x && f1 >= x;
    const R = this.route;
    this.signals.forEach((sg, i) => {
      const L = this.light(sg);
      const d = sg.s - f1;
      if (L === 'red' && d > 0 && d < 10 && P.v < 0.3 && !this.flags[`redok${i}`]) {
        this.flags[`redok${i}`] = true;
        if (!this.flags.redNoted) {
          this.flags.redNoted = true;
          this.hooks.coach('good', 'Stopped for the red light', 'You stopped behind the line. Wait for the green, and check the crosswalk is clear before you go.');
        }
      }
      if (crossed(sg.s) && L === 'red') {
        this.violate(`red${i}`, 'yield', 15, 'You ran a red light', 'A red light means stop behind the white line and wait for green. Massachusetts has no right on red where it is posted, and red-light running is one of the top causes of serious crashes.', true);
      }
    });
    this.events.forEach((e, i) => {
      if (e.kind === 'stop') {
        if (f1 > e.s - 12 && f1 < e.s + 1) this.stopMinV[i] = Math.min(this.stopMinV[i], P.v);
        if (crossed(e.s)) {
          if (this.stopMinV[i] > 0.4) this.violate(`stop${i}`, 'yield', 8, 'Come to a full stop', 'Massachusetts law requires a complete stop at a stop sign, behind the line or crosswalk, before you go. Rolling through is a common road-test fail.');
          else this.hooks.coach('good', 'Full stop', 'You stopped completely at the stop sign, then went when it was clear.');
        }
      } else if (e.kind === 'crosswalk' && crossed(e.s)) {
        if (this.peds.some((p) => p.cw === i && p.onRoad)) {
          this.violate(`ped${i}`, 'yield', 15, 'You drove through an occupied crosswalk', 'Massachusetts law requires drivers to stop for anyone in a crosswalk on their half of the road, or approaching it from the other half. Stop before the crosswalk and let them finish.', true);
        }
      } else if (e.kind === 'rail') {
        const on = Math.abs(P.s - e.s) < 3 && P.v < 0.3;
        this.railT = on ? this.railT + dt : 0;
        if (this.railT > 1) this.violate('rail', 'yield', 5, 'Never stop on railroad tracks', 'Only cross when you can clear the tracks completely. If traffic ahead is stopped, wait before the crossing.');
      } else if (e.kind === 'turn' && (e.dir === 'left' || e.dir === 'right')) {
        this.checkTurn(e, i, P, crossed);
      }
    });
    if (this.photo) return;
    // Lane changes away from turns: a quick sideways move of most of a lane width.
    const ext = R.extent(P.s);
    const lane = Math.max(0, Math.min(ext.lanes - 1, Math.floor((ext.right - ext.bike - P.off) / ext.laneW)));
    const nearTurn = this.events.some((e) => e.kind === 'turn' && Math.abs(e.s - P.s) < 30);
    this.anchorOff += (P.off - this.anchorOff) * Math.min(1, dt / 5);
    if (nearTurn) this.anchorOff = P.off;
    if (Math.abs(P.off - this.anchorOff) > 2.4 && ext.lanes > 1) {
      const left = P.off < this.anchorOff;
      this.anchorOff = P.off;
      const n = ++this.laneChanges;
      if (left ? !this.signalLeft : !this.signal) {
        this.violate(`lcsig${n}`, 'blind', 2, 'Signal before you change lanes', `Turn on your ${left ? 'left' : 'right'} signal a few seconds before you move over, so drivers around you know what you're doing.`);
      }
      if (this.simTime - (left ? this.lastLook : this.lastLookRight) > 3) {
        this.violate(`lclook${n}`, 'blind', 3, 'Check your blind spot', `Check your ${left ? 'left' : 'right'} mirror, then hold ${left ? 'Q' : 'E'} to glance over your shoulder before you move over.`);
      }
      const f = { x: Math.cos(P.pose.h), y: Math.sin(P.pose.h) };
      const cut = this.cars.some((c) => {
        if (c.isPlayer || c.free !== undefined || c.dir !== 1 || c.lane !== lane) return false;
        const rel = (c.pose.x - P.pose.x) * f.x + (c.pose.y - P.pose.y) * f.y;
        return rel > -9 && rel < 4;
      });
      if (cut) this.violate(`lcunsafe${n}`, 'blind', 5, 'Unsafe lane change', 'A car was beside you in the lane you moved into. Let it pass first, then merge into the gap behind it.', true);
    }
    P.lane = lane;
  }

  private checkTurn(e: Extract<RouteEvent, { kind: 'turn' }>, i: number, P: RCar, crossed: (x: number) => boolean): void {
    const right = e.dir === 'right';
    const onSide = right ? this.signal : this.signalLeft;
    if (crossed(e.s - 8)) {
      if (!onSide) {
        this.violate(`tsig${i}`, 'signals', 3, `Signal your ${e.dir} turn`, `Turn on your ${e.dir} signal at least 100 feet (about 30 m) before you turn onto ${e.onto}, so drivers and cyclists behind you know.`);
      } else if (!this.flags.tsigOk) {
        this.flags.tsigOk = true;
        this.hooks.coach('good', 'Turn signaled', `Your ${e.dir} signal told everyone around you that you were turning onto ${e.onto}.`);
      }
      const ext = this.route.extent(e.s - 10);
      if (ext.lanes > 1 && (right ? P.lane !== 0 : P.lane !== ext.lanes - 1)) {
        this.violate(`tlane${i}`, 'signals', 2, 'Turn from the correct lane', `Get into the ${right ? 'rightmost' : 'leftmost'} lane before a ${e.dir} turn, and stay in it through the turn.`);
      }
    }
    // Turning left across a two-way street: oncoming traffic goes first.
    if (!right && !this.route.seg(e.s - 5).oneway && Math.abs(P.s - e.s) < 15 && P.off < -0.6 && !this.flags[`lyield${i}`]) {
      const coming = this.cars.some((c) => c.free === undefined && c.dir === -1 && c.s - P.s > -4 && c.s - P.s < 4 + c.v * 3);
      if (coming) this.violate(`lyield${i}`, 'yield', 12, 'Yield to oncoming traffic when turning left', `Turning left onto ${e.onto}, you must wait for oncoming cars to pass. Pull forward into the intersection if it's clear, and turn only into a real gap.`, true);
      else this.flags[`lyield${i}`] = true;
    }
    const bikeRight = right && this.route.extent(e.s - 10).bike > 0;
    if (!bikeRight && crossed(e.s - 6) && this.simTime - (right ? this.lastLookRight : this.lastLook) > 4) {
      this.violate(`tlook${i}`, 'blind', 4, `Look ${e.dir} before you turn`, `Glance ${e.dir} (hold ${right ? 'E' : 'Q'}) just before turning onto ${e.onto}: people cross at corners, and cars and bikes come from that side.`);
    }
    if (bikeRight) {
      if (crossed(e.s - 6) && this.simTime - this.lastLookRight > 4) {
        this.violate(`hooklook${i}`, 'blind', 4, 'Check for cyclists before turning right', 'There is a bike lane on your right. Before turning right, check your right mirror and look over your right shoulder (hold E). Cyclists going straight have the right of way.');
      }
      if (crossed(e.s)) {
        const hooked = this.peds.some((p) => p.bike && p.s - P.s > -12 && p.s - P.s < 3);
        if (hooked) this.violate(`hook${i}`, 'blind', 6, 'You cut off a cyclist', 'Turning right across a cyclist going straight (a "right hook") is a leading cause of bike crashes in Cambridge. Let them pass, then turn behind them.', true);
      }
    }
    // Self-cancelling blinker once the turn is done.
    if (crossed(e.s + 15) && onSide) {
      if (right) this.setSignal(false);
      else this.setSignalLeft(false);
    }
  }

  /** Every frame: speed, following distance and lane position, each scaled by how far off it is. */
  private assess(P: RCar, dt: number): void {
    const mph = P.v * MPHF;
    const limit = this.speedLimit(P.s);
    const sp = clamp01((mph - limit - 2) / 5);
    this.lose('speed', sp * RATE.speed * dt);
    if (this.sustained(`speed${limit}`, sp > 0, dt, 1.2)) {
      this.violate(`speed${limit}`, 'speed', 0, 'Over the speed limit', `You hit ${Math.round(mph)} mph where the limit is ${limit}. Cambridge lowered most city streets to 20 mph; main roads are 25 unless posted.`);
    }

    if (this.photo) return;
    let gap = Infinity;
    for (const c of this.cars) {
      if (c.isPlayer || c.free !== undefined || c.dir !== 1 || Math.abs(c.off - P.off) > 1.7) continue;
      const d = c.s - P.s - 4.4;
      if (d > -2 && d < gap) gap = d;
    }
    let fl = 0;
    if (P.v > 3 && gap < Infinity) fl = clamp01((2 - Math.max(0, gap) / P.v) / 1.5);
    this.lose('following', fl * RATE.following * dt);
    if (this.sustained('follow', fl > 0.3, dt, 1.5)) {
      this.violate('follow', 'following', 0, 'Too close to the car ahead', 'Keep at least two seconds behind: when the car ahead passes a fixed point, count "one thousand one, one thousand two" before you reach it. City traffic stops suddenly.');
    }

    const ext = this.route.extent(P.s);
    const nearTurn = this.events.some((e) => e.kind === 'turn' && Math.abs(e.s - P.s) < 25);
    const centre = this.route.laneCentre(P.s, P.lane);
    const tol = nearTurn ? 2.2 : 0.8;
    let drift = clamp01((Math.abs(P.off - centre) - tol) / 1.5);
    const leftTurn = this.events.some((e) => e.kind === 'turn' && e.dir.includes('left') && Math.abs(e.s - P.s) < 30);
    const overYellow = !ext.oneway && P.off < -0.4 && !leftTurn;
    const inBike = ext.bike > 0 && P.off > ext.right - ext.bike + 0.2 && P.off < ext.right + 0.6;
    if (!this.paved() || overYellow) drift = 1;
    const latAcc = (P.v * P.v * Math.abs(Math.tan(this.steer))) / WHEELBASE;
    const swerve = clamp01((latAcc - 4.5) / 3);
    this.lose('lane', Math.max(drift, swerve) * RATE.lane * dt);
    if (this.sustained('yellow', overYellow, dt, 0.5)) this.violate('yellow', 'lane', 3, 'Keep right of the yellow line', 'You drifted over the double yellow line into oncoming traffic. Stay in your own lanes on two-way streets.');
    if (this.sustained('bikelane', inBike && !nearTurn, dt, 0.8)) this.violate('bikelane', 'lane', 3, 'Stay out of the bike lane', 'Driving or parking in a bike lane is illegal in Massachusetts. Only cross it to turn, after checking for cyclists.');
    if (this.sustained('offroad', !this.paved(), dt, 0.5)) this.violate('offroad', 'lane', 3, 'You left the road', 'Keep all four wheels on the pavement. Ease off the gas and steer gently back into your lane.');
    if (this.sustained('drift', drift > 0.3 && this.paved() && !overYellow, dt, 1.5)) this.violate('drift', 'lane', 0, 'Hold your lane', 'You wandered from the middle of your lane. Look well ahead, not at the hood, and make small steering corrections.');
    if (this.sustained('swerve', swerve > 0.4, dt, 0.4)) this.violate('swerve', 'lane', 0, 'Steer more gently', 'That was a sharp turn for your speed. Slow down before the corner, then steer smoothly.');
  }

  private checkCrash(): void {
    const P = this.player;
    for (const c of this.cars) {
      // Cars that have turned off onto a cross street are on another road.
      if (c.isPlayer || c.free !== undefined || Math.abs(c.pose.x - P.pose.x) > 6 || Math.abs(c.pose.y - P.pose.y) > 6) continue;
      if (carsOverlap(c.pose, P.pose)) return this.crash('car');
    }
    // People and bikes: inside the car's outline, plus their own half-width.
    const f = { x: Math.cos(P.pose.h), y: Math.sin(P.pose.h) };
    for (const p of this.peds) {
      const dx = p.x - P.pose.x;
      const dy = p.y - P.pose.y;
      const lon = dx * f.x + dy * f.y;
      const lat = -dx * f.y + dy * f.x;
      if (Math.abs(lon) < CAR_HALF.l + (p.bike ? 0.8 : 0.25) && Math.abs(lat) < CAR_HALF.w + (p.bike ? 0.22 : 0.3)) return this.crash(p.bike ? 'bike' : 'ped');
    }
    const e = this.route.extent(P.s);
    // Past the curb and well onto the sidewalk: parked cars, poles and storefronts.
    if (P.off > e.right + 3.5 || P.off < e.left - 3.5) this.crash('curb');
  }

  private crash(kind: 'car' | 'ped' | 'bike' | 'curb' | 'lost'): void {
    const what = { car: 'Collision', ped: 'Hit a pedestrian', bike: 'Hit a cyclist', curb: 'Drove onto the sidewalk', lost: 'Left the route' }[kind];
    this.state = 'crashed';
    this.critical = what;
    this.marks.push({ key: 'crash', title: what, x: this.player.pose.x, y: this.player.pose.y });
    this.lose(kind === 'curb' || kind === 'lost' ? 'lane' : 'yield', 30);
    const body = {
      car: 'You and another car reached the same spot. Keep a two-second gap, stay in your lane, and check mirrors before you move.',
      ped: 'Watch every crosswalk and be ready to stop for people stepping out.',
      bike: 'Cambridge has a lot of cyclists. Check the bike lane before you move right and give bikes room.',
      curb: 'You mounted the curb. Slow down before corners and keep the car between the lane lines.',
      lost: 'You drove off the planned route. Follow the arrows on the NAV screen.',
    }[kind];
    this.hooks.coach('bad', what, body);
    this.hooks.result({ pass: false, title: what, body: `${body} Score counts only the part of the route you drove.` });
  }

  private finish(): void {
    this.state = 'done';
    const pass = this.score >= PASS_SCORE && !this.critical;
    const verdict = pass
      ? Object.keys(this.flags).some((k) => !/ok|Noted|Ok/.test(k)) ? 'You made it to MIT Sloan. Check the coach notes for what to tighten up.' : 'Clean drive across Cambridge. You are ready to try it for real.'
      : this.critical
        ? `You reached MIT Sloan, but "${this.critical}" is a critical error that fails the run on its own.`
        : `You reached MIT Sloan, but your driving scored below ${PASS_SCORE}. Check the breakdown to see which habits cost the most.`;
    this.hooks.result({ pass, title: pass ? 'Arrived: passed' : 'Arrived: try again', body: verdict });
  }
}
