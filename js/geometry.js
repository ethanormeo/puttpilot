/*
 * geometry.js — pure 2D geometry for PuttPilot.
 * Vectors, homography (perspective transform), matrix inverse, ray/segment intersection.
 * No DOM. Runs in the browser (window.Geo) and in Node (module.exports) so the same
 * code is unit-tested headlessly.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Geo = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- vector helpers ----------------------------------------------------
  const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
  const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
  const scale = (a, s) => ({ x: a.x * s, y: a.y * s });
  const dot = (a, b) => a.x * b.x + a.y * b.y;
  const cross = (a, b) => a.x * b.y - a.y * b.x;
  const len = (a) => Math.hypot(a.x, a.y);
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const norm = (a) => { const l = Math.hypot(a.x, a.y) || 1e-9; return { x: a.x / l, y: a.y / l }; };

  // Reflect a direction d about a wall with unit normal n:  r = d - 2(d·n)n
  function reflect(d, n) {
    const k = 2 * dot(d, n);
    return { x: d.x - k * n.x, y: d.y - k * n.y };
  }

  // ---- dense linear solver (Gauss-Jordan, partial pivot) -----------------
  // Solve A x = b for square A (array of rows) and vector b. Returns x or null.
  function solveLinear(A, b) {
    const n = b.length;
    const M = A.map((row, i) => row.concat([b[i]]));
    for (let col = 0; col < n; col++) {
      let piv = col;
      for (let r = col + 1; r < n; r++) {
        if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
      }
      if (Math.abs(M[piv][col]) < 1e-12) return null; // singular
      const tmp = M[col]; M[col] = M[piv]; M[piv] = tmp;
      const pivVal = M[col][col];
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const f = M[r][col] / pivVal;
        if (f === 0) continue;
        for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
      }
    }
    const x = new Array(n);
    for (let i = 0; i < n; i++) x[i] = M[i][n] / M[i][i];
    return x;
  }

  // ---- homography --------------------------------------------------------
  // Solve the 3x3 homography H mapping src[i] -> dst[i] (4 correspondences).
  // Returns a length-9 row-major array with H[8] normalised to 1, or null.
  function solveHomography(src, dst) {
    if (src.length < 4 || dst.length < 4) return null;
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const x = src[i].x, y = src[i].y, u = dst[i].x, v = dst[i].y;
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    const h = solveLinear(A, b);
    if (!h) return null;
    return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  }

  // Apply homography H to point p -> mapped point (perspective divide).
  function applyH(H, p) {
    const x = H[0] * p.x + H[1] * p.y + H[2];
    const y = H[3] * p.x + H[4] * p.y + H[5];
    const w = H[6] * p.x + H[7] * p.y + H[8];
    return { x: x / w, y: y / w };
  }

  // Inverse of a 3x3 (row-major length-9) matrix, or null if singular.
  function invert3(H) {
    const a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7], i = H[8];
    const C11 = e * i - f * h, C12 = -(d * i - f * g), C13 = d * h - e * g;
    const C21 = -(b * i - c * h), C22 = a * i - c * g, C23 = -(a * h - b * g);
    const C31 = b * f - c * e, C32 = -(a * f - c * d), C33 = a * e - b * d;
    const det = a * C11 + b * C12 + c * C13;
    if (Math.abs(det) < 1e-12) return null;
    const s = 1 / det;
    // inverse = (1/det) * adjugate (transpose of cofactor matrix)
    return [C11 * s, C21 * s, C31 * s, C12 * s, C22 * s, C32 * s, C13 * s, C23 * s, C33 * s];
  }

  // ---- ray / segment -----------------------------------------------------
  // Ray P + t*D (t>0, D need not be unit) intersected with segment A->B.
  // Returns { t, point, n } where n is the wall unit normal facing the ray, or null.
  function raySegment(P, D, A, B) {
    const e = sub(B, A);
    const denom = cross(D, e);
    if (Math.abs(denom) < 1e-12) return null; // parallel
    const w = sub(A, P);
    const t = cross(w, e) / denom;   // distance scalar along D
    const s = cross(w, D) / denom;   // param along segment [0,1]
    if (t > 1e-7 && s >= -1e-6 && s <= 1 + 1e-6) {
      const point = { x: P.x + D.x * t, y: P.y + D.y * t };
      let n = norm({ x: -e.y, y: e.x });
      if (dot(n, D) > 0) n = { x: -n.x, y: -n.y }; // face the incoming ray
      return { t, point, n };
    }
    return null;
  }

  // Signed angle (radians) to rotate vector a onto vector b, in (-PI, PI].
  function signedAngle(a, b) {
    return Math.atan2(cross(a, b), dot(a, b));
  }

  return {
    sub, add, scale, dot, cross, len, dist, norm, reflect,
    solveLinear, solveHomography, applyH, invert3, raySegment, signedAngle,
  };
});
