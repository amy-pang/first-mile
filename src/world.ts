/** The three.js scene: roads, houses, trees, signs, traffic meshes, lighting and the two cameras. */
import * as THREE from 'three';
import { DCW, DEG, DEND, DY, LANE_DROP, LANE_END, R_IN, R_OUT, ROADS, RW, TAU, type Pt } from './constants';
import { add, inboundEdge, lerpAngle, pickOne, rand, ringPt, roadPt, tanAt, U, yawFor } from './math';
import type { Pose } from './constants';
import { SIGNS, type SignSpec } from './signs';
import type { Phase, Weather } from './trip';

const PPM = 160; // sign texture resolution, pixels per metre
const RAIN_DROPS = 1500;
/** Half-size of the box of rain kept around the driver, in metres. */
const RAIN_BOX = 22;

export interface Layer {
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

/** What the scene needs from a simulation: the cars, people and the driver's inputs. */
export interface SceneSim {
  cars: readonly {
    id: number; isPlayer: boolean; pose: Pose; braking: boolean; color: string; ems?: boolean;
    /** Which blinker is on; rotary cars leave it out and signal right as they near their exit. */
    blink?: 'left' | 'right' | null;
    s?: number; path?: { sExit: number; sOff: number };
  }[];
  peds: readonly { id: number; x: number; y: number; color: string; bike?: boolean; h?: number }[];
  player: { pose: Pose };
  steer: number;
  input: { look: boolean; lookRight?: boolean };
}

export class World {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(72, 16 / 10, 0.25, 700);
  readonly mirrorCam = new THREE.PerspectiveCamera(30, 3.6, 0.5, 400);
  /** Door mirrors: each looks back and a little outward from its side of the car. */
  readonly leftCam = new THREE.PerspectiveCamera(22, 1.55, 0.3, 300);
  readonly rightCam = new THREE.PerspectiveCamera(22, 1.55, 0.3, 300);

  /**
   * Mirrors are rendered into a texture, then drawn back left-to-right flipped, the way a real mirror shows
   * the road behind you. A car in the lane to your left appears on the left of the glass.
   */
  private readonly mirrors: { el: HTMLElement; cam: THREE.PerspectiveCamera; rt: THREE.WebGLRenderTarget }[];
  private readonly flipScene = new THREE.Scene();
  private readonly flipCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly flipMat = new THREE.MeshBasicMaterial({ depthTest: false, depthWrite: false, toneMapped: false });

  /** Smoothed view heading, head turn and steering-wheel angle (degrees). */
  readonly cam = { h: -Math.PI / 2, prevH: -Math.PI / 2, yaw: 0, steer: 0 };

  protected readonly hemi = new THREE.HemisphereLight(0xe4f0ff, 0x5a6a48, 0.85);
  protected readonly sun = new THREE.DirectionalLight(0xffffff, 0.7);
  protected readonly fog = new THREE.Fog(0xd6e1e7, 110, 430);
  protected readonly flatMats: THREE.MeshBasicMaterial[] = [];
  protected readonly signMats: THREE.MeshBasicMaterial[] = [];
  private readonly beam: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  protected readonly layers = new Map<string, Layer>();
  private readonly carMeshes = new Map<number, THREE.Group>();
  private readonly pedMeshes = new Map<number, THREE.Group>();
  private readonly lights: Record<Phase, LightPreset>;
  private readonly rainSky = skyTex(['#4B5560', '#6E7882', '#8A939B']);
  private readonly rainNightSky = skyTex(['#05070B', '#0E141C', '#171E27']);
  private readonly rain: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  private phase: Phase = 'day';
  private wet = false;
  private headlights = false;
  protected maxAniso = 4;

