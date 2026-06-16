/*
 * Headless test harness for PuttPilot geometry + solver. Run: node test/test.js
 * No deps. Exits non-zero on failure.
 */
const Geo = require('../js/geometry.js');
const Solver = require('../js/solver.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + name + (detail ? '  — ' + detail : '')); }
}
function approx(a, b, eps) { return Math.abs(a - b) <= (eps == null ? 1e-6 : eps); }
function section(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }

// ---------------------------------------------------------------- geometry
section('Geometry — linear solver & homography');
{
  // identity homography: src == dst
  const sq = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  const Hid = Geo.solveHomography(sq, sq);
  ok('identity homography maps points to themselves', Hid && approx(Geo.applyH(Hid, { x: 3, y: 7 }).x, 3, 1e-6) && approx(Geo.applyH(Hid, { x: 3, y: 7 }).y, 7, 1e-6));

  // a known perspective quad -> unit rectangle, round-trips through inverse
  const src = [{ x: 100, y: 120 }, { x: 540, y: 90 }, { x: 600, y: 400 }, { x: 60, y: 430 }];
  const dst = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 60 }, { x: 0, y: 60 }];
  const H = Geo.solveHomography(src, dst);
  ok('homography maps each src corner to its dst corner', (() => {
    for (let i = 0; i < 4; i++) {
      const m = Geo.applyH(H, src[i]);
      if (!approx(m.x, dst[i].x, 1e-4) || !approx(m.y, dst[i].y, 1e-4)) return false;
    }
    return true;
  })());

  const Hinv = Geo.invert3(H);
  ok('inverse homography round-trips an interior point', (() => {
    const p = { x: 321, y: 268 };
    const fwd = Geo.applyH(H, p);
    const back = Geo.applyH(Hinv, fwd);
    return approx(back.x, p.x, 1e-3) && approx(back.y, p.y, 1e-3);
  })());

  ok('3x3 inverse times original is identity (interior probe)', (() => {
    const a = Geo.applyH(H, { x: 200, y: 300 });
    const b = Geo.applyH(Geo.invert3(H), a);
    return approx(b.x, 200, 1e-3) && approx(b.y, 300, 1e-3);
  })());
}

section('Geometry — reflection & ray/segment');
{
  // reflect a 45° down-right ray off a horizontal wall (normal up) -> up-right
  const r = Geo.reflect({ x: 1, y: 1 }, { x: 0, y: -1 });
  ok('reflect off horizontal wall flips y only', approx(r.x, 1) && approx(r.y, -1));

  // ray hitting a vertical wall at x=10
  const hit = Geo.raySegment({ x: 0, y: 5 }, { x: 1, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 });
  ok('ray hits vertical wall at correct distance', hit && approx(hit.t, 10, 1e-6) && approx(hit.point.x, 10, 1e-6));
  ok('wall normal faces the incoming ray', hit && hit.n.x < 0);

  // ray parallel to wall -> no hit
  const miss = Geo.raySegment({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 5 }, { x: 10, y: 5 });
  ok('parallel ray misses', miss === null);

  // ray pointing away from a segment behind it -> no hit
  const behind = Geo.raySegment({ x: 0, y: 5 }, { x: -1, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 });
  ok('ray pointing away misses', behind === null);

  // signed angle sanity
  ok('signedAngle +90° turning left (CCW) is +PI/2', approx(Geo.signedAngle({ x: 1, y: 0 }, { x: 0, y: 1 }), Math.PI / 2, 1e-9));
}

