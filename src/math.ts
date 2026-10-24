import { RC, TAU, type Pt } from './constants';

export const U = (p: number): Pt => ({ x: Math.cos(p), y: Math.sin(p) });
export const N = (p: number): Pt => ({ x: -Math.sin(p), y: Math.cos(p) });

/** Point on road `phi`, `d` metres from the centre, offset `o` metres sideways (negative = inbound lane). */
export const roadPt = (p: number, d: number, o: number): Pt => {
  const u = U(p);
  const n = N(p);
  return { x: u.x * d + n.x * o, y: u.y * d + n.y * o };
};

export const ringPt = (t: number, r: number = RC): Pt => ({ x: Math.cos(t) * r, y: Math.sin(t) * r });

/** Direction of travel at ring angle `t` (traffic circulates with decreasing angle, i.e. counterclockwise on screen). */
export const tanAt = (t: number): Pt => ({ x: Math.sin(t), y: -Math.cos(t) });

export const add = (a: Pt, b: Pt, k: number): Pt => ({ x: a.x + b.x * k, y: a.y + b.y * k });
export const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);

export const cub = (a: Pt, b: Pt, c: Pt, d: Pt, t: number): Pt => {
  const m = 1 - t;
  const A = m * m * m;
  const B = 3 * m * m * t;
  const C = 3 * m * t * t;
  const D = t * t * t;
  return { x: A * a.x + B * b.x + C * c.x + D * d.x, y: A * a.y + B * b.y + C * c.y + D * d.y };
};

export const rand = (a: number, b: number): number => a + Math.random() * (b - a);
export const pickOne = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];

/** Yaw for a three.js object whose local +z should face direction `v` (2D x → three x, 2D y → three z). */
export const yawFor = (v: Pt): number => Math.atan2(v.x, v.y);

export const angDiff = (a: number, b: number): number => ((((b - a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
export const lerpAngle = (a: number, b: number, t: number): number => a + angDiff(a, b) * t;
