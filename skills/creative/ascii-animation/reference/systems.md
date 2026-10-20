# Systems that read well as ASCII

A glyph grid is a low-resolution, high-contrast medium. Systems that survive it
are **continuous fields** or **agent trails** — things whose edges are soft and
whose density varies slowly. Anything with hard 1-cell detail (Game of Life,
falling sand) turns into noise.

| system | looks like | grid at 1440p | per-frame cost | harness |
|---|---|---|---|---|
| boid school (the site's ocean) | fish, distant shoals | 197×76 glyphs | 17 ms | `ocean.html` + `ocean/` engine |
| physarum (slime mould) | krill swarms, currents, veins | 160×62 glyphs | 20 ms | `physarum.html` |
| Gray-Scott (reaction–diffusion) | coral, rings, drifting cells | 150×57 glyphs | 17 ms | `reaction-diffusion.html` |
| Lenia | alien cells, breathing blobs | 120×48 | not built | — |
| Game of Life | blocky, dies to still lifes | — | cheap | — |

Costs measured on the capture machine at 2560×1440 with the 2 s captures in this
skill.

## Physarum

Agents deposit into a scalar field, sense three points ahead, turn toward the
strongest, blur and decay the field. The field is the picture.

```js
SENSOR_ANGLE = 0.42    // radians either side
SENSOR_DIST  = 5.5     // cells
TURN         = 0.50
SPEED        = 0.9
DEPOSIT      = 1       // into a field capped at ~60
decay        = 0.93    // per 3×3 blur pass
agents       = 11_000  // on a 320×124 field
```

- **Saturation kills it.** Past ~25 k agents the field is uniformly bright, all
  three sensors read equal, and every agent locks into a circular orbit — the
  classic ring artifact. If rings appear, cut the agent count or the deposit;
  adding agents is not the lever.
- Seed the agents in a few loose clumps, not uniformly: structure appears in
  seconds and then wanders.
- Simulate at **2× the glyph grid** and fold with `max`, so a two-cell filament
  becomes a single glyph stroke. At 1× the filaments alias into noise.

## Gray-Scott

Two chemicals, `u` fed and `v` consumed. `Du=0.16, Dv=0.08, dt=1`, 9-point
Laplacian (0.2 orthogonal, 0.05 diagonal, −1 centre).

| F | K | behaviour |
|---|---|---|
| 0.014 | 0.054 | drifting rings — sparse, calm, never fills (best wallpaper) |
| 0.0545 | 0.062 | coral — grows outward, settles near 11 % cover |
| 0.029 | 0.057 | mazes — dense, slowly shifting |
| 0.026 | 0.051 | chaos — fills the frame, too busy |

- **Seed patches, not cells.** An isolated `u=0.5, v=0.25` cell diffuses its `v`
  away faster than the reaction feeds it and the dish stays black. Use 4–10 cell
  radius discs, 20–40 of them.
- The rule of thumb that predicts death: the reaction only feeds while
  `u·v > F + K`. Seed at `u=0.5, v=0.25` → `0.125`; `F+K` above that needs a
  push, below it dies.
- 4–6 sub-steps per rendered frame is enough at 30 fps; the pattern moves in
  seconds, not frames.

## Boids (the site engine)

Already tuned; `renderer.js` clamps the glyph cell to 8–13 px and derives the
world from the canvas size, so the same `seed` and canvas size reproduce the
same frame. Export it rather than reimplementing it.

## Glyph mapping

- **Ramp:** `" .,:;+*x#%@"` — 12 steps, dark to dense. Below ~6 % intensity,
  draw nothing: the empty water is the composition.
- **Gamma:** `t = pow(v, 0.62–0.75)` before indexing the ramp, or the mid-tones
  collapse into the first three characters.
- **Colour:** lerp two stops (dim slate → pale cyan) by the same `t` that picks
  the glyph. Colour alone, without the ramp, stops reading as ASCII.
- **Cell:** width = `W / cols`; height = `round(width × 1.45)`. 120–160 columns
  at 1440p keeps glyphs legible (16 px wide) without turning into pixels.
- **Fold:** with a 2× sim, `max` of the four cells preserves thin strokes;
  a pure mean erases single-cell filaments.
