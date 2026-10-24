/** The three.js scene: roads, houses, trees, signs, traffic meshes, lighting and the two cameras. */
import * as THREE from 'three';
import { DCW, DEG, DEND, DY, R_IN, R_OUT, ROADS, RW, TAU, type Pt } from './constants';
import { add, angDiff, lerpAngle, pickOne, rand, ringPt, roadPt, tanAt, U, yawFor } from './math';
import type { Simulation } from './sim';
import { SIGNS, type SignSpec } from './signs';
import type { Phase } from './trip';

const PPM = 160; // sign texture resolution, pixels per metre

interface Layer {
  color: number;
  y: number;
  pos: number[];
}

interface LightPreset {
  sky: THREE.Texture;
  fog: number;
  near: number;
  far: number;
  hemi: number;
  sun: number;
  flat: number;
  sign: number;
  beam: number;
}

function skyTex(stops: [string, string, string]): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 256;
  const g = c.getContext('2d')!;
  const gr = g.createLinearGradient(0, 0, 0, 256);
  gr.addColorStop(0, stops[0]);
  gr.addColorStop(0.55, stops[1]);
  gr.addColorStop(1, stops[2]);
  g.fillStyle = gr;
  g.fillRect(0, 0, 4, 256);
  return new THREE.CanvasTexture(c);
}

export class World {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(72, 16 / 10, 0.25, 700);
  readonly mirrorCam = new THREE.PerspectiveCamera(30, 3.6, 0.5, 400);

  /** Smoothed view heading, head turn and steering-wheel angle (degrees). */
  readonly cam = { h: -Math.PI / 2, prevH: -Math.PI / 2, yaw: 0, steer: 0 };

  private readonly hemi = new THREE.HemisphereLight(0xe4f0ff, 0x5a6a48, 0.85);
  private readonly sun = new THREE.DirectionalLight(0xffffff, 0.7);
  private readonly fog = new THREE.Fog(0xd6e1e7, 110, 430);
  private readonly flatMats: THREE.MeshBasicMaterial[] = [];
  private readonly signMats: THREE.MeshBasicMaterial[] = [];
  private readonly beam: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private readonly layers = new Map<string, Layer>();
  private readonly carMeshes = new Map<number, THREE.Group>();
  private readonly pedMeshes = new Map<number, THREE.Group>();
  private readonly lights: Record<Phase, LightPreset>;
  private maxAniso = 4;

  private readonly poleMat = new THREE.MeshLambertMaterial({ color: 0x8a9096 });
  private readonly poleGeo = new THREE.CylinderGeometry(0.05, 0.05, 1, 8);
  private readonly carGeo = {
    body: new THREE.BoxGeometry(4.4, 0.8, 1.85),
    cabin: new THREE.BoxGeometry(2.3, 0.62, 1.62),
    wheel: new THREE.CylinderGeometry(0.34, 0.34, 0.26, 10).rotateX(Math.PI / 2),
    lamp: new THREE.BoxGeometry(0.06, 0.18, 0.42),
  };
  private readonly carMat = {
    glass: new THREE.MeshLambertMaterial({ color: 0x1e262e }),
    wheel: new THREE.MeshLambertMaterial({ color: 0x141414 }),
    tailOn: new THREE.MeshBasicMaterial({ color: 0xff2a1f }),
    tailOff: new THREE.MeshBasicMaterial({ color: 0x6e1a16 }),
    head: new THREE.MeshBasicMaterial({ color: 0xfff3cf }),
  };
  private readonly bodyMats = new Map<string, THREE.MeshLambertMaterial>();
  private readonly pedGeo = {
    body: new THREE.CylinderGeometry(0.22, 0.27, 0.95, 8),
    legs: new THREE.CylinderGeometry(0.2, 0.16, 0.8, 8),
    head: new THREE.SphereGeometry(0.17, 8, 6),
  };
  private readonly pedMat = {
    legs: new THREE.MeshLambertMaterial({ color: 0x2c3440 }),
    skin: new THREE.MeshLambertMaterial({ color: 0xd9b08c }),
  };
  private readonly pedBodyMats = new Map<string, THREE.MeshLambertMaterial>();

