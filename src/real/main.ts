import '../style.css';
import { CarAudio } from '../audio';
import { loadRoute } from './data';
import { loadStreet, PhotoView } from './photos';
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
  const photos = street ? new PhotoView(stage, street) : null;

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
  // Street photos by default when they've been fetched; the 3D scene is only built if you switch to it.
  let built = false;
  const setView = (photo: boolean) => {
    sim.photo = photo && !!photos;
    if (photos) photos.visible = sim.photo;
    if (!sim.photo && !built) { world.build(); built = true; }
    document.body.classList.toggle('photo-mode', sim.photo);
    document.getElementById('photo-note')!.hidden = !sim.photo;
    document.getElementById('view-photo')!.setAttribute('aria-pressed', String(sim.photo));
    document.getElementById('view-3d')!.setAttribute('aria-pressed', String(!sim.photo));
    ui.renderRules();
    ui.restart();
  };
  document.getElementById('view-photo')!.addEventListener('click', () => setView(true));
  document.getElementById('view-3d')!.addEventListener('click', () => setView(false));
  if (!photos) (document.getElementById('view-photo') as HTMLButtonElement).disabled = true;
  setView(new URLSearchParams(location.search).get('view') !== '3d');
  // Let traffic settle in before the first frame.
  for (let i = 0; i < 200; i++) sim.step(0.05);

  let last = performance.now();
  const frame = (t: number) => {
    const dt = Math.max(0, Math.min(0.05, (t - last) / 1000));
    last = t;
    if (!ui.paused) sim.step(dt);
    world.sync(sim, ui.paused ? 0 : dt);
    if (sim.photo) photos!.update(sim);
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
