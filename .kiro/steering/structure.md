# Project Structure

```
index.html            Page markup: stage, car cabin overlay, side panel, guide, tabs
vite.config.ts        Vite config (relative base for GitHub Pages)
tsconfig.json         TypeScript (strict) config
.env.local            Secrets (Supabase); git-ignored

src/
  main.ts             Boot: fonts, auth modal wiring, tab switching, World +
                      Simulation setup, the requestAnimationFrame loop
  constants.ts        Geometry, roads, speed limits, shared types
  math.ts             Small 2D vector/geometry helpers
  path.ts             Drivable paths through the rotary
  sim.ts              Traffic, pedestrians, player car, rule checks.
                      *No DOM, no three.js* — talks to the page only via SimHooks
  world.ts            three.js scene: lighting, signs, meshes, cameras, mirrors
  signs.ts            Canvas artwork + plain-language explanations for each sign
  audio.ts            Synthesized engine/road/rain/siren/blinker/horn/crash sounds
  trip.ts             Trip times; traffic + lighting by time of day
  ui.ts               Controls, instruments, route map, coach feed, guide,
                      crash map + My Runs tab rendering
  auth.ts             AuthManager — Supabase sign in / sign up / sign out
  supabase.ts         Supabase client setup
  bike-density.ts     Bike-count data helpers (reference data)
  crash-stats.ts      Crash-statistics helpers (reference data)
  style.css           Styles

public/               Static JSON served as-is
  crash-grid.json     Preprocessed crash grid (from scripts/)
  streets.json        Preprocessed street data (from scripts/)

scripts/              Python 3 preprocessing -> public/ JSON
  preprocess-crashes.py
  preprocess-streets.py

data/                 Raw Cambridge open datasets + fetch scripts (reference)
  Street_Centerline_*.geojson
  cambridge-broadway-bicycle/
  cambridge-citywide-bikes/
  cambridge-crashes/

dist/                 Build output (generated)
```

## Architectural Rules

- **Separation of concerns:** `sim.ts` is the pure simulation core and must stay
  free of DOM and three.js. It communicates outward only through the `SimHooks`
  interface, so it can run headlessly or behind a different front end. Do not
  import three.js or touch `document` from `sim.ts`.
- **Rendering layer:** `world.ts` owns all three.js. `ui.ts` owns all DOM/UI
  (controls, instruments, maps, tabs). `main.ts` wires them together.
- **Graceful degradation:** Tab switching is registered before `World` is
  constructed so the non-3D tabs survive a WebGL failure. Keep new 3D code inside
  the WebGL-guarded path.
- **Frame-loop safety:** The animation loop catches and logs per-frame errors and
  always re-schedules; never let a frame error escape the loop.
- **Data vs. live sim:** Files under `data/` and the `bike-density` / `crash-stats`
  helpers are reference/experimental data, not yet part of the core driving sim.
  Keep that boundary clear until explicitly integrated.
```