// ---------------------------------------------------------------- solver
section('Solver — simulate primitives');
{
  const W = 100, H = 60;
  const walls = Solver.boundaryWalls(W, H);

  // straight shot down the middle reaches a hole directly ahead
  const ball = { x: 10, y: 30 };
  const hole = { x: 80, y: 30, r: 3 };
  const straight = Solver.simulate(ball, { x: 1, y: 0 }, 0.7, walls, hole, null, {});
  ok('straight medium putt sinks a hole dead ahead', straight.sunk, 'minDist=' + straight.minHoleDist.toFixed(2));

  // a too-soft putt that stops short does NOT sink
  const soft = Solver.simulate(ball, { x: 1, y: 0 }, 0.06, walls, { x: 95, y: 30, r: 3 }, null, {});
  ok('a too-soft putt stops short (no sink)', !soft.sunk);

  // a ball aimed at a wall reflects (bounces > 0) and stays inside the box
  const banked = Solver.simulate({ x: 20, y: 10 }, Geo.norm({ x: 1, y: -1 }), 0.9, walls, { x: 999, y: 999, r: 1 }, null, {});
  ok('shot into a wall produces at least one bounce', banked.bounces >= 1, 'bounces=' + banked.bounces);
  ok('bouncing ball never escapes the box', banked.path.every((p) => p.x >= -0.5 && p.x <= W + 0.5 && p.y >= -0.5 && p.y <= H + 0.5));
}

section('Solver — bank-shot solving');
{
  const W = 100, H = 60;
  const walls = Solver.boundaryWalls(W, H);

  // Hole tucked behind a wall segment so the DIRECT line is blocked -> must bank.
  // Wall segment blocks the straight path between ball and hole.
  const ball = { x: 15, y: 15 };
  const hole = { x: 15, y: 45, r: 3.2 };
  const blocker = [{ a: { x: 0, y: 30 }, b: { x: 60, y: 30 } }]; // wall with a gap on the right
  const wallsB = Solver.boundaryWalls(W, H, blocker);
  const r = Solver.solve(ball, hole, wallsB, null, { coarse: 360 });
  ok('solver finds at least one sinking shot for a blocked hole', r.solutions.length >= 1,
    'solutions=' + r.solutions.length + (r.fallback ? ' (fallback miss=' + r.fallback.miss.toFixed(1) + ')' : ''));
  if (r.best) {
    const path = r.best.result.path;
    const last = path[path.length - 1];
    ok('best solution actually ends in the cup', r.best.result.sunk && Math.hypot(last.x - hole.x, last.y - hole.y) <= hole.r + 0.5,
      'end=(' + last.x.toFixed(1) + ',' + last.y.toFixed(1) + ')');
    ok('best solution requires going around/over the blocker (bounce or detour)', r.best.result.path.length >= 2);
  }

  // Open hole: solver should prefer a direct (0-bounce) solution.
  const r2 = Solver.solve({ x: 10, y: 30 }, { x: 85, y: 30, r: 3 }, walls, null, { coarse: 240 });
  ok('open hole yields a near-direct solution as the best', r2.best && r2.best.bounces === 0, r2.best ? 'bounces=' + r2.best.bounces : 'no best');
  ok('open-hole best aim is roughly straight (|aim| < 8°)', r2.best && Math.abs(r2.best.aimDeg) < 8, r2.best ? 'aimDeg=' + r2.best.aimDeg.toFixed(2) : '');
}

section('Solver — slope bends the path');
{
  const W = 100, H = 60;
  const walls = Solver.boundaryWalls(W, H);
  const ball = { x: 10, y: 30 };
  // strong downhill toward +y should curve a straight-ahead putt downward
  const flat = Solver.simulate(ball, { x: 1, y: 0 }, 0.7, walls, { x: 999, y: 999, r: 1 }, null, {});
  const tilted = Solver.simulate(ball, { x: 1, y: 0 }, 0.7, walls, { x: 999, y: 999, r: 1 }, { x: 0, y: 0.25 }, {});
  const flatEnd = flat.path[flat.path.length - 1];
  const tiltEnd = tilted.path[tilted.path.length - 1];
  ok('slope deflects the resting point downhill (+y)', tiltEnd.y > flatEnd.y + 3, 'flatY=' + flatEnd.y.toFixed(1) + ' tiltY=' + tiltEnd.y.toFixed(1));
}

// ---------------------------------------------------------------- summary
console.log('\n' + (fail === 0
  ? '\x1b[1;32mALL ' + pass + ' TESTS PASSED\x1b[0m'
  : '\x1b[1;31m' + fail + ' FAILED\x1b[0m, ' + pass + ' passed'));
process.exit(fail === 0 ? 0 : 1);
