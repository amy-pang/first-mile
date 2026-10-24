# Tech Stack & Commands

## Stack

- **Language:** TypeScript (strict mode).
- **Build tool / dev server:** [Vite](https://vitejs.dev/) 5.
- **3D:** [three.js](https://threejs.org/) r128 (`three@0.128.0`, pinned).
- **Audio:** Web Audio API — all sound is synthesized live; there are no audio
  asset files.
- **Backend / auth:** [Supabase](https://supabase.com/) (`@supabase/supabase-js`)
  for optional accounts and saved "runs".
- **Font:** Overpass (Google Fonts).
- **Preprocessing:** Python 3 scripts under `scripts/` that emit JSON into
  `public/`.

Dependencies are version-pinned (notably `three` and `@types/three` at exactly
`0.128.0`). Keep `three` and its types in lockstep when upgrading.

## Commands

```bash
npm install          # install dependencies (Node.js 18+)
npm run dev          # Vite dev server; open the printed localhost URL
npm run build        # tsc --noEmit (type-check) then vite build -> dist/
npm run preview      # serve the production build locally
npm run typecheck    # type-check only (tsc --noEmit)
npm run preprocess   # python3 scripts/preprocess-crashes.py -> public/ JSON
```

After any code change, run `npm run typecheck` (or `npm run build`) — the build
gates on `tsc --noEmit`, so type errors must be clean.

## Environment

- Secrets live in `.env.local` (git-ignored). Supabase URL/anon key are read from
  Vite env vars (`import.meta.env`). Never hardcode or commit keys; reference them
  by name.

## Deployment

- `vite.config.ts` uses a **relative base**, so `dist/` works from any sub-path.
- Target is GitHub Pages: `npm run build` then publish `dist/` (e.g. a GitHub
  Actions Pages workflow).

## Conventions

- TypeScript strict; prefer explicit types on public interfaces.
- Keep simulation logic free of DOM and three.js (see `structure.md`); interact
  with the page only through the `SimHooks` interface so `sim.ts` stays headless-
  testable.
- The render/frame loop must never throw fatally — a single bad frame is caught
  and logged, never allowed to wedge the page. Preserve this defensiveness.
- Tabs (Drive / My Runs / Crash Map / Before You Drive) must keep working even if
  WebGL fails to initialize; only the 3D Drive view depends on WebGL.
