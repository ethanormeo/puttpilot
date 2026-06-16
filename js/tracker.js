/*
 * tracker.js — markerless planar tracking, pure JS (no OpenCV, no WebXR).
 *
 * Same idea virtual try-on uses (track features in the camera frame each tick),
 * but tuned for a handful of high-contrast points instead of a face mesh.
 * Tracks the lane corners across frames with ZNCC (zero-mean normalised
 * cross-correlation) patch matching + velocity prediction, so the homography
 * can be re-solved every frame and the HUD stays locked to the real surface as
 * the phone moves. Robust to lighting (zero-mean/normalised) and degrades
 * gracefully: lost points are reconstructed from the confident ones, and if too
 * few survive it reports ok=false so the app can ask for a quick re-lock.
 *
 * Operates on a single-channel (grayscale) Uint8 buffer at processing
 * resolution. DOM-free + Node-testable. Browser: window.PatchTracker.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PatchTracker = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  class PatchTracker {
    constructor(opts) {
      opts = opts || {};
      this.pr = opts.patchRadius || 7;       // patch is (2*pr+1)^2
      this.sr = opts.searchRadius || 13;     // +/- search window
      this.minZncc = opts.minZncc != null ? opts.minZncc : 0.5;
      this.w = 0; this.h = 0;
      this.points = null;    // [{x,y}]
      this.vel = null;       // [{x,y}]
      this.patches = null;   // [{z:Float32Array, norm, n}]
      this.ready = false;
    }

    // gray: Uint8 length w*h. pts: array of {x,y} in processing coords.
    init(gray, w, h, pts) {
      this.w = w; this.h = h;
      this.points = pts.map((p) => ({ x: p.x, y: p.y }));
      this.vel = pts.map(() => ({ x: 0, y: 0 }));
      this.patches = pts.map((p) => this._extract(gray, p.x, p.y));
      this.ready = this.patches.every((q) => q != null);
      return this.ready;
    }

    _extract(gray, cx, cy) {
      const pr = this.pr, n = (2 * pr + 1) * (2 * pr + 1);
      const xi = Math.round(cx), yi = Math.round(cy);
      if (xi - pr < 0 || yi - pr < 0 || xi + pr >= this.w || yi + pr >= this.h) return null;
      const vals = new Float32Array(n);
      let k = 0, sum = 0;
      for (let dy = -pr; dy <= pr; dy++) {
        const row = (yi + dy) * this.w + xi;
        for (let dx = -pr; dx <= pr; dx++) { const v = gray[row + dx]; vals[k++] = v; sum += v; }
      }
      const mean = sum / n;
      let ss = 0;
      for (let i = 0; i < n; i++) { vals[i] -= mean; ss += vals[i] * vals[i]; }
      const norm = Math.sqrt(ss) || 1e-6;
      return { z: vals, norm, n };
    }

    // ZNCC of stored patch p against window centred at (cx,cy) in gray.
    _score(gray, p, cx, cy) {
      const pr = this.pr, n = p.n;
      const xi = Math.round(cx), yi = Math.round(cy);
      if (xi - pr < 0 || yi - pr < 0 || xi + pr >= this.w || yi + pr >= this.h) return -2;
      let sum = 0;
      for (let dy = -pr; dy <= pr; dy++) {
        const row = (yi + dy) * this.w + xi;
        for (let dx = -pr; dx <= pr; dx++) sum += gray[row + dx];
      }
      const mean = sum / n;
      let dot = 0, ss = 0, k = 0;
      for (let dy = -pr; dy <= pr; dy++) {
        const row = (yi + dy) * this.w + xi;
        for (let dx = -pr; dx <= pr; dx++) { const c = gray[row + dx] - mean; dot += c * p.z[k++]; ss += c * c; }
      }
      const denom = p.norm * (Math.sqrt(ss) || 1e-6);
      return dot / denom; // in [-1, 1]
    }

    update(gray) {
      if (!this.ready) return { points: this.points, confidence: 0, ok: false };
      const sr = this.sr;
      const results = this.points.map((p, i) => {
        const px = p.x + this.vel[i].x, py = p.y + this.vel[i].y; // predicted
        let best = -2, bx = px, by = py;
        for (let dy = -sr; dy <= sr; dy++) {
          for (let dx = -sr; dx <= sr; dx++) {
            const s = this._score(gray, this.patches[i], px + dx, py + dy);
            if (s > best) { best = s; bx = px + dx; by = py + dy; }
          }
        }
        return { x: bx, y: by, score: best };
      });

      const good = results.filter((r) => r.score >= this.minZncc);
      let ok = good.length >= 3;

      // reconstruct weak points from a similarity fit of the good ones
      if (ok && good.length < results.length) {
        const fit = similarityFit(
          good.map((r, idx) => this.points[results.indexOf(r)]),
          good.map((r) => ({ x: r.x, y: r.y }))
        );
        if (fit) {
          for (let i = 0; i < results.length; i++) {
            if (results[i].score < this.minZncc) {
              const m = applySim(fit, this.points[i]);
              results[i].x = m.x; results[i].y = m.y;
            }
          }
        }
      }

      // commit positions + velocity
      for (let i = 0; i < results.length; i++) {
        this.vel[i] = { x: results[i].x - this.points[i].x, y: results[i].y - this.points[i].y };
        this.points[i] = { x: results[i].x, y: results[i].y };
      }
      const confidence = results.reduce((a, r) => a + Math.max(0, r.score), 0) / results.length;
      return { points: this.points.map((p) => ({ x: p.x, y: p.y })), confidence, ok, scores: results.map((r) => r.score) };
    }

    // Re-anchor patches at current positions (used on a manual re-lock).
    relock(gray) {
      if (!this.points) return false;
      this.patches = this.points.map((p) => this._extract(gray, p.x, p.y));
      this.vel = this.points.map(() => ({ x: 0, y: 0 }));
      this.ready = this.patches.every((q) => q != null);
      return this.ready;
    }
  }

  // least-squares similarity (scale+rotation+translation) mapping src->dst
  function similarityFit(src, dst) {
    const n = Math.min(src.length, dst.length);
    if (n < 2) return null;
    let msx = 0, msy = 0, mdx = 0, mdy = 0;
    for (let i = 0; i < n; i++) { msx += src[i].x; msy += src[i].y; mdx += dst[i].x; mdy += dst[i].y; }
    msx /= n; msy /= n; mdx /= n; mdy /= n;
    let a = 0, b = 0, d = 0;
    for (let i = 0; i < n; i++) {
      const sx = src[i].x - msx, sy = src[i].y - msy, dx = dst[i].x - mdx, dy = dst[i].y - mdy;
      a += sx * dx + sy * dy;
      b += sx * dy - sy * dx;
      d += sx * sx + sy * sy;
    }
    if (d < 1e-9) return null;
    const cos = a / d, sin = b / d; // includes scale
    return { cos, sin, tx: mdx - (cos * msx - sin * msy), ty: mdy - (sin * msx + cos * msy) };
  }
  function applySim(f, p) {
    return { x: f.cos * p.x - f.sin * p.y + f.tx, y: f.sin * p.x + f.cos * p.y + f.ty };
  }

  PatchTracker.similarityFit = similarityFit;
  PatchTracker.applySim = applySim;
  return PatchTracker;
});
