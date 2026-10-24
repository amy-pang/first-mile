/** Traffic, pedestrians, the player's car and the rule checks. No DOM or three.js in here. */
import {
  AI_COLORS, CURB_W, DCW, DEG, DEND, DS, DY, LANE, LANE_END, MPHF, ORD, PED_COLORS, R_IN, R_OUT, RC, ROADS, RW, TAU,
  TIME_SCALE, type Pose, type Pt,
} from './constants';
import { add, curbCentre, dist, inboundEdge, N, pickOne, rand, roadPt, U } from './math';
import { getPath, poseAt, type Path } from './path';
import type { SignKey } from './signs';
import { pedSpawnInterval } from './bike-density';
import { conditionsFor, fmtT, TRAFFIC_LABEL, type Traffic, type Trip, type Weather } from './trip';

export type CoachKind = 'good' | 'warn' | 'bad' | 'info' | 'sign';
export type RunState = 'ready' | 'driving' | 'done' | 'crashed';
export type SignEventKey = SignKey | 'exit';

export interface Car {
  id: number;
  isPlayer: boolean;
  path: Path;
  s: number;
  v: number;
  vmax: number;
  ringV: number;
  color: string;
  clearT: number;
  cleared: boolean;
  waiting: boolean;
  stuck: number;
  blockedBy: Car | null;
  braking: boolean;
  onRing: boolean;
  pose: Pose;
  /** An ambulance running lights and siren. */
  ems?: boolean;
  /** 0 to 1: how far the ambulance has moved into the left lane to pass. */
  overtake?: number;
}

export interface Ped {
  id: number;
  road: number;
  dir: 1 | -1;
  off: number;
  speed: number;
  committed: boolean;
  onRoad: boolean;
  color: string;
  x: number;
  y: number;
}

export interface RunResult {
  pass: boolean;
  title: string;
  body: string;
}

export interface SimHooks {
  coach(kind: CoachKind, title: string, body: string, quiet?: boolean): void;
  sign(key: SignEventKey): void;
  exitsChanged(): void;
  signalChanged(left: boolean, right: boolean): void;
  lightsChanged(on: boolean): void;
  scoreChanged(score: number): void;
  driveStarted(): void;
  result(r: RunResult): void;
}

export interface RouteOptions {
  start: number;
  dest: number;
  leave: number;
  arrive: number;
  weather: Weather;
  /** Include an ambulance that comes through the rotary during the run. */
  ems: boolean;
}

/**
 * The score is 100 points split across driving skills. Steady habits (speed, following distance, lane position)
 * lose points for every second they slip, scaled by how far off they are; one-off rules lose a fixed amount.
 * Each category bottoms out at zero, so one bad habit can't wipe out the whole score.
 */
export type Category = 'speed' | 'following' | 'lane' | 'yield' | 'signals' | 'blind';
export const CATEGORIES: readonly { key: Category; label: string; weight: number; what: string }[] = [
  { key: 'yield', label: 'Right of way', weight: 30, what: 'Yielding to rotary traffic, pedestrians and emergency vehicles' },
  { key: 'speed', label: 'Speed control', weight: 20, what: 'Within 25 mph on the roads, near the 20 mph advisory in the rotary, and no stopping inside it' },
  { key: 'following', label: 'Following distance', weight: 15, what: 'At least a two-second gap to the car ahead (three in rain)' },
  { key: 'lane', label: 'Lane position and steering', weight: 15, what: 'Holding your lane, staying on the pavement, steering smoothly' },
  { key: 'signals', label: 'Signals and checks', weight: 10, what: 'Looking left before entering the rotary, signaling your exit, headlights in rain' },
  { key: 'blind', label: 'Checking blind spots', weight: 10, what: 'Before changing lanes: signal, check your mirror and over your shoulder, and merge only into a safe gap' },
];
/** Points lost per second at full severity, for the continuously measured categories. */
const RATE = { speed: 2, following: 1.5, lane: 1.5 } as const;
/** A run passes at this score, as long as there was no critical error. */
export const PASS_SCORE = 80;

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

/** Where a rule was broken, for the post-run debrief map. */
export interface Mark {
  key: string;
  title: string;
  x: number;
  y: number;
}

const crossed = (a: number, b: number, x: number): boolean => a < x && b >= x;

const WHEELBASE = 2.7;
/** Largest front-wheel angle at a standstill, in radians; it shrinks as speed rises. */
const STEER_MAX = 0.55;

/** True when `p` is on asphalt: an approach road, the circulating roadway, or the flare where they meet. */
export function onPavement(p: Pt): boolean {
  const r = Math.hypot(p.x, p.y);
  if (r >= R_IN && r <= R_OUT + 1.5) return true;
  for (const road of ROADS) {
    const u = U(road.phi);
    const n = N(road.phi);
    const along = p.x * u.x + p.y * u.y;
    const lat = Math.abs(p.x * n.x + p.y * n.y);
    if (along > R_IN && along < DEND + 40 && lat <= RW + 0.6) return true;
    if (along > R_IN && along < DY + 4 && lat <= RW + 5) return true;
    // The extra inbound lane on the right, until its taper runs out.
    const side = p.x * n.x + p.y * n.y;
    if (along > LANE_END && along < DEND + 40 && side < 0 && side >= inboundEdge(along) - 0.6) return true;
  }
  return false;
}

export class Simulation {
  cars: Car[] = [];
  peds: Ped[] = [];
  player!: Car;
  state: RunState = 'ready';
  /** Points lost so far in each category. */
  lost: Record<Category, number> = { speed: 0, following: 0, lane: 0, yield: 0, signals: 0, blind: 0 };
  /** A mistake that fails the run on its own, whatever the score (as on a road test). */
  critical: string | null = null;
  flags: Record<string, boolean> = {};
  traffic: Traffic = 'rush';
  trip: Trip = { leave: 510, arrive: 540, phase: 'day' };
  tripSec = 0;
  startIdx = 0;
  destIdx = 2;
  exitNum = 2;
  passedCount = 0;
  topMph = 0;
  simTime = 0;
  /** Right and left turn signals; at most one is on. */
  signal = false;
  signalLeft = false;
  headlights = false;
  weather: Weather = 'clear';
  /** Whether this run includes an ambulance, and whether it has appeared yet. */
  emsPlanned = false;
  emsSpawned = false;
  /** Where the ambulance comes from: the road to your left (yield to it) or up behind you (pull over). */
  emsFrom: 'left' | 'behind' = 'left';
  /** Rule breaks and the path driven, for the debrief map. */
  marks: Mark[] = [];
  trail: Pt[] = [];
  /** Front-wheel angle in radians; negative steers left. */
  steer = 0;
  readonly input = { gas: false, brake: false, look: false, left: false, right: false };

