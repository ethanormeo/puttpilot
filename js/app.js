/*
 * app.js — PuttPilot front end.
 * Camera + tap calibration (homography) + markerless planar tracking (Live Lock)
 * + live HUD render loop + controls. Geometry/physics/tracking live in
 * Geo (geometry.js), Solver (solver.js), PatchTracker (tracker.js).
 *
 * Source of truth once calibrated: geometry is stored in RECTIFIED (top-down)
 * coords. Every frame the tracker updates the screen positions of the lane
 * corners, the homography is re-solved, and all rectified geometry is projected
 * back to screen — so the overlay sticks to the real surface as the phone moves.
 */
(function () {
  'use strict';
  const Geo = window.Geo, Solver = window.Solver, PatchTracker = window.PatchTracker;
  const $ = (id) => document.getElementById(id);

  const video = $('cam'), hud = $('hud'), ctx = hud.getContext('2d');
  const proc = document.createElement('canvas');
  const pctx = proc.getContext('2d', { willReadFrequently: true });
  let grayBuf = new Uint8Array(0);
  let tracker = null;

  // ---- application state -------------------------------------------------
  const S = {
    mode: 'intro',          // intro | live | denied
    step: 'corners',        // corners | ball | hole | ready
    corners: [],            // screen-space taps during calibration
    ordered: null,          // 4 corners ordered TL,TR,BR,BL (screen) — tracked live
    H: null, Hinv: null,    // screen<->rectified homographies (updated each frame when tracking)
    dst: null,              // rectified rectangle corners
    W: 100, RH: 60, holeR: 3.4,
    rectBall: null, rectHole: null, rectWalls: [], // rectified source of truth
    pendingWall: null,      // first wall tap (screen)
    slope: null,            // {x,y} rectified downhill * grade
    settingSlope: false, slopeStart: null,
    addingWall: false,
    solutions: [], solIdx: 0, fallback: null,
    powerOverride: null, overrideResult: null,
    tracking: true,         // Live Lock on/off
    trackOK: false,
    frozen: false,
    dpr: 1, w: 0, h: 0, procScale: 1, procW: 2, procH: 2,
    t0: 0,
  };

  // ---- canvas sizing -----------------------------------------------------
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    S.dpr = dpr; S.w = window.innerWidth; S.h = window.innerHeight;
    hud.width = Math.round(S.w * dpr); hud.height = Math.round(S.h * dpr);
    hud.style.width = S.w + 'px'; hud.style.height = S.h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sf = Math.min(1, 460 / Math.max(S.w, S.h, 1));
    S.procScale = sf; S.procW = Math.max(2, Math.round(S.w * sf)); S.procH = Math.max(2, Math.round(S.h * sf));
    proc.width = S.procW; proc.height = S.procH;
    if (grayBuf.length !== S.procW * S.procH) grayBuf = new Uint8Array(S.procW * S.procH);
    tracker = null; // re-anchor after a resize
  }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 250));

  const screenToProc = (p) => ({ x: p.x * S.procScale, y: p.y * S.procScale });
  const procToScreen = (p) => ({ x: p.x / S.procScale, y: p.y / S.procScale });
  const toRect = (p) => Geo.applyH(S.H, p);
  const toScreen = (p) => Geo.applyH(S.Hinv, p);

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
    $('intro').classList.add('hidden'); $('denied').classList.add('hidden');
    $('topbar').classList.remove('hidden'); $('dock').classList.remove('hidden');
    resize(); setStep('corners');
  }
  function showDenied(msg) {
    S.mode = 'denied'; $('deniedMsg').textContent = msg;
    $('intro').classList.add('hidden'); $('denied').classList.remove('hidden');
  }

  // ---- device orientation (drift aid when tracking is off) ---------------
  let lastTilt = null, calibTilt = null;
  function requestOrientation() {
    const add = () => window.addEventListener('deviceorientation', onTilt);
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        DeviceOrientationEvent.requestPermission().then((r) => { if (r === 'granted') add(); }).catch(() => {});
      } else add();
    } catch (_) {}
  }
  function onTilt(e) { lastTilt = { b: e.beta || 0, g: e.gamma || 0 }; }
  function driftWarning() {
    if (S.tracking || !calibTilt || !lastTilt) return false;
    return Math.abs(lastTilt.b - calibTilt.b) + Math.abs(lastTilt.g - calibTilt.g) > 14;
  }

  // ---- grayscale frame for the tracker -----------------------------------
  function grabGray() {
    if (!video.videoWidth || video.readyState < 2) return null;
    const vw = video.videoWidth, vh = video.videoHeight, w = S.w, h = S.h;
    const cs = Math.max(w / vw, h / vh);
    const offX = (w - vw * cs) / 2, offY = (h - vh * cs) / 2;
    pctx.drawImage(video, -offX / cs, -offY / cs, w / cs, h / cs, 0, 0, S.procW, S.procH);
    const d = pctx.getImageData(0, 0, S.procW, S.procH).data;
    for (let i = 0, j = 0; j < grayBuf.length; i += 4, j++) grayBuf[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
    return { gray: grayBuf, w: S.procW, h: S.procH };
  }

  // ---- tap handling ------------------------------------------------------
  hud.addEventListener('pointerdown', onPointerDown);
  hud.addEventListener('pointermove', onPointerMove);
  hud.addEventListener('pointerup', onPointerUp);
  const toLocal = (e) => { const r = hud.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

  function onPointerDown(e) {
    if (S.mode !== 'live') return;
    const p = toLocal(e);
    if (S.settingSlope) { S.slopeStart = p; return; }
    handleTap(p);
  }
  function onPointerMove(e) { if (S.settingSlope && S.slopeStart) computeSlope(S.slopeStart, toLocal(e)); }
  function onPointerUp() {
    if (S.settingSlope && S.slopeStart) {
      S.settingSlope = false; S.slopeStart = null;
      $('slopeBtn').classList.remove('active'); setStatus(S.slope ? 'Slope set' : 'Slope cleared');
    }
  }

  function handleTap(p) {
    if (S.addingWall) {
      if (!S.pendingWall) { S.pendingWall = p; setStatus('Tap the other end of the wall'); }
      else { S.rectWalls.push({ a: toRect(S.pendingWall), b: toRect(p) }); S.pendingWall = null; S.addingWall = false; $('wallBtn').classList.remove('active'); recompute(); }
      return;
    }
    if (S.step === 'corners') {
      if (S.corners.length < 4) S.corners.push(p);
      if (S.corners.length === 4) { calibrate(); setStep('ball'); } else setStatus(S.corners.length + '/4 corners');
      return;
    }
    if (S.step === 'ball') { S.rectBall = toRect(p); setStep('hole'); return; }
    if (S.step === 'hole') { S.rectHole = toRect(p); S.rectHole.r = S.holeR; setStep('ready'); lockIn(); return; }
    if (S.step === 'ready') {
      if (S.tracking && !S.trackOK) { initTracker(); setStatus('Re-locked'); return; }
      // nudge the closer of ball / hole
      const sb = S.rectBall ? toScreen(S.rectBall) : null, sh = S.rectHole ? toScreen(S.rectHole) : null;
      const db = sb ? Geo.dist(p, sb) : 1e9, dh = sh ? Geo.dist(p, sh) : 1e9;
      if (Math.min(db, dh) < 70) { const r = toRect(p); if (db <= dh) S.rectBall = r; else { S.rectHole = r; S.rectHole.r = S.holeR; } recompute(); }
    }
  }

  // ---- calibration -------------------------------------------------------
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
  function calibrate() {
    const o = orderCorners(S.corners); S.ordered = o;
    const top = Geo.dist(o[0], o[1]), bottom = Geo.dist(o[3], o[2]);
    const left = Geo.dist(o[0], o[3]), right = Geo.dist(o[1], o[2]);
    let aspect = Math.max(0.25, Math.min(4, ((top + bottom) / 2) / Math.max((left + right) / 2, 1e-3)));
    if (aspect >= 1) { S.W = 100; S.RH = 100 / aspect; } else { S.RH = 100; S.W = 100 * aspect; }
    S.holeR = Math.max(2.2, Math.min(S.W, S.RH) * 0.06);
    S.dst = [{ x: 0, y: 0 }, { x: S.W, y: 0 }, { x: S.W, y: S.RH }, { x: 0, y: S.RH }];
    S.H = Geo.solveHomography(o, S.dst); S.Hinv = S.H ? Geo.invert3(S.H) : null;
    calibTilt = lastTilt; tracker = null;
  }

  function lockIn() { recompute(); if (S.tracking) initTracker(); }

  function initTracker() {
    if (!PatchTracker || !S.ordered) return;
    const g = grabGray(); if (!g) { tracker = null; return; }
    tracker = new PatchTracker({ patchRadius: 8, searchRadius: 14, minZncc: 0.5 });
    S.trackOK = tracker.init(g.gray, g.w, g.h, S.ordered.map(screenToProc));
  }

  // re-solve homography from the tracked corners (called each frame)
  function trackingStep() {
    if (S.step !== 'ready' || !S.tracking || S.frozen) return;
    const g = grabGray(); if (!g) return;
    if (!tracker || !tracker.ready) { initTracker(); return; }
    const res = tracker.update(g.gray);
    if (res.ok) {
      const ordered = res.points.map(procToScreen);
      const H = Geo.solveHomography(ordered, S.dst);
      if (H) { S.ordered = ordered; S.H = H; S.Hinv = Geo.invert3(H); S.trackOK = true; }
    } else S.trackOK = false;
  }

  // ---- slope -------------------------------------------------------------
  function computeSlope(a, b) {
    if (!S.H) return;
    const v = Geo.sub(toRect(b), toRect(a)), mag = Geo.len(v), span = (S.W + S.RH) / 2;
    const grade = Math.max(0, Math.min(0.32, (mag / span) * 0.5));
    S.slope = grade < 0.01 ? null : { x: Geo.norm(v).x * grade, y: Geo.norm(v).y * grade };
    recompute();
  }

  // ---- solve -------------------------------------------------------------
  function recompute() {
    if (!S.H || !S.rectBall || !S.rectHole) return;
    const hole = { x: S.rectHole.x, y: S.rectHole.y, r: S.holeR };
    const walls = Solver.boundaryWalls(S.W, S.RH, S.rectWalls);
    const res = Solver.solve(S.rectBall, hole, walls, S.slope, { coarse: 300 });
    S.solutions = res.solutions; S.fallback = res.fallback;
    if (S.solIdx >= S.solutions.length) S.solIdx = 0;
    S.powerOverride = null; S.overrideResult = null;
    updateControlsForSolution(); updateReadout();
  }
  const currentSolution = () => (S.solutions.length ? S.solutions[S.solIdx] : null);

  function updateControlsForSolution() {
    const sol = currentSolution();
    $('altBtn').classList.toggle('hidden', S.solutions.length < 2);
    const pw = $('powerWrap');
    if (sol || S.fallback) {
      pw.classList.remove('hidden');
      const base = sol ? sol.power : (S.fallback ? S.fallback.power : 0.6);
      $('power').value = Math.round(base * 100); $('powerVal').textContent = powerLabel(base);
    } else pw.classList.add('hidden');
  }
  function powerLabel(p) { return p < 0.32 ? 'soft' : p < 0.5 ? 'easy' : p < 0.68 ? 'medium' : p < 0.86 ? 'firm' : 'full'; }

  function applyPowerOverride(p01) {
    const sol = currentSolution() || S.fallback; if (!sol || !S.H) return;
    const hole = { x: S.rectHole.x, y: S.rectHole.y, r: S.holeR };
    const walls = Solver.boundaryWalls(S.W, S.RH, S.rectWalls);
    S.powerOverride = p01;
    S.overrideResult = Solver.simulate(S.rectBall, sol.dir, p01, walls, hole, S.slope, {});
    updateReadout();
  }

  // ---- readout -----------------------------------------------------------
  function updateReadout() {
    const el = $('readout'), sol = currentSolution();
    if (!sol && !S.fallback) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden'); el.classList.toggle('miss', !sol);
    const use = sol || S.fallback;
    const deg = Math.abs(Math.round(use.aimDeg)), side = aimSide(use);
    const route = use.bounces === 0 ? 'straight in' : use.bounces === 1 ? '1-cushion bank' : use.bounces + '-cushion bank';
    const powerTxt = powerLabel(S.powerOverride != null ? S.powerOverride : use.power) + ' power';
    let verdict = sol ? 'SINKS IT' : 'best line (no clean sink — adjust)';
    if (S.overrideResult) verdict = S.overrideResult.sunk ? 'SINKS IT' : (S.overrideResult.minHoleDist < S.holeR * 1.6 ? 'just misses — nudge power' : 'off line');
    const dirTxt = deg < 2 ? '<span class="dir">dead straight</span>' : 'aim <span class="dir">' + deg + '° ' + side + '</span>';
    el.innerHTML = '<div class="big-line">' + dirTxt + '</div><div class="sub-line">' + route + ' · ' + powerTxt + ' · ' + verdict + '</div>';
  }
  function aimSide(sol) {
    if (!S.Hinv || !S.rectBall) return '';
    const ballS = toScreen(S.rectBall);
    const aheadS = toScreen(sol.result.path.length > 1 ? sol.result.path[1] : sol.result.path[0]);
    const holeS = toScreen(S.rectHole);
    return Geo.cross(Geo.norm(Geo.sub(holeS, ballS)), Geo.norm(Geo.sub(aheadS, ballS))) > 0 ? 'right' : 'left';
  }

  // ---- render loop -------------------------------------------------------
  function frame(t) {
    if (!S.t0) S.t0 = t;
    try { trackingStep(); } catch (_) {}
    draw((t - S.t0) / 1000);
    requestAnimationFrame(frame);
  }

  function draw(time) {
    ctx.clearRect(0, 0, S.w, S.h);
    if (S.mode !== 'live') return;
    const locked = S.step === 'ready' || (S.step !== 'corners' && S.H);

    // lane outline (projected from the rectified rectangle so it tracks)
    if (S.H && S.dst) {
      const c = S.dst.map(toScreen);
      ctx.save(); ctx.beginPath(); ctx.moveTo(c[0].x, c[0].y);
      for (let i = 1; i < 4; i++) ctx.lineTo(c[i].x, c[i].y);
      ctx.closePath();
      ctx.strokeStyle = S.trackOK || !S.tracking ? 'rgba(56,225,255,0.55)' : 'rgba(255,194,75,0.6)';
      ctx.lineWidth = 2; ctx.setLineDash([10, 8]); ctx.stroke(); ctx.setLineDash([]); ctx.restore();
    }
    if (S.step === 'corners') for (let i = 0; i < S.corners.length; i++) drawPin(S.corners[i], '#38e1ff', String(i + 1));

    for (const w of S.rectWalls) {
      const a = toScreen(w.a), b = toScreen(w.b);
      ctx.save(); ctx.strokeStyle = '#ff8da6'; ctx.lineWidth = 5; ctx.lineCap = 'round';
      ctx.shadowColor = '#ff8da6'; ctx.shadowBlur = 10;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.restore();
    }
    if (S.pendingWall) drawPin(S.pendingWall, '#ff8da6', '');

    const sol = currentSolution() || S.fallback;
    if (sol && S.Hinv && S.rectBall) drawSolution(sol, time, !currentSolution());

    if (S.rectHole && S.Hinv && locked) drawHole(toScreen(S.rectHole), time);
    if (S.rectBall && S.Hinv && locked) drawBall(toScreen(S.rectBall));
    if (S.slope && S.Hinv && S.rectBall) drawSlope();

    if (S.step === 'ready') {
      if (S.tracking && !S.trackOK) setStatus('Tracking lost — tap to re-lock');
      else if (driftWarning()) setStatus('Phone moved — Reset to re-aim');
      else if (S.tracking) setStatus('Locked to surface');
    }
  }

  function drawPin(p, color, label) {
    ctx.save(); ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 12;
    ctx.beginPath(); ctx.arc(p.x, p.y, 8, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0; ctx.fillStyle = '#04121a';
    if (label) { ctx.font = '700 11px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(label, p.x, p.y + 0.5); }
    ctx.restore();
  }
  function drawBall(p) {
    ctx.save(); ctx.fillStyle = '#fff'; ctx.shadowColor = '#fff'; ctx.shadowBlur = 14;
    ctx.beginPath(); ctx.arc(p.x, p.y, 9, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.stroke(); ctx.restore();
  }
  function drawHole(p, time) {
    const pulse = 1 + 0.12 * Math.sin(time * 3);
    ctx.save(); ctx.strokeStyle = '#38e1ff'; ctx.shadowColor = '#38e1ff'; ctx.shadowBlur = 16; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(p.x, p.y, 13 * pulse, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(56,225,255,0.18)'; ctx.beginPath(); ctx.arc(p.x, p.y, 7, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  }
  function drawSolution(sol, time, isMiss) {
    const pts = sol.result.path.map(toScreen);
    if (pts.length < 2) return;
    const color = isMiss ? '#ffc24b' : '#2bffa3';
    ctx.save(); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.shadowColor = color; ctx.shadowBlur = 18; ctx.strokeStyle = color; ctx.lineWidth = 6; ctx.globalAlpha = 0.9;
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y); ctx.stroke();
    ctx.shadowBlur = 0; ctx.globalAlpha = 1; ctx.lineWidth = 2.5; ctx.strokeStyle = '#eafff5';
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y); ctx.stroke();
    ctx.restore();
    for (let i = 1; i < pts.length - 1; i++) {
      ctx.save(); ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 10;
      ctx.beginPath(); ctx.arc(pts[i].x, pts[i].y, 5, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    }
    const travel = travelPoint(pts, (time * 0.45) % 1);
    if (travel) { ctx.save(); ctx.fillStyle = '#fff'; ctx.shadowColor = color; ctx.shadowBlur = 16; ctx.beginPath(); ctx.arc(travel.x, travel.y, 5.5, 0, Math.PI * 2); ctx.fill(); ctx.restore(); }
    drawArrow(pts[0], Geo.norm(Geo.sub(pts[1], pts[0])), color);
  }
  function travelPoint(pts, f) {
    let total = 0; const segs = [];
    for (let i = 1; i < pts.length; i++) { const d = Geo.dist(pts[i - 1], pts[i]); segs.push(d); total += d; }
    if (total < 1) return null;
    let target = f * total;
    for (let i = 0; i < segs.length; i++) {
      if (target <= segs[i]) { const r = segs[i] ? target / segs[i] : 0; return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * r, y: pts[i].y + (pts[i + 1].y - pts[i].y) * r }; }
      target -= segs[i];
    }
    return pts[pts.length - 1];
  }
  function drawArrow(p, dir, color) {
    const p2 = { x: p.x + dir.x * 34, y: p.y + dir.y * 34 }, left = rot(dir, 2.5), right = rot(dir, -2.5);
    ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.shadowColor = color; ctx.shadowBlur = 10;
    ctx.beginPath(); ctx.moveTo(p2.x, p2.y); ctx.lineTo(p2.x + left.x * 12, p2.y + left.y * 12);
    ctx.moveTo(p2.x, p2.y); ctx.lineTo(p2.x + right.x * 12, p2.y + right.y * 12); ctx.stroke(); ctx.restore();
  }
  const rot = (v, a) => { const c = Math.cos(a), s = Math.sin(a); return { x: v.x * c - v.y * s, y: v.x * s + v.y * c }; };
  function drawSlope() {
    const a = toScreen(S.rectBall);
    const tip = toScreen({ x: S.rectBall.x + S.slope.x / 0.32 * (S.W * 0.18), y: S.rectBall.y + S.slope.y / 0.32 * (S.W * 0.18) });
    ctx.save(); ctx.strokeStyle = '#ffc24b'; ctx.fillStyle = '#ffc24b'; ctx.lineWidth = 3; ctx.setLineDash([6, 5]);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(tip.x, tip.y); ctx.stroke(); ctx.setLineDash([]);
    ctx.font = '700 11px system-ui'; ctx.fillText('downhill', tip.x + 6, tip.y); ctx.restore();
  }

  // ---- step / status UI --------------------------------------------------
  function setStep(step) {
    S.step = step;
    const hint = $('stepHint');
    if (step === 'corners') hint.innerHTML = 'Tap the <b>4 corners</b> of the lane';
    else if (step === 'ball') hint.innerHTML = 'Tap the <b>ball</b>';
    else if (step === 'hole') hint.innerHTML = 'Tap the <b>hole</b>';
    else hint.innerHTML = 'Line locked — tap ball/hole to nudge';
    $('lockBtn').classList.toggle('hidden', step !== 'ready');
    if (step !== 'ready') setStatus('');
  }
  function setStatus(s) { $('status').textContent = s || ''; }

  // ---- buttons -----------------------------------------------------------
  $('startBtn').addEventListener('click', startCamera);
  $('retryBtn').addEventListener('click', startCamera);
  $('safariBtn').addEventListener('click', () => { $('deniedMsg').textContent = 'In Safari, make sure the address bar shows Safari (not an in-app browser). Reload, then Allow camera.'; });
  $('helpBtn').addEventListener('click', () => $('help').classList.remove('hidden'));
  $('helpClose').addEventListener('click', () => $('help').classList.add('hidden'));

  $('lockBtn').addEventListener('click', () => {
    S.tracking = !S.tracking;
    $('lockBtn').classList.toggle('active', S.tracking);
    $('lockBtn').textContent = S.tracking ? '🔒 Live Lock' : '🔓 Pinned';
    if (S.tracking) initTracker(); else S.trackOK = false;
    setStatus(S.tracking ? 'Live Lock on' : 'Overlay pinned to frame');
  });

  $('undoBtn').addEventListener('click', () => {
    if (S.pendingWall) { S.pendingWall = null; S.addingWall = false; $('wallBtn').classList.remove('active'); return; }
    if (S.step === 'ready') { S.rectHole = null; setStep('hole'); clearSolution(); return; }
    if (S.step === 'hole') { S.rectBall = null; setStep('ball'); return; }
    if (S.step === 'ball') { S.corners.pop(); S.ordered = null; S.H = null; S.Hinv = null; setStep('corners'); return; }
    if (S.step === 'corners' && S.corners.length) { S.corners.pop(); setStatus(S.corners.length + '/4 corners'); }
  });

  $('altBtn').addEventListener('click', () => {
    if (S.solutions.length < 2) return;
    S.solIdx = (S.solIdx + 1) % S.solutions.length; S.powerOverride = null; S.overrideResult = null;
    updateControlsForSolution(); updateReadout();
  });

  $('slopeBtn').addEventListener('click', () => {
    if (S.step !== 'ready') { setStatus('Place ball & hole first'); return; }
    if (S.slope) { S.slope = null; $('slopeBtn').classList.remove('active'); recompute(); setStatus('Slope cleared'); return; }
    S.settingSlope = true; $('slopeBtn').classList.add('active'); setStatus('Drag downhill ↓');
  });

  $('wallBtn').addEventListener('click', () => {
    if (!S.H) { setStatus('Finish corners first'); return; }
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
    S.corners = []; S.ordered = null; S.rectBall = null; S.rectHole = null; S.rectWalls = [];
    S.pendingWall = null; S.H = null; S.Hinv = null; S.dst = null; S.slope = null;
    S.solutions = []; S.fallback = null; S.solIdx = 0; tracker = null; S.trackOK = false; clearSolution();
    if (S.frozen) { S.frozen = false; video.play().catch(() => {}); $('freezeBtn').classList.remove('active'); $('freezeBtn').textContent = 'Freeze'; }
    ['slopeBtn', 'wallBtn'].forEach((id) => $(id).classList.remove('active'));
    S.addingWall = false; S.settingSlope = false; setStep('corners'); setStatus('');
  });

  function clearSolution() { $('readout').classList.add('hidden'); $('powerWrap').classList.add('hidden'); $('altBtn').classList.add('hidden'); }

  $('power').addEventListener('input', (e) => {
    const p = Math.max(0, Math.min(1, e.target.value / 100));
    $('powerVal').textContent = powerLabel(p); applyPowerOverride(p);
  });

  if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));

  // ---- boot --------------------------------------------------------------
  resize();
  requestAnimationFrame(frame);
})();
