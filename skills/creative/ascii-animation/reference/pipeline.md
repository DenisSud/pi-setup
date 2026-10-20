# Capture, encode, deploy

## The pipeline

Browsers are the cheapest renderer you already have: canvas 2D, text metrics,
and a font stack. Drive the simulation by hand at a **fixed timestep** and the
output is deterministic — the same seed and size give the same video twice.

1. `scripts/serve.mjs` serves a directory and turns `POST /frame?i=N` into
   `NNNNN.png`.
2. `scripts/capture.sh` copies the harness page into the served root, launches
   headless Chromium against it, waits for `/done`, and encodes with ffmpeg.
3. The harness owns the loop:

```js
engine.destroy();                                  // kill rAF: its dt is wall-clock
for (let t = 0; t < settle; t += 1/60) world.step(1/60);
for (let f = 0; f < frames; f++) {
  for (let k = 0; k < per; k++) world.step(1/60);
  render();
  await fetch("/frame?i=" + f, { method: "POST", body: await toBlob(canvas) });
}
fetch("/done");
```

`fetch` of a `Blob` sends raw bytes — no base64, no CDP, no puppeteer.

## Measured on this machine (NVIDIA, 2560×1440)

| | |
|---|---|
| render, 1440p, 197×76 glyphs | 17 ms/frame |
| 3 min at 30 fps (5 400 frames) | ~1.6 min of rendering |
| H.264 CRF 20 | ~19 MB/min → 57 MB for 3 min |
| H.264 CRF 23 | ~15 MB/min |
| playback | one hardware-decoded video, ~1–3 % CPU |

`--force-device-scale-factor=1` and pinning `devicePixelRatio` to 1 in the page
matter: without them the canvas can come out at 0.9× and the video is 2304×1296.

## The seam

A loop either repeats visibly or hides the join.

- **Ping-pong** is exact and free, and motion reversal is invisible in
  reaction–diffusion and physarum:
  ```sh
  ffmpeg -i in.mp4 -vf reverse -an rev.mp4
  printf "file 'in.mp4'\nfile 'rev.mp4'\n" > list.txt
  ffmpeg -f concat -safe 0 -i list.txt -c copy loop.mp4
  ```
- **Directional motion** (fish, currents) cannot be reversed. Render longer
  than you need and cut where the frame is calm; a 60–120 s loop with one
  cut reads as continuous. Two seconds of crossfade help only if you can
  build it at the frame level, because both ends must be the *same* content.

## As a wallpaper on GNOME 50 / Wayland

Mutter speaks no `wlr-layer-shell`, so `mpvpaper`, `swww`, `gslapper` and
`xwinwrap` are all out. The wallpaper must live inside GNOME Shell, which means
an extension that plays a file.

| | package | backend | notes |
|---|---|---|---|
| **gnome-wallpaper-engine** | `pkgs.gnomeExtensions.gnome-wallpaper-engine` | mpv, separate process, window reparented under the background layer | GNOME 50 Wayland only for multi-monitor + click-through; needs `mpv` `ffmpeg` on PATH; pauses on fullscreen and on battery |
| **Hanabi** | not in nixpkgs — build `main` | GStreamer, `gtk4paintablesink` | targets GNOME 50+, Wayland only; needs `meson`, `node`, `npm`, and the GTK4 GStreamer sink; known NVIDIA hw-decode caveat |

NixOS:

```nix
environment.systemPackages = with pkgs; [ mpv ffmpeg gnomeExtensions.gnome-wallpaper-engine ];
```

then log out and back in, and enable it in the Extensions app. Extensions are
per-user state; the package only makes them visible.

### Beyond video

`gnome-wallpaper-engine` gets its result by launching a process, forcing its
window to `DESKTOP` type, moving it under the background layer, and cloning it
per monitor. `mpv` is only the program in its `argv`. Swapping that for a
terminal running `asciiquarium`, or a kiosk Chromium on a page running the live
sim, turns the video loop back into a live program — at continuous render cost.
Same trick as Hanabi's `Blender` wallpaper plugin, different host.

## What does not work here

- `mpvpaper`, `swww`/`awww`, `hyprpaper`, `swaybg` — layer-shell or per-compositor.
- `xwinwrap` + `mpv` — X11 only; GNOME 50 on Wayland has no X11 session.
- GNOME itself: static images or an XML slideshow, nothing animated.
