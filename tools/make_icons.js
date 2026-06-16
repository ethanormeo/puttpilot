/*
 * make_icons.js — generate PuttPilot PNG icons with zero dependencies.
 * Draws the brand mark (neon bank-shot line + ball + hole on dark) and writes
 * real PNGs via a tiny zlib-backed encoder. Run: node tools/make_icons.js
 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// ---- CRC32 ----
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---- drawing helpers (software, with cheap anti-aliasing) ----
function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const L2 = dx * dx + dy * dy || 1e-9;
  let t = ((px - ax) * dx + (py - ay) * dy) / L2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + dx * t, cy = ay + dy * t;
  return Math.hypot(px - cx, py - cy);
}
const sstep = (e0, e1, x) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
function over(dst, i, r, g, b, a) {
  const ia = 1 - a;
  dst[i] = r * a + dst[i] * ia;
  dst[i + 1] = g * a + dst[i + 1] * ia;
  dst[i + 2] = b * a + dst[i + 2] * ia;
  dst[i + 3] = Math.min(255, a * 255 + dst[i + 3] * ia);
}

function render(N) {
  const buf = Buffer.alloc(N * N * 4);
  // bank-shot polyline (normalized to N): ball -> wall -> hole
  const ball = { x: 0.70 * N, y: 0.76 * N };
  const wall = { x: 0.88 * N, y: 0.46 * N };
  const hole = { x: 0.30 * N, y: 0.30 * N };
  const lineW = N * 0.045;

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;
      // background vertical gradient
      const g = y / N;
      let R = 19 - g * 11, G = 27 - g * 18, B = 41 - g * 30; // #131b29 -> ~#080b11
      // additive neon glow along the line
      const d1 = distToSeg(x, y, ball.x, ball.y, wall.x, wall.y);
      const d2 = distToSeg(x, y, wall.x, wall.y, hole.x, hole.y);
      const d = Math.min(d1, d2);
      const glow = Math.exp(-d / (N * 0.05)) * 90;
      R += glow * 0.17; G += glow; B += glow * 0.55;
      buf[i] = Math.min(255, R); buf[i + 1] = Math.min(255, G); buf[i + 2] = Math.min(255, B); buf[i + 3] = 255;

      // bright line core
      const core = sstep(lineW * 0.5 + 1.5, lineW * 0.5 - 1.5, d);
      if (core > 0) over(buf, i, 234, 255, 245, core);

      // hole ring (cyan)
      const dh = Math.abs(Math.hypot(x - hole.x, y - hole.y) - N * 0.11);
      const ring = sstep(N * 0.018 + 1.5, N * 0.018 - 1.5, dh);
      if (ring > 0) over(buf, i, 56, 225, 255, ring * 0.95);

      // ball (white)
      const db = Math.hypot(x - ball.x, y - ball.y);
      const ballc = sstep(N * 0.085 + 1.5, N * 0.085 - 1.5, db);
      if (ballc > 0) over(buf, i, 255, 255, 255, ballc);
    }
  }
  return buf;
}

function write(N, name) {
  const png = encodePNG(N, N, render(N));
  const out = path.join(__dirname, '..', 'icons', name);
  fs.writeFileSync(out, png);
  console.log('wrote', name, '(' + N + 'x' + N + ', ' + png.length + ' bytes)');
}

write(192, 'icon-192.png');
write(512, 'icon-512.png');
write(180, 'apple-touch-icon.png');
write(32, 'favicon-32.png');
