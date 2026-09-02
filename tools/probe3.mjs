// Full race-flow probe: teleports the player near the finish, coasts across,
// and verifies finish -> results -> replay transitions work without errors.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const server = spawn('npx', ['vite', 'preview', '--port', '4175'], { stdio: 'pipe' });
await new Promise((res) => setTimeout(res, 2500));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message?.slice(0, 300)));
await page.goto('http://localhost:4175');
await page.waitForSelector('#menu:not(.hidden)', { timeout: 60000 });
await page.click('#btn-start');
await page.waitForTimeout(4500); // countdown + GO

// teleport player just before the finish
await page.evaluate(() => {
  const g = window.__game;
  const len = g.race.track.length;
  const p = g.race.track.posAtS(len - 40, g.playerBike.pos);
  g.playerBike.pos.y = g.sampler.heightAt(p.x, p.z) + 1.0;
  g.playerBike.vel.set(0, 0, 0);
});

await page.keyboard.down('KeyW');
await page.waitForTimeout(6000); // coast through finish, replay should start
await page.keyboard.up('KeyW');
const state1 = await page.evaluate(() => ({
  state: window.__game.state,
  playerFinish: window.__game.race.player.finishTime,
}));
console.log('after finish:', JSON.stringify(state1));
await page.screenshot({ path: 'captures/10-replay-or-results.png' });

await page.waitForTimeout(7000); // replay should end -> results
const state2 = await page.evaluate(() => ({
  state: window.__game.state,
  resultsVisible: !document.getElementById('results').classList.contains('hidden'),
  standings: window.__game.race.standings().map((r) => ({
    n: r.name, t: r.finishTime, s: Math.round(r.progressS),
  })),
}));
console.log('results:', JSON.stringify(state2, null, 1));
await page.screenshot({ path: 'captures/11-results.png' });

// restart flow
await page.click('#btn-restart');
await page.waitForTimeout(1000);
const state3 = await page.evaluate(() => ({
  state: window.__game.state,
  raceState: window.__game.race.state,
  playerPos: window.__game.playerBike.pos.toArray().map((v) => Math.round(v)),
}));
console.log('after restart:', JSON.stringify(state3));

await browser.close(); server.kill(); process.exit(0);
