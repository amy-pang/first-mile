import { DEND, DS, DY, DCW, LANE, OFF, RC, ROADS, TAU, type Pose, type Pt } from './constants';
import { add, cub, dist, ringPt, roadPt, tanAt, U } from './math';

/** A drivable path from one road, around the rotary, out another road, sampled about every metre. */
export interface Path {
  pts: Pt[];
  /** Cumulative distance along the path at each point. */
  cum: number[];
  len: number;
  inIdx: number;
  outIdx: number;
  /** Ring angle where the path joins the rotary. */
  ta: number;
  /** Ring angle where the path leaves the rotary. */
  tb: number;
  /** Merge point on the ring. */
  M: Pt;
  sYield: number;
  sMerge: number;
  sExit: number;
  sOff: number;
  sCW: number;
  /** Other exits this path drives past, in order. */
  passes: { road: number; s: number }[];
}

const cache = new Map<number, Path>();

export function getPath(i: number, o: number): Path {
  const key = i * 4 + o;
  const hit = cache.get(key);
  if (hit) return hit;

  const pin = ROADS[i].phi;
  const pout = ROADS[o].phi;
  const pts: Pt[] = [];

  for (let d = DS; d > DY; d -= 1) pts.push(roadPt(pin, d, -LANE));
  const yieldIdx = pts.length;

  const ta = pin - OFF;
  const e0 = roadPt(pin, DY, -LANE);
  const e3 = ringPt(ta);
  const e1 = add(e0, U(pin), -5);
  const e2 = add(e3, tanAt(ta), -4);
  for (let k = 0; k < 16; k++) pts.push(cub(e0, e1, e2, e3, k / 16));
  const mergeIdx = pts.length;

  let tb = pout + OFF;
  while (tb >= ta) tb -= TAU;
  const steps = Math.ceil((ta - tb) * RC);
  for (let k = 0; k < steps; k++) pts.push(ringPt(ta - ((ta - tb) * k) / steps));
  const exitIdx = pts.length;

  const x0 = ringPt(tb);
  const x3 = roadPt(pout, DY, LANE);
  const x1 = add(x0, tanAt(tb), 4);
  const x2 = add(x3, U(pout), -5);
  for (let k = 0; k < 16; k++) pts.push(cub(x0, x1, x2, x3, k / 16));
  const offIdx = pts.length;

  for (let d = DY; d <= DEND; d += 1) pts.push(roadPt(pout, d, LANE));

  const cum = [0];
  for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + dist(pts[k - 1], pts[k]));

  const path: Path = {
    pts,
    cum,
    len: cum[cum.length - 1],
    inIdx: i,
    outIdx: o,
    ta,
    tb,
    M: e3,
    sYield: cum[yieldIdx],
    sMerge: cum[mergeIdx],
    sExit: cum[exitIdx],
    sOff: cum[offIdx],
    sCW: DS - DCW,
    passes: [],
  };

  for (let r = 0; r < 4; r++) {
    if (r === i || r === o) continue;
    let th = ROADS[r].phi + OFF;
    while (th >= ta) th -= TAU;
    if (th > tb) path.passes.push({ road: r, s: path.sMerge + (ta - th) * RC });
  }
  path.passes.sort((a, b) => a.s - b.s);

  cache.set(key, path);
  return path;
}

export function poseAt(p: Path, s: number): Pose {
  s = Math.max(0, Math.min(p.len - 0.001, s));
  let lo = 0;
  let hi = p.cum.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (p.cum[m] <= s) lo = m;
    else hi = m;
  }
  const a = p.pts[lo];
  const b = p.pts[hi];
  const t = (s - p.cum[lo]) / (p.cum[hi] - p.cum[lo] || 1);
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, h: Math.atan2(b.y - a.y, b.x - a.x) };
}