  constructor(canvas: HTMLCanvasElement, private readonly stage: HTMLElement, private readonly mirrorEl: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.scene.fog = this.fog;
    this.lights = {
      day: { sky: skyTex(['#7FA9CC', '#BFD4E3', '#DDE6EA']), fog: 0xd6e1e7, near: 110, far: 430, hemi: 0.85, sun: 0.7, flat: 1, sign: 1, beam: 0 },
      dawn: { sky: skyTex(['#5A6C93', '#D7A88C', '#F0D3B6']), fog: 0xd8c3b4, near: 90, far: 380, hemi: 0.6, sun: 0.45, flat: 0.8, sign: 0.95, beam: 0.06 },
      dusk: { sky: skyTex(['#3D4A77', '#C8826A', '#E6B490']), fog: 0xb59a90, near: 80, far: 340, hemi: 0.48, sun: 0.32, flat: 0.68, sign: 0.92, beam: 0.1 },
      night: { sky: skyTex(['#04060C', '#0F1828', '#1C2537']), fog: 0x121925, near: 35, far: 210, hemi: 0.16, sun: 0.04, flat: 0.3, sign: 0.78, beam: 0.22 },
    };
    this.scene.background = this.lights.day.sky;
    this.scene.add(this.hemi);
    this.sun.position.set(80, 140, 50);
    this.scene.add(this.sun);

    // A soft headlight pool on the road ahead, used at dusk and night.
    const beamGeo = new THREE.BufferGeometry();
    beamGeo.setAttribute('position', new THREE.Float32BufferAttribute([2, 0, -1.3, 2, 0, 1.3, 28, 0, 5.5, 2, 0, -1.3, 28, 0, 5.5, 28, 0, -5.5], 3));
    this.beam = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({
      color: 0xfff1c2, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }));
    this.scene.add(this.beam);
  }

  resize(): void {
    const w = this.stage.clientWidth;
    const h = this.stage.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  applyLighting(phase: Phase): void {
    const L = this.lights[phase];
    this.scene.background = L.sky;
    this.fog.color.setHex(L.fog);
    this.fog.near = L.near;
    this.fog.far = L.far;
    this.hemi.intensity = L.hemi;
    this.sun.intensity = L.sun;
    for (const m of this.flatMats) m.color.copy(m.userData.base as THREE.Color).multiplyScalar(L.flat);
    for (const m of this.signMats) m.color.setScalar(L.sign);
    this.beam.material.opacity = L.beam;
    this.beam.visible = L.beam > 0;
  }

  /* ---------- static scenery ---------- */

  build(): void {
    this.maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(1200, 1200), this.flatMat(0x6f8c5b));
    ground.rotation.x = -Math.PI / 2;
    this.scene.add(ground);

    this.buildRoads();
    this.buildIsland();
    this.buildHouses();
    this.buildTrees();
    this.buildSigns();
  }

  private flatMat(color: number): THREE.MeshBasicMaterial {
    const m = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide });
    m.userData.base = m.color.clone();
    this.flatMats.push(m);
    return m;
  }

  private layer(key: string, color: number, y: number): Layer {
    let L = this.layers.get(key);
    if (!L) {
      L = { color, y, pos: [] };
      this.layers.set(key, L);
    }
    return L;
  }

  private quad(L: Layer, a: Pt, b: Pt, c: Pt, d: Pt): void {
    const y = L.y;
    L.pos.push(a.x, y, a.y, b.x, y, b.y, c.x, y, c.y, a.x, y, a.y, c.x, y, c.y, d.x, y, d.y);
  }

  private tri(L: Layer, a: Pt, b: Pt, c: Pt): void {
    const y = L.y;
    L.pos.push(a.x, y, a.y, b.x, y, b.y, c.x, y, c.y);
  }

  private strip(L: Layer, phi: number, d0: number, d1: number, off: number, w: number): void {
    this.quad(L, roadPt(phi, d0, off - w / 2), roadPt(phi, d1, off - w / 2), roadPt(phi, d1, off + w / 2), roadPt(phi, d0, off + w / 2));
  }

  private band(L: Layer, r0: number, r1: number, t0: number, t1: number): void {
    const n = Math.max(4, Math.ceil(Math.abs(t1 - t0) / (3 * DEG)));
    for (let i = 0; i < n; i++) {
      const a = t0 + ((t1 - t0) * i) / n;
      const b = t0 + ((t1 - t0) * (i + 1)) / n;
      this.quad(L, ringPt(a, r0), ringPt(b, r0), ringPt(b, r1), ringPt(a, r1));
    }
  }

  private buildRoads(): void {
    const asph = this.layer('asph', 0x4a4e54, 0.04);
    const paint = this.layer('paint', 0xe9ebe6, 0.08);
    const yel = this.layer('yel', 0xd8a71c, 0.08);
    const walk = this.layer('walk', 0xb9b6ae, 0.14);
    for (const r of ROADS) {
      this.strip(asph, r.phi, R_IN + 2, DEND + 40, 0, RW * 2);
      this.strip(walk, r.phi, R_OUT + 1.2, DEND + 40, -(RW + 1.25), 2.5);
      this.strip(walk, r.phi, R_OUT + 1.2, DEND + 40, RW + 1.25, 2.5);
      this.strip(yel, r.phi, R_OUT + 1, DEND + 40, -0.16, 0.12);
      this.strip(yel, r.phi, R_OUT + 1, DEND + 40, 0.16, 0.12);
      this.strip(paint, r.phi, R_OUT + 3, DEND + 40, -(RW - 0.25), 0.13);
      this.strip(paint, r.phi, R_OUT + 3, DEND + 40, RW - 0.25, 0.13);
      for (let o = -3.3; o <= 3.31; o += 1.1) this.strip(paint, r.phi, DCW - 2, DCW + 2, o, 0.5);
      for (let o = -RW + 0.5; o <= -0.6; o += 0.9) {
        this.tri(paint, roadPt(r.phi, DY, o - 0.3), roadPt(r.phi, DY, o + 0.3), roadPt(r.phi, DY + 0.9, o));
      }
    }
    this.band(asph, R_IN, R_OUT + 0.3, 0, TAU);
    const gapA = Math.asin((RW + 1) / R_OUT);
    const gapW = Math.asin((RW + 2.6) / (R_OUT + 1.3));
    for (const r of ROADS) {
      this.band(paint, R_OUT - 0.4, R_OUT - 0.27, r.phi + gapA, r.phi + Math.PI / 2 - gapA);
      this.band(walk, R_OUT + 0.3, R_OUT + 2.8, r.phi + gapW, r.phi + Math.PI / 2 - gapW);
    }
    this.band(paint, R_IN + 0.3, R_IN + 0.43, 0, TAU);

    for (const L of this.layers.values()) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(L.pos, 3));
      this.scene.add(new THREE.Mesh(g, this.flatMat(L.color)));
    }
  }

  private buildIsland(): void {
    const curb = new THREE.MeshLambertMaterial({ color: 0xa9a59c });
    const grass = new THREE.MeshLambertMaterial({ color: 0x7a985f });
    const island = new THREE.Mesh(new THREE.CylinderGeometry(R_IN, R_IN, 0.3, 64), [curb, grass, grass]);
    island.position.y = 0.15;
    this.scene.add(island);
    const flag = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 9, 8), this.poleMat);
    flag.position.set(0, 4.6, 0);
    this.scene.add(flag);
    const cloth = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 1.1), new THREE.MeshLambertMaterial({ color: 0xf2f2ee, side: THREE.DoubleSide }));
    cloth.position.set(0.95, 8.4, 0);
    this.scene.add(cloth);
  }

  /** Triple-decker style houses with clapboard siding. */
  private buildHouses(): void {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d')!;
    g.fillStyle = '#FFFFFF';
    g.fillRect(0, 0, 128, 128);
    g.fillStyle = '#E3E3E3';
    for (let y = 6; y < 128; y += 9) g.fillRect(0, y, 128, 2);
    g.fillStyle = '#F7F7F7';
    g.fillRect(36, 26, 56, 78);
    g.fillStyle = '#3B4652';
    g.fillRect(42, 32, 44, 66);
    g.fillStyle = '#F7F7F7';
    g.fillRect(62, 32, 4, 66);
    g.fillRect(42, 63, 44, 4);
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(3, 3);
    const roof = new THREE.MeshLambertMaterial({ color: 0x4b4f55 });
    const colors = ['#C8D3DC', '#E6D7B2', '#B5C6A3', '#D8B6A6', '#9DB2C6', '#E8E2D6', '#B86450', '#CFC6E0'];
    const mats = colors.map((col) => {
      const m = new THREE.MeshLambertMaterial({ color: col, map: tex });
      return [m, m, roof, roof, m, m];
    });
    const box = new THREE.BoxGeometry(1, 1, 1);
    for (const r of ROADS) {
      for (const side of [-1, 1]) {
        for (let d = 46; d < 215; ) {
          const wa = rand(8, 11);
          const dep = rand(9, 12);
          const h = rand(8, 12);
          const m = new THREE.Mesh(box, pickOne(mats));
          const p = roadPt(r.phi, d + wa / 2, side * (10.5 + dep / 2));
          m.scale.set(dep, h, wa);
          m.position.set(p.x, h / 2, p.y);
          m.rotation.y = yawFor(U(r.phi));
          this.scene.add(m);
          d += wa + rand(2.5, 5);
        }
      }
    }
  }

  private buildTrees(): void {
    const trunkGeo = new THREE.CylinderGeometry(0.2, 0.26, 3.4, 6);
    const crownGeo = new THREE.SphereGeometry(1.9, 9, 7);
    const trunkMat = new THREE.MeshLambertMaterial({ color: 0x6b5240 });
    const crownMats = [0x4e7a3e, 0x5c8746, 0x456f38].map((col) => new THREE.MeshLambertMaterial({ color: col }));
    const tree = (p: Pt, s = 1) => {
      const t = new THREE.Mesh(trunkGeo, trunkMat);
      t.position.set(p.x, 1.7 * s, p.y);
      t.scale.setScalar(s);
      this.scene.add(t);
      const c = new THREE.Mesh(crownGeo, pickOne(crownMats));
      c.position.set(p.x, 4.3 * s, p.y);
      c.scale.setScalar(s * rand(0.9, 1.2));
      this.scene.add(c);
    };
    const signZones = [172, 140, 105, 70, 33];
    for (const r of ROADS) {
      for (const side of [-1, 1]) {
        for (let d = 48; d < 212; d += 16) {
          if (side === -1 && signZones.some((z) => Math.abs(z - d) < 9)) continue;
          tree(roadPt(r.phi, d, side * 8.6), rand(0.85, 1.05));
        }
      }
    }
    for (let k = 0, n = 0; k < 600 && n < 70; k++) {
      const p = { x: rand(-210, 210), y: rand(-210, 210) };
      const ax = Math.abs(p.x);
      const az = Math.abs(p.y);
      if (ax < RW + 5 || az < RW + 5 || Math.hypot(p.x, p.y) < R_OUT + 7) continue;
      if ((ax < 24 && az > 40) || (az < 24 && ax > 40)) continue;
      tree(p, rand(0.9, 1.3));
      n++;
    }
    for (let k = 0; k < 4; k++) tree(ringPt((k * TAU) / 4 + 0.6, rand(10, 13)), 0.85);
  }

  private canvasTex(spec: SignSpec, back = false): THREE.CanvasTexture {
    const c = document.createElement('canvas');
    c.width = Math.round(spec.w * PPM);
    c.height = Math.round(spec.h * PPM);
    const g = c.getContext('2d')!;
    if (back) {
      g.fillStyle = '#7E858B';
      spec.shape(g, c.width, c.height);
      g.fill();
    } else spec.draw(g, c.width, c.height);
    const t = new THREE.CanvasTexture(c);
    t.anisotropy = this.maxAniso;
    return t;
  }

  private placeSign(spec: SignSpec, pos: Pt, face: Pt, bottom: number, poles = 1): void {
    const grp = new THREE.Group();
    const geo = new THREE.PlaneGeometry(spec.w, spec.h);
    const fMat = new THREE.MeshBasicMaterial({ map: this.canvasTex(spec), transparent: true, alphaTest: 0.5 });
    this.signMats.push(fMat);
    const front = new THREE.Mesh(geo, fMat);
    front.position.set(0, bottom + spec.h / 2, 0.035);
    grp.add(front);
    const back = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: this.canvasTex(spec, true), transparent: true, alphaTest: 0.5 }));
    back.position.set(0, bottom + spec.h / 2, 0.015);
    back.rotation.y = Math.PI;
    grp.add(back);
    const ph = bottom + spec.h * 0.55;
    const xs = poles === 2 ? [-spec.w * 0.3, spec.w * 0.3] : [0];
    for (const x of xs) {
      const p = new THREE.Mesh(this.poleGeo, this.poleMat);
      p.scale.y = ph;
      p.position.set(x, ph / 2, 0);
      grp.add(p);
    }
    grp.position.set(pos.x, 0, pos.y);
    grp.rotation.y = yawFor(face);
    this.scene.add(grp);
  }

  /** The full sign sequence on every approach, plus One Way and exit signs around the rotary. */
  private buildSigns(): void {
    ROADS.forEach((r, i) => {
      const f = U(r.phi);
      const right = (d: number) => roadPt(r.phi, d, -(RW + 1.6));
      this.placeSign(SIGNS.speed(25), right(172), f, 1.5);
      this.placeSign(SIGNS.diagram(i), roadPt(r.phi, 140, -(RW + 3.3)), f, 1.8, 2);
      this.placeSign(SIGNS.plaque(['20 MPH'], '#F5C400', 1.0, 0.5), right(105), f, 1.55);
      this.placeSign(SIGNS.rotaryWarn(), right(105), f, 2.15);
      this.placeSign(SIGNS.plaque(['AHEAD'], '#F5C400', 1.0, 0.4), right(70), f, 1.6);
      this.placeSign(SIGNS.pedWarn(), right(70), f, 2.1);
      this.placeSign(SIGNS.stateLaw(), roadPt(r.phi, DCW + 3.5, 0), f, 0.15);
      this.placeSign(SIGNS.plaque(['TO TRAFFIC', 'IN ROTARY'], '#FFFFFF', 1.2, 0.62), right(DY - 0.5), f, 1.15);
      this.placeSign(SIGNS.yieldSign(), right(DY - 0.5), f, 1.85);
      this.placeSign(SIGNS.oneWay(), ringPt(r.phi, R_IN - 1.4), f, 1.1);
      const th = r.phi + 32 * DEG;
      const t = tanAt(th);
      this.placeSign(SIGNS.exitGuide(r), ringPt(th, R_OUT + 1.6), { x: -t.x, y: -t.y }, 1.6, 2);
    });
  }

  /* ---------- moving objects ---------- */

  private makeCar(color: string): THREE.Group {
    const g = new THREE.Group();
    let bodyMat = this.bodyMats.get(color);
    if (!bodyMat) {
      bodyMat = new THREE.MeshLambertMaterial({ color });
      this.bodyMats.set(color, bodyMat);
    }
    const body = new THREE.Mesh(this.carGeo.body, bodyMat);
    body.position.y = 0.72;
    g.add(body);
    const cab = new THREE.Mesh(this.carGeo.cabin, this.carMat.glass);
    cab.position.set(-0.25, 1.43, 0);
    g.add(cab);
    for (const x of [-1.4, 1.4]) {
      for (const z of [-0.93, 0.93]) {
        const w = new THREE.Mesh(this.carGeo.wheel, this.carMat.wheel);
        w.position.set(x, 0.34, z);
        g.add(w);
      }
    }
    const tails: THREE.Mesh[] = [];
    for (const z of [-0.62, 0.62]) {
      const t = new THREE.Mesh(this.carGeo.lamp, this.carMat.tailOff);
      t.position.set(-2.21, 0.85, z);
      g.add(t);
      tails.push(t);
      const h = new THREE.Mesh(this.carGeo.lamp, this.carMat.head);
      h.position.set(2.21, 0.85, z);
      g.add(h);
    }
    g.userData.tails = tails;
    this.scene.add(g);
    return g;
  }

  private makePed(color: string): THREE.Group {
    const g = new THREE.Group();
    const legs = new THREE.Mesh(this.pedGeo.legs, this.pedMat.legs);
    legs.position.y = 0.4;
    g.add(legs);
    let m = this.pedBodyMats.get(color);
    if (!m) {
      m = new THREE.MeshLambertMaterial({ color });
      this.pedBodyMats.set(color, m);
    }
    const body = new THREE.Mesh(this.pedGeo.body, m);
    body.position.y = 1.27;
    g.add(body);
    const head = new THREE.Mesh(this.pedGeo.head, this.pedMat.skin);
    head.position.y = 1.9;
    g.add(head);
    this.scene.add(g);
    return g;
  }

  /** Match meshes to the simulation and move the driver's cameras. */
  sync(sim: Simulation, dt: number): void {
    const liveCars = new Set<number>();
    for (const c of sim.cars) {
      if (c.isPlayer) continue;
      liveCars.add(c.id);
      let mesh = this.carMeshes.get(c.id);
      if (!mesh) {
        mesh = this.makeCar(c.color);
        this.carMeshes.set(c.id, mesh);
      }
      mesh.position.set(c.pose.x, 0, c.pose.y);
      mesh.rotation.y = -c.pose.h;
      const lamp = c.braking ? this.carMat.tailOn : this.carMat.tailOff;
      for (const t of mesh.userData.tails as THREE.Mesh[]) t.material = lamp;
    }
    for (const [id, mesh] of this.carMeshes) {
      if (!liveCars.has(id)) {
        this.scene.remove(mesh);
        this.carMeshes.delete(id);
      }
    }
    const livePeds = new Set<number>();
    for (const p of sim.peds) {
      livePeds.add(p.id);
      let mesh = this.pedMeshes.get(p.id);
      if (!mesh) {
        mesh = this.makePed(p.color);
        this.pedMeshes.set(p.id, mesh);
      }
      mesh.position.set(p.x, 0, p.y);
    }
    for (const [id, mesh] of this.pedMeshes) {
      if (!livePeds.has(id)) {
        this.scene.remove(mesh);
        this.pedMeshes.delete(id);
      }
    }

    const pp = sim.player.pose;
    const cam = this.cam;
    cam.h = lerpAngle(cam.h, pp.h, Math.min(1, dt * 9));
    const turnRate = dt > 0 ? angDiff(cam.prevH, cam.h) / dt : 0;
    cam.prevH = cam.h;
    const steerTarget = Math.max(-110, Math.min(110, turnRate * 190));
    cam.steer += (steerTarget - cam.steer) * Math.min(1, dt * 6);
    cam.yaw += ((sim.input.look ? -1.05 : 0) - cam.yaw) * Math.min(1, dt * 7);

    const lookH = cam.h + cam.yaw;
    const left = cam.h - Math.PI / 2;
    const seat = { x: pp.x + Math.cos(left) * 0.38, y: pp.y + Math.sin(left) * 0.38 };
    this.camera.position.set(seat.x, 1.22, seat.y);
    this.camera.lookAt(seat.x + Math.cos(lookH) * 10, 1.0, seat.y + Math.sin(lookH) * 10);
    this.beam.position.set(pp.x, 0.1, pp.y);
    this.beam.rotation.y = -pp.h;
    const back = add(seat, U(cam.h), 0.6);
    this.mirrorCam.position.set(back.x, 1.3, back.y);
    this.mirrorCam.lookAt(back.x - Math.cos(cam.h) * 10, 1.15, back.y - Math.sin(cam.h) * 10);
  }

  /** Snap the view straight ahead (used on restart). */
  resetView(h: number): void {
    this.cam.h = this.cam.prevH = h;
  }

  render(): void {
    const w = this.stage.clientWidth;
    const h = this.stage.clientHeight;
    const r = this.renderer;
    r.setScissorTest(false);
    r.setViewport(0, 0, w, h);
    r.render(this.scene, this.camera);

    // Rear-view mirror: a second camera drawn into the mirror frame's rectangle.
    const mr = this.mirrorEl.getBoundingClientRect();
    const sr = this.stage.getBoundingClientRect();
    const bw = 5;
    const x = mr.left - sr.left + bw;
    const y = mr.top - sr.top + bw;
    const mw = mr.width - 2 * bw;
    const mh = mr.height - 2 * bw;
    if (mw > 4 && mh > 4) {
      this.mirrorCam.aspect = mw / mh;
      this.mirrorCam.updateProjectionMatrix();
      r.setScissorTest(true);
      r.setScissor(x, h - y - mh, mw, mh);
      r.setViewport(x, h - y - mh, mw, mh);
      r.render(this.scene, this.mirrorCam);
      r.setScissorTest(false);
      r.setViewport(0, 0, w, h);
    }
  }
}