  private nextId = 1;
  private spawnT = 0;
  private pedT = 2;
  private stopT = 0;
  private lastLook = -99;
  private laneT = 0;
  private offT = 0;
  private sigAtExit = false;
  private missed = false;
  private darkT = 0;
  private pullT = 0;
  private emsWaited = false;
  private lightsNoted = false;
  /** Seconds each habit has been slipping, so a coach note appears only when it lasts. */
  private slipT: Record<string, number> = {};
  private shownScore = 100;
  /** Lane-change practice: whether you've moved out of the ending lane, and the car sent to sit in your blind spot. */
  private merged = false;
  private blindCarSent = false;
  private lastSide = 0;
  private emsPulled = false;
  private signEvents: { key: SignEventKey; s: number }[] = [];

  constructor(private readonly hooks: SimHooks) {}

  /** Current trip clock, in minutes after midnight. */
  tripNow(): number {
    return this.trip.leave + (this.tripSec * TIME_SCALE) / 60;
  }

  get score(): number {
    let total = 0;
    for (const c of CATEGORIES) total += Math.max(0, c.weight - this.lost[c.key]);
    return Math.round(total);
  }

  /** Points earned in each category, for the results card. */
  breakdown(): { key: Category; label: string; weight: number; got: number; what: string }[] {
    return CATEGORIES.map((c) => ({ ...c, got: Math.round(Math.max(0, c.weight - this.lost[c.key])) }));
  }

