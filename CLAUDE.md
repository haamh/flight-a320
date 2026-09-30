# AERIS A320 flight simulator

Single-flight, hyper-realistic Airbus A320 simulation (Aurora EAUR RWY 09 -> Bayview EBVR ILS 09, 22 NM) built with Vite, React 19, TypeScript and three.js r186. `npm run build` emits one self-contained `dist/index.html`.

## Commands
- `npm ci` - install
- `npm run dev` - dev server (http://localhost:5173)
- `npx tsc --noEmit -p .` - typecheck (strict, no unused locals/params)
- `npm run build` - production single-file build
- `node tools/snap.mjs --w 960 --h 540 --out shots <presets>` - headless screenshots + `renderer.info` stats; needs the dev server (it drives the dev-only `window.sim` handle). Software rendering here: 5-15 s per frame.

## Layout
- `src/App.tsx` - React HUD, menu, end screens; owns the `Sim` instance.
- `src/sim/engine.ts` - `Sim`: renderer, post-processing, cameras, input, main loop, telemetry.
- `src/sim/physics.ts` - flight model, ground contact, autopilot/ILS.
- `src/sim/fuselage.ts` - fuselage cross-section math and the flight deck window panes (`PANES`).
- `src/sim/aircraft.ts` - exterior aircraft: livery, fuselage, windows, wings, engines, tail, gear, lights.
- `src/sim/cockpit.ts` - flight deck interior (panels, pedestal, overhead, seats, sidesticks, displays).
- `src/sim/instruments.ts` - canvas drawing of PFD / ND / E/WD / SD.
- `src/sim/world.ts`, `terrain.ts`, `textures.ts` - scenery, airports, procedural textures.
- Body frame: nose toward -Z, up +Y, right wing +X, meters. Fuselage centerline 3.45 m above ground.

## Agent workflow
- The main session is the orchestrator (Opus 5.5, `.claude/agents/orchestrator.md`): plans, splits work by file ownership, reviews, integrates, commits.
- Implementation goes to the `executor` subagent (Sonnet 5.5, `.claude/agents/executor.md`). The orchestrator reviews every change and takes over tasks the executor cannot finish well (precise geometry, shaders, perf root-causing).
- Parallel executors must own disjoint files.

## Authorship (strict)
- The repository owner is the sole author. Commit with the owner's identity (the SessionStart hook sets it).
- Never add `Co-Authored-By` or `Claude-Session` trailers, "generated with" lines, session links, or any mention of an AI/assistant in commits, PR text, code, comments, UI or assets.

## Performance budget
- Steady 60 fps at 1080p on a mid/high-end GPU. The dynamic-resolution controller in `engine.ts` protects the frame rate; do not rely on it to hide waste.
- No allocations in the render loop; merged/instanced static geometry; no additional shadow-casting lights; throttle canvas-texture uploads.
- Measure with `renderer.info` (whole frame, `autoReset = false`) before and after rendering changes.

## A320 realism references
- Flight deck windows: 6 panes. Two large flat front windscreens with a narrow centre post; two sliding side windows (No. 2, with handle and sill); two fixed rear side windows (No. 3, smaller, top edge sloping down aft). Exterior: glass sits nearly flush with thin dark seals; no painted black mask on standard liveries.
- Flight deck (see A320 photos): blue-grey panels (#4a5563-ish) with light-grey legends; six square DUs across the main panel (PFD, ND | E/WD over SD | ND, PFD); ISIS and clock beside the E/WD/SD; gear lever and autobrake panel right of the SD; glareshield with FCU centre and EFIS control panels each side, amber/white backlit; pedestal with two MCDUs forward, thrust levers with detents, ENG MASTER switches, speedbrake lever left, flap lever right, RMP/ACP panels, parking brake handle; sidesticks on the outboard consoles with tiller and fold-out table; large backlit overhead panel; centre windscreen post with standby compass; sun visors; blue pinstripe seats.