  protected readonly poleMat = new THREE.MeshLambertMaterial({ color: 0x8a9096 });
  protected readonly poleGeo = new THREE.CylinderGeometry(0.05, 0.05, 1, 8);
  private readonly carGeo = {
    body: new THREE.BoxGeometry(4.4, 0.8, 1.85),
    cabin: new THREE.BoxGeometry(2.3, 0.62, 1.62),
    wheel: new THREE.CylinderGeometry(0.34, 0.34, 0.26, 10).rotateX(Math.PI / 2),
    lamp: new THREE.BoxGeometry(0.06, 0.18, 0.42),
    signal: new THREE.BoxGeometry(0.06, 0.14, 0.3),
  };
  private readonly carMat = {
    glass: new THREE.MeshLambertMaterial({ color: 0x1e262e }),
    wheel: new THREE.MeshLambertMaterial({ color: 0x141414 }),
    tailOn: new THREE.MeshBasicMaterial({ color: 0xff2a1f }),
    tailOff: new THREE.MeshBasicMaterial({ color: 0x6e1a16 }),
    head: new THREE.MeshBasicMaterial({ color: 0xfff3cf }),
    signalOn: new THREE.MeshBasicMaterial({ color: 0xff9400 }),
    signalOff: new THREE.MeshBasicMaterial({ color: 0x5a3500 }),
    redOn: new THREE.MeshBasicMaterial({ color: 0xff2020 }),
    redOff: new THREE.MeshBasicMaterial({ color: 0x5a1010 }),
    blueOn: new THREE.MeshBasicMaterial({ color: 0x2a6bff }),
    blueOff: new THREE.MeshBasicMaterial({ color: 0x10204a }),
    stripe: new THREE.MeshLambertMaterial({ color: 0xd8262a }),
  };
  private readonly barGeo = new THREE.BoxGeometry(0.5, 0.18, 0.7);
  private readonly stripeGeo = new THREE.BoxGeometry(4.42, 0.16, 1.87);
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

  private contextLost = false;

  constructor(canvas: HTMLCanvasElement, private readonly stage: HTMLElement, mirrorEl: HTMLElement, sideEls: [HTMLElement, HTMLElement]) {
    // Fail fast with a clear message if the browser/GPU can't give us a WebGL context
    // (commonly: too many live contexts across tabs, or hardware acceleration disabled).
    // Probe on a throwaway canvas so we don't lock the real canvas to a context type,
    // then let three.js create the real context. This guarantees the constructor throws
    // cleanly instead of returning a broken renderer that throws on every frame.
    const probeCanvas = document.createElement('canvas');
    const probe = (probeCanvas.getContext('webgl2') || probeCanvas.getContext('webgl') || probeCanvas.getContext('experimental-webgl'));
    if (!probe) {
      throw new Error('WebGL unavailable: the browser could not create a WebGL context.');
    }

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));

