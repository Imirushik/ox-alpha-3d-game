// Capture harness: boots the game headless, drives it through a run, and
// grabs retina stills + frame sequences for art/animation review.
// Usage: node tools/capture.mjs [--seq] [--t seconds]
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const SEQ = process.argv.includes('--seq');
const OUT = 'captures';
mkdirSync(OUT, { recursive: true });

// start vite preview of the built game
const server = spawn('npx', ['vite', 'preview', '--port', '4173'], { stdio: 'pipe' });
await new Promise((res) => setTimeout(res, 2500));

const browser = await chromium.launch({
  args: ['--use-angle=metal', '--enable-unsafe-webgpu'],
});
const page = await browser.newPage({
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 2,
});

page.on('console', (m) => {
  const t = m.text();
  if (t.includes('failed') || t.includes('error') || t.includes('Error')) console.log('[console]', t);
});
page.on('pageerror', (e) => console.log('[pageerror]', e.stack?.split('\n').slice(0,6).join(' | ')));

await page.goto('http://localhost:4173');
// wait for the menu (terrain built)
await page.waitForSelector('#menu:not(.hidden)', { timeout: 60000 });
console.log('menu visible — terrain built');

await page.screenshot({ path: `${OUT}/00-menu.png` });

// start the run
await page.click('#btn-start');
await page.waitForTimeout(1000);
await page.screenshot({ path: `${OUT}/01-countdown.png` });

// wait through countdown (~3.6s) then drive: hold W, steer with occasional A/D
await page.waitForTimeout(3200);
console.log('racing…');

// drive straight-ish with gentle steering for N seconds, capturing stills
async function drive(seconds, keyPattern) {
  const steps = keyPattern || [['KeyW', 1000]];
  const t0 = Date.now();
  let i = 0;
  while ((Date.now() - t0) / 1000 < seconds) {
    const [key, dur] = steps[i % steps.length];
    await page.keyboard.down(key);
    if (key === 'KeyW') { /* keep pedaling */ }
    await page.waitForTimeout(dur);
    await page.keyboard.up(key);
    i++;
  }
}

if (!SEQ) {
  // stills at interesting moments
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/02-start-section.png` });
  await page.waitForTimeout(4000);
  await page.keyboard.down('KeyD');
  await page.waitForTimeout(700);
  await page.keyboard.up('KeyD');
  await page.screenshot({ path: `${OUT}/03-corner.png` });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${OUT}/04-mid-mountain.png` });
  await page.keyboard.up('KeyW');
} else {
  // frame sequence: capture every ~90ms while driving
  await page.keyboard.down('KeyW');
  for (let f = 0; f < 60; f++) {
    await page.waitForTimeout(90);
    if (f === 20) await page.keyboard.down('KeyA');
    if (f === 26) await page.keyboard.up('KeyA');
    if (f === 40) await page.keyboard.down('KeyD');
    if (f === 46) await page.keyboard.up('KeyD');
    await page.screenshot({ path: `${OUT}/seq-${String(f).padStart(2, '0')}.png` });
  }
  await page.keyboard.up('KeyW');
}

console.log('done');
await browser.close();
server.kill();
process.exit(0);
