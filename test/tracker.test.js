/*
 * Unit tests for the pure-JS planar tracker. Run: node test/tracker.test.js
 * Builds a synthetic textured frame, shifts it by a known amount, and asserts
 * the tracker recovers the motion (and reconstructs an occluded point).
 */
const PatchTracker = require('../js/tracker.js');

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + n); } else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + n + (d ? '  — ' + d : '')); } };

// grayscale frame: Gaussian blobs at the corners + high-frequency texture so
// patches are distinctive and an occluded (blanked) region won't false-match.
function makeImg(w, h, centers) {
  const g = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // deterministic high-freq texture (won't correlate with a smooth blob)
      let v = 120 + 26 * (((x * 131 + y * 977) ^ (x * y * 13)) % 19 - 9) / 9;
      for (let c = 0; c < centers.length; c++) {
        const dx = x - centers[c].x, dy = y - centers[c].y;
        v += 120 * Math.exp(-(dx * dx + dy * dy) / (2 * 4 * 4));
      }
      g[y * w + x] = Math.max(0, Math.min(255, v));
    }
  }
  return g;
}
// rigidly shift the whole scene (true camera motion): out(x,y)=img(x-dx,y-dy)
function shiftImg(img, w, h, dx, dy) {
  const g = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = Math.max(0, Math.min(w - 1, x - dx)), sy = Math.max(0, Math.min(h - 1, y - dy));
      g[y * w + x] = img[sy * w + sx];
    }
  }
  return g;
}
// blank a square region to flat gray (simulate a corner getting occluded)
function occludeAt(img, w, h, cx, cy, r) {
  const g = img.slice();
  for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
    if (x >= 0 && x < w && y >= 0 && y < h) g[y * w + x] = 128;
  }
  return g;
}

console.log('\n\x1b[1mTracker — recovers a known shift\x1b[0m');
{
  const w = 160, h = 120;
  const centers = [{ x: 40, y: 35 }, { x: 120, y: 35 }, { x: 120, y: 90 }, { x: 40, y: 90 }];
  const img0 = makeImg(w, h, centers);
  const tk = new PatchTracker({ patchRadius: 7, searchRadius: 14 });
  ok('init succeeds on a textured frame', tk.init(img0, w, h, centers));

  const shift = { x: 4, y: -3 };
  const img1 = shiftImg(img0, w, h, shift.x, shift.y);
  const r = tk.update(img1);
  ok('reports ok with high confidence', r.ok && r.confidence > 0.7, 'conf=' + r.confidence.toFixed(2));
  let maxErr = 0;
  for (let i = 0; i < 4; i++) {
    const ex = centers[i].x + shift.x, ey = centers[i].y + shift.y;
    maxErr = Math.max(maxErr, Math.hypot(r.points[i].x - ex, r.points[i].y - ey));
  }
  ok('all 4 corners tracked to within 1.5px of truth', maxErr < 1.5, 'maxErr=' + maxErr.toFixed(2));
}

console.log('\n\x1b[1mTracker — reconstructs an occluded corner from the others\x1b[0m');
{
  const w = 160, h = 120;
  const centers = [{ x: 40, y: 35 }, { x: 120, y: 35 }, { x: 120, y: 90 }, { x: 40, y: 90 }];
  const img0 = makeImg(w, h, centers);
  const tk = new PatchTracker({ patchRadius: 7, searchRadius: 14 });
  tk.init(img0, w, h, centers);
  const shift = { x: 5, y: 2 };
  // shift the whole scene, then blank corner #3 (index 2) so it must be reconstructed
  const shifted = shiftImg(img0, w, h, shift.x, shift.y);
  const img1 = occludeAt(shifted, w, h, centers[2].x + shift.x, centers[2].y + shift.y, 11);
  const r = tk.update(img1);
  ok('still ok with one corner occluded (>=3 good)', r.ok, 'scores=' + (r.scores || []).map((s) => s.toFixed(2)).join(','));
  const ex = centers[2].x + shift.x, ey = centers[2].y + shift.y;
  const err = Math.hypot(r.points[2].x - ex, r.points[2].y - ey);
  ok('occluded corner reconstructed near truth (<3px)', err < 3, 'err=' + err.toFixed(2));
}

console.log('\n\x1b[1mTracker — similarity fit recovers a transform\x1b[0m');
{
  const ang = 0.2, s = 1.15, tx = 7, ty = -4;
  const src = [{ x: 10, y: 5 }, { x: 30, y: 8 }, { x: 28, y: 40 }, { x: 9, y: 38 }];
  const dst = src.map((p) => ({ x: s * (Math.cos(ang) * p.x - Math.sin(ang) * p.y) + tx, y: s * (Math.sin(ang) * p.x + Math.cos(ang) * p.y) + ty }));
  const f = PatchTracker.similarityFit(src, dst);
  const probe = { x: 20, y: 20 };
  const got = PatchTracker.applySim(f, probe);
  const exp = { x: s * (Math.cos(ang) * probe.x - Math.sin(ang) * probe.y) + tx, y: s * (Math.sin(ang) * probe.x + Math.cos(ang) * probe.y) + ty };
  ok('similarityFit reproduces the mapping on a new point', Math.hypot(got.x - exp.x, got.y - exp.y) < 1e-6);
}

console.log('\n' + (fail === 0 ? '\x1b[1;32mALL ' + pass + ' TRACKER TESTS PASSED\x1b[0m' : '\x1b[1;31m' + fail + ' FAILED\x1b[0m, ' + pass + ' passed'));
process.exit(fail === 0 ? 0 : 1);
