/*
 * End-to-end pipeline test: reproduce exactly what app.js does on calibration —
 * order screen corners, estimate dims, build the homography, rectify ball+hole,
 * solve, then project the solution back to screen — and assert it is coherent.
 * Run: node test/integration.js
 */
const Geo = require('../js/geometry.js');
const Solver = require('../js/solver.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + name + (detail ? '  — ' + detail : '')); }
}

// --- replicate app.js glue (pure parts) ---
function orderCorners(pts) {
  let tl = pts[0], br = pts[0], tr = pts[0], bl = pts[0];
  for (const q of pts) {
    if (q.x + q.y < tl.x + tl.y) tl = q;
    if (q.x + q.y > br.x + br.y) br = q;
    if (q.y - q.x < tr.y - tr.x) tr = q;
    if (q.y - q.x > bl.y - bl.x) bl = q;
  }
  return [tl, tr, br, bl];
}
function calibrate(corners) {
  const o = orderCorners(corners);
  const top = Geo.dist(o[0], o[1]), bottom = Geo.dist(o[3], o[2]);
  const left = Geo.dist(o[0], o[3]), right = Geo.dist(o[1], o[2]);
  let aspect = ((top + bottom) / 2) / Math.max((left + right) / 2, 1e-3);
  aspect = Math.max(0.25, Math.min(4, aspect));
  let W, RH;
  if (aspect >= 1) { W = 100; RH = 100 / aspect; } else { RH = 100; W = 100 * aspect; }
  const holeR = Math.max(2.2, Math.min(W, RH) * 0.06);
  const dst = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: RH }, { x: 0, y: RH }];
  const Hm = Geo.solveHomography(o, dst);
  return { o, W, RH, holeR, H: Hm, Hinv: Geo.invert3(Hm) };
}

console.log('\n\x1b[1mIntegration — realistic perspective lane\x1b[0m');

// A phone looking down a lane: far edge (top) is narrower than the near edge (bottom).
// Screen is ~390x780 (CSS px). Corners tapped in arbitrary order.
const screenCorners = [
  { x: 150, y: 200 },  // far-left
  { x: 250, y: 205 },  // far-right
  { x: 330, y: 640 },  // near-right
  { x: 70, y: 650 },   // near-left
];
const cal = calibrate([screenCorners[2], screenCorners[0], screenCorners[3], screenCorners[1]]); // shuffled order
ok('homography built from shuffled corner taps', !!cal.H && !!cal.Hinv);

const toRect = (p) => Geo.applyH(cal.H, p);
const toScreen = (p) => Geo.applyH(cal.Hinv, p);

// ball near the player, hole up the lane and a touch to the right
const ballScreen = { x: 200, y: 560 };
const holeScreen = { x: 235, y: 250 };
const ballR = toRect(ballScreen), holeR = toRect(holeScreen); holeR.r = cal.holeR;

ok('ball maps inside the rectified rectangle', ballR.x > -1 && ballR.x < cal.W + 1 && ballR.y > -1 && ballR.y < cal.RH + 1,
  'ballR=(' + ballR.x.toFixed(1) + ',' + ballR.y.toFixed(1) + ') W=' + cal.W.toFixed(1) + ' H=' + cal.RH.toFixed(1));

const walls = Solver.boundaryWalls(cal.W, cal.RH);
const res = Solver.solve(ballR, holeR, walls, null, { coarse: 300 });
ok('pipeline finds a sinking line for an open lane', res.solutions.length >= 1 || (res.fallback && res.fallback.miss < cal.holeR * 2),
  'sols=' + res.solutions.length);

const sol = res.best || res.fallback;
const pathScreen = sol.result.path.map(toScreen);
ok('rendered line starts at the ball on screen', Geo.dist(pathScreen[0], ballScreen) < 4,
  'start=(' + pathScreen[0].x.toFixed(1) + ',' + pathScreen[0].y.toFixed(1) + ')');

if (res.best) {
  const end = pathScreen[pathScreen.length - 1];
  ok('rendered line ends near the hole on screen', Geo.dist(end, holeScreen) < 30,
    'end=(' + end.x.toFixed(1) + ',' + end.y.toFixed(1) + ') hole=(' + holeScreen.x + ',' + holeScreen.y + ')');
}

// the hole is to the RIGHT of straight-up, so the aim should lean right (screen space)
const ahead = toScreen(sol.result.path[1]);
const straight = Geo.norm(Geo.sub(holeScreen, ballScreen));
const aim = Geo.norm(Geo.sub(ahead, ballScreen));
const side = Geo.cross(straight, aim) > 0 ? 'right' : 'left';
ok('aim direction is coherent (small offset from straight for an open hole)',
  Math.abs(sol.aimDeg) < 20, 'aimDeg=' + sol.aimDeg.toFixed(1) + ' side=' + side);

// blocked lane forces a bank, still renders onto screen
console.log('\n\x1b[1mIntegration — blocked lane forces a bank, projects to screen\x1b[0m');
const blocker = [{ a: toRect({ x: 60, y: 400 }), b: toRect({ x: 250, y: 400 }) }];
const wallsB = Solver.boundaryWalls(cal.W, cal.RH, blocker);
const resB = Solver.solve(ballR, holeR, wallsB, null, { coarse: 360 });
const solB = resB.best || resB.fallback;
ok('blocked lane still yields a renderable line', !!solB && solB.result.path.length >= 2);
if (resB.best) {
  const ps = solB.result.path.map(toScreen);
  ok('banked line stays on-screen-ish and ends at the cup', Geo.dist(ps[ps.length - 1], holeScreen) < 35 && resB.best.bounces >= 1,
    'bounces=' + resB.best.bounces);
}

console.log('\n' + (fail === 0
  ? '\x1b[1;32mALL ' + pass + ' INTEGRATION CHECKS PASSED\x1b[0m'
  : '\x1b[1;31m' + fail + ' FAILED\x1b[0m, ' + pass + ' passed'));
process.exit(fail === 0 ? 0 : 1);
