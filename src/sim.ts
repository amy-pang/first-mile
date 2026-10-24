/** Traffic, pedestrians, the player's car and the rule checks. No DOM or three.js in here. */
import {
  AI_COLORS, DCW, DEG, DEND, DS, DY, LANE, LIMIT_APP, LIMIT_RING, MPHF, ORD, PED_COLORS, R_IN, R_OUT, RC, ROADS, RW, TAU,
  TIME_SCALE, type Pose, type Pt,
} from './constants';
import { add, dist, N, pickOne, rand, roadPt, U } from './math';
import { getPath, poseAt, type Path } from './path';
import type { SignKey } from './signs';
import { conditionsFor, fmtT, TRAFFIC_LABEL, type Traffic, type Trip } from './trip';

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
  signalChanged(on: boolean): void;
  scoreChanged(score: number): void;
  driveStarted(): void;
  result(r: RunResult): void;
}

export interface RouteOptions {
  start: number;
  dest: number;
  leave: number;
  arrive: number;
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
  }
  return false;
}

export class Simulation {
  cars: Car[] = [];
  peds: Ped[] = [];
  player!: Car;
  state: RunState = 'ready';
  score = 100;
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
  signal = false;
  /** Front-wheel angle in radians; negative steers left. */
  steer = 0;
  readonly input = { gas: false, brake: false, look: false, left: false, right: false };

  private nextId = 1;
  private spawnT = 0;
  private pedT = 2;
  private spT = 0;
  private apT = 0;
  private stopT = 0;
  private lastLook = -99;
  private laneT = 0;
  private offT = 0;
  private sigAtExit = false;
  private missed = false;
  private signEvents: { key: SignEventKey; s: number }[] = [];

  constructor(private readonly hooks: SimHooks) {}

  /** Current trip clock, in minutes after midnight. */
  tripNow(): number {
    return this.trip.leave + (this.tripSec * TIME_SCALE) / 60;
  }

  zone(): 'approach' | 'rotary' | 'leaving' {
    const p = this.player;
    if (p.s < p.path.sYield) return 'approach';
    if (p.s < p.path.sExit) return 'rotary';
    return 'leaving';
  }

  setSignal(on: boolean): void {
    this.signal = on;
    this.hooks.signalChanged(on);
  }

  restart(opts: RouteOptions): void {
    const old = this.player ? this.player.pose : null;
    this.startIdx = opts.start;
    this.destIdx = opts.dest;
    this.cars = this.cars.filter(
      (c) => !c.isPlayer && (!old || dist(c.pose, old) > 6) && !(c.path.inIdx === opts.start && c.s < c.path.sYield + 2),
    );
    this.exitNum = (opts.dest - opts.start + 4) % 4;
    this.trip.leave = opts.leave;
    this.trip.arrive = opts.arrive;
    const cond = conditionsFor(opts.leave);
    this.traffic = cond.traffic;
    this.trip.phase = cond.phase;
    this.tripSec = 0;

    const path = getPath(opts.start, opts.dest);
    this.player = {
      id: 0, isPlayer: true, path, s: 8, v: 0, vmax: 0, ringV: 0, color: '#E0A50C', clearT: 0, cleared: true, waiting: false,
      stuck: 0, blockedBy: null, braking: false, onRing: false, pose: poseAt(path, 8),
    };
    this.cars.push(this.player);
    this.state = 'ready';
    this.score = 100;
    this.flags = {};
    this.passedCount = 0;
    this.spT = this.apT = this.stopT = this.laneT = this.offT = 0;
    this.steer = 0;
    this.sigAtExit = this.missed = false;
    this.topMph = 0;
    this.lastLook = -99;
    this.signEvents = this.buildSignEvents();
    this.setSignal(false);
    this.hooks.scoreChanged(this.score);

    const R = ROADS[opts.dest];
    this.hooks.coach('info', `Take Route ${R.route} to ${R.town}`,
      `It's the ${ORD[this.exitNum - 1]} exit. Read the signs on the way in, look left and yield at the rotary, stay near 20 mph inside, and signal right before you leave.`);
    const tips: Record<Traffic, string> = {
      rush: 'Expect a steady stream of cars in the rotary and more people at crosswalks. Gaps are shorter, so be patient at the yield line.',
      moderate: 'Traffic is steady but gaps come regularly. Still look left every time before you enter.',
      light: 'Few cars are out, which tempts drivers to roll through the yield line. Slow down and check anyway.',
    };
    const light = this.trip.phase === 'night'
      ? ' It is dark: pedestrians are harder to see, so scan the crosswalk early.'
      : this.trip.phase === 'dawn' || this.trip.phase === 'dusk' ? ' Low sun and dim light make pedestrians harder to spot.' : '';
    this.hooks.coach('info', `Leaving ${fmtT(this.trip.leave)}: ${TRAFFIC_LABEL[this.traffic].toLowerCase()}`,
      `${tips[this.traffic]}${light} You have ${this.trip.arrive - this.trip.leave} minutes to arrive by ${fmtT(this.trip.arrive)}.`);
  }

