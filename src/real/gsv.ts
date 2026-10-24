/**
 * Google Street View along the route, through the Street View Static API. Photos are requested live as you drive and
 * shown straight away; nothing is saved (Google's terms). Panorama lookups use the free metadata endpoint; each
 * photo shown is one billed request. Google's logo and copyright are part of every image.
 */
import type { Route } from './data';
import type { Frame, PhotoSource } from './photos';

const API = 'https://maps.googleapis.com/maps/api/streetview';
const STEP = 6;

interface Meta { status: string; pano_id?: string; date?: string; copyright?: string }

export function googleStreetView(route: Route, key: string, startS: number, onProgress: (done: number, total: number) => void): PhotoSource {
  const [lat0, lon0] = route.data.origin;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const frames: Frame[] = [];
  const spots: { s: number; lat: number; lon: number; heading: number }[] = [];
  for (let s = 0; s < route.len; s += STEP) {
    const p = route.at(s, route.laneCentre(s, 0));
    // A heading averaged over the next few metres, so each photo points down the road rather than at a kerb.
    const a = route.at(Math.max(0, s - 4));
    const b = route.at(Math.min(route.len, s + 8));
    const heading = (90 + (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI + 360) % 360;
    spots.push({ s, lat: lat0 - p.y / 110540, lon: lon0 + p.x / kx, heading });
  }

  // Look up the nearest panorama for each spot, a few at a time, starting where the drive starts.
  const found: (Meta | null | undefined)[] = new Array(spots.length).fill(undefined);
  const first = Math.max(0, Math.floor(startS / STEP) - 2);
  const order = [...spots.keys()].map((k) => (first + k) % spots.length);
  let next = 0;
  let done = 0;
  const rebuild = () => {
    frames.length = 0;
    spots.forEach((sp, i) => {
      const m = found[i];
      if (!m || m.status !== 'OK' || !m.pano_id) return;
      const prev = frames[frames.length - 1];
      // The same panorama again only needs a new frame where the road turns noticeably.
      const turned = prev && Math.abs(((sp.heading - (prev.heading ?? 0) + 540) % 360) - 180) > 15;
      if (!prev || prev.id !== m.pano_id || turned) {
        frames.push({ s: sp.s, id: m.pano_id, pano: false, turn: 0, date: m.date ?? '', by: m.copyright ?? '© Google', heading: sp.heading });
      }
    });
    onProgress(done, spots.length);
  };
  const worker = async () => {
    while (next < order.length) {
      const i = order[next++];
      const sp = spots[i];
      try {
        const r = await fetch(`${API}/metadata?location=${sp.lat.toFixed(6)},${sp.lon.toFixed(6)}&radius=20&source=outdoor&key=${encodeURIComponent(key)}`);
        found[i] = (await r.json()) as Meta;
      } catch {
        found[i] = null;
      }
      done++;
      // Rebuilding is cheap; do it often at first so the view appears quickly, then in batches.
      if (done < 30 || done % 20 === 0 || done === spots.length) rebuild();
    }
  };
  for (let k = 0; k < 6; k++) void worker();

  return {
    step: STEP,
    frames,
    url: (f, look) => {
      const h = ((f.heading ?? 0) + look * 80 + 360) % 360;
      return `${API}?size=640x400&pano=${encodeURIComponent(f.id)}&heading=${h.toFixed(1)}&fov=80&pitch=-2&key=${encodeURIComponent(key)}`;
    },
    credit: (f) => `Google Street View${f.date ? `, ${f.date}` : ''} · ${f.by}`,
    canLook: true,
  };
}
