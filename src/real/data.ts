/** The real Harvard → MIT route, built from OpenStreetMap by scripts/build-real-route.py. */
import type { Pose, Pt } from '../constants';

export interface Seg {
  s0: number;
  s1: number;
  name: string;
  ref: string | null;
  mph: number;
  /** Travel lanes in our direction, and in the opposite direction (0 on one-way streets). */
  lanes: number;
  opp: number;
  oneway: boolean;
  /** Bike facility on our right: a painted lane, a separated track, or a shared bus/bike lane. */
  bike: 'lane' | 'track' | 'bus' | null;
  turns: string | null;
}

export type RouteEvent =
  | { kind: 'signal'; s: number; end: number; ped?: boolean }
  | { kind: 'stop'; s: number }
  | { kind: 'crosswalk'; s: number }
  | { kind: 'rail'; s: number }
  | { kind: 'bikebox'; s: number }
  | { kind: 'speed'; s: number; mph: number }
  | { kind: 'turn'; s: number; dir: 'left' | 'right' | 'bear-left' | 'bear-right' | 'straight'; onto: string; from: string };

export interface RouteData {
  attribution: string;
  /** Latitude and longitude of the local x/y origin. */
  origin: [number, number];
  start: string;
  goal: string;
  length: number;
  pts: [number, number][];
  segs: Seg[];
  events: RouteEvent[];
  roads: { pts: [number, number][]; w: number; oneway: boolean; name: string }[];
  buildings: { pts: [number, number][]; h: number }[];
  green: [number, number][][];
  laneW: number;
  bikeW: number;
}

/** The route centreline with distance lookups. */
export class Route {
  readonly cum: number[] = [0];
  readonly len: number;
  /** Roadway edges and bike-lane width every metre, smoothed so lane counts change over a taper, not a step. */
  private readonly edgeL: number[] = [];
  private readonly edgeR: number[] = [];
  private readonly bikeW: number[] = [];

  constructor(readonly data: RouteData) {
    const p = data.pts;
    for (let i = 1; i < p.length; i++) this.cum.push(this.cum[i - 1] + Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]));
    this.len = this.cum[this.cum.length - 1];
    const n = Math.ceil(this.len) + 1;
    const raw = Array.from({ length: n }, (_, s) => this.rawExtent(s));
    const TAPER = 15;
    for (let s = 0; s < n; s++) {
      let l = 0, r = 0, b = 0, k = 0;
      for (let j = Math.max(0, s - TAPER); j <= Math.min(n - 1, s + TAPER); j++, k++) {
        l += raw[j].left;
        r += raw[j].right;
        b += raw[j].bike;
      }
      this.edgeL.push(l / k);
      this.edgeR.push(r / k);
      this.bikeW.push(b / k);
    }
  }

  private rawExtent(s: number): { left: number; right: number; bike: number } {
    const g = this.seg(s);
    const W = this.data.laneW;
    const bike = g.bike === 'lane' || g.bike === 'track' ? this.data.bikeW : 0;
    if (g.oneway) return { left: -(g.lanes * W) / 2, right: (g.lanes * W) / 2 + bike, bike };
    return { left: -(g.opp * W + bike), right: g.lanes * W + bike, bike };
  }

  private idx(s: number): number {
    let lo = 0;
    let hi = this.cum.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (this.cum[m] <= s) lo = m;
      else hi = m;
    }
    return lo;
  }

  /** Point on the centreline at distance `s`, shifted `off` metres to the right of travel. */
  at(s: number, off = 0): Pose {
    s = Math.max(0, Math.min(this.len - 0.001, s));
    const i = this.idx(s);
    const a = this.data.pts[i];
    const b = this.data.pts[Math.min(i + 1, this.data.pts.length - 1)];
    const L = this.cum[i + 1] - this.cum[i] || 1;
    const t = (s - this.cum[i]) / L;
    const h = Math.atan2(b[1] - a[1], b[0] - a[0]);
    // +y is south, so "right of travel" is (−sin h, cos h).
    return { x: a[0] + (b[0] - a[0]) * t - Math.sin(h) * off, y: a[1] + (b[1] - a[1]) * t + Math.cos(h) * off, h };
  }

  seg(s: number): Seg {
    const segs = this.data.segs;
    for (const g of segs) if (s < g.s1) return g;
    return segs[segs.length - 1];
  }

  /** Nearest distance along the route to `p`, searching around `near`; and the signed sideways offset (right +). */
  locate(p: Pt, near: number): { s: number; off: number } {
    let best = near;
    let bd = Infinity;
    for (let s = Math.max(0, near - 6); s <= Math.min(this.len, near + 14); s += 0.5) {
      const q = this.at(s);
      const d = (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
      if (d < bd) { bd = d; best = s; }
    }
    const q = this.at(best);
    const off = -(p.x - q.x) * Math.sin(q.h) + (p.y - q.y) * Math.cos(q.h);
    return { s: best, off };
  }

  /**
   * Sideways extent of the roadway at `s`, from the centreline: our side runs from 0 out to `right`
   * (travel lanes, then any bike lane), the other side out to `left` (negative). One-way streets are centred.
   */
  extent(s: number): { left: number; right: number; lanes: number; laneW: number; bike: number; oneway: boolean } {
    const g = this.seg(s);
    const i = Math.max(0, Math.min(this.edgeR.length - 1, Math.round(s)));
    return { left: this.edgeL[i], right: this.edgeR[i], lanes: g.lanes, laneW: this.data.laneW, bike: this.bikeW[i], oneway: g.oneway };
  }

  /** Centre offset of lane `k` in our direction (0 = rightmost). */
  laneCentre(s: number, k: number): number {
    const e = this.extent(s);
    return e.right - e.bike - e.laneW * (k + 0.5);
  }
}

export async function loadRoute(): Promise<Route> {
  const r = await fetch(new URL('real-route.json', document.baseURI));
  if (!r.ok) throw new Error(`real-route.json: ${r.status}`);
  return new Route((await r.json()) as RouteData);
}
