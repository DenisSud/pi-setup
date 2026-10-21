---
name: ascii-animation
description: Make living ASCII animations — swarms, slime mould, reaction–diffusion, boid schools — rendered as glyphs on a canvas and exported as a loop for a wallpaper, article cover or video. Use when the user wants a programmatic animation with an ASCII, terminal or retro-digital look, asks for a live wallpaper built from text characters, or wants generative art out of glyphs rather than pixels.
disable-model-invocation: true
---

# ASCII animation

The medium is a grid of monospace cells; the subject is something alive. Two
things carry the look: **density picks the glyph**, and the empty cells are part
of the composition. Everything else is simulation parameters.

## Steps

1. **Pick the system.** Choose from `reference/systems.md` by the movement you
   want — schooling, drifting rings, veins, coral. New systems are fine; the
   table exists to avoid re-deriving parameters.
   *Done when:* you can name the system, the glyph grid (cols × rows) and the
   frame budget.

2. **Fix the grid.** Cell width is `W / cols`, height `round(width × 1.45)`.
   Monospace only, and measure a glyph rather than assuming its advance —
   `JetBrains Mono`, `DejaVu Sans Mono` and friends differ by a pixel, and that
   pixel compounds across 160 columns.
   *Done when:* one frame fills the canvas edge to edge with no clipped cells.

3. **Make it deterministic.** Seeded PRNG, fixed `1/60` step, no `Date`,
   `performance.now()` or `dt` from `requestAnimationFrame` inside the sim. The
   engine's own loop is wall-clock timed; stop it and step the world by hand.
   *Done when:* two runs at the same seed produce byte-identical first frames
   (`cmp frames/00000.png`).

4. **Judge a still.** Capture one frame and look at it at 100 % (`devicePixelRatio`
   pinned to 1) and at fit-to-screen. At 100 % it must read as characters; at
   fit it must read as an organism. Tune density and ramp first, parameters
   second.
   *Done when:* both readings hold. If the frame reads as noise, the system is
   too busy for the grid — go back to step 1.

5. **Capture the loop.** `scripts/capture.sh` — headless Chromium,
   fixed-timestep harness, PNG frames, x264.
   *Done when:* the mp4 is exactly `W×H`, plays at the intended fps, and no
   frame is duplicated or missing at the start.

6. **Close the seam.** Ping-pong for symmetric systems; for directional motion,
   render long and cut where the water is calm. Both commands are in
   `reference/pipeline.md`.
   *Done when:* playing the last two seconds into the first two shows no jump.

7. **Ship it.** Site cover, or wallpaper on GNOME (`reference/pipeline.md`).
   *Done when:* it loads from the deployed path at the real display size.

## Rules

- **Simulate at 2× the glyph grid and fold with `max`.** At 1× the filaments
  alias into noise; a pure mean erases single-cell strokes.
- **Saturation is the failure mode of every agent system.** When the field goes
  uniformly bright, sensing becomes meaningless and agents lock into circles or
  straight lines. Cut agents and deposit; never add more.
- **Glyphs must land on whole pixels.** Fractional `fillText` origins shimmer
  frame to frame and the meditative look collapses into flicker.
- **Motion slower than you think.** 24–30 fps for water and fish, 12–15 for
  cellular systems. The frame rate does not need to match the system's elegance.
- **Draw nothing below ~6 % intensity.** Air is part of the picture.
- **Pin the device pixel ratio.** A headless capture at 0.9× silently produces a
  2304×1296 video that looks wrong on a 2560×1440 display.

## Files

- `scripts/capture.sh` — page → mp4 (server, Chromium, x264).
- `scripts/serve.mjs` — static server + `POST /frame` sink.
- `scripts/ocean.html` — exports the site's boid ocean (`?engine=` path).
- `scripts/physarum.html` — slime-mould trails.
- `scripts/reaction-diffusion.html` — Gray-Scott, drifting rings.
- `reference/systems.md` — systems, parameters, glyph mapping, why Life fails.
- `reference/pipeline.md` — measured costs, seam recipes, GNOME wallpaper deploy.
