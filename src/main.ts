import './style.css';
import { CarAudio } from './audio';
import { Simulation } from './sim';
import { UI } from './ui';
import { World } from './world';

async function fontsReady(timeoutMs: number): Promise<void> {
  if (!document.fonts?.load) return;
  try {
    await Promise.race([
      Promise.all([document.fonts.load('900 40px Overpass'), document.fonts.load('800 40px Overpass')]),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  } catch {
    /* fall back to system fonts */
  }
}

function showFailure(stage: HTMLElement): void {
  const f = document.createElement('div');
  f.className = 'fail';
  f.textContent = 'The 3D view could not load in this browser. Try refreshing, or open the page in a current version of Chrome, Safari, Edge or Firefox.';
  stage.append(f);
}

async function boot(): Promise<void> {
  const stage = document.getElementById('stage')!;
  const ui = new UI();
  await fontsReady(1800);
  ui.fillGuideImages();

  let world: World;
  try {
    world = new World(document.getElementById('view') as HTMLCanvasElement, stage, document.getElementById('mirror')!, [
      document.getElementById('mirror-l')!,
      document.getElementById('mirror-r')!,
    ]);
  } catch {
    showFailure(stage);
    return;
  }

  await ui.loadCrashGrid();

  const sim = new Simulation(ui);
  sim.destIdx = 1 + Math.floor(Math.random() * 3);
  const audio = new CarAudio();
  ui.attach(sim, world, audio);
  // Browsers block sound until the visitor interacts with the page.
  const unlock = () => { if (audio.enabled) audio.unlock(); };
  window.addEventListener('pointerdown', unlock, { capture: true });
  window.addEventListener('keydown', unlock, { capture: true });
  ui.drawCityMap('all');

  world.resize();
  new ResizeObserver(() => world.resize()).observe(stage);
  world.build();
  ui.restart();

  // Let traffic build up before the first frame so the rotary is already busy.
  for (let i = 0; i < 900; i++) sim.step(0.05);
  world.resetView(sim.player.pose.h);

  // Tab switching
  document.querySelectorAll<HTMLButtonElement>('[role="tab"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab!;
      document.querySelectorAll('[role="tab"]').forEach((b) => b.setAttribute('aria-selected', 'false'));
      btn.setAttribute('aria-selected', 'true');
      document.querySelectorAll<HTMLElement>('.tab-panel').forEach((p) => { p.hidden = true; });
      const panel = document.getElementById(`tab-${tab}`);
      if (panel) panel.hidden = false;
      if (tab === 'map') ui.drawCityMap();
    });
  });

  let last = performance.now();
  const frame = (t: number) => {
    const dt = Math.max(0, Math.min(0.05, (t - last) / 1000));
    last = t;
    if (!ui.paused) sim.step(dt);
    world.sync(sim, ui.paused ? 0 : dt);
    world.render();
    ui.update(dt, t);
    audio.update(sim, ui.paused, t, world.cam.h);
    requestAnimationFrame(frame);
  };
  world.sync(sim, 0.05);
  world.render();
  ui.update(0, 0);
  requestAnimationFrame(frame);
}

void boot();
