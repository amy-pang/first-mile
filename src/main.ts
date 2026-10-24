import './style.css';
import { AuthManager } from './auth';
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

function wireAuthModal(auth: AuthManager): void {
  const modal = document.getElementById('auth-modal')!;
  const btn = document.getElementById('auth-btn')!;
  const title = document.getElementById('auth-title')!;
  const emailIn = document.getElementById('auth-input-email') as HTMLInputElement;
  const passwordIn = document.getElementById('auth-input-password') as HTMLInputElement;
  const errorEl = document.getElementById('auth-error')!;
  const submitBtn = document.getElementById('auth-submit')!;
  const toggleBtn = document.getElementById('auth-toggle')!;
  const cancelBtn = document.getElementById('auth-cancel')!;

  let mode: 'signin' | 'signup' = 'signin';

  const open = () => {
    emailIn.value = '';
    passwordIn.value = '';
    errorEl.hidden = true;
    modal.hidden = false;
    emailIn.focus();
  };
  const close = () => { modal.hidden = true; };

  const setMode = (m: 'signin' | 'signup') => {
    mode = m;
    title.textContent = m === 'signin' ? 'Sign in' : 'Sign up';
    submitBtn.textContent = m === 'signin' ? 'Sign in' : 'Sign up';
    toggleBtn.textContent = m === 'signin' ? 'No account? Sign up' : 'Already have an account? Sign in';
    errorEl.hidden = true;
  };

  btn.addEventListener('click', () => {
    if (auth.user) {
      void auth.signOut();
    } else {
      setMode('signin');
      open();
    }
  });

  toggleBtn.addEventListener('click', () => setMode(mode === 'signin' ? 'signup' : 'signin'));
  cancelBtn.addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

  submitBtn.addEventListener('click', async () => {
    const email = emailIn.value.trim();
    const password = passwordIn.value;
    if (!email || !password) {
      errorEl.textContent = 'Enter your email and password.';
      errorEl.hidden = false;
      return;
    }
    submitBtn.setAttribute('disabled', '');
    const err = mode === 'signin'
      ? await auth.signIn(email, password)
      : await auth.signUp(email, password);
    submitBtn.removeAttribute('disabled');
    if (err) {
      errorEl.textContent = err;
      errorEl.hidden = false;
    } else {
      if (mode === 'signup') {
        errorEl.textContent = 'Check your email to confirm your account, then sign in.';
        errorEl.className = 'auth-error';
        errorEl.style.color = 'var(--ok)';
        errorEl.hidden = false;
      } else {
        close();
      }
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) close();
    if (e.key === 'Enter' && !modal.hidden) submitBtn.click();
  });
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

  const auth = new AuthManager();
  await auth.init();
  ui.setAuth(auth);
  wireAuthModal(auth);

  await fontsReady(1800);
  ui.fillGuideImages();

  await ui.loadCrashGrid();

  // Tab switching registered before World so tabs work even if WebGL fails.
  document.querySelectorAll<HTMLButtonElement>('[role="tab"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab!;
      document.querySelectorAll('[role="tab"]').forEach((b) => b.setAttribute('aria-selected', 'false'));
      btn.setAttribute('aria-selected', 'true');
      document.querySelectorAll<HTMLElement>('.tab-panel').forEach((p) => { p.hidden = true; });
      const panel = document.getElementById(`tab-${tab}`);
      if (panel) panel.hidden = false;
      if (tab === 'map') ui.drawCityMap();
      if (tab === 'runs') void ui.loadAndRenderRuns();
    });
  });

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
