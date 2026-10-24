import '../style.css';
import { CarAudio } from '../audio';
import { loadRoute } from './data';
import { googleStreetView } from './gsv';
import { loadStreet, mapillarySource, PhotoView } from './photos';
import { RouteSim } from './sim';
import { RouteUI } from './ui';
import { RealWorld } from './world';

function showFailure(stage: HTMLElement, msg: string): void {
  const d = document.createElement('div');
  d.className = 'result';
  d.innerHTML = '<div class="result-card fail-card"><h2>Can’t start the drive</h2><p></p></div>';
  d.querySelector('p')!.textContent = msg;
  stage.append(d);
}

async function boot(): Promise<void> {
  const stage = document.getElementById('stage')!;
  if (document.fonts?.load) {
    await Promise.all([document.fonts.load('900 40px Overpass'), document.fonts.load('800 20px Overpass')]).catch(() => undefined);
  }
  let route;
  try {
    route = await loadRoute();
  } catch (e) {
    showFailure(stage, `The route data didn't load (${(e as Error).message}). Run "python3 scripts/build-real-route.py".`);
    return;
  }
  let world: RealWorld;
  try {
    world = new RealWorld(document.getElementById('view') as HTMLCanvasElement, stage, document.getElementById('mirror')!, [
      document.getElementById('mirror-l')!,
      document.getElementById('mirror-r')!,
    ]);
  } catch {
    showFailure(stage, 'This browser could not start WebGL, which the 3D view needs.');
    return;
  }
  world.setRoute(route);
  const street = await loadStreet();
  const photos = street ? new PhotoView(stage, mapillarySource(street)) : null;

  const ui = new RouteUI();
  const sim = new RouteSim(route, ui);
  // ?at=1200 starts partway along the route (metres from Lehman Hall), handy for practising one stretch.
  const at = Number(new URLSearchParams(location.search).get('at'));
  if (at > 0) sim.startAt = at;
  const audio = new CarAudio();
  ui.attach(sim, world, audio);
  const unlock = () => { if (audio.enabled) audio.unlock(); };
  window.addEventListener('pointerdown', unlock, { capture: true });
  window.addEventListener('keydown', unlock, { capture: true });

  world.resize();
  new ResizeObserver(() => world.resize()).observe(stage);
  // Three views: Google Street View (needs VITE_GOOGLE_MAPS_KEY with the Street View Static API), Mapillary photos,
  // or our own 3D scene. The photo views keep the car on the route; only our own 3D scene allows free steering.
  const key = (import.meta.env.VITE_GOOGLE_MAPS_KEY as string | undefined) ?? '';
  const progress = document.createElement('div');
  progress.className = 'g3d-status';
  const gsvSource = key ? googleStreetView(route, key, sim.startAt, (done, total) => {
    progress.textContent = `Finding Google Street View along the route… ${Math.round((done / total) * 100)}%`;
    progress.hidden = done >= total;
  }) : null;
  const google = gsvSource ? new PhotoView(stage, gsvSource) : null;
  if (google) google.root.append(progress);
  type View = 'google' | 'photo' | '3d';
  const btn = (v: View) => document.getElementById(`view-${v === 'google' ? 'google' : v === 'photo' ? 'photo' : '3d'}`) as HTMLButtonElement;
  let built = false;
  let view: View = '3d';
  const setView = (v: View) => {
    if (v === 'google' && !google) v = photos ? 'photo' : '3d';
    if (v === 'photo' && !photos) v = '3d';
    view = v;
    sim.photo = v !== '3d';
    if (photos) photos.visible = v === 'photo';
    if (google) google.visible = v === 'google';
    if (v === '3d' && !built) { world.build(); built = true; }
    document.body.classList.toggle('photo-mode', sim.photo);
    document.getElementById('photo-note')!.hidden = v !== 'photo';
    document.getElementById('google-note')!.hidden = v !== 'google';
    for (const x of ['google', 'photo', '3d'] as View[]) btn(x).setAttribute('aria-pressed', String(x === v));
    ui.renderRules();
    ui.restart();
  };
  for (const x of ['google', 'photo', '3d'] as View[]) btn(x).addEventListener('click', () => setView(x));
  if (!google) { btn('google').disabled = true; btn('google').title = 'Add VITE_GOOGLE_MAPS_KEY (Street View Static API) to .env.local'; }
  if (!photos) { btn('photo').disabled = true; btn('photo').title = 'Run scripts/fetch-street-photos.py'; }
  const asked = new URLSearchParams(location.search).get('view') as View | null;
  setView(asked ?? (google ? 'google' : 'photo'));
  // Let traffic settle in before the first frame.
  for (let i = 0; i < 200; i++) sim.step(0.05);

  let last = performance.now();
  const frame = (t: number) => {
    const dt = Math.max(0, Math.min(0.05, (t - last) / 1000));
    last = t;
    if (!ui.paused) sim.step(dt);
    world.sync(sim, ui.paused ? 0 : dt);
    if (view === 'photo') photos!.update(sim);
    else if (view === 'google') google!.update(sim);
    else {
      world.updateSignals(sim);
      world.render();
    }
    ui.update(t);
    audio.update(sim, ui.paused, t, world.cam.h);
    requestAnimationFrame(frame);
  };
  world.sync(sim, 0.05);
  world.resetView(sim.player.pose.h);
  requestAnimationFrame(frame);
}

void boot();
