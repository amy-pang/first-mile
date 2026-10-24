# Product Overview

**FirstMile** — "Your first mile on Massachusetts roads."

FirstMile is an in-browser, in-car driving simulator that helps newcomers to
Massachusetts (international students, out-of-state drivers) practice a **rotary
(roundabout)** before they drive a real one. Built for **Hackachusetts 2026 ·
Civic track**.

The rotary is a generic practice layout following Massachusetts sign and
route-shield conventions, not one specific real intersection.

## Target Users

- International students and newcomers unfamiliar with Massachusetts rotaries.
- Out-of-state drivers adapting to local rules (e.g. *wipers on → headlights on*).
- Anyone wanting low-stakes practice yielding, merging, and reading MA-style signs.

## Core Features

- **Free steering** — arrow keys / on-screen buttons; wheels self-straighten; you
  can miss an exit and loop around again.
- **Lane change & blind spots** — start in a right lane that ends before the
  rotary; signal left (Z), check mirror, look over shoulder (hold Q), merge into a
  safe gap. Merging into an occupied blind spot is a **critical error**.
- **Rain** — slick roads, longer stopping distance, wipers, grey sky; enforces the
  MA *wipers on → headlights on* rule (L toggles lights).
- **Emergency vehicle** — an ambulance (lights + panned siren) enters from the
  left; yield, keep moving inside the rotary, pull over after exiting ahead of it.
- **Driver's-seat view** — windshield road view, turning steering wheel,
  speedometer, rear-view + left/right side mirrors (flipped like real mirrors),
  nav screen, dashboard trip clock.
- **Massachusetts-style signs** — speed limit, rotary diagram with route shields,
  rotary warning (20 mph advisory), pedestrian crossing, "State Law" crosswalk,
  Yield, One Way. Each pops up with an explanation on approach.
- **Route map** — choose start/destination around the rotary: US 20 Allston,
  MA 2A Cambridge, MA 16 Somerville, MA 2 West Arlington.
- **Trip times** — set departure/arrival; departure sets traffic (rush/moderate/
  light) and lighting (day/sunrise/sunset/night). Trip clock runs 20× real time.
- **Debrief map** — after each run, a result card draws the line you drove with
  numbered dots at every rule break.
- **Live-synthesized sound** — engine, road/wind, curb rumble, blinker, rain,
  wipers, siren, horn, crash, coaching chimes — all via Web Audio API, no files
  (M mutes).
- **Rules & signs guide** — plain-language explanations of rotary and other MA
  rules newcomers miss.
- **Accounts & saved runs** — optional Supabase auth; a "My Runs" tab lists past
  runs.

## Scoring Model

100 points across six weighted categories:

| Category | Weight |
|---|---|
| Right of way | 30 |
| Speed control | 20 |
| Following distance (2-second rule; 3 in rain) | 15 |
| Lane position & steering | 15 |
| Signals & checks | 10 |
| Blind-spot checks | 10 |

- Steady-habit rules bleed points every second they slip, scaled by how far off
  you are; one-off rules lose a fixed amount.
- **Pass** = 80+ **and** no critical error.
- **Critical errors**: collision, occupied crosswalk, failure to yield, pulling
  out in front of an ambulance, unsafe lane change.
- Taking the wrong exit or arriving late costs **nothing**. Speeding costs points.

## Scope & Honesty Notes

- The rotary is a generic practice layout, not a real intersection.
- Rules are summarized for practice — defer to the official MA RMV Driver's Manual
  for anything authoritative; don't present in-app guidance as legal/official.
- Rush-hour windows and lighting are simple approximations for late-October
  Boston, not live data.
- Coach feedback is currently scripted. A fuller build would ground an LLM in the
  MA Driver's Manual, real OpenStreetMap intersections, and MassDOT crash hotspots.

## Reference Data (in `data/`)

Cambridge open datasets kept for future grounding (crash hotspots, bike counts,
street centerlines) — not yet wired into the live simulation.
