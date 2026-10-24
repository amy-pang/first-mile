/**
 * Street-photo view: real photos along the route, either Mapillary's (fetched by scripts/fetch-street-photos.py) or
 * Google Street View's (requested live, see gsv.ts), with the simulated pedestrians, cyclists, oncoming cars and the
 * signal you must obey drawn over them.
 */
import type { RouteSim } from './sim';

export interface Frame {
  s: number;
  id: string;
  pano: boolean;
  /** Photo heading minus our direction of travel, in degrees. */
  turn: number;
  date: string;
  by: string;
  /** Compass heading to request, for sources that can point the camera (Google Street View). */
  heading?: number;
}

/** Where photos come from. `frames` may keep growing while the view is in use. */
export interface PhotoSource {
  step: number;
  frames: Frame[];
  url(f: Frame, look: -1 | 0 | 1): string;
  credit(f: Frame): string;
  /** True when looking left or right swaps in a real photo facing that way. */
  canLook: boolean;
}

export interface StreetData {
  attribution: string;
  step: number;
  frames: Frame[];
}

export async function loadStreet(): Promise<StreetData | null> {
  try {
    const r = await fetch(new URL('street-route.json', document.baseURI));
    if (!r.ok) return null;
    const d = (await r.json()) as StreetData;
    return d.frames.length ? d : null;
  } catch {
    return null;
  }
}

/** Where the horizon sits in the view, as a fraction of its height (above the dashboard). */
const HORIZON = 0.4;

/** Mapillary photos saved by scripts/fetch-street-photos.py. */
export function mapillarySource(d: StreetData): PhotoSource {
  return {
    step: d.step,
    frames: d.frames,
    url: (f) => new URL(`street/${f.id}.jpg`, document.baseURI).href,
    credit: (f) => `Photo ${f.date} by ${f.by} · Mapillary, CC-BY-SA 4.0`,
    canLook: false,
  };
}

export class PhotoView {
  readonly root: HTMLDivElement;
  private readonly imgs: [HTMLImageElement, HTMLImageElement];
  private readonly overlay: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private readonly credit: HTMLDivElement;
  private readonly look: HTMLDivElement;
  private front = 0;
  private shown = '';
  private readonly cache = new Map<string, HTMLImageElement>();

  constructor(stage: HTMLElement, private readonly data: PhotoSource) {
    this.root = document.createElement('div');
    this.root.className = 'street';
    this.imgs = [document.createElement('img'), document.createElement('img')];
    for (const im of this.imgs) {
      im.alt = '';
      im.decoding = 'async';
      this.root.append(im);
    }
    this.imgs[0].alt = 'Street-level photo of the road ahead';
    this.overlay = document.createElement('canvas');
    this.g = this.overlay.getContext('2d')!;
    this.credit = document.createElement('div');
    this.credit.className = 'street-credit';
    this.look = document.createElement('div');
    this.look.className = 'look-panel';
    this.root.append(this.overlay, this.credit, this.look);
    stage.querySelector('canvas.view')!.after(this.root);
  }

  set visible(on: boolean) {
    this.root.hidden = !on;
  }