  step(dt: number): void {
    this.simTime += dt;
    for (const c of this.cars) if (!c.isPlayer) c.pose = poseAt(c.path, c.s);
    this.spawnT -= dt;
    if (this.spawnT <= 0) {
      this.spawnAI();
      this.spawnT = this.traffic === 'rush' ? rand(1.6, 2.8) : this.traffic === 'moderate' ? rand(3, 4.6) : rand(5, 8);
    }
    this.pedT -= dt;
    if (this.pedT <= 0) {
      this.spawnPed();
      this.pedT = this.trip.phase === 'night' ? rand(9, 15) : this.traffic === 'rush' ? rand(3.5, 6.5) : rand(5, 9);
    }
    if (this.state === 'driving') this.tripSec += dt;
    this.updatePeds(dt);
    for (const c of this.cars) if (!c.isPlayer) this.updateAI(c, dt);
    this.updatePlayer(dt);
    for (const c of this.cars) if (!c.isPlayer) c.pose = poseAt(c.path, c.s);
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
      const reach = Math.max(o.v, 4) * 2.4 + 6;
      for (let ds = -4; ds <= reach; ds += 1) if (dist(poseAt(o.path, o.s + ds), M) < 4) return o;
    }
    return null;
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
    if (toY > 0 && toY < 30) target = Math.min(target, 3 + toY * 0.26);
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
    const { gap, by } = this.leadGap(a);
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
    else acc = inp.brake ? -7.5 : inp.gas ? 3.2 : -0.6;
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

    if (s1 < pt.sYield && P.v > LIMIT_APP) {
      this.apT += dt;
      if (this.apT > 1.5) this.violate('approach', 5, 'Speeding on the approach', `You hit ${Math.round(P.v * MPHF)} mph in a 25 zone. Ease off early so you arrive at the rotary slowly enough to judge gaps.`);
    } else this.apT = 0;

