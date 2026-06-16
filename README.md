# ◎ PuttPilot — AR Mini-Golf Aim Caddie

Point your phone camera at a mini-golf hole, tap the corners + ball + cup, and PuttPilot paints the **exact aim line** — including **bank shots off the walls** — with the power to sink it. Runs **100% on your device**: no backend, no accounts, no uploads, no tracking, no cost.

**Live:** https://ethanormeo.github.io/puttpilot/

## How it works
1. **Calibrate** — tap the 4 corners of the flat playing surface. A homography maps the perspective view to a clean top-down model.
2. **Mark** — tap the ball, then the hole.
3. **Solve** — a physics simulator (rolling friction, wall restitution, optional slope) sweeps every aim angle and finds the shot that drops — direct or banked.
4. **Aim** — the glowing line, bounce points, aim angle, and suggested power are drawn back over your live camera view.

**Live Lock** (markerless tracking): after calibrating, PuttPilot tracks the lane corners frame-to-frame and re-solves the homography every frame, so the aim line **stays glued to the real surface as you move the phone** — the same class of in-browser computer vision that powers glasses/makeup virtual try-on, just tracking ground feature points instead of a face (no WebXR needed, works on iOS Safari). Tap to re-lock if tracking slips; toggle it off to pin the overlay to a still frame.

Extras: **slope** (drag downhill — the line curves), **+ wall** (add interior obstacle edges), **alternate routes**, **freeze frame** for steady aiming, **power** slider.

## Why a phone web app and not the Meta Ray-Bans?
Researched and decided: as of mid-2026 the Ray-Ban Display dev platform **splits camera access (phone-only, no lens draw) from on-lens rendering (Meta UI components only, no camera)** and never lets them combine — plus it's not world-locked AR and publishing is partner-gated. A custom CV aim-line on the lens is impossible for an indie today. The phone PWA is the only path that is free, cross-platform, and actually overlays a custom line on the live view. (Ray-Ban revisited post-GA as an optional camera accessory.)

## Tech
- Vanilla HTML/CSS/JS — no framework, no build step, pure static site.
- Hand-rolled homography + 2D ray-cast/reflect physics (`js/geometry.js`, `js/solver.js`) — no heavy CV dependency.
- Markerless planar tracking (`js/tracker.js`) — ZNCC patch-matching optical flow on the lane corners, pure JS (~3 KB; the stock OpenCV.js build ships without the optical-flow module, so this is hand-rolled rather than a 10 MB WASM dependency).
- PWA (manifest + service worker) — installable + offline.
- Hosted free on GitHub Pages over HTTPS (required for camera).

## Develop / test
```bash
node test/test.js          # unit tests (geometry + solver)
node test/integration.js   # end-to-end calibrate -> solve -> project
node test/tracker.test.js  # markerless tracker (shift recovery + occlusion)
node test/smoke.mjs        # real headless-Chrome smoke test (fake camera)
node tools/make_icons.js   # regenerate PNG icons
python3 -m http.server 8000  # serve locally (camera needs https on a phone)
```

## iPhone note
The home-screen icon opens in **Safari** on purpose — `getUserMedia` is most reliable there. Camera permission is re-prompted each launch (an iOS quirk, not a bug). Always **Allow**.

_PuttPilot is a visual guide, not a guarantee — real turf has nap and break it can't see. Read the line, trust your stroke._
