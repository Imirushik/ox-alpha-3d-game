// Verifies the demo autopilot drives the player properly.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const server = spawn('npx', ['vite', 'preview', '--port', '4181'], { stdio: 'pipe' });
await new Promise((res) => setTimeout(res, 2500));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message?.slice(0, 200)));
await page.goto('http://localhost:4181');
await page.waitForSelector('#menu:not(.hidden)', { timeout: 60000 });
await page.evaluate(() => { window.__DEMO_AUTOPILOT = true; });
await page.click('#btn-start');
await page.waitForTimeout(4500);
for (const t of [10, 20, 30, 40]) {
  await page.waitForTimeout(10000);
  const s = await page.evaluate(() => {
    const g = window.__game;
    const b = g.playerBike;
    return {
      t: Math.round(g.race.time),
      s: Math.round(g.race.player.progressS),
      kmh: Math.round(b.speedKmh),
      crashed: b.crashed,
      air: b.airTime > 0.1,
      trick: b.activeTrickName || '-',
      boost: Math.round(b.boostMeter),
    };
  });
  console.log(JSON.stringify(s));
}
await browser.close(); server.kill(); process.exit(0);
