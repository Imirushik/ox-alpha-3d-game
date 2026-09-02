# Sunrise Descent

A cel-shaded downhill BMX racing game that runs entirely in the browser. Race
three AI riders from an alpine summit to the valley floor across a procedural
5 km course of rock gardens, berms, jumps, ravines, ridges, and stream beds.

> [Watch the gameplay demo](media/demo-run.webm) — a full autonomous run
> recorded directly from the game engine.

## Highlights

- Complete race flow: countdown, checkpoints, standings, replay, results, and restart
- Physics-driven riding with suspension, grip, pumping, manuals, tricks, crashes, and boost
- Procedural terrain shaped with layered noise, hydraulic erosion, and course carving
- Stylized rendering with cel bands, ink outlines, quantized fog, bloom, and speed lines
- Personality-driven AI riders and a saved ghost run
- No external art or audio assets: meshes, textures, and sound are generated at runtime

## Getting started

### Requirements

- Node.js 20.19 or newer (or Node.js 22.12 or newer)
- npm
- A modern browser with WebGL support

### Install and run

```bash
npm ci
npm run dev
```

Open the local URL shown by Vite (normally <http://localhost:5173>), then select
**Drop In**.

## Controls

| Input | Action |
| --- | --- |
| <kbd>A</kbd> / <kbd>D</kbd> | Steer and lean; spin while airborne |
| <kbd>W</kbd> | Pedal; pitch forward while airborne |
| <kbd>S</kbd> | Brake; hold to preload and release at a lip to pump; backflip while airborne |
| <kbd>Space</kbd> | Tap to bunny hop; hold on the ground to manual |
| <kbd>Shift</kbd> | Use boost earned from clean trick landings |
| <kbd>Q</kbd> / <kbd>E</kbd> | Whip while airborne |
| <kbd>1</kbd>–<kbd>6</kbd> | Tabletop, x-up, superman, tailwhip, 360, and backflip |
| <kbd>T</kbd> | Return to the racing line at the cost of speed |
| <kbd>R</kbd> | Restart the run |

Land cleanly to convert trick score into boost. A poor landing causes a crash.

## Available commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the Vite development server |
| `npm run build` | Create an optimized production build in `dist/` |
| `npm run preview` | Preview the production build locally |
| `npm run typecheck` | Validate the TypeScript source without emitting files |
| `npm run check` | Run all required repository checks |
| `npm run capture` | Record automated gameplay screenshots in `captures/` |
| `npm run record` | Generate the WebM gameplay demo with the built-in autopilot |

The capture and recording tools use Playwright. Recording also relies on the
project's bundled FFmpeg development dependency.

## Project structure

```text
src/
├── core/       Input, audio, random-number generation, and procedural noise
├── game/       Bike physics, riders, AI, race flow, camera, effects, and HUD
├── render/     Cel shading, outlines, post-processing, sky, and textures
├── world/      Heightfield generation, terrain, track, and foliage
├── main.ts     Application entry point
└── style.css   Interface and canvas styles

tools/          Automated capture and recording scripts
media/          Published gameplay demo
```

## Technical overview

The mountain begins as domain-warped fractal and ridged noise. A bounded
hydraulic-erosion pass creates gullies and fans, after which a hand-authored
Catmull–Rom race line carves the corridor, berms, jumps, ravine, ridge, and
stream into the same heightfield used by rendering, physics, and AI.

The renderer combines ramp-based lighting, inverted-hull outlines, Sobel edges,
quantized fog, procedural textures, and lightweight post-processing. The game
uses Three.js for rendering, TypeScript for source code, and Vite for local
development and production builds.

## Project status

The game is playable from countdown through results and replay. The terrain,
rendering, race flow, tricks, boost, ghost, HUD, and synthesized audio are all
implemented. Current limitations include conservative erosion, blob shadows in
place of shadow maps, visibly simplified riders at long distances, and AI
recovery behavior that can occasionally be noticeable.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) before proposing a change. Report
security concerns according to [SECURITY.md](SECURITY.md), not through a public
issue.

## License

No license has been granted yet. Until a license is added, all rights are
reserved by the repository owner.
