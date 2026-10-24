# FirstMile

Your first mile on Massachusetts roads. FirstMile is an in-car driving simulator that helps newcomers to Massachusetts, such as international students and drivers from other states, practice a rotary before they drive a real one.

Built for **Hackachusetts 2026 · Civic track**.

## Features

- **Free steering.** Steer with the arrow keys or the on-screen buttons. The wheels straighten when you let go, and you can miss your exit and go around again.
- **Rain.** Choose rainy weather for slick roads, longer stopping distances, wipers and a grey sky. The Massachusetts rule *wipers on, headlights on* is checked: press L to turn your lights on.
- **Emergency vehicle.** Tick "Emergency vehicle" and an ambulance with lights and a siren comes through the rotary from your left. Wait for it at the yield line, keep moving inside the rotary, and pull over once you've exited ahead of it. The siren is panned so you can hear which side it's on.
- **Debrief map.** After each run, the result card shows the line you drove with a numbered dot at every spot where you broke a rule.
- **Sound.** A quiet cabin mix: a soft engine hum that climbs through the gears, road and wind noise, curb rumble, blinker ticks, rain and wipers, a siren, a horn tap when you cut someone off, a crash, and gentle coaching chimes. All generated live with the Web Audio API, so there are no sound files. Press M to mute.
- **Driver's-seat view.** You see the road through the windshield, with a steering wheel that turns, a speedometer, a rear-view mirror and left and right side mirrors (flipped like real mirrors), a nav screen and a dashboard trip clock.
- **Massachusetts-style signs.** Speed limit, rotary diagram with route shields, rotary warning with a 20 mph advisory, pedestrian crossing, the "State Law" crosswalk sign, Yield and One Way. Each sign pops up with an explanation as you approach it.
- **Route map.** Choose your start and destination around the rotary (US 20 Allston, MA 2A Cambridge, MA 16 Somerville, MA 2 West Arlington).
- **Trip times.** Set when you leave and when you need to arrive. Your departure time sets traffic (rush hour, moderate, light) and lighting (day, sunrise, sunset, night). The trip clock runs 20× real time.
- **Rule checks and coaching.** Yielding to circulating traffic, looking left, stopping for pedestrians, speed, not stopping inside the rotary, signaling your exit, keeping right of the yellow line, staying on the road and out of the centre island, and taking the right exit. Arriving late never costs points; speeding does.
- **Score based on driving habits.** 100 points across six weighted categories: right of way (30), speed control (20), following distance (15, two-second rule, three in rain), lane position and steering (15), signals and checks (12) and rotary flow (8). Steady habits lose points every second they slip, scaled by how far off you are; one-off rules lose a fixed amount. Pass with 80+ and no critical error (collision, occupied crosswalk, failing to yield, pulling out in front of an ambulance). Taking the wrong exit or arriving late costs nothing. The result card shows the breakdown.
- **Rules and signs guide.** Plain-language explanations of rotary rules and other Massachusetts rules newcomers often miss.

## Getting started

Requires [Node.js](https://nodejs.org/) 18 or newer.

```bash
npm install
npm run dev        # start the dev server, then open the printed localhost URL
npm run build      # type-check and build to dist/
npm run preview    # serve the production build locally
npm run typecheck  # type-check only
```

## Controls

| Action | Button | Keyboard |
|---|---|---|
| Gas | Gas | ↑ or W |
| Brake | Brake | ↓, S or Space |
| Steer left / right | Left / Right | ← → or A D |
| Look left | Look left | Q |
| Signal right | Signal | E |
| Headlights | Lights | L |
| Sound on/off | Sound on | M |
| Pause | Pause | P |
| Restart | New run | R |

## Project structure

```
index.html          Page markup: stage, car cabin overlay, side panel, guide
src/
  main.ts           Boot: fonts, world, simulation, frame loop
  constants.ts      Geometry, roads, speed limits, shared types
  math.ts           Small 2D helpers
  path.ts           Drivable paths through the rotary
  sim.ts            Traffic, pedestrians, player car and rule checks (no DOM or three.js)
  world.ts          three.js scene, lighting, signs, meshes, cameras and mirror
  signs.ts          Canvas artwork and explanations for every sign
  audio.ts          Synthesised engine, road, rain, siren, blinker, horn and crash sounds
  trip.ts           Trip times, traffic and lighting by time of day
  ui.ts             Controls, instruments, route map, coach feed, guide
  style.css         Styles
```

`sim.ts` talks to the page only through the `SimHooks` interface, so the simulation can be tested headlessly or reused with a different front end.

## Deploying to GitHub Pages

`vite.config.ts` uses a relative base, so `dist/` works from any sub-path. Run `npm run build` and publish the `dist/` folder, for example with a GitHub Actions Pages workflow.

## Notes

- The rotary is a generic practice layout, not one specific real intersection. Route shields and sign styles follow Massachusetts conventions.
- Rules are summarized for practice. Check the official Massachusetts Driver's Manual from the RMV before a road test.
- Rush-hour windows and lighting are simple approximations for late-October Boston, not live data.
- Coach feedback is scripted. A full build would use an LLM grounded in the Massachusetts Driver's Manual, real intersections from OpenStreetMap, and practice hotspots ranked by MassDOT crash data.

## Tech

TypeScript (strict), [Vite](https://vitejs.dev/), [three.js](https://threejs.org/) r128, Overpass font from Google Fonts.
# first-mile
