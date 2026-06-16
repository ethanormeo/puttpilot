/*
 * Headless browser smoke test. Serves the app on localhost, drives the real
 * Chrome with a fake camera, runs the full corners->ball->hole tap flow, asserts
 * no runtime errors, the readout populates, and screenshots the rendered HUD.
 * Run: node test/smoke.mjs
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      const fp = path.join(ROOT, p);
      if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.writeHead(404); return res.end('nf'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
      fs.createReadStream(fp).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

let failures = 0;
const ok = (name, cond, detail) => {
  console.log('  ' + (cond ? '\x1b[32m✓\x1b[0m ' : '\x1b[31m✗\x1b[0m ') + name + (cond ? '' : '  — ' + (detail || '')));
  if (!cond) failures++;
};

const { server, port } = await serve();
const URL = `http://127.0.0.1:${port}/index.html`;
console.log('\n\x1b[1mSmoke — real Chrome + fake camera\x1b[0m\n  serving ' + URL);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--no-sandbox',
  ],
});

const pageErrors = [];
const consoleErrors = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 400, height: 800, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  await page.goto(URL, { waitUntil: 'networkidle0' });
  ok('page loads with no boot error', pageErrors.length === 0, pageErrors.join(' | '));

  const hasMedia = await page.evaluate(() => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia));
  ok('getUserMedia available (secure context)', hasMedia);

  await page.click('#startBtn');
  await page.waitForFunction(() => !document.getElementById('dock').classList.contains('hidden'), { timeout: 6000 });
  ok('camera starts and live UI appears', true);

  const intro = await page.evaluate(() => document.getElementById('intro').classList.contains('hidden'));
  ok('intro overlay dismissed', intro);

  // run the full tap flow
  const taps = [
    [130, 260], [280, 260], [300, 560], [110, 560], // 4 corners
    [200, 500],                                       // ball
    [205, 300],                                       // hole
  ];
  for (const [x, y] of taps) { await page.mouse.click(x, y); await new Promise((r) => setTimeout(r, 120)); }
  await new Promise((r) => setTimeout(r, 600));

  const state = await page.evaluate(() => ({
    step: document.getElementById('stepHint').textContent,
    readoutHidden: document.getElementById('readout').classList.contains('hidden'),
    readout: document.getElementById('readout').textContent,
    powerHidden: document.getElementById('powerWrap').classList.contains('hidden'),
  }));
  ok('reached the aiming step (readout visible)', !state.readoutHidden, 'step=' + state.step);
  ok('readout shows an aim instruction', /aim|straight/i.test(state.readout), JSON.stringify(state.readout));
  ok('power control revealed', !state.powerHidden);

  // exercise a few buttons for runtime safety
  await page.click('#slopeBtn').catch(() => {});
  await page.mouse.click(200, 480); await page.mouse.move(230, 430); await page.mouse.up().catch(() => {});
  await page.click('#freezeBtn').catch(() => {});
  await page.click('#freezeBtn').catch(() => {});
  await page.click('#altBtn').catch(() => {});
  await page.click('#helpBtn').catch(() => {});
  await page.click('#helpClose').catch(() => {});
  await new Promise((r) => setTimeout(r, 200));

  const shot = path.join('/tmp', 'puttpilot-smoke.png');
  await page.screenshot({ path: shot });
  console.log('  screenshot: ' + shot);

  ok('no runtime page errors during full flow', pageErrors.length === 0, pageErrors.join(' | '));
  ok('no console errors during full flow', consoleErrors.length === 0, consoleErrors.join(' | '));
} catch (e) {
  console.log('  \x1b[31mEXCEPTION\x1b[0m ' + e.message);
  failures++;
} finally {
  await browser.close();
  server.close();
}

console.log('\n' + (failures === 0 ? '\x1b[1;32mSMOKE TEST PASSED\x1b[0m' : '\x1b[1;31mSMOKE TEST FAILED (' + failures + ')\x1b[0m'));
process.exit(failures === 0 ? 0 : 1);
