/*
 * solver.js — putt physics + aim solver, in rectified top-down space.
 *
 * Everything here works in "table units" where the longer side of the lane is
 * ~100 units. A shot is simulated by stepping a ball forward under rolling
 * friction (and optional slope acceleration), reflecting off wall segments with
 * restitution, and capturing into the hole only if it arrives slow enough
 * (a screamer lips out — so power matters). The solver sweeps aim directions
 * (and a few power levels) and returns the cleanest shot that sinks.
 *
 * Pure + DOM-free so it is unit-tested in Node. Browser: window.Solver.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./geometry.js'));
  else root.Solver = factory(root.Geo);
})(typeof self !== 'undefined' ? self : this, function (Geo) {
  'use strict';
  const { sub, dot, len, norm, reflect, raySegment, signedAngle } = Geo;

  // Tunable physics constants (table units, seconds).
  const DEFAULTS = {
    G: 420,             // "gravity" scale for slope accel (units/s^2)
    rolling: 0.20,      // rolling resistance coefficient -> friction decel = rolling*G
    restitution: 0.72,  // speed retained after a wall bounce
    dt: 1 / 120,        // integration step
    maxTime: 12,        // seconds before we give up
    stopSpeed: 6,       // below this speed the ball is "stopped"
    captureSpeed: 165,  // max speed at which the ball can drop into the cup
    vMin: 70,           // power=0 launch speed
    vMax: 360,          // power=1 launch speed
    maxBounces: 6,
  };

  // Simulate one shot. Returns { path:[{x,y}], sunk, bounces, stoppedAt, minHoleDist, length }.
  // ball:{x,y}, dirUnit:{x,y}, power:0..1, walls:[{a,b}], hole:{x,y,r}, slope:{x,y}(downhill unit)*grade, opts.
  function simulate(ball, dirUnit, power, walls, hole, slope, opts) {
    const C = Object.assign({}, DEFAULTS, opts || {});
    const fric = C.rolling * C.G;
    const slopeAcc = slope ? { x: slope.x * C.G, y: slope.y * C.G } : { x: 0, y: 0 };
    const v0 = C.vMin + (C.vMax - C.vMin) * Math.max(0, Math.min(1, power));

    let p = { x: ball.x, y: ball.y };
    let vel = { x: dirUnit.x * v0, y: dirUnit.y * v0 };
    const path = [{ x: p.x, y: p.y }];
    let bounces = 0;
    let minHoleDist = Infinity;
    let sunk = false;
    let length = 0;

    const steps = Math.ceil(C.maxTime / C.dt);
    for (let i = 0; i < steps; i++) {
      // slope acceleration
      vel.x += slopeAcc.x * C.dt;
      vel.y += slopeAcc.y * C.dt;
      // rolling friction opposes motion
      let spd = len(vel);
      if (spd > 0) {
        const drop = Math.min(fric * C.dt, spd);
        vel.x -= (vel.x / spd) * drop;
        vel.y -= (vel.y / spd) * drop;
        spd = len(vel);
      }
      if (spd < C.stopSpeed && i > 2) {
        // came to rest
        return finish(path, sunk, bounces, p, minHoleDist, length);
      }

      // move this step, resolving wall bounces within it
      let remaining = spd * C.dt;
      let dir = norm(vel);
      let guard = 0;
      while (remaining > 1e-6 && guard++ < 16) {
        let best = null;
        for (let w = 0; w < walls.length; w++) {
          const hit = raySegment(p, dir, walls[w].a, walls[w].b);
          if (hit && hit.t <= remaining + 1e-6 && (!best || hit.t < best.t)) best = hit;
        }
        if (!best) {
          // free travel; check hole capture along this sub-segment
          const next = { x: p.x + dir.x * remaining, y: p.y + dir.y * remaining };
          const cap = captureCheck(p, next, hole, spd, C);
          length += remaining;
          if (cap.hit) { path.push(cap.point); minHoleDist = 0; return finish(path, true, bounces, cap.point, 0, length); }
          minHoleDist = Math.min(minHoleDist, cap.minDist);
          p = next; path.push({ x: p.x, y: p.y });
          remaining = 0;
        } else {
          const bp = best.point;
          const cap = captureCheck(p, bp, hole, spd, C);
          length += best.t;
          if (cap.hit) { path.push(cap.point); return finish(path, true, bounces, cap.point, 0, length); }
          minHoleDist = Math.min(minHoleDist, cap.minDist);
          p = { x: bp.x, y: bp.y };
          path.push({ x: p.x, y: p.y });
          // reflect velocity and lose energy
          vel = reflect(vel, best.n);
          vel.x *= C.restitution; vel.y *= C.restitution;
          spd = len(vel);
          dir = norm(vel);
          remaining = (remaining - best.t) * C.restitution;
          bounces++;
          if (bounces > C.maxBounces) return finish(path, false, bounces, p, minHoleDist, length);
        }
      }
      vel = { x: dir.x * spd, y: dir.y * spd };
    }
    return finish(path, sunk, bounces, p, minHoleDist, length);
  }

  function captureCheck(p0, p1, hole, spd, C) {
    // closest distance from segment p0->p1 to the hole centre
    const seg = sub(p1, p0);
    const L2 = dot(seg, seg) || 1e-9;
    let t = dot(sub(hole, p0), seg) / L2;
    t = Math.max(0, Math.min(1, t));
    const closest = { x: p0.x + seg.x * t, y: p0.y + seg.y * t };
    const d = Math.hypot(closest.x - hole.x, closest.y - hole.y);
    const hit = d <= hole.r && spd <= C.captureSpeed;
    return { hit, point: closest, minDist: d };
  }

  function finish(path, sunk, bounces, stoppedAt, minHoleDist, length) {
    return { path, sunk, bounces, stoppedAt, minHoleDist, length };
  }

  // Build the 4 boundary walls of the rectified rectangle [0,W]x[0,H] plus any
  // user-added interior segments.
  function boundaryWalls(W, H, extra) {
    const c = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }];
    const walls = [
      { a: c[0], b: c[1] }, { a: c[1], b: c[2] },
      { a: c[2], b: c[3] }, { a: c[3], b: c[0] },
    ];
    if (extra) for (const s of extra) walls.push(s);
    return walls;
  }

  // Solve: sweep aim directions (+ power levels), return ranked sinking shots.
  // Returns { solutions:[{dir,power,result,aimDeg,bounces}], best, aimedAt }.
  function solve(ball, hole, walls, slope, opts) {
    const C = Object.assign({}, DEFAULTS, opts || {});
    // Span gentle "die-it-in" putts up to firm bank shots, so a soft DIRECT putt
    // is found when the hole is reachable without banking off the back wall.
    const powers = (opts && opts.powers) || [0.25, 0.4, 0.55, 0.7, 0.85, 1.0];
    const coarse = (opts && opts.coarse) || 240;
    const toHole = norm(sub(hole, ball));

    const sinkers = [];
    let closest = null; // best non-sinking fallback (min hole distance)

    function trial(theta, power) {
      const dir = { x: Math.cos(theta), y: Math.sin(theta) };
      const res = simulate(ball, dir, power, walls, hole, slope, C);
      const cand = { theta, dir, power, result: res, bounces: res.bounces };
      if (res.sunk) sinkers.push(cand);
      if (!closest || res.minHoleDist < closest.result.minHoleDist) closest = cand;
      return cand;
    }

    // coarse sweep over full circle
    for (let k = 0; k < coarse; k++) {
      const theta = (k / coarse) * Math.PI * 2;
      for (const pw of powers) trial(theta, pw);
    }

    // refine around each promising direction (sinkers + closest) at fine resolution
    const seeds = sinkers.slice();
    if (closest) seeds.push(closest);
    const refined = [];
    for (const seed of seeds) {
      for (let d = -3; d <= 3; d += 0.25) {
        const theta = seed.theta + (d * Math.PI) / 180;
        for (const pw of powers) refined.push(trial(theta, pw));
      }
    }

    // rank sinkers: prefer fewer bounces, then a power with comfortable margin, then shorter path
    sinkers.sort((a, b) => {
      if (a.bounces !== b.bounces) return a.bounces - b.bounces;
      const ma = a.result.length, mb = b.result.length;
      return ma - mb;
    });

    // de-duplicate near-identical aim solutions (within 4 degrees & same bounce count)
    const solutions = [];
    for (const s of sinkers) {
      const aimDeg = (signedAngle(toHole, s.dir) * 180) / Math.PI;
      const dup = solutions.find((o) => o.bounces === s.bounces && Math.abs(o.aimDeg - aimDeg) < 4);
      if (dup) continue;
      solutions.push({
        dir: s.dir, power: s.power, result: s.result, bounces: s.bounces,
        aimDeg, // + = aim right of straight line, - = left
      });
      if (solutions.length >= 4) break;
    }

    let best = solutions[0] || null;
    let fallback = null;
    if (!best && closest) {
      fallback = {
        dir: closest.dir, power: closest.power, result: closest.result,
        bounces: closest.bounces,
        aimDeg: (signedAngle(toHole, closest.dir) * 180) / Math.PI,
        miss: closest.result.minHoleDist,
      };
    }
    return { solutions, best, fallback, aimedAt: hole };
  }

  return { simulate, solve, boundaryWalls, DEFAULTS };
});
