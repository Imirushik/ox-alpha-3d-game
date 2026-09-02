// Physics probe: watches the player bike's state to find runaway energy.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const server = spawn('npx', ['vite', 'preview', '--port', '4174'], { stdio: 'pipe' });
await new Promise((res) => setTimeout(res, 2500));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message?.slice(0, 200)));
await page.goto('http://localhost:4174');
await page.waitForSelector('#menu:not(.hidden)', { timeout: 60000 });
await page.click('#btn-start');
await page.waitForTimeout(1000);

const probe = async (label) => {
  const s = await page.evaluate((lbl) => {
    const g = window.__game;
    const b = g.playerBike;
    const r = g.race;
    return {
      label: lbl,
      pos: b.pos.toArray().map((v) => +v.toFixed(2)),
      vel: b.vel.toArray().map((v) => +v.toFixed(2)),
      onGround: b.onGround,
      zone: b.zone,
      crashed: b.crashed,
      raceState: r.state,
      camY: +g.cam.camera.position.y.toFixed(2),
      compF: +b.compF.toFixed(2),
    };
  }, label);
  console.log(JSON.stringify(s));
};

for (const t of [1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 16]) {
  await page.waitForTimeout(1000);
  await probe(`t=${t}s`);
}
await browser.close();
server.kill();
process.exit(0);