    if (crossed(f0, f1, pt.sCW - 2) && this.peds.some((p) => p.road === this.startIdx && p.onRoad)) {
      this.violate('ped', 35, 'You drove through an occupied crosswalk', 'Massachusetts law requires drivers to yield to people in a crosswalk. The in-street "State Law" sign is your reminder. Stop before the white bars.');
    }
    if (crossed(f0, f1, pt.sYield)) {
      if (this.simTime - this.lastLook > 8) this.violate('look', 5, 'Check left before you enter', 'Traffic in a rotary comes from your left. Hold Look left as you reach the yield line so you can judge the gap.');
      if (this.mergeThreat(P)) this.violate('yield', 35, 'You failed to yield entering the rotary', 'A car already circulating was heading for your entry point. The Yield sign means traffic in the rotary goes first. Stop at the triangles and wait for a gap.');
      else this.hooks.coach('good', 'Clean entry', 'You entered with a safe gap. Cars already in the rotary have the right of way; entering drivers wait for them.');
    }
    for (const ps of pt.passes) {
      if (!crossed(s0, s1, ps.s)) continue;
      this.passedCount++;
      this.hooks.exitsChanged();
      if (this.signal && !this.flags.early) {
        this.flags.early = true;
        this.hooks.coach('warn', 'Signal a little later', `Your blinker was on as you passed the ${ROADS[ps.road].town} exit. Drivers waiting there may think you're leaving. Signal after you pass the exit before yours.`);
      }
    }
    if (P.onRing && P.v > LIMIT_RING) {
      this.spT += dt;
      if (this.spT > 0.8) this.violate('speed', 10, 'Too fast for the rotary', `You hit ${Math.round(P.v * MPHF)} mph. The yellow plaque advised 20. Slower speeds give you time to react to merging cars.`);
    } else this.spT = 0;
    if (P.onRing && P.v < 0.4) {
      if (this.leadGap(P).gap > 10) {
        this.stopT += dt;
        if (this.stopT > 1.5) this.violate('stop', 10, "Don't stop inside the rotary", 'Once you are in, keep moving with traffic unless something blocks you. Stopping in the circle invites rear-end crashes.');
      }
    } else this.stopT = 0;
    if (crossed(s0, s1, pt.sExit)) this.sigAtExit = this.signal;
    if (crossed(s0, s1, pt.sOff)) {
      if (this.sigAtExit) this.hooks.coach('good', 'Exit signaled', 'Your right blinker told drivers waiting at this entry that you were leaving, so they could go sooner.');
      else this.violate('signal', 10, 'No exit signal', 'Turn on your right signal after you pass the exit before yours, so waiting drivers know you are leaving.');
    }
    if (crossed(s0, s1, pt.sOff + 6) && this.signal) this.setSignal(false);
    this.checkPosition(P, dt, paved);
    if (this.state !== 'driving') return;
    if (s1 > pt.sOff + 45) this.finish();
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
      this.violate('island', 15, 'You drove onto the centre island', 'Stay on the circulating roadway. The island is not a shortcut, even when the rotary looks empty.');
    } else if (!paved) {
      this.offT += dt;
      if (this.offT > 0.4) this.violate('offroad', 10, 'You left the road', 'Keep all four wheels on the pavement. Ease off the gas and steer gently back into your lane.');
    } else this.offT = 0;

    if (P.s < pt.sYield - 2 || P.s > pt.sOff + 2) {
      const q = poseAt(pt, P.s);
      const leftOff = (p.x - q.x) * Math.sin(q.h) - (p.y - q.y) * Math.cos(q.h);
      if (leftOff > LANE + 0.4) {
        this.laneT += dt;
        if (this.laneT > 0.6) this.violate('lane', 10, 'Keep right of the yellow line', 'You drifted into oncoming traffic. Stay in the right-hand lane on two-way roads.');
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
    this.hooks.result({ pass: false, title: 'Wrong exit', body: `You took Route ${took.route} to ${took.town} instead of Route ${want.route} to ${want.town}. Watch the exit count and the green guide signs.` });
  }

  private violate(key: string, pts: number, title: string, body: string): void {
    if (this.flags[key]) return;
    this.flags[key] = true;
    this.score = Math.max(0, this.score - pts);
    this.hooks.scoreChanged(this.score);
    this.hooks.coach('bad', title, `${body} (−${pts})`);
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

  private crash(kind: 'car' | 'ped' | 'house'): void {
    this.state = 'crashed';
    this.score = 0;
    this.hooks.scoreChanged(0);
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
    const pass = this.score >= 70;
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
      : 'You reached your exit but broke key rotary rules. Review the coach notes and try again.';
    this.hooks.result({ pass, title: pass ? 'Passed' : 'Try again', body: `${verdict} ${timing}` });
  }
}
