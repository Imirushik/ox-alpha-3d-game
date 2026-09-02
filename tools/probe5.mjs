import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const server = spawn('npx', ['vite', 'preview', '--port', '4177'], { stdio: 'pipe' });
await new Promise((res) => setTimeout(res, 2500));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message?.slice(0, 200)));
await page.goto('http://localhost:4177');
await page.waitForSelector('#menu:not(.hidden)', { timeout: 60000 });
await page.click('#btn-start');
await page.waitForTimeout(4500);
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(10000);
  const s = await page.evaluate(() => {
    const g = window.__game;
    return {
      t: Math.round(g.race.time),
      racers: g.race.racers.map((r) => ({
        n: r.name,
        s: Math.round(r.progressS),
        fin: r.finishTime ? +r.finishTime.toFixed(1) : null,
        cr: r.bike.crashed,
        v: Math.round(r.bike.speed * 3.6),
      })),
    };
  });
  console.log(JSON.stringify(s));
}
await browser.close(); server.kill(); process.exit(0);
