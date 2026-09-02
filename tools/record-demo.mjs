// Records the official demo video at true 1080p30 with deterministic framing:
// the game advances one fixed 1/30 s step per frame while Node screenshots
// each rendered frame, then ffmpeg assembles a smooth H.264 MP4 (CRF 17).
// This avoids Playwright's lossy real-time VP8 pipeline entirely.
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import ffmpegPath from 'ffmpeg-static';

const OUT_DIR = 'media';
const FRAMES = `${OUT_DIR}/.frames`;
const FPS = 30;
const SECONDS = 75;
mkdirSync(FRAMES, { recursive: true });

const server = spawn('npx', ['vite', 'preview', '--port', '4180'], { stdio: 'pipe' });
await new Promise((res) => setTimeout(res, 2500));

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
});
const page = await context.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message?.slice(0, 200)));

await page.goto('http://localhost:4180');
await page.waitForSelector('#menu:not(.hidden)', { timeout: 60000 });

// showcase autopilot + fixed-step deterministic mode + cinematic bars
await page.evaluate(() => {
  window.__DEMO_AUTOPILOT = true;
  window.__DEMO_FIXED_STEP = true;
  document.body.classList.add('demo');
});
await page.click('#btn-start');

// advance through the countdown (no capture) — the orbit intro is part of it
const countdownFrames = 120; // 4 s: orbit around the grid, then GO
for (let i = 0; i < countdownFrames; i++) {
  await page.evaluate(() => window.__game.stepDemoFrame());
}
await page.evaluate(() => window.__game.stepDemoFrame()); // GO frame

console.log(`capturing ${SECONDS * FPS} deterministic frames…`);
const total = SECONDS * FPS;
for (let i = 0; i < total; i++) {
  await page.evaluate(() => window.__game.stepDemoFrame());
  const buf = await page.screenshot({ type: 'jpeg', quality: 92 });
  writeFileSync(`${FRAMES}/f${String(i).padStart(5, '0')}.jpg`, buf);
  if (i % 300 === 0) console.log(`  ${i}/${total}`);
}
await browser.close();
server.kill();

const dest = `${OUT_DIR}/demo-run.mp4`;
console.log('assembling MP4 (1080p30, CRF 17, slow)…');
execFileSync(ffmpegPath, [
  '-y',
  '-framerate', String(FPS),
  '-i', `${FRAMES}/f%05d.jpg`,
  '-c:v', 'libx264',
  '-preset', 'slow',
  '-crf', '17',
  '-pix_fmt', 'yuv420p',
  '-movflags', '+faststart',
  '-an',
  dest,
], { stdio: ['ignore', 'ignore', 'inherit'] });
rmSync(FRAMES, { recursive: true, force: true });

const mb = (statSync(dest).size / 1024 / 1024).toFixed(1);
console.log(`saved ${dest} (${mb} MB, ${SECONDS}s @ ${FPS}fps, 1080p)`);
process.exit(0);
