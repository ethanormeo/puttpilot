/*
 * app.js — PuttPilot front end.
 * Camera + tap calibration (homography) + live HUD render loop + controls.
 * Geometry/physics live in Geo (geometry.js) and Solver (solver.js).
 */
(function () {
  'use strict';
  const Geo = window.Geo, Solver = window.Solver;
  const $ = (id) => document.getElementById(id);

  const video = $('cam'), hud = $('hud'), ctx = hud.getContext('2d');

  // ---- application state -------------------------------------------------
  const S = {
    mode: 'intro',          // intro | live | denied
    step: 'corners',        // corners | ball | hole | ready
    corners: [],            // screen-space taps (CSS px)
    ordered: null,          // corners ordered TL,TR,BR,BL (screen)
    ball: null, hole: null, // screen-space
    walls: [],              // interior walls: [{a,b}] screen-space
    pendingWall: null,
    H: null, Hinv: null,    // screen<->rectified homographies
    W: 100, RH: 60,         // rectified rectangle dims
    holeR: 3.4,             // hole capture radius (rectified units)
    slope: null,            // {x,y} rectified downhill * grade
    settingSlope: false, slopeStart: null,
    addingWall: false,
    solutions: [], solIdx: 0, fallback: null,
    powerOverride: null,    // 0..1 or null
    overrideResult: null,
    frozen: false,
    dpr: 1, w: 0, h: 0,
    t0: 0,
  };

  // ---- canvas sizing -----------------------------------------------------
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    S.dpr = dpr;
    S.w = window.innerWidth; S.h = window.innerHeight;
    hud.width = Math.round(S.w * dpr); hud.height = Math.round(S.h * dpr);
    hud.style.width = S.w + 'px'; hud.style.height = S.h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 250));

  // ---- camera ------------------------------------------------------------
  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return showDenied('This browser can’t open the camera. Open the link in Safari or Chrome over https.');
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      video.srcObject = stream;
      await video.play().catch(() => {});
      enterLive();
      requestOrientation();
    } catch (err) {
      let msg = 'Camera permission was blocked.';
      if (err && err.name === 'NotAllowedError') msg = 'You denied camera access. Tap Retry and choose Allow.';
      else if (err && err.name === 'NotFoundError') msg = 'No camera found on this device.';
      else if (err && err.name === 'NotReadableError') msg = 'The camera is busy in another app. Close it and retry.';
      else if (err && location.protocol !== 'https:' && location.hostname !== 'localhost') msg = 'The camera needs a secure (https) page.';
      showDenied(msg);
    }
  }

  function enterLive() {
    S.mode = 'live';
    $('intro').classList.add('hidden');
    $('denied').classList.add('hidden');
    $('topbar').classList.remove('hidden');
    $('dock').classList.remove('hidden');
    resize();
    setStep('corners');
  }

  function showDenied(msg) {
    S.mode = 'denied';
    $('deniedMsg').textContent = msg;
    $('intro').classList.add('hidden');
    $('denied').classList.remove('hidden');
  }

  // ---- device orientation (optional drift aid) ---------------------------
  let lastTilt = null, calibTilt = null;
  function requestOrientation() {
    const add = () => window.addEventListener('deviceorientation', onTilt);
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        DeviceOrientationEvent.requestPermission().then((r) => { if (r === 'granted') add(); }).catch(() => {});
      } else add();
    } catch (_) {}
  }
  function onTilt(e) {
    lastTilt = { b: e.beta || 0, g: e.gamma || 0, a: e.alpha || 0 };
  }
  function driftWarning() {
    if (!calibTilt || !lastTilt) return false;
    const d = Math.abs(lastTilt.b - calibTilt.b) + Math.abs(lastTilt.g - calibTilt.g);
    return d > 14;
  }

  // ---- tap handling ------------------------------------------------------
  hud.addEventListener('pointerdown', onPointerDown);
  hud.addEventListener('pointermove', onPointerMove);
  hud.addEventListener('pointerup', onPointerUp);

  function toLocal(e) {
    const r = hud.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function onPointerDown(e) {
    if (S.mode !== 'live') return;
    const p = toLocal(e);
    if (S.settingSlope) { S.slopeStart = p; return; }
    handleTap(p);
  }
  function onPointerMove(e) {
    if (S.settingSlope && S.slopeStart) {
      const p = toLocal(e);
      computeSlope(S.slopeStart, p);
    }
  }
  function onPointerUp() {
    if (S.settingSlope && S.slopeStart) {
      S.settingSlope = false; S.slopeStart = null;
      $('slopeBtn').classList.remove('active');
      setStatus(S.slope ? 'Slope set' : 'Slope cleared');
    }
  }

  function handleTap(p) {
    if (S.addingWall) {
      if (!S.pendingWall) { S.pendingWall = p; setStatus('Tap the other end of the wall'); }
      else { S.walls.push({ a: S.pendingWall, b: p }); S.pendingWall = null; S.addingWall = false; $('wallBtn').classList.remove('active'); recompute(); }
      return;
    }
    if (S.step === 'corners') {
      if (S.corners.length < 4) S.corners.push(p);
      if (S.corners.length === 4) { calibrate(); setStep('ball'); }
      else setStatus(S.corners.length + '/4 corners');
      return;
    }
    if (S.step === 'ball') { S.ball = p; setStep('hole'); return; }
    if (S.step === 'hole') { S.hole = p; setStep('ready'); recompute(); return; }
    if (S.step === 'ready') {
      // tap to move the ball or hole, whichever is closer
      const db = S.ball ? Geo.dist(p, S.ball) : 1e9;
      const dh = S.hole ? Geo.dist(p, S.hole) : 1e9;
      if (Math.min(db, dh) < 60) { if (db <= dh) S.ball = p; else S.hole = p; recompute(); }
    }
  }

  // ---- calibration: homography + rectified dims --------------------------
  function orderCorners(pts) {
    // assign TL,TR,BR,BL using x+y / y-x extremes (robust to tap order)
    let tl = pts[0], br = pts[0], tr = pts[0], bl = pts[0];
    for (const q of pts) {
      if (q.x + q.y < tl.x + tl.y) tl = q;
      if (q.x + q.y > br.x + br.y) br = q;
      if (q.y - q.x < tr.y - tr.x) tr = q;
      if (q.y - q.x > bl.y - bl.x) bl = q;
    }
    return [tl, tr, br, bl];
  }

  function calibrate() {
    const o = orderCorners(S.corners);
    S.ordered = o;
    // estimate aspect from average screen edge lengths
    const top = Geo.dist(o[0], o[1]), bottom = Geo.dist(o[3], o[2]);
    const left = Geo.dist(o[0], o[3]), right = Geo.dist(o[1], o[2]);
    const wAvg = (top + bottom) / 2, hAvg = (left + right) / 2;
    let aspect = wAvg / Math.max(hAvg, 1e-3);
    aspect = Math.max(0.25, Math.min(4, aspect));
    if (aspect >= 1) { S.W = 100; S.RH = 100 / aspect; } else { S.RH = 100; S.W = 100 * aspect; }
    S.holeR = Math.max(2.2, Math.min(S.W, S.RH) * 0.06);
    const dst = [{ x: 0, y: 0 }, { x: S.W, y: 0 }, { x: S.W, y: S.RH }, { x: 0, y: S.RH }];
    S.H = Geo.solveHomography(o, dst);          // screen -> rectified
    S.Hinv = S.H ? Geo.invert3(S.H) : null;     // rectified -> screen
    calibTilt = lastTilt;
  }

  // screen -> rectified
  const toRect = (p) => Geo.applyH(S.H, p);
  // rectified -> screen
  const toScreen = (p) => Geo.applyH(S.Hinv, p);

  // ---- slope -------------------------------------------------------------
  function computeSlope(a, b) {
    if (!S.H) return;
    const ra = toRect(a), rb = toRect(b);
    const v = Geo.sub(rb, ra);
    const mag = Geo.len(v);
    const span = (S.W + S.RH) / 2;
    const grade = Math.max(0, Math.min(0.32, (mag / span) * 0.5));
    if (grade < 0.01) { S.slope = null; }
    else { const u = Geo.norm(v); S.slope = { x: u.x * grade, y: u.y * grade }; }
    recompute();
  }

  // ---- solve -------------------------------------------------------------
  function recompute() {
    if (!S.H || !S.ball || !S.hole) return;
    const ball = toRect(S.ball), hole = toRect(S.hole);
    hole.r = S.holeR;
    const extra = S.walls.map((w) => ({ a: toRect(w.a), b: toRect(w.b) }));
    const walls = Solver.boundaryWalls(S.W, S.RH, extra);
    const res = Solver.solve(ball, hole, walls, S.slope, { coarse: 300 });
    S.solutions = res.solutions; S.fallback = res.fallback;
    if (S.solIdx >= S.solutions.length) S.solIdx = 0;
    S.powerOverride = null; S.overrideResult = null;
    updateControlsForSolution();
    updateReadout();
  }

  function currentSolution() {
    if (S.solutions.length) return S.solutions[S.solIdx];
    return null;
  }

  function updateControlsForSolution() {
    const sol = currentSolution();
    $('altBtn').classList.toggle('hidden', S.solutions.length < 2);
    const pw = $('powerWrap');
    if (sol || S.fallback) {
      pw.classList.remove('hidden');
      const base = sol ? sol.power : (S.fallback ? S.fallback.power : 0.6);
      $('power').value = Math.round(base * 100);
      $('powerVal').textContent = powerLabel(base);
    } else pw.classList.add('hidden');
  }

  function powerLabel(p) {
    if (p < 0.32) return 'soft';
    if (p < 0.5) return 'easy';
    if (p < 0.68) return 'medium';
    if (p < 0.86) return 'firm';
    return 'full';
  }

  // re-simulate the current direction at the user's power (educational override)
  function applyPowerOverride(p01) {
    const sol = currentSolution() || S.fallback;
    if (!sol || !S.H) return;
    const ball = toRect(S.ball), hole = toRect(S.hole); hole.r = S.holeR;
    const extra = S.walls.map((w) => ({ a: toRect(w.a), b: toRect(w.b) }));
    const walls = Solver.boundaryWalls(S.W, S.RH, extra);
    S.powerOverride = p01;
    S.overrideResult = Solver.simulate(ball, sol.dir, p01, walls, hole, S.slope, {});
    updateReadout();
  }

  // ---- readout -----------------------------------------------------------
  function updateReadout() {
    const el = $('readout');
    const sol = currentSolution();
    if (!sol && !S.fallback) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    el.classList.toggle('miss', !sol);

    const use = sol || S.fallback;
    const side = aimSide(use);
    const deg = Math.abs(Math.round(use.aimDeg));
    const bounces = use.bounces;
    const route = bounces === 0 ? 'straight in' : bounces === 1 ? '1-cushion bank' : bounces + '-cushion bank';

    let powerTxt = powerLabel(S.powerOverride != null ? S.powerOverride : use.power) + ' power';
    let verdict = sol ? 'SINKS IT' : 'best line (no clean sink — adjust)';
    if (S.overrideResult) verdict = S.overrideResult.sunk ? 'SINKS IT' : (S.overrideResult.minHoleDist < S.holeR * 1.6 ? 'just misses — nudge power' : 'off line');

    const dirTxt = deg < 2 ? '<span class="dir">dead straight</span>' : 'aim <span class="dir">' + deg + '° ' + side + '</span>';
    el.innerHTML = '<div class="big-line">' + dirTxt + '</div>' +
      '<div class="sub-line">' + route + ' · ' + powerTxt + ' · ' + verdict + '</div>';
  }

  // left/right from the player's view, decided in screen space
  function aimSide(sol) {
    if (!S.Hinv || !S.ball) return '';
    const ballS = S.ball;
    const path = sol.result.path;
    const aheadRect = path.length > 1 ? path[1] : path[0];
    const aheadS = toScreen(aheadRect);
    const holeS = S.hole;
    const straight = Geo.norm(Geo.sub(holeS, ballS));
    const aim = Geo.norm(Geo.sub(aheadS, ballS));
    const c = Geo.cross(straight, aim);
    return c > 0 ? 'right' : 'left';
  }

  // ---- render loop -------------------------------------------------------
  function frame(t) {
    if (!S.t0) S.t0 = t;
    const time = (t - S.t0) / 1000;
    draw(time);
    requestAnimationFrame(frame);
  }

  function draw(time) {
    ctx.clearRect(0, 0, S.w, S.h);
    if (S.mode !== 'live') return;

    // calibrated surface outline
    if (S.ordered) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(S.ordered[0].x, S.ordered[0].y);
      for (let i = 1; i < 4; i++) ctx.lineTo(S.ordered[i].x, S.ordered[i].y);
      ctx.closePath();
      ctx.strokeStyle = 'rgba(56,225,255,0.55)';
      ctx.lineWidth = 2; ctx.setLineDash([10, 8]); ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
    // pending corner taps
    if (S.step === 'corners') {
      for (let i = 0; i < S.corners.length; i++) drawPin(S.corners[i], '#38e1ff', String(i + 1));
    }

    // interior walls
    for (const w of S.walls) {
      ctx.save();
      ctx.strokeStyle = '#ff8da6'; ctx.lineWidth = 5; ctx.lineCap = 'round';
      ctx.shadowColor = '#ff8da6'; ctx.shadowBlur = 10;
      ctx.beginPath(); ctx.moveTo(w.a.x, w.a.y); ctx.lineTo(w.b.x, w.b.y); ctx.stroke();
      ctx.restore();
    }
    if (S.pendingWall) drawPin(S.pendingWall, '#ff8da6', '');

    // the solved line
    const sol = currentSolution() || S.fallback;
    if (sol && S.Hinv) drawSolution(sol, time, !currentSolution());

    // ball + hole
    if (S.hole) drawHole(S.hole, time);
    if (S.ball) drawBall(S.ball);

    // slope arrow
    if (S.slope && S.Hinv && S.ball) drawSlope();

    // drift hint
    if (S.step === 'ready' && driftWarning()) {
      setStatus('Phone moved — Reset to re-aim');
    }
  }

  function drawPin(p, color, label) {
    ctx.save();
    ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 12;
    ctx.beginPath(); ctx.arc(p.x, p.y, 8, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0; ctx.fillStyle = '#04121a';
    if (label) { ctx.font = '700 11px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(label, p.x, p.y + 0.5); }
    ctx.restore();
  }

  function drawBall(p) {
    ctx.save();
    ctx.fillStyle = '#ffffff'; ctx.shadowColor = '#ffffff'; ctx.shadowBlur = 14;
    ctx.beginPath(); ctx.arc(p.x, p.y, 9, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.stroke();
    ctx.restore();
  }

  function drawHole(p, time) {
    const pulse = 1 + 0.12 * Math.sin(time * 3);
    ctx.save();
    ctx.strokeStyle = '#38e1ff'; ctx.shadowColor = '#38e1ff'; ctx.shadowBlur = 16; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(p.x, p.y, 13 * pulse, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(56,225,255,0.18)';
    ctx.beginPath(); ctx.arc(p.x, p.y, 7, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  function drawSolution(sol, time, isMiss) {
    const pts = sol.result.path.map(toScreen);
    if (pts.length < 2) return;
    const color = isMiss ? '#ffc24b' : '#2bffa3';
    // glow underlay
    ctx.save();
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.shadowColor = color; ctx.shadowBlur = 18;
    ctx.strokeStyle = color; ctx.lineWidth = 6; ctx.globalAlpha = 0.9;
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
    // bright core
    ctx.shadowBlur = 0; ctx.globalAlpha = 1; ctx.lineWidth = 2.5; ctx.strokeStyle = '#eafff5';
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
    ctx.restore();

    // bounce markers
    for (let i = 1; i < pts.length - 1; i++) {
      ctx.save();
      ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 10;
      ctx.beginPath(); ctx.arc(pts[i].x, pts[i].y, 5, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    // travelling ball preview
    const travel = travelPoint(pts, (time * 0.45) % 1);
    if (travel) {
      ctx.save();
      ctx.fillStyle = '#ffffff'; ctx.shadowColor = color; ctx.shadowBlur = 16;
      ctx.beginPath(); ctx.arc(travel.x, travel.y, 5.5, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    // aim arrow at the ball (first segment direction)
    const dir = Geo.norm(Geo.sub(pts[1], pts[0]));
    drawArrow(pts[0], dir, color);
  }

  function travelPoint(pts, f) {
    // total length
    let total = 0; const segs = [];
    for (let i = 1; i < pts.length; i++) { const d = Geo.dist(pts[i - 1], pts[i]); segs.push(d); total += d; }
    if (total < 1) return null;
    let target = f * total;
    for (let i = 0; i < segs.length; i++) {
      if (target <= segs[i]) {
        const r = segs[i] ? target / segs[i] : 0;
        return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * r, y: pts[i].y + (pts[i + 1].y - pts[i].y) * r };
      }
      target -= segs[i];
    }
    return pts[pts.length - 1];
  }

  function drawArrow(p, dir, color) {
    const len = 34, p2 = { x: p.x + dir.x * len, y: p.y + dir.y * len };
    const left = rot(dir, 2.5), right = rot(dir, -2.5);
    ctx.save();
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 3; ctx.lineCap = 'round';
    ctx.shadowColor = color; ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.moveTo(p2.x, p2.y); ctx.lineTo(p2.x + left.x * 12, p2.y + left.y * 12);
    ctx.moveTo(p2.x, p2.y); ctx.lineTo(p2.x + right.x * 12, p2.y + right.y * 12);
    ctx.stroke(); ctx.restore();
  }
  function rot(v, a) { const c = Math.cos(a), s = Math.sin(a); return { x: v.x * c - v.y * s, y: v.x * s + v.y * c }; }

  function drawSlope() {
    const ballR = toRect(S.ball);
    const tip = { x: ballR.x + S.slope.x / 0.32 * (S.W * 0.18), y: ballR.y + S.slope.y / 0.32 * (S.W * 0.18) };
    const a = toScreen(ballR), b = toScreen(tip);
    ctx.save();
    ctx.strokeStyle = '#ffc24b'; ctx.fillStyle = '#ffc24b'; ctx.lineWidth = 3; ctx.setLineDash([6, 5]);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.setLineDash([]);
    ctx.font = '700 11px system-ui'; ctx.fillText('downhill', b.x + 6, b.y);
    ctx.restore();
  }

  // ---- step / status UI --------------------------------------------------
  function setStep(step) {
    S.step = step;
    const hint = $('stepHint');
    if (step === 'corners') hint.innerHTML = 'Tap the <b>4 corners</b> of the lane';
    else if (step === 'ball') hint.innerHTML = 'Tap the <b>ball</b>';
    else if (step === 'hole') hint.innerHTML = 'Tap the <b>hole</b>';
    else hint.innerHTML = 'Line locked — tap ball/hole to nudge';
    setStatus(step === 'ready' ? 'Aiming' : '');
  }
  function setStatus(s) { $('status').textContent = s || ''; }

  // ---- buttons -----------------------------------------------------------
  $('startBtn').addEventListener('click', startCamera);
  $('retryBtn').addEventListener('click', startCamera);
  $('safariBtn').addEventListener('click', () => {
    $('deniedMsg').textContent = 'In Safari, tap the “aA” (or share) menu in the address bar → it must say Safari, not an in-app browser. Reload, then Allow camera.';
  });
  $('helpBtn').addEventListener('click', () => $('help').classList.remove('hidden'));
  $('helpClose').addEventListener('click', () => $('help').classList.add('hidden'));

  $('undoBtn').addEventListener('click', () => {
    if (S.pendingWall) { S.pendingWall = null; S.addingWall = false; $('wallBtn').classList.remove('active'); return; }
    if (S.step === 'ready') { S.hole = null; setStep('hole'); clearSolution(); return; }
    if (S.step === 'hole') { S.ball = null; setStep('ball'); return; }
    if (S.step === 'ball') { S.corners.pop(); S.ordered = null; S.H = null; setStep('corners'); return; }
    if (S.step === 'corners' && S.corners.length) { S.corners.pop(); setStatus(S.corners.length + '/4 corners'); }
  });

  $('altBtn').addEventListener('click', () => {
    if (S.solutions.length < 2) return;
    S.solIdx = (S.solIdx + 1) % S.solutions.length;
    S.powerOverride = null; S.overrideResult = null;
    updateControlsForSolution(); updateReadout();
  });

  $('slopeBtn').addEventListener('click', () => {
    if (S.step !== 'ready') { setStatus('Place ball & hole first'); return; }
    if (S.slope) { S.slope = null; $('slopeBtn').classList.remove('active'); recompute(); setStatus('Slope cleared'); return; }
    S.settingSlope = true; $('slopeBtn').classList.add('active'); setStatus('Drag downhill ↓');
  });

  $('wallBtn').addEventListener('click', () => {
    if (S.step === 'corners') { setStatus('Finish corners first'); return; }
    S.addingWall = !S.addingWall; S.pendingWall = null;
    $('wallBtn').classList.toggle('active', S.addingWall);
    setStatus(S.addingWall ? 'Tap both ends of the wall' : '');
  });

  $('freezeBtn').addEventListener('click', () => {
    S.frozen = !S.frozen;
    if (S.frozen) video.pause(); else video.play().catch(() => {});
    $('freezeBtn').classList.toggle('active', S.frozen);
    $('freezeBtn').textContent = S.frozen ? 'Unfreeze' : 'Freeze';
  });

  $('resetBtn').addEventListener('click', () => {
    S.corners = []; S.ordered = null; S.ball = null; S.hole = null; S.walls = [];
    S.pendingWall = null; S.H = null; S.Hinv = null; S.slope = null;
    S.solutions = []; S.fallback = null; S.solIdx = 0; clearSolution();
    if (S.frozen) { S.frozen = false; video.play().catch(() => {}); $('freezeBtn').classList.remove('active'); $('freezeBtn').textContent = 'Freeze'; }
    ['slopeBtn', 'wallBtn'].forEach((id) => $(id).classList.remove('active'));
    S.addingWall = false; S.settingSlope = false;
    setStep('corners'); setStatus('');
  });

  function clearSolution() { $('readout').classList.add('hidden'); $('powerWrap').classList.add('hidden'); $('altBtn').classList.add('hidden'); }

  $('power').addEventListener('input', (e) => {
    const p = Math.max(0, Math.min(1, e.target.value / 100));
    $('powerVal').textContent = powerLabel(p);
    applyPowerOverride(p);
  });

  // ---- service worker ----------------------------------------------------
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }

  // ---- boot --------------------------------------------------------------
  resize();
  requestAnimationFrame(frame);
})();
