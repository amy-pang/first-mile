/** The 3D scene for the real route: OSM streets, markings, signals, signs and building footprints. */
import * as THREE from 'three';
import type { Pt } from '../constants';
import { SIGNS } from '../signs';
import { World, type Layer } from '../world';
import type { Route } from './data';
import type { RouteSim } from './sim';

const WALL_COLORS = [0xb5654f, 0xc9b99a, 0xa8a39a, 0x8e5a48, 0xd8cdb8, 0x9aa3a8, 0xc48a6a, 0xe3ddd0];

export class RealWorld extends World {
  private heads: { sg: number; lamps: THREE.Mesh[] }[] = [];
  private readonly lampOn = [0xff3326, 0xffc61a, 0x2fe07a].map((c) => new THREE.MeshBasicMaterial({ color: c }));
  private readonly lampOff = [0x3a1210, 0x3a2e0c, 0x0e2a18].map((c) => new THREE.MeshBasicMaterial({ color: c }));
  private route!: Route;

  setRoute(route: Route): void {
    this.route = route;
  }

  override build(): void {
    this.maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    const R = this.route;
    const d = R.data;
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), this.flatMat(0xb3aea4));
    ground.rotation.x = -Math.PI / 2;
    this.scene.add(ground);
    const grass = this.flatMat(0x7f9a62);
    for (const poly of d.green) this.polygon(poly, grass, 0.02);

    const asph = this.layer('asph', 0x4a4e54, 0.04);
    for (const r of d.roads) this.polyline(asph, r.pts, r.w);
    this.buildRouteSurface();
    this.buildMarkings();
    this.buildControls();
    this.buildBuildings();
    for (const L of this.layers.values()) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(L.pos, 3));
      this.scene.add(new THREE.Mesh(g, this.flatMat(L.color)));
    }
  }

  /** Show each signal head's current colour. */
  updateSignals(sim: RouteSim): void {
    for (const h of this.heads) {
      const L = sim.light(sim.signals[h.sg]);
      const on = L === 'red' ? 0 : L === 'yellow' ? 1 : 2;
      h.lamps.forEach((m, k) => { m.material = k === on ? this.lampOn[k] : this.lampOff[k]; });
    }
  }

  /* ---------- geometry helpers ---------- */

  private polygon(poly: [number, number][], mat: THREE.Material, y: number): void {
    const shape = new THREE.Shape(poly.map(([x, z]) => new THREE.Vector2(x, z)));
    const m = new THREE.Mesh(new THREE.ShapeGeometry(shape), mat);
    m.rotation.x = Math.PI / 2;
    m.position.y = y;
    this.scene.add(m);
  }

  /** A road of width `w` along a polyline, with round joints so corners have no gaps. */
  private polyline(L: Layer, pts: [number, number][], w: number): void {
    const h = w / 2;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[i + 1];
      const len = Math.hypot(bx - ax, by - ay) || 1;
      const nx = (-(by - ay) / len) * h;
      const ny = ((bx - ax) / len) * h;
      this.quad(L, { x: ax + nx, y: ay + ny }, { x: bx + nx, y: by + ny }, { x: bx - nx, y: by - ny }, { x: ax - nx, y: ay - ny });
    }
    for (const [x, y] of pts) {
      for (let k = 0; k < 10; k++) {
        const a = (k / 10) * Math.PI * 2;
        const b = ((k + 1) / 10) * Math.PI * 2;
        this.tri(L, { x, y }, { x: x + Math.cos(a) * h, y: y + Math.sin(a) * h }, { x: x + Math.cos(b) * h, y: y + Math.sin(b) * h });
      }
    }
  }

  /** A band along the route between sideways offsets `a(s)` and `b(s)`, from s0 to s1. */
  private alongRoute(L: Layer, s0: number, s1: number, a: (s: number) => number, b: (s: number) => number, step = 2): void {
    const R = this.route;
    for (let s = s0; s < s1; s += step) {
      const e = Math.min(s1, s + step);
      this.quad(L, R.at(s, a(s)), R.at(e, a(e)), R.at(e, b(e)), R.at(s, b(s)));
    }
  }

  private skip(s: number): boolean {
    // No lane markings across intersections and through the turns.
    const ev = this.route.data.events;
    return ev.some((e) => (e.kind === 'signal' && s > e.s + 0.5 && s < e.end - 0.5) || (e.kind === 'turn' && Math.abs(e.s - s) < 10));
  }

  /* ---------- the route ---------- */

  private buildRouteSurface(): void {
    const R = this.route;
    const asph = this.layer('asph', 0x4a4e54, 0.04);
    this.alongRoute(asph, 0, R.len, (s) => R.extent(s).left - 0.3, (s) => R.extent(s).right + 0.3, 1.5);
    const curb = this.layer('curb', 0xc9c5bc, 0.1);
    this.alongRoute(curb, 0, R.len, (s) => R.extent(s).right + 0.3, (s) => R.extent(s).right + 0.55, 1.5);
    this.alongRoute(curb, 0, R.len, (s) => R.extent(s).left - 0.55, (s) => R.extent(s).left - 0.3, 1.5);
  }

  private buildMarkings(): void {
    const R = this.route;
    const white = this.layer('paint', 0xe9ebe6, 0.08);
    const yellow = this.layer('yel', 0xd8a71c, 0.08);
    const green = this.layer('bike', 0x4f9a68, 0.07);
    for (let s = 0; s < R.len; s += 1.5) {
      if (this.skip(s)) continue;
      const e = Math.min(R.len, s + 1.5);
      const x = R.extent(s);
      const line = (L: typeof white, off: number, w = 0.12) => this.quad(L, R.at(s, off - w / 2), R.at(e, off - w / 2), R.at(e, off + w / 2), R.at(s, off + w / 2));
      const dashed = s % 12 < 3;
      if (x.oneway) {
        line(white, x.left + 0.25);
      } else {
        line(yellow, -0.14, 0.1);
        line(yellow, 0.14, 0.1);
      }
      line(white, x.right - x.bike - 0.1);
      for (let k = 1; k < x.lanes; k++) if (dashed) line(white, x.right - x.bike - k * x.laneW);
      const g = R.seg(s);
      if (!x.oneway) for (let k = 1; k < g.opp; k++) if (dashed) line(white, -(k * x.laneW));
      if (x.bike > 0) this.quad(green, R.at(s, x.right - x.bike), R.at(e, x.right - x.bike), R.at(e, x.right), R.at(s, x.right));
    }
  }

  private zebra(s: number, depth = 3): void {
    const R = this.route;
    const white = this.layer('paint', 0xe9ebe6, 0.09);
    const x = R.extent(s);
    for (let o = x.left + 0.4; o < x.right - 0.2; o += 1.1) {
      this.quad(white, R.at(s - depth / 2, o), R.at(s + depth / 2, o), R.at(s + depth / 2, o + 0.5), R.at(s - depth / 2, o + 0.5));
    }
  }

  private stopLine(s: number, from: number, to: number): void {
    const R = this.route;
    const white = this.layer('paint', 0xe9ebe6, 0.09);
    this.quad(white, R.at(s - 0.25, from), R.at(s + 0.25, from), R.at(s + 0.25, to), R.at(s - 0.25, to));
  }

  /** Facing the driver who is travelling along the route at `s`. */
  private faceAt(s: number): Pt {
    const h = this.route.at(s).h;
    return { x: -Math.cos(h), y: -Math.sin(h) };
  }

  private crossStreet(s: number): string | null {
    const p = this.route.at(s);
    const here = this.route.seg(s).name;
    let best: string | null = null;
    let bd = 14;
    for (const r of this.route.data.roads) {
      if (!r.name || r.name === here) continue;
      for (const [x, y] of r.pts) {
        const d = Math.hypot(x - p.x, y - p.y);
        if (d < bd) { bd = d; best = r.name; }
      }
    }
    return best;
  }

  private buildControls(): void {
    const R = this.route;
    const d = R.data;
    const right = (s: number, extra = 1.2) => R.at(s, R.extent(s).right + extra);
    this.placeSign(SIGNS.speed(R.seg(10).mph), right(14), this.faceAt(14), 1.5);
    let sgIdx = 0;
    for (const e of d.events) {
      if (e.kind === 'signal') {
        this.zebra(e.s + 1.5);
        if (e.end - e.s > 9) this.zebra(e.end - 1.5);
        const x = R.extent(e.s);
        this.stopLine(e.s - 0.6, x.oneway ? x.left : 0, x.right);
        this.signalHead(e.s, sgIdx, false);
        if (!x.oneway) this.signalHead(e.end, sgIdx, true);
        const name = this.crossStreet((e.s + e.end) / 2);
        if (name && !e.ped) this.placeSign(SIGNS.streetBlade(name), right(e.s + 2, 1.6), this.faceAt(e.s), 2.9);
        sgIdx++;
      } else if (e.kind === 'crosswalk') {
        this.zebra(e.s);
      } else if (e.kind === 'stop') {
        const x = R.extent(e.s);
        this.stopLine(e.s, x.left, x.right);
        this.placeSign(SIGNS.stopSign(), right(e.s), this.faceAt(e.s), 1.6);
      } else if (e.kind === 'speed') {
        if (R.seg(e.s + 1).s1 - e.s > 80) this.placeSign(SIGNS.speed(e.mph), right(e.s + 3), this.faceAt(e.s), 1.5);
      } else if (e.kind === 'turn' && e.dir !== 'straight') {
        this.placeSign(SIGNS.streetBlade(e.onto), right(e.s - 6, 1.6), this.faceAt(e.s - 6), 2.9);
      } else if (e.kind === 'rail') {
        const rail = this.layer('rail', 0x5b5e62, 0.1);
        const x = R.extent(e.s);
        for (const o of [-0.72, 0.72]) this.quad(rail, R.at(e.s + o - 0.06, x.left - 2), R.at(e.s + o + 0.06, x.left - 2), R.at(e.s + o + 0.06, x.right + 2), R.at(e.s + o - 0.06, x.right + 2));
        this.placeSign(SIGNS.crossbuck(), right(e.s - 5), this.faceAt(e.s), 2.4);
      } else if (e.kind === 'bikebox') {
        const green = this.layer('bikebox', 0x4f9a68, 0.085);
        const x = R.extent(e.s);
        this.quad(green, R.at(e.s - 4, 0.1), R.at(e.s, 0.1), R.at(e.s, x.right - x.bike), R.at(e.s - 4, x.right - x.bike));
      }
    }
  }

  /** A mast-arm traffic signal: pole at the curb, arm over the lanes, a head facing approaching traffic. */
  private signalHead(s: number, sg: number, oncoming: boolean): void {
    const R = this.route;
    const x = R.extent(s);
    const base = R.at(s, oncoming ? x.left - 1 : x.right + 1);
    const over = R.at(s, oncoming ? x.left / 2 : (x.right - x.bike) / 2);
    const h = R.at(s).h + (oncoming ? Math.PI : 0);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.15, 6.2, 8), this.poleMat);
    pole.position.set(base.x, 3.1, base.y);
    this.scene.add(pole);
    const len = Math.hypot(over.x - base.x, over.y - base.y);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(len, 0.14, 0.14), this.poleMat);
    arm.position.set((base.x + over.x) / 2, 5.9, (base.y + over.y) / 2);
    arm.rotation.y = -Math.atan2(over.y - base.y, over.x - base.x);
    this.scene.add(arm);
    const head = new THREE.Group();
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.34, 1.05, 0.36), new THREE.MeshLambertMaterial({ color: 0x1c1f22 }));
    head.add(box);
    const lamps: THREE.Mesh[] = [];
    for (let k = 0; k < 3; k++) {
      const lamp = new THREE.Mesh(new THREE.CircleGeometry(0.12, 14), this.lampOff[k]);
      lamp.position.set(-0.18, 0.33 - k * 0.33, 0);
      lamp.rotation.y = -Math.PI / 2;
      head.add(lamp);
      lamps.push(lamp);
    }
    head.position.set(over.x, 5.25, over.y);
    // The lamps sit on the head's −x face; turn it so that face points back at the driver.
    head.rotation.y = -h;
    this.scene.add(head);
    this.heads.push({ sg, lamps });
  }

  private buildBuildings(): void {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    g.fillStyle = '#FFFFFF';
    g.fillRect(0, 0, 64, 64);
    g.fillStyle = '#5A6672';
    g.fillRect(14, 14, 36, 30);
    g.fillStyle = '#DDE3E8';
    g.fillRect(31, 14, 2, 30);
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(1 / 3.6, 1 / 3.3);
    const roof = new THREE.MeshLambertMaterial({ color: 0x55595f });
    const walls = WALL_COLORS.map((col) => new THREE.MeshLambertMaterial({ color: col, map: tex }));
    this.route.data.buildings.forEach((b, i) => {
      if (b.pts.length < 3) return;
      const shape = new THREE.Shape(b.pts.map(([x, y]) => new THREE.Vector2(x, -y)));
      const geo = new THREE.ExtrudeGeometry(shape, { depth: b.h, bevelEnabled: false });
      const m = new THREE.Mesh(geo, [roof, walls[i % walls.length]]);
      m.rotation.x = -Math.PI / 2;
      this.scene.add(m);
    });
  }
}