    // A WebGL context can be lost (GPU reset, too many live contexts across tabs, backgrounding).
    // Track it so render() can skip work instead of throwing and wedging the page.
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
      console.warn('WebGL context lost');
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      console.warn('WebGL context restored');
    });
    const rt = () => new THREE.WebGLRenderTarget(4, 4);
    this.mirrors = [
      { el: mirrorEl, cam: this.mirrorCam, rt: rt() },
      { el: sideEls[0], cam: this.leftCam, rt: rt() },
      { el: sideEls[1], cam: this.rightCam, rt: rt() },
    ];
    const quad = new THREE.PlaneGeometry(2, 2);
    const uv = quad.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setX(i, 1 - uv.getX(i));
    this.flipScene.add(new THREE.Mesh(quad, this.flipMat));
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

    // Rain: short falling streaks in a box that follows the camera.
    const rp = new Float32Array(RAIN_DROPS * 6);
    for (let i = 0; i < RAIN_DROPS; i++) {
      const x = rand(-RAIN_BOX, RAIN_BOX);
      const y = rand(0, 14);
      const z = rand(-RAIN_BOX, RAIN_BOX);
      rp.set([x, y, z, x + 0.03, y - 0.45, z], i * 6);
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(rp, 3));
    this.rain = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: 0xc8d4de, transparent: true, opacity: 0.45, depthWrite: false }));
    this.rain.frustumCulled = false;
    this.rain.visible = false;
    this.scene.add(this.rain);
  }

  resize(): void {
    const w = this.stage.clientWidth;
    const h = this.stage.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  applyLighting(phase: Phase, weather: Weather = 'clear'): void {
    const L = this.lights[phase];
    const wet = weather === 'rain';
    // Overcast rain: grey sky, haze closer in, and everything a little dimmer.
    const dim = wet ? 0.72 : 1;
    this.phase = phase;
    this.wet = wet;
    this.scene.background = wet ? (phase === 'night' ? this.rainNightSky : this.rainSky) : L.sky;
    this.fog.color.setHex(wet ? (phase === 'night' ? 0x0e131a : 0x8f979e) : L.fog);
    this.fog.near = L.near * (wet ? 0.6 : 1);
    this.fog.far = L.far * (wet ? 0.6 : 1);
    this.hemi.intensity = L.hemi * dim;
    this.sun.intensity = L.sun * (wet ? 0.35 : 1);
    for (const m of this.flatMats) m.color.copy(m.userData.base as THREE.Color).multiplyScalar(L.flat * dim);
    for (const m of this.signMats) m.color.setScalar(L.sign * (wet ? 0.9 : 1));
    this.rain.visible = wet;
    this.rain.material.color.setHex(phase === 'night' ? 0x6c7682 : 0xc8d4de);
    this.setHeadlights(this.headlights);
  }

  /** The headlight pool shows only while the lights are on: brightest in the dark, faint in daylight. */
  setHeadlights(on: boolean): void {
    this.headlights = on;
    const op = on ? Math.max(this.lights[this.phase].beam, this.wet ? 0.1 : 0.04) : 0;
    this.beam.material.opacity = op;
    this.beam.visible = op > 0;
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

  protected flatMat(color: number): THREE.MeshBasicMaterial {
    const m = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide });
    m.userData.base = m.color.clone();
    this.flatMats.push(m);
    return m;
  }

  protected layer(key: string, color: number, y: number): Layer {
    let L = this.layers.get(key);
    if (!L) {
      L = { color, y, pos: [] };
      this.layers.set(key, L);
    }
    return L;
  }

  protected quad(L: Layer, a: Pt, b: Pt, c: Pt, d: Pt): void {
    const y = L.y;
    L.pos.push(a.x, y, a.y, b.x, y, b.y, c.x, y, c.y, a.x, y, a.y, c.x, y, c.y, d.x, y, d.y);
  }

  protected tri(L: Layer, a: Pt, b: Pt, c: Pt): void {
    const y = L.y;
    L.pos.push(a.x, y, a.y, b.x, y, b.y, c.x, y, c.y);
  }

  protected strip(L: Layer, phi: number, d0: number, d1: number, off: number, w: number): void {
    this.quad(L, roadPt(phi, d0, off - w / 2), roadPt(phi, d1, off - w / 2), roadPt(phi, d1, off + w / 2), roadPt(phi, d0, off + w / 2));
  }

  /** Like `strip`, but with sideways offsets that vary along the road (sampled every 2.5 m). */
  private edgeStrip(L: Layer, phi: number, d0: number, d1: number, a: (d: number) => number, b: (d: number) => number): void {
    for (let d = d0; d < d1; d += 2.5) {
      const e = Math.min(d1, d + 2.5);
      this.quad(L, roadPt(phi, d, a(d)), roadPt(phi, e, a(e)), roadPt(phi, e, b(e)), roadPt(phi, d, b(d)));
    }
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
      // The extra inbound lane, its taper, and the sidewalk and edge line that follow it.
      this.edgeStrip(asph, r.phi, LANE_END, DEND + 40, inboundEdge, () => -RW);
      this.edgeStrip(walk, r.phi, R_OUT + 1.2, DEND + 40, (d) => inboundEdge(d) - 2.5, inboundEdge);
      this.strip(walk, r.phi, R_OUT + 1.2, DEND + 40, RW + 1.25, 2.5);
      this.strip(yel, r.phi, R_OUT + 1, DEND + 40, -0.16, 0.12);
      this.strip(yel, r.phi, R_OUT + 1, DEND + 40, 0.16, 0.12);
      this.edgeStrip(paint, r.phi, R_OUT + 3, DEND + 40, (d) => inboundEdge(d) + 0.19, (d) => inboundEdge(d) + 0.32);
      this.strip(paint, r.phi, R_OUT + 3, DEND + 40, RW - 0.25, 0.13);
      // Broken white lane line between the two inbound lanes: 3 m dashes, 9 m gaps.
      for (let d = LANE_DROP; d < DEND + 40; d += 12) this.strip(paint, r.phi, d, d + 3, -RW, 0.13);
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
          // The extra inbound lane and its sidewalk fill the verge here.
          if (side === -1 && d > LANE_END - 6) continue;
          tree(roadPt(r.phi, d, side * 8.6), rand(0.85, 1.05));
        }
      }
    }
    for (let k = 0, n = 0; k < 600 && n < 70; k++) {
      const p = { x: rand(-210, 210), y: rand(-210, 210) };
      const ax = Math.abs(p.x);
      const az = Math.abs(p.y);
      if (ax < RW + 8 || az < RW + 8 || Math.hypot(p.x, p.y) < R_OUT + 7) continue;
      if ((ax < 24 && az > 40) || (az < 24 && ax > 40)) continue;
      tree(p, rand(0.9, 1.3));
      n++;
    }
    for (let k = 0; k < 4; k++) tree(ringPt((k * TAU) / 4 + 0.6, rand(10, 13)), 0.85);
  }

  protected canvasTex(spec: SignSpec, back = false): THREE.CanvasTexture {
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

  protected placeSign(spec: SignSpec, pos: Pt, face: Pt, bottom: number, poles = 1): void {
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
      const right = (d: number) => roadPt(r.phi, d, inboundEdge(d) - 1.6);
      this.placeSign(SIGNS.speed(25), right(172), f, 1.5);
      this.placeSign(SIGNS.plaque(['RIGHT LANE', 'ENDS'], '#F5C400', 1.3, 0.62), right(160), f, 1.5);
      this.placeSign(SIGNS.laneEnds(), right(160), f, 2.2);
      this.placeSign(SIGNS.diagram(i), roadPt(r.phi, 140, inboundEdge(140) - 2.4), f, 1.8, 2);
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

  private makeCar(color: string, ems = false): THREE.Group {
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
    const signals: { right: THREE.Mesh[]; left: THREE.Mesh[] } = { right: [], left: [] };
    for (const x of [-2.21, 2.21] as const) {
      for (const [side, z] of [['right', 0.88], ['left', -0.88]] as [string, number][]) {
        const s = new THREE.Mesh(this.carGeo.signal, this.carMat.signalOff);
        s.position.set(x, 0.85, z);
        g.add(s);
        (signals as Record<string, THREE.Mesh[]>)[side].push(s);
      }
    }
    g.userData.signals = signals;
    if (ems) {
      // Ambulance: red side stripe and a light bar with one red and one blue lamp.
      const stripe = new THREE.Mesh(this.stripeGeo, this.carMat.stripe);
      stripe.position.y = 0.72;
      g.add(stripe);
      const bars: THREE.Mesh[] = [];
      for (const z of [-0.4, 0.4]) {
        const b = new THREE.Mesh(this.barGeo, this.carMat.redOff);
        b.position.set(0.2, 1.83, z);
        g.add(b);
        bars.push(b);
      }
      g.userData.bars = bars;
    }
    this.scene.add(g);
    return g;
  }

  /** Two wheels and a frame under a pedestrian mesh turn it into a cyclist (riding along local +x). */
  private addBike(g: THREE.Group): void {
    const wheel = new THREE.TorusGeometry(0.33, 0.04, 6, 16);
    const mat = new THREE.MeshLambertMaterial({ color: 0x222222 });
    for (const x of [-0.55, 0.55]) {
      const w = new THREE.Mesh(wheel, mat);
      w.position.set(x, 0.34, 0);
      g.add(w);
    }
    const frame = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.05, 0.05), new THREE.MeshLambertMaterial({ color: 0x2f6fb0 }));
    frame.position.set(0, 0.62, 0);
    g.add(frame);
    for (const c of g.children.slice(0, 3)) c.position.y += 0.45;
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
  sync(sim: SceneSim, dt: number): void {
    const liveCars = new Set<number>();
    for (const c of sim.cars) {
      if (c.isPlayer) continue;
      liveCars.add(c.id);
      let mesh = this.carMeshes.get(c.id);
      if (!mesh) {
        mesh = this.makeCar(c.color, c.ems);
        this.carMeshes.set(c.id, mesh);
      }
      mesh.position.set(c.pose.x, 0, c.pose.y);
      mesh.rotation.y = -c.pose.h;
      const lamp = c.braking ? this.carMat.tailOn : this.carMat.tailOff;
      for (const t of mesh.userData.tails as THREE.Mesh[]) t.material = lamp;
      const sigs = mesh.userData.signals as { right: THREE.Mesh[]; left: THREE.Mesh[] } | undefined;
      if (sigs) {
        const blink = c.blink !== undefined ? c.blink
          : c.path && c.s !== undefined && c.s > c.path.sExit - 20 && c.s < c.path.sOff + 5 ? 'right' : null;
        const flip = Math.floor(performance.now() / 500) % 2 === 0;
        const on = (side: 'left' | 'right') => (blink === side && flip ? this.carMat.signalOn : this.carMat.signalOff);
        for (const m of sigs.right) m.material = on('right');
        for (const m of sigs.left) m.material = on('left');
      }
      const bars = mesh.userData.bars as THREE.Mesh[] | undefined;
      if (bars) {
        // Alternate red and blue about four times a second.
        const flip = Math.floor(performance.now() / 250) % 2 === 0;
        bars[0].material = flip ? this.carMat.redOn : this.carMat.redOff;
        bars[1].material = flip ? this.carMat.blueOff : this.carMat.blueOn;
      }
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
        if (p.bike) this.addBike(mesh);
        this.pedMeshes.set(p.id, mesh);
      }
      mesh.position.set(p.x, 0, p.y);
      if (p.h !== undefined) mesh.rotation.y = -p.h;
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
    cam.prevH = cam.h;
    // About three turns of the wheel per radian of front-wheel angle, like a real steering rack.
    const steerTarget = Math.max(-180, Math.min(180, (sim.steer * 180 * 3) / Math.PI));
    cam.steer += (steerTarget - cam.steer) * Math.min(1, dt * 6);
    // Holding Look turns your head far enough to see over your left shoulder into the blind spot.
    cam.yaw += ((sim.input.look ? -1.3 : sim.input.lookRight ? 1.05 : 0) - cam.yaw) * Math.min(1, dt * 7);

    const lookH = cam.h + cam.yaw;
    const left = cam.h - Math.PI / 2;
    const seat = { x: pp.x + Math.cos(left) * 0.38, y: pp.y + Math.sin(left) * 0.38 };
    this.camera.position.set(seat.x, 1.22, seat.y);
    this.camera.lookAt(seat.x + Math.cos(lookH) * 10, 1.0, seat.y + Math.sin(lookH) * 10);
    this.beam.position.set(pp.x, 0.1, pp.y);
    if (this.rain.visible) this.moveRain(pp, dt);
    this.beam.rotation.y = -pp.h;
    const back = add(seat, U(cam.h), 0.6);
    this.mirrorCam.position.set(back.x, 1.3, back.y);
    this.mirrorCam.lookAt(back.x - Math.cos(cam.h) * 10, 1.15, back.y - Math.sin(cam.h) * 10);
    // Door mirrors sit just ahead of the driver, about a metre out from the car's centreline on each side.
    const door = (c: THREE.PerspectiveCamera, side: -1 | 1) => {
      const at = add(add(pp, U(cam.h + (side * Math.PI) / 2), 1.0), U(cam.h), 0.6);
      const look = cam.h + Math.PI - side * 0.22;
      c.position.set(at.x, 1.1, at.y);
      c.lookAt(at.x + Math.cos(look) * 10, 0.95, at.y + Math.sin(look) * 10);
    };
    door(this.leftCam, -1);
    door(this.rightCam, 1);
  }

  /** Drop the rain and wrap each streak around the box that travels with the driver. */
  private moveRain(c: Pt, dt: number): void {
    const attr = this.rain.geometry.getAttribute('position') as THREE.BufferAttribute;
    const a = attr.array as Float32Array;
    const fall = 16 * dt;
    for (let i = 0; i < a.length; i += 6) {
      let x = a[i] - fall * 0.03;
      let y = a[i + 1] - fall;
      let z = a[i + 2];
      if (y < 0) y += 14;
      if (x < c.x - RAIN_BOX) x += RAIN_BOX * 2;
      else if (x > c.x + RAIN_BOX) x -= RAIN_BOX * 2;
      if (z < c.y - RAIN_BOX) z += RAIN_BOX * 2;
      else if (z > c.y + RAIN_BOX) z -= RAIN_BOX * 2;
      a[i] = x;
      a[i + 1] = y;
      a[i + 2] = z;
      a[i + 3] = x + 0.03;
      a[i + 4] = y - 0.45;
      a[i + 5] = z;
    }
    attr.needsUpdate = true;
  }

  /** Snap the view straight ahead (used on restart). */
  resetView(h: number): void {
    this.cam.h = this.cam.prevH = h;
  }

  render(): void {
    const w = this.stage.clientWidth;
    const h = this.stage.clientHeight;
    const r = this.renderer;
    // Nothing to draw if the context is gone or the stage is hidden/zero-size (e.g. another tab is open).
    if (this.contextLost || r.getContext().isContextLost() || w <= 0 || h <= 0) return;
    r.setScissorTest(false);
    r.setViewport(0, 0, w, h);
    r.render(this.scene, this.camera);

    // Rear-view and door mirrors: each camera renders to its own texture, drawn flipped into its frame.
    const sr = this.stage.getBoundingClientRect();
    const pr = r.getPixelRatio();
    for (const m of this.mirrors) {
      const mr = m.el.getBoundingClientRect();
      const x = mr.left - sr.left + m.el.clientLeft;
      const y = mr.top - sr.top + m.el.clientTop;
      const mw = m.el.clientWidth;
      const mh = m.el.clientHeight;
      if (mw <= 4 || mh <= 4) continue;
      const pw = Math.round(mw * pr);
      const ph = Math.round(mh * pr);
      if (m.rt.width !== pw || m.rt.height !== ph) m.rt.setSize(pw, ph);
      m.cam.aspect = mw / mh;
      m.cam.updateProjectionMatrix();
      r.setRenderTarget(m.rt);
      r.render(this.scene, m.cam);
      r.setRenderTarget(null);
      this.flipMat.map = m.rt.texture;
      r.setScissorTest(true);
      r.setScissor(x, h - y - mh, mw, mh);
      r.setViewport(x, h - y - mh, mw, mh);
      r.render(this.flipScene, this.flipCam);
      r.setScissorTest(false);
      r.setViewport(0, 0, w, h);
    }
  }
}