  /** Index of the photo for distance `s`: the last one taken at or just before where you are. */
  private frameAt(s: number): number {
    const f = this.data.frames;
    let lo = 0;
    let hi = f.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (f[m].s <= s + 3) lo = m;
      else hi = m - 1;
    }
    return lo;
  }

  private preload(i: number): void {
    const f = this.data.frames[i];
    if (!f) return;
    const url = this.data.url(f, 0);
    if (this.cache.has(url)) return;
    const im = new Image();
    im.decoding = 'async';
    im.src = url;
    this.cache.set(url, im);
    if (this.cache.size > 40) this.cache.delete(this.cache.keys().next().value as string);
  }

  /** Size and place a photo: regular photos fill the view; panoramas show the 110° slice facing our way. */
  private place(im: HTMLImageElement, f: Frame, zoom: number): void {
    const W = this.root.clientWidth;
    const H = this.root.clientHeight;
    if (f.pano) {
      const iw = W * (360 / 110) * zoom;
      const ih = iw / 2;
      const centre = 0.5 - f.turn / 360;
      im.style.width = `${iw}px`;
      im.style.height = `${ih}px`;
      im.style.left = `${W / 2 - centre * iw}px`;
      im.style.top = `${H * HORIZON - ih / 2}px`;
      im.style.objectFit = 'fill';
    } else {
      const ratio = (im.naturalWidth || 4) / (im.naturalHeight || 3);
      let iw = W * zoom;
      let ih = iw / ratio;
      if (ih < H * zoom) { ih = H * zoom; iw = ih * ratio; }
      // Shift a little sideways when the camera faced slightly off our heading.
      const shift = (-f.turn / 70) * W;
      im.style.width = `${iw}px`;
      im.style.height = `${ih}px`;
      im.style.left = `${(W - iw) / 2 + shift}px`;
      // Put the photo's horizon high in the windshield, so the road isn't hidden behind the dashboard.
      im.style.top = `${Math.max(H - ih, H * HORIZON - ih / 2)}px`;
      im.style.objectFit = 'fill';
    }
  }

  update(sim: RouteSim): void {
    if (this.root.hidden) return;
    const P = sim.player;
    if (!this.data.frames.length) return;
    const i = this.frameAt(P.s);
    const f = this.data.frames[i];
    const look: -1 | 0 | 1 = this.data.canLook ? (sim.input.look ? -1 : sim.input.lookRight ? 1 : 0) : 0;
    const url = this.data.url(f, look);
    if (url !== this.shown) {
      this.shown = url;
      const back = this.imgs[1 - this.front];
      back.onload = () => {
        this.place(back, f, 1);
        back.style.opacity = '1';
        this.imgs[this.front].style.opacity = '0';
        this.front = 1 - this.front;
      };
      back.src = url;
      for (let k = 1; k <= 5; k++) this.preload(i + k);
      this.credit.textContent = this.data.credit(f);
    }
    // Ease in towards the next photo so moving forward feels continuous.
    const t = look ? 0 : Math.max(0, Math.min(1, (P.s - f.s) / this.data.step));
    this.place(this.imgs[this.front], f, 1 + 0.12 * t);
    this.drawOverlay(sim, look !== 0);
    this.drawLook(sim);
  }

  /** Simulated people, bikes and oncoming cars, in rough perspective over the photo. */
  private drawOverlay(sim: RouteSim, sideways: boolean): void {
    const c = this.overlay;
    const W = this.root.clientWidth;
    const H = this.root.clientHeight;
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const g = this.g;
    g.clearRect(0, 0, W, H);
    const P = sim.player;
    const fpx = W * 0.62;
    const horizon = H * HORIZON;
    const eye = 1.4;
    const at = (d: number, off: number) => ({ x: W / 2 + ((off - P.off) * fpx) / d, y: horizon + (eye * fpx) / d, k: fpx / d });
    const items: { d: number; draw: () => void }[] = [];
    for (const p of sim.peds) {
      const d = p.s - P.s - 1.5;
      if (d < 3 || d > 70 || (!p.bike && !p.onRoad && Math.abs(p.off) > 9)) continue;
      items.push({ d, draw: () => {
        const q = at(d, p.off);
        const h = 1.7 * q.k;
        g.fillStyle = p.color;
        g.strokeStyle = 'rgba(0,0,0,.55)';
        g.lineWidth = Math.max(1, q.k * 0.05);
        if (p.bike) {
          g.beginPath();
          g.arc(q.x - 0.45 * q.k, q.y - 0.33 * q.k, 0.33 * q.k, 0, Math.PI * 2);
          g.arc(q.x + 0.45 * q.k, q.y - 0.33 * q.k, 0.33 * q.k, 0, Math.PI * 2);
          g.stroke();
        }
        const top = q.y - h - (p.bike ? 0.4 * q.k : 0);
        g.beginPath();
        g.roundRect(q.x - 0.22 * q.k, top + 0.3 * q.k, 0.44 * q.k, h * 0.55, 0.1 * q.k);
        g.fill();
        g.stroke();
        g.beginPath();
        g.arc(q.x, top + 0.16 * q.k, 0.15 * q.k, 0, Math.PI * 2);
        g.fillStyle = '#d9b08c';
        g.fill();
        if (!p.bike) {
          g.fillStyle = '#2c3440';
          g.fillRect(q.x - 0.18 * q.k, top + 0.3 * q.k + h * 0.55, 0.36 * q.k, h * 0.4);
        }
      } });
    }
    for (const car of sim.cars) {
      if (car.isPlayer || car.free !== undefined) continue;
      const d = (car.s - P.s) - 2;
      if (d < 3 || d > 90) continue;
      items.push({ d, draw: () => {
        const q = at(d, car.off);
        const w = 1.85 * q.k;
        const h = 1.45 * q.k;
        g.fillStyle = car.color;
        g.strokeStyle = 'rgba(0,0,0,.6)';
        g.lineWidth = Math.max(1, q.k * 0.04);
        g.beginPath();
        g.roundRect(q.x - w / 2, q.y - h, w, h * 0.92, 0.18 * q.k);
        g.fill();
        g.stroke();
        g.fillStyle = 'rgba(30,38,46,.85)';
        g.fillRect(q.x - w * 0.38, q.y - h * 0.9, w * 0.76, h * 0.34);
        g.fillStyle = car.dir === -1 ? '#fff3cf' : '#ff2a1f';
        g.fillRect(q.x - w * 0.42, q.y - h * 0.42, w * 0.16, h * 0.1);
        g.fillRect(q.x + w * 0.26, q.y - h * 0.42, w * 0.16, h * 0.1);
      } });
    }
    // Looking sideways in a real photo: the figures are placed for the view ahead, so leave them out.
    if (!sideways) items.sort((a, b) => b.d - a.d).forEach((it) => it.draw());

    // The signal you must obey, whatever the photo happens to show.
    const sg = sim.signals.find((x) => x.s - P.s > -2 && x.s - P.s < 120);
    if (sg) {
      const L = sim.light(sg);
      const x = W * 0.86;
      const y = H * 0.12;
      const r = Math.max(7, H * 0.022);
      g.fillStyle = 'rgba(12,14,16,.85)';
      g.beginPath();
      g.roundRect(x - r * 1.6, y - r * 1.4, r * 3.2, r * 7.4, r * 0.6);
      g.fill();
      (['red', 'yellow', 'green'] as const).forEach((c2, k) => {
        g.beginPath();
        g.arc(x, y + r * 0.2 + k * r * 2.3, r, 0, Math.PI * 2);
        g.fillStyle = L === c2 ? (c2 === 'red' ? '#ff3326' : c2 === 'yellow' ? '#ffc61a' : '#2fe07a') : '#2a2e33';
        g.fill();
      });
      g.font = `700 ${Math.round(r * 1.1)}px Overpass, sans-serif`;
      g.textAlign = 'center';
      g.fillStyle = '#fff';
      g.fillText(`${Math.max(0, Math.round((sg.s - P.s - 2.2) * 3.281))} ft`, x, y + r * 7.6);
    }
  }

  /** Holding Q or E: what a glance over that shoulder would show. */
  private drawLook(sim: RouteSim): void {
    const P = sim.player;
    const left = sim.input.look;
    const right = sim.input.lookRight;
    this.look.hidden = !left && !right;
    if (this.look.hidden) return;
    const seen: string[] = [];
    if (left) {
      const oncoming = sim.cars.filter((c) => c.dir === -1 && c.free === undefined && c.s - P.s > -5 && c.s - P.s < 70);
      const crossing = sim.peds.filter((p) => !p.bike && p.onRoad && p.s - P.s > 0 && p.s - P.s < 30);
      if (oncoming.length) seen.push(`${oncoming.length} oncoming car${oncoming.length > 1 ? 's' : ''}, nearest ${Math.round(Math.min(...oncoming.map((c) => c.s - P.s)) * 3.281)} ft`);
      if (crossing.length) seen.push('people crossing ahead');
    } else {
      const bikes = sim.peds.filter((p) => p.bike && p.s - P.s > -15 && p.s - P.s < 6);
      if (bikes.length) seen.push(`cyclist in the bike lane ${bikes[0].s < P.s ? 'behind you' : 'beside you'}`);
      const crossing = sim.peds.filter((p) => !p.bike && p.onRoad && p.s - P.s > 0 && p.s - P.s < 30);
      if (crossing.length) seen.push('people crossing ahead');
    }
    this.look.className = `look-panel ${left ? 'left' : 'right'}`;
    this.look.innerHTML = '';
    const b = document.createElement('b');
    b.textContent = left ? '◂ Looking left' : 'Looking right ▸';
    const p = document.createElement('span');
    p.textContent = seen.length ? seen.join(' · ') : 'Clear';
    this.look.append(b, p);
  }
}