  zone(): 'approach' | 'rotary' | 'leaving' {
    const p = this.player;
    if (p.s < p.path.sYield) return 'approach';
    if (p.s < p.path.sExit) return 'rotary';
    return 'leaving';
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

  setHeadlights(on: boolean): void {
    this.headlights = on;
    this.hooks.lightsChanged(on);
    if (on && this.weather === 'rain' && this.state === 'driving' && !this.flags.lights && !this.lightsNoted) {
      this.lightsNoted = true;
      this.hooks.coach('good', 'Headlights on in the rain', 'Massachusetts law: whenever your wipers are running, your headlights must be on too. It helps other drivers see you.');
    }
  }

  /** The ambulance, if one is on the road. */
  ems(): Car | undefined {
    return this.cars.find((c) => c.ems);
  }

  restart(opts: RouteOptions): void {
    const old = this.player ? this.player.pose : null;
    this.startIdx = opts.start;
    this.destIdx = opts.dest;
    this.cars = this.cars.filter(
      (c) => !c.isPlayer && !c.ems && (!old || dist(c.pose, old) > 6) && !(c.path.inIdx === opts.start && c.s < c.path.sYield + 2),
    );
    this.weather = opts.weather;
    this.emsPlanned = opts.ems;
    this.emsSpawned = false;
    this.emsFrom = Math.random() < 0.5 ? 'left' : 'behind';
    this.exitNum = (opts.dest - opts.start + 4) % 4;
    this.trip.leave = opts.leave;
    this.trip.arrive = opts.arrive;
    const cond = conditionsFor(opts.leave);
    this.traffic = cond.traffic;
    this.trip.phase = cond.phase;
    this.tripSec = 0;

    const path = getPath(opts.start, opts.dest);
    // You start in the right-hand lane, which ends before the rotary, so every run includes a merge.
    const start = { ...roadPt(ROADS[opts.start].phi, DS - 8, -(RW + CURB_W / 2)), h: poseAt(path, 8).h };
    this.player = {
      id: 0, isPlayer: true, path, s: 8, v: 0, vmax: 0, ringV: 0, color: '#E0A50C', clearT: 0, cleared: true, waiting: false,
      stuck: 0, blockedBy: null, braking: false, onRing: false, pose: start,
    };
    this.lastSide = this.sideOffset();
    this.cars.push(this.player);
    this.state = 'ready';
    this.lost = { speed: 0, following: 0, lane: 0, yield: 0, signals: 0, blind: 0 };
    this.critical = null;
    this.slipT = {};
    this.shownScore = 100;
    this.flags = {};
    this.passedCount = 0;
    this.stopT = this.laneT = this.offT = 0;
    this.steer = 0;
    this.sigAtExit = this.missed = false;
    this.darkT = this.pullT = 0;
    this.emsWaited = this.lightsNoted = this.emsPulled = false;
    this.marks = [];
    this.trail = [];
    this.merged = this.blindCarSent = false;
    this.topMph = 0;
    this.lastLook = -99;
    this.signEvents = this.buildSignEvents();
    this.setSignal(false);
    this.setSignalLeft(false);
    // Night drivers already have their lights on; in rain it's up to you.
    this.setHeadlights(this.trip.phase === 'night');
    this.hooks.scoreChanged(this.score);

    const R = ROADS[opts.dest];
    this.hooks.coach('info', `Take Route ${R.route} to ${R.town}`,
      `It's the ${ORD[this.exitNum - 1]} exit. Your lane ends ahead, so merge left first: signal (Z), check your mirror and blind spot (hold Q), then move over. Look left and yield at the rotary, stay near 20 mph inside, and signal right before you leave.`);
    const tips: Record<Traffic, string> = {
      rush: 'Expect a steady stream of cars in the rotary and more people at crosswalks. Gaps are shorter, so be patient at the yield line.',
      moderate: 'Traffic is steady but gaps come regularly. Still look left every time before you enter.',
      light: 'Few cars are out, which tempts drivers to roll through the yield line. Slow down and check anyway.',
    };
    const light = this.trip.phase === 'night'
      ? ' It is dark: pedestrians are harder to see, so scan the crosswalk early.'
      : this.trip.phase === 'dawn' || this.trip.phase === 'dusk' ? ' Low sun and dim light make pedestrians harder to spot.' : '';
    const rain = this.weather === 'rain'
      ? ' It is raining: the road is slick, so brake earlier, and turn your headlights on (L) because your wipers are running.'
      : '';
    this.hooks.coach('info', `Leaving ${fmtT(this.trip.leave)}: ${TRAFFIC_LABEL[this.traffic].toLowerCase()}`,
      `${tips[this.traffic]}${light}${rain} You have ${this.trip.arrive - this.trip.leave} minutes to arrive by ${fmtT(this.trip.arrive)}.`);
  }

  step(dt: number): void {
    this.simTime += dt;
    for (const c of this.cars) if (!c.isPlayer) this.placeCar(c);
    const P = this.player;
    if (this.emsPlanned && !this.emsSpawned && this.state === 'driving' && P.s > (this.emsFrom === 'left' ? P.path.sYield - 70 : 25)) this.spawnEms();
    // An ambulance coming up behind you already fills the blind spot, so skip the extra car then.
    if (!this.blindCarSent && this.state === 'driving' && P.s > 12 && !(this.emsPlanned && this.emsFrom === 'behind')) this.spawnBlindCar();
    this.spawnT -= dt;
    if (this.spawnT <= 0) {
      this.spawnAI();
      this.spawnT = this.traffic === 'rush' ? rand(1.6, 2.8) : this.traffic === 'moderate' ? rand(3, 4.6) : rand(5, 8);
    }
    this.pedT -= dt;
    if (this.pedT <= 0) {
      this.spawnPed();
      const [pedLo, pedHi] = pedSpawnInterval(this.tripNow());
      const nightFactor = this.trip.phase === 'night' ? 2.5 : 1;
      this.pedT = rand(pedLo * nightFactor, pedHi * nightFactor);
    }
    if (this.state === 'driving') this.tripSec += dt;
    this.updatePeds(dt);
    for (const c of this.cars) if (!c.isPlayer) this.updateAI(c, dt);
    this.updatePlayer(dt);
    for (const c of this.cars) if (!c.isPlayer) this.placeCar(c);
    this.cars = this.cars.filter((c) => c.isPlayer || c.s < c.path.len - 1);
    if (this.state === 'driving') this.checkCrash();
  }

  /** Nearest obstacle along `a`'s path, as a distance ahead. */
  leadGap(a: Car): { gap: number; by: Car | Ped | null } {
    const L = 6 + a.v * 1.4;
    let best = Infinity;
    let by: Car | Ped | null = null;
    for (let ds = 2.5; ds <= 2.5 + L; ds += 1) {
      const q = poseAt(a.path, a.s + ds);
      for (const o of this.cars) {
        if (o === a) continue;
        const op = o.pose;
        if (Math.abs(op.x - q.x) > 2.6 || Math.abs(op.y - q.y) > 2.6) continue;
        if (dist(op, q) < 2.4) {
          if (o.blockedBy === a && (a.onRing || a.id < o.id)) continue;
          if (ds < best) { best = ds; by = o; }
        }
      }
      for (const p of this.peds) if (p.onRoad && dist(p, q) < 2.0 && ds < best) { best = ds; by = p; }
      if (by) break;
    }
    return { gap: best, by };
  }

  private mergeThreat(self: Car): Car | null {
    const M = self.path.M;
    for (const o of this.cars) {
      if (o === self || o.waiting) continue;
      if (o.s < o.path.sYield - 1) continue;
      // A car queued behind you in your own lane isn't circulating traffic.
      if (o.path.inIdx === self.path.inIdx && o.s < o.path.sMerge && o.s < self.s) continue;
      if (this.approaching(o, M, 2.4)) return o;
    }
    return null;
  }

  /** True when `o` will pass close to `M` within roughly `horizon` seconds (or has only just passed it, from `from` metres back). */
  private approaching(o: Car, M: Pt, horizon: number, from = -4): boolean {
    const reach = Math.max(o.v, 4) * horizon + 6;
    for (let ds = from; ds <= reach; ds += 1) if (dist(poseAt(o.path, o.s + ds), M) < 4) return true;
    return false;
  }

  /** Put an AI car on its path; an ambulance overtaking a pulled-over player swings into the left lane. */
  private placeCar(c: Car): void {
    c.pose = poseAt(c.path, c.s);
    const o = c.overtake ?? 0;
    if (o > 0) {
      c.pose.x += Math.sin(c.pose.h) * o * LANE * 2;
      c.pose.y -= Math.cos(c.pose.h) * o * LANE * 2;
    }
  }

  /**
   * Either an ambulance enters from the road to the player's left, timed to reach the player's entry about when
   * they do, and exits after it (ideally at the player's exit, so it follows them out); or it comes up behind the
   * player on their own approach road.
   */
  private spawnEms(): void {
    this.emsSpawned = true;
    const st = this.startIdx;
    const left = this.emsFrom === 'left';
    const i = left ? (st + 3) % 4 : st;
    const o = left
      ? this.destIdx === (st + 1) % 4 || this.destIdx === (st + 2) % 4 ? this.destIdx : (st + 1) % 4
      : this.destIdx;
    const path = getPath(i, o);
    const s = left ? path.sYield - 100 : 0;
    // Clear its lane so it isn't stuck behind ordinary traffic before the lesson starts.
    this.cars = this.cars.filter((c) => c.isPlayer || !(c.path.inIdx === i && (left ? Math.abs(c.s - s) < 10 : c.s < this.player.s + 4)));
    this.cars.push({
      id: this.nextId++, isPlayer: false, path, s, v: 13, vmax: 14, ringV: 9.5, color: '#F4F5F2', clearT: 0, cleared: true,
      waiting: false, stuck: 0, blockedBy: null, braking: false, onRing: false, pose: poseAt(path, s), ems: true, overtake: 0,
    });
    this.hooks.coach('warn', 'Siren approaching', left
      ? 'An ambulance is coming through the rotary from your left. Let it go first: don\'t enter in front of it, and never stop inside the rotary. Once you have exited, pull to the right and slow down so it can pass.'
      : 'An ambulance is coming up behind you. Ease off, keep to the right and slow down or stop so it can pass on your left. Don\'t speed up or brake suddenly.');
  }

  private spawnAI(): void {
    if (this.cars.length > 16) return;
    const i = (this.startIdx + 1 + Math.floor(Math.random() * 3)) % 4;
    let o: number;
    do o = Math.floor(Math.random() * 4); while (o === i);
    for (const c of this.cars) if (c.path.inIdx === i && c.s < 12) return;
    const path = getPath(i, o);
    this.cars.push({
      id: this.nextId++, isPlayer: false, path, s: 0, v: rand(9, 11), vmax: rand(10.5, 12.5), ringV: rand(6.8, 8.6),
      color: pickOne(AI_COLORS), clearT: 0, cleared: false, waiting: false, stuck: 0, blockedBy: null, braking: false,
      onRing: false, pose: poseAt(path, 0),
    });
  }

  private updateAI(a: Car, dt: number): void {
    const P = a.path;
    a.onRing = a.s >= P.sMerge && a.s < P.sExit;
    let target = a.vmax;
    if (a.onRing) target = Math.min(target, a.ringV);
    const toY = P.sYield - a.s;
    if (toY > 0 && toY < 30 && !a.ems) target = Math.min(target, 3 + toY * 0.26);
    if (a.ems) this.updateOvertake(a, dt);
    a.waiting = false;
    if (!a.cleared && toY > -0.5 && toY < 1.5) {
      const hold = () => { a.waiting = true; target = 0; a.v = Math.min(a.v, Math.max(0, toY) * 1.5); };
      if (this.mergeThreat(a)) { hold(); a.clearT = rand(0.3, 0.8); }
      else {
        a.clearT -= dt;
        if (a.clearT <= 0) a.cleared = true;
        else hold();
      }
    }
    let { gap, by } = this.leadGap(a);
    if (by === this.player && (a.overtake ?? 0) > 0.85) { gap = Infinity; by = null; }
    a.blockedBy = by && 'path' in by ? by : null;
    if (by) target = Math.min(target, Math.max(0, gap - 4.5) * 1.3);
    if (a.v < 0.2 && !a.waiting) a.stuck += dt;
    else a.stuck = 0;
    if (a.stuck > 5 && by && 'path' in by && !by.isPlayer) target = 3;
    a.braking = target < a.v - 0.3 || a.v < 0.2;
    if (a.v < target) a.v = Math.min(target, a.v + 2.6 * dt);
    else a.v = Math.max(target, a.v - 7 * dt);
    a.s += a.v * dt;
  }

  /** How far ahead of the ambulance the player is, when both are on the same approach or exit road; null otherwise. */
  emsBehind(a: Car): number | null {
    const P = this.player;
    const sameIn = a.path.inIdx === P.path.inIdx && a.s < a.path.sYield && P.s < P.path.sYield;
    const sameOut = a.path.outIdx === P.path.outIdx && a.s > a.path.sExit - 5 && P.s > P.path.sExit;
    if (!sameIn && !sameOut) return null;
    const ahead = (P.pose.x - a.pose.x) * Math.cos(a.pose.h) + (P.pose.y - a.pose.y) * Math.sin(a.pose.h);
    return dist(a.pose, P.pose) < 40 ? ahead : null;
  }

  /** Once the player has slowed on the exit road, the ambulance swings left, passes, and pulls back in. */
  private updateOvertake(a: Car, dt: number): void {
    const ahead = this.emsBehind(a);
    const want = ahead !== null && ahead > -10 && (this.player.v < 3 || (a.overtake ?? 0) > 0.5) ? 1 : 0;
    a.overtake = Math.max(0, Math.min(1, (a.overtake ?? 0) + (want ? dt : -dt * 0.7)));
  }

  private spawnPed(): void {
    // Bias crossings toward the player's own approach so the crosswalk rule actually comes up.
    const road = Math.random() < 0.45 ? this.startIdx : (this.startIdx + 1 + Math.floor(Math.random() * 3)) % 4;
    if (this.peds.some((p) => p.road === road)) return;
    const dir: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
    const p: Ped = {
      id: this.nextId++, road, dir, off: -9 * dir, speed: rand(1.4, 1.8), committed: false, onRoad: false,
      color: pickOne(PED_COLORS), x: 0, y: 0,
    };
    this.placePed(p);
    this.peds.push(p);
  }

  private placePed(p: Ped): void {
    const q = roadPt(ROADS[p.road].phi, DCW, p.off);
    p.x = q.x;
    p.y = q.y;
    p.onRoad = Math.abs(p.off) < RW + 0.5;
  }

  private carNear(p: Ped): boolean {
    const phi = ROADS[p.road].phi;
    const a = roadPt(phi, DCW, -LANE);
    const b = roadPt(phi, DCW, LANE);
    return this.cars.some((c) => {
      const d = Math.min(dist(c.pose, a), dist(c.pose, b));
      return d < 3 || (c.v > 1 && d < 14);
    });
  }

  private updatePeds(dt: number): void {
    for (const p of this.peds) {
      if (!p.committed && p.dir * p.off >= -(RW + 1.2)) {
        if (this.carNear(p)) { this.placePed(p); continue; }
        p.committed = true;
      }
      p.off += p.dir * p.speed * dt;
      this.placePed(p);
    }
    this.peds = this.peds.filter((p) => p.dir * p.off < 9.5);
  }

  private buildSignEvents(): { key: SignEventKey; s: number }[] {
    const pt = this.player.path;
    const ev: { key: SignEventKey; s: number }[] = [
      { key: 'speed', s: DS - 172 - 30 },
      { key: 'lanes', s: DS - 160 - 28 },
      { key: 'diagram', s: DS - 140 - 45 },
      { key: 'warn', s: DS - 105 - 35 },
      { key: 'ped', s: DS - 70 - 35 },
      { key: 'law', s: DS - (DCW + 3.5) - 40 },
      { key: 'yield', s: DS - DY - 22 },
      { key: 'oneway', s: pt.sYield + 1 },
    ];
    let th = ROADS[this.destIdx].phi + 32 * DEG;
    while (th >= pt.ta) th -= TAU;
    ev.push({ key: 'exit', s: pt.sMerge + (pt.ta - th) * RC - 10 });
    return ev.sort((a, b) => a.s - b.s);
  }

  private updatePlayer(dt: number): void {
    const P = this.player;
    const inp = this.input;
    if (this.state === 'ready' && inp.gas) {
      this.state = 'driving';
      this.hooks.driveStarted();
    }
    if (this.state === 'crashed') { P.v = 0; return; }
    const paved = onPavement(P.pose);
    let acc: number;
    if (this.state === 'done') acc = 1.5;
    else if (this.state === 'ready') acc = -4;
    // Wet pavement: tyres grip less, so the same pedal press stops you over a longer distance.
    else acc = inp.brake ? (this.weather === 'rain' ? -5.5 : -7.5) : inp.gas ? 3.2 : -0.6;
    if (!paved && P.v > 4) acc = Math.min(acc, -5); // curbs and grass hold you to about 9 mph
    P.v = Math.max(0, Math.min(16, P.v + acc * dt));
    this.drive(P, dt);
    const s0 = P.s;
    P.s = this.progress(P);
    const s1 = P.s;
    if (inp.look) this.lastLook = this.simTime;
    if (this.state !== 'driving') return;

    const pt = P.path;
    const f0 = s0 + 2.2;
    const f1 = s1 + 2.2;
    P.onRing = s1 >= pt.sMerge && s1 < pt.sExit;
    this.topMph = Math.max(this.topMph, P.v * MPHF);
    while (this.signEvents.length && this.signEvents[0].s <= s1) this.hooks.sign(this.signEvents.shift()!.key);
    const tail = this.trail[this.trail.length - 1];
    if (!tail || dist(tail, P.pose) > 1) this.trail.push({ x: P.pose.x, y: P.pose.y });

    if (this.weather === 'rain' && !this.headlights) {
      this.darkT += dt;
      if (this.darkT > 5) this.violate('lights', 'signals', 2, 'Wipers on, headlights on', 'Massachusetts law requires headlights whenever your wipers are running. Press L to turn them on.');
    }
    this.checkEms(P, dt, f1);

    this.checkMerge(P);
    if (this.merged && this.signalLeft && this.sideOffset() > -RW + 1.2) this.setSignalLeft(false);
    this.assess(P, dt, paved);

    if (crossed(f0, f1, pt.sCW - 2) && this.peds.some((p) => p.road === this.startIdx && p.onRoad)) {
      this.violate('ped', 'yield', 15, 'You drove through an occupied crosswalk', 'Massachusetts law requires drivers to yield to people in a crosswalk. The in-street "State Law" sign is your reminder. Stop before the white bars.', true);
    }
    if (crossed(f0, f1, pt.sYield)) {
      if (this.simTime - this.lastLook > 8) this.violate('look', 'signals', 3, 'Check left before you enter', 'Traffic in a rotary comes from your left. Hold Look left as you reach the yield line so you can judge the gap.');
      const e = this.ems();
      if (e && e.path.inIdx !== pt.inIdx && this.approaching(e, pt.M, 4, 0)) {
        this.violate('ems', 'yield', 12, "Don't pull out in front of an ambulance", 'Emergency vehicles with lights and siren have the right of way. Wait at the yield line until it has passed, then enter.', true);
      } else if (this.mergeThreat(P)) this.violate('yield', 'yield', 15, 'You failed to yield entering the rotary', 'A car already circulating was heading for your entry point. The Yield sign means traffic in the rotary goes first. Stop at the triangles and wait for a gap.', true);
      else if (this.emsWaited) this.hooks.coach('good', 'You let the ambulance through', 'Waiting at the yield line kept its path clear. Entering only after it passed was exactly right.');
      else this.hooks.coach('good', 'Clean entry', 'You entered with a safe gap. Cars already in the rotary have the right of way; entering drivers wait for them.');
    }
    for (const ps of pt.passes) {
      if (!crossed(s0, s1, ps.s)) continue;
      this.passedCount++;
      this.hooks.exitsChanged();
      if (this.signal && !this.flags.early) {
        this.flags.early = true;
        this.lose('signals', 1);
        this.hooks.coach('warn', 'Signal a little later', `Your blinker was on as you passed the ${ROADS[ps.road].town} exit. Drivers waiting there may think you're leaving. Signal after you pass the exit before yours.`);
      }
    }
    if (P.onRing && P.v < 0.4) {
      if (this.leadGap(P).gap > 10) {
        this.stopT += dt;
        if (this.stopT > 1.5) this.violate('stop', 'speed', 5, "Don't stop inside the rotary", this.ems()
          ? 'Even with a siren behind you, keep moving in the rotary. Stopping in the circle traps the ambulance. Exit first, then pull to the right.'
          : 'Once you are in, keep moving with traffic unless something blocks you. Stopping in the circle invites rear-end crashes.');
      }
    } else this.stopT = 0;
    if (crossed(s0, s1, pt.sExit)) this.sigAtExit = this.signal;
    if (crossed(s0, s1, pt.sOff)) {
      if (this.sigAtExit) this.hooks.coach('good', 'Exit signaled', 'Your right blinker told drivers waiting at this entry that you were leaving, so they could go sooner.');
      else this.violate('signal', 'signals', 4, 'No exit signal', 'Turn on your right signal after you pass the exit before yours, so waiting drivers know you are leaving.');
    }
    if (crossed(s0, s1, pt.sOff + 6) && this.signal) this.setSignal(false);
    this.checkPosition(P, dt, paved);
    if (this.state !== 'driving') return;
    if (s1 > pt.sOff + 45) this.finish();
  }

  /** Ambulance rules: wait for it at the yield line, and pull over once you've exited ahead of it. */
  private checkEms(P: Car, dt: number, f1: number): void {
    const e = this.ems();
    if (!e) return;
    const pt = P.path;
    if (f1 < pt.sYield && f1 > pt.sYield - 8 && P.v < 0.5 && this.approaching(e, pt.M, 4, 0)) this.emsWaited = true;
    const ahead = this.emsBehind(e);
    if (ahead === null || ahead < 0) return;
    if (P.v < 2) {
      if (!this.emsPulled && !this.flags['ems-pull']) {
        this.emsPulled = true;
        this.hooks.coach('good', 'You pulled over for the ambulance', 'Slowing and keeping right let it pass safely. Wait until it is well clear before you speed up again.');
      }
      return;
    }
    if (this.emsPulled) return;
    this.pullT += dt;
    if (this.pullT > 4) this.violate('ems-pull', 'yield', 4, 'Pull over and let it pass', 'With an ambulance behind you, slow down and keep to the right so it can get by. In a rotary, wait until you have exited.');
  }

  /** Move the player with a simple bicycle model: the arrow keys turn the front wheels, which self-centre when released. */
  private drive(P: Car, dt: number): void {
    const inp = this.input;
    const dir = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
    const lim = STEER_MAX / (1 + P.v * 0.12);
    const rate = dir ? 1.4 : 3;
    const want = dir * lim;
    this.steer += Math.max(-rate * dt, Math.min(rate * dt, want - this.steer));
    this.steer = Math.max(-lim, Math.min(lim, this.steer));
    const p = P.pose;
    p.h += ((P.v * Math.tan(this.steer)) / WHEELBASE) * dt;
    const nx = p.x + Math.cos(p.h) * P.v * dt;
    const ny = p.y + Math.sin(p.h) * P.v * dt;
    // Edge of the modelled town: stop rather than drive into the void.
    if (Math.hypot(nx, ny) > DEND + 60) { P.v = 0; return; }
    p.x = nx;
    p.y = ny;
  }

  /** Where the player is along their planned route, found from their free position. */
  private progress(P: Car): number {
    const pt = P.path;
    const s0 = P.s;
    let best = s0;
    let bd = Infinity;
    for (let s = Math.max(0, s0 - 4); s <= Math.min(pt.len, s0 + 12); s += 0.5) {
      const d = dist(poseAt(pt, s), P.pose);
      if (d < bd) { bd = d; best = s; }
    }
    const r = Math.hypot(P.pose.x, P.pose.y);
    if (s0 < pt.sMerge - 1 || bd < 3 || r < R_IN - 1.5 || r > R_OUT + 1.5) return best;
    // Circulating but off the planned line: measure progress by ring angle instead.
    let a = (pt.ta - Math.atan2(P.pose.y, P.pose.x)) % TAU;
    if (a < 0) a += TAU;
    const sr = pt.sMerge + a * RC;
    if (sr <= pt.sExit) {
      if (sr < s0 - 20) this.newLap();
      return sr;
    }
    if (!this.missed && this.state === 'driving') {
      this.missed = true;
      this.hooks.coach('warn', 'Missed your exit? Go around again', "That's fine in a rotary. Stay in the circle, keep moving, and take your exit when it comes back around.");
    }
    return s0;
  }

  private newLap(): void {
    this.passedCount = 0;
    this.missed = false;
    this.hooks.exitsChanged();
    const ev = this.buildSignEvents().find((e) => e.key === 'exit');
    if (ev && !this.signEvents.some((e) => e.key === 'exit')) this.signEvents.unshift(ev);
  }

  /** Lane, off-road and wrong-exit checks for a car that can now go anywhere. */
  private checkPosition(P: Car, dt: number, paved: boolean): void {
    const pt = P.path;
    const p = P.pose;
    const r = Math.hypot(p.x, p.y);
    if (r < R_IN - 0.3) {
      this.violate('island', 'lane', 5, 'You drove onto the centre island', 'Stay on the circulating roadway. The island is not a shortcut, even when the rotary looks empty.');
    } else if (!paved) {
      this.offT += dt;
      if (this.offT > 0.4) this.violate('offroad', 'lane', 3, 'You left the road', 'Keep all four wheels on the pavement. Ease off the gas and steer gently back into your lane.');
    } else this.offT = 0;

    if (P.s < pt.sYield - 2 || P.s > pt.sOff + 2) {
      const q = poseAt(pt, P.s);
      const leftOff = (p.x - q.x) * Math.sin(q.h) - (p.y - q.y) * Math.cos(q.h);
      if (leftOff > LANE + 0.4) {
        this.laneT += dt;
        if (this.laneT > 0.6) this.violate('lane', 'lane', 3, 'Keep right of the yellow line', 'You drifted into oncoming traffic. Stay in the right-hand lane on two-way roads.');
      } else this.laneT = 0;
    }

    if (P.s < pt.sMerge) return;
    for (let i = 0; i < 4; i++) {
      if (i === pt.outIdx) continue;
      const u = U(ROADS[i].phi);
      const n = N(ROADS[i].phi);
      if (p.x * u.x + p.y * u.y > DY + 8 && Math.abs(p.x * n.x + p.y * n.y) < RW + 3) return this.wrongExit(i);
    }
  }

  private wrongExit(road: number): void {
    this.state = 'done';
    const took = ROADS[road];
    const want = ROADS[this.destIdx];
    this.hooks.coach('warn', `You left toward ${took.town}`, `Your exit was Route ${want.route} to ${want.town}. If you miss an exit in a real rotary, don't brake or swerve: stay in the circle and go around again.`);
    const pass = this.score >= PASS_SCORE && !this.critical;
    this.hooks.result({
      pass, title: 'Wrong exit',
      body: `You took Route ${took.route} to ${took.town} instead of Route ${want.route} to ${want.town}. That isn't a rule break, so it doesn't cost points, but watch the exit count and the green guide signs.${this.critical ? ` Critical error: ${this.critical}.` : ''}`,
    });
  }

  /**
   * A broken rule: noted once per run, with a fixed deduction from its category (0 for habits that are scored
   * continuously instead). Critical errors fail the run whatever the score.
   */
  private violate(key: string, cat: Category, pts: number, title: string, body: string, critical = false): void {
    if (this.flags[key]) return;
    this.flags[key] = true;
    this.mark(key, title);
    if (critical && !this.critical) this.critical = title;
    this.lose(cat, pts);
    const label = CATEGORIES.find((c) => c.key === cat)!.label;
    this.hooks.coach('bad', title, `${body} (${pts ? `−${pts} ` : ''}${label}${critical ? ', critical error' : ''})`);
  }

  private lose(cat: Category, pts: number): void {
    this.lost[cat] += pts;
    const sc = this.score;
    if (sc !== this.shownScore) {
      this.shownScore = sc;
      this.hooks.scoreChanged(sc);
    }
  }

  /** Track how long `key` has been slipping; true once it has lasted `after` seconds (and only once per run). */
  private sustained(key: string, bad: boolean, dt: number, after: number): boolean {
    this.slipT[key] = bad ? (this.slipT[key] ?? 0) + dt : 0;
    return this.slipT[key] > after && !this.flags[key];
  }

  /** Every frame of driving: speed, following distance and lane position, each scaled by how far off it is. */
  private assess(P: Car, dt: number, paved: boolean): void {
    const zone = this.zone();
    const mph = P.v * MPHF;

    // Speed: a 2 mph cushion, then up to full severity 5 mph over (6 over the rotary's 20 mph advisory).
    const ring = zone === 'rotary';
    const limit = ring ? 20 : 25;
    const sp = clamp01((mph - limit - 2) / (ring ? 6 : 5));
    this.lose('speed', sp * RATE.speed * dt);
    if (this.sustained(ring ? 'speed' : 'approach', sp > 0, dt, 1.2)) {
      if (ring) this.violate('speed', 'speed', 0, 'Too fast for the rotary', `You hit ${Math.round(mph)} mph. The yellow plaque advised 20. Slower speeds give you time to react to merging cars.`);
      else this.violate('approach', 'speed', 0, 'Over the speed limit', `You hit ${Math.round(mph)} mph in a 25 zone. Ease off early so you arrive at the rotary slowly enough to judge gaps.`);
    }

    // Following distance: the two-second rule, three seconds on wet roads.
    const need = this.weather === 'rain' ? 3 : 2;
    let fl = 0;
    if (P.v > 3) {
      const h = Math.max(0, this.followGap(P)) / P.v;
      fl = clamp01((need - h) / (need - 0.5));
    }
    this.lose('following', fl * RATE.following * dt);
    if (this.sustained('follow', fl > 0.3, dt, 1.5)) {
      this.violate('follow', 'following', 0, 'Too close to the car ahead', `Keep at least ${need === 3 ? 'three seconds' : 'two seconds'} behind: pick a fixed point, and when the car ahead passes it you should be able to count "one thousand one, one thousand two"${need === 3 ? ', "one thousand three"' : ''} before you reach it.`);
    }

    // Lane position: drift from the planned line (looser through the curves and the rotary), plus harsh swerves.
    const pt = P.path;
    const curve = P.s > pt.sYield - 2 && P.s < pt.sOff + 2;
    const tol = curve ? 1.6 : 0.7;
    let dev = dist(P.pose, poseAt(pt, P.s));
    const along = this.alongStart();
    if (P.s < pt.sYield && along > LANE_END) {
      const o = this.sideOffset();
      dev = Math.min(Math.abs(o + LANE), Math.abs(o - curbCentre(along)));
    }
    const drift = paved ? clamp01((dev - tol) / 1.5) : 1;
    const latAcc = (P.v * P.v * Math.abs(Math.tan(this.steer))) / WHEELBASE;
    const swerve = clamp01((latAcc - 4.5) / 3);
    this.lose('lane', Math.max(drift, swerve) * RATE.lane * dt);
    if (paved && this.sustained('drift', drift > 0.3, dt, 1.5)) {
      this.violate('drift', 'lane', 0, 'Hold your lane', 'You wandered from the middle of your lane. Look well ahead, not at the hood, and make small steering corrections.');
    }
    if (this.sustained('swerve', swerve > 0.4, dt, 0.4)) {
      this.violate('swerve', 'lane', 0, 'Steer more gently', 'That was a sharp turn for your speed. Slow down before the curve, then steer smoothly.');
    }
  }

  /** How far you are from the rotary along your own approach road. */
  private alongStart(): number {
    const u = U(ROADS[this.startIdx].phi);
    return this.player.pose.x * u.x + this.player.pose.y * u.y;
  }

  /** Your sideways offset from your approach road's centre line: −2 is the main lane, −6 the lane that ends. */
  private sideOffset(): number {
    const n = N(ROADS[this.startIdx].phi);
    return this.player.pose.x * n.x + this.player.pose.y * n.y;
  }

  /**
   * A car in the continuing lane, a little behind you and a little faster, so it is passing through your
   * blind spot around the time your lane starts to end.
   */
  private spawnBlindCar(): void {
    this.blindCarSent = true;
    const P = this.player;
    const st = this.startIdx;
    let o: number;
    do o = Math.floor(Math.random() * 4); while (o === st);
    const path = getPath(st, o);
    const s = Math.max(0, P.s - rand(10, 18));
    this.cars = this.cars.filter((c) => c.isPlayer || !(c.path.inIdx === st && c.s < P.s + 6));
    this.cars.push({
      id: this.nextId++, isPlayer: false, path, s, v: Math.max(8, P.v + 3.5), vmax: 11.8, ringV: rand(6.8, 8.6),
      color: pickOne(AI_COLORS), clearT: 0, cleared: false, waiting: false, stuck: 0, blockedBy: null, braking: false,
      onRing: false, pose: poseAt(path, s),
    });
  }

  /** The merge out of the ending lane: signal, mirror and shoulder check, and a gap in the lane you move into. */
  private checkMerge(P: Car): void {
    if (this.merged || P.s > P.path.sYield) return;
    const o = this.sideOffset();
    const was = this.lastSide;
    this.lastSide = o;
    const along = this.alongStart();
    if (was < -RW && o >= -RW) {
      this.merged = true;
      let clean = true;
      if (!this.signalLeft) {
        clean = false;
        this.violate('lc-signal', 'blind', 3, 'Signal before you change lanes', 'Turn on your left signal (Z) a few seconds before you move over, so drivers behind you know what you are about to do.');
      }
      if (this.simTime - this.lastLook > 3) {
        clean = false;
        this.violate('lc-look', 'blind', 4, 'Check your blind spot', "Mirrors miss the area just behind your left shoulder. Before you move left, check your left mirror, then hold Q to glance over your shoulder.");
      }
      const f = U(P.pose.h);
      const cut = this.cars.find((c) => {
        if (c.isPlayer || c.path.inIdx !== this.startIdx || c.s > c.path.sYield) return false;
        const rel = (c.pose.x - P.pose.x) * f.x + (c.pose.y - P.pose.y) * f.y;
        return rel > -10 && rel < 4;
      });
      if (cut) {
        clean = false;
        this.violate('lc-unsafe', 'blind', 6, 'Unsafe lane change', 'A car was right beside you in the lane you moved into. Let it pass, then merge into the gap behind it.', true);
      }
      if (clean) this.hooks.coach('good', 'Clean lane change', 'Signal, mirror, shoulder check, then a smooth move into a safe gap. That is exactly how to change lanes.');
    } else if (o < -RW - 0.5 && along < LANE_END + 1) {
      this.merged = true;
      this.violate('lc-missed', 'blind', 6, 'Merge before your lane ends', 'Your lane ran out. Signal and merge early, while there is still room, instead of waiting for the end of the taper.');
    }
  }

  /** Bumper-to-bumper gap to a car travelling the same way ahead on your line; Infinity if none is close. */
  private followGap(P: Car): number {
    // Nobody drives ahead of you in the ending lane.
    if (P.s < P.path.sYield && this.sideOffset() < -RW) return Infinity;
    const range = Math.max(12, P.v * 3.3) + 5;
    for (let ds = 3; ds <= range; ds += 1) {
      const q = poseAt(P.path, P.s + ds);
      for (const o of this.cars) {
        if (o === P) continue;
        if (Math.abs(o.pose.x - q.x) > 2.6 || Math.abs(o.pose.y - q.y) > 2.6) continue;
        if (dist(o.pose, q) > 2.2) continue;
        // Crossing and oncoming traffic isn't "the car ahead".
        if (Math.cos(o.pose.h - P.pose.h) < 0.6) continue;
        return ds - 4.4;
      }
    }
    return Infinity;
  }

  private checkCrash(): void {
    const pp = this.player.pose;
    const front = add(pp, U(pp.h), 1.8);
    for (const c of this.cars) if (!c.isPlayer && dist(c.pose, pp) < 3.0) return this.crash('car');
    for (const p of this.peds) if (dist(p, pp) < 1.5 || dist(p, front) < 1.2) return this.crash('ped');
    // Rows of houses line each road from 46 m out, set back 10.5 m from its centreline (see World.buildHouses).
    for (const r of ROADS) {
      const along = front.x * Math.cos(r.phi) + front.y * Math.sin(r.phi);
      const lat = Math.abs(-front.x * Math.sin(r.phi) + front.y * Math.cos(r.phi));
      if (along > 46 && along < DEND && lat > 10.3 && lat < 21) return this.crash('house');
    }
  }

  private mark(key: string, title: string): void {
    this.marks.push({ key, title, x: this.player.pose.x, y: this.player.pose.y });
  }

  private crash(kind: 'car' | 'ped' | 'house'): void {
    this.state = 'crashed';
    const what = kind === 'car' ? 'Collision' : kind === 'house' ? 'Hit a building' : 'Hit a pedestrian';
    this.mark('crash', what);
    this.critical = what;
    this.lose(kind === 'house' ? 'lane' : 'yield', 30);
    if (kind === 'car') {
      this.hooks.coach('bad', 'Collision', 'You and a circulating car reached the same spot. Slow down early, look left, and enter only when the gap is clear.');
      this.hooks.result({ pass: false, title: 'Collision', body: 'Wait for a real gap at the yield line next time.' });
    } else if (kind === 'house') {
      this.hooks.coach('bad', 'You hit a building', 'You left the road and struck a house. If you drift off the pavement, brake and steer gently back into your lane.');
      this.hooks.result({ pass: false, title: 'Off the road', body: 'Keep the car between the curbs, and slow down before you steer hard.' });
    } else {
      this.hooks.coach('bad', 'You hit a pedestrian', 'Watch the crosswalk on your approach and be ready to stop before the white bars.');
      this.hooks.result({ pass: false, title: 'Pedestrian struck', body: 'Scan the crosswalk before you reach it.' });
    }
  }

  private finish(): void {
    this.state = 'done';
    const pass = this.score >= PASS_SCORE && !this.critical;
    const misses = Object.keys(this.flags).filter((k) => k !== 'early').length;
    const at = this.tripNow();
    const diff = Math.round(this.trip.arrive - at);
    const timing = diff >= 0 ? `Arrived ${fmtT(at)}, ${diff} min early.` : `Arrived ${fmtT(at)}, ${-diff} min late.`;
    if (diff < 0) {
      this.hooks.coach('warn', `You arrived ${-diff} min late`, 'Next time, leave earlier instead of rushing. Waiting for a safe gap only costs a minute or two, and your score counts safety, not speed.');
    } else {
      this.hooks.coach('good', `On time with ${diff} min to spare`, 'A buffer in your plan means you never feel pressure to squeeze into a tight gap.');
    }
    const verdict = pass
      ? misses ? 'You made it out safely. Check the coach notes for what to tighten up.' : 'Clean run. Try a rush-hour or nighttime departure next.'
      : this.critical
        ? `You reached your exit, but "${this.critical}" is a critical error that fails the run on its own. Review the coach notes and try again.`
        : `You reached your exit, but your driving scored below ${PASS_SCORE}. Check the breakdown to see which habits cost the most.`;
    this.hooks.result({ pass, title: pass ? 'Passed' : 'Try again', body: `${verdict} ${timing}` });
  }
}
