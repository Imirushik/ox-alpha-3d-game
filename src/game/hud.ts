// Hand-designed cel HUD: speed, position, timer, boost meter, trick popups,
// checkpoint splits, wrong-way warning, corner-preview arrow, and the route
// profile strip. All DOM/CSS/canvas — no default browser chrome anywhere.
import * as THREE from 'three';

interface RiderDot { name: string; color: string; isPlayer: boolean; }

export class HUD {
  private el = {
    speedNum: document.getElementById('speed-num')!,
    posOrd: document.getElementById('pos-ord')!,
    timer: document.getElementById('hud-timer')!,
    boostSegs: document.querySelector('.boost-segs') as HTMLDivElement,
    profile: document.getElementById('hud-profile') as HTMLCanvasElement,
    trickPop: document.getElementById('trick-pop')!,
    split: document.getElementById('split-toast')!,
    wrongway: document.getElementById('wrongway')!,
    countdown: document.getElementById('countdown')!,
    airMeter: document.getElementById('air-meter')!,
    hud: document.getElementById('hud')!,
    cornerHint: document.getElementById('corner-hint')!,
  };
  private boostSegEls: HTMLDivElement[] = [];
  private trickPopTimer = 0;
  private splitTimer = 0;
  private profileHeights: number[] = [];
  private riderDots: RiderDot[] = [];
  private progress: Array<{ frac: number }> = [];

  constructor() {
    for (let i = 0; i < 10; i++) {
      const s = document.createElement('div');
      s.className = 'seg';
      this.el.boostSegs.appendChild(s);
      this.boostSegEls.push(s);
    }
  }

  show(): void { this.el.hud.classList.remove('hidden'); }
  hide(): void { this.el.hud.classList.add('hidden'); }

  setProfile(profileHeights: number[], dots: RiderDot[]): void {
    this.profileHeights = profileHeights;
    this.riderDots = dots;
    this.progress = dots.map(() => ({ frac: 0 }));
  }

  setProgress(i: number, frac: number): void {
    if (this.progress[i]) this.progress[i].frac = frac;
  }

  frame(dt: number): void {
    if (this.trickPopTimer > 0) {
      this.trickPopTimer -= dt;
      if (this.trickPopTimer <= 0) this.el.trickPop.classList.remove('show');
    }
    if (this.splitTimer > 0) {
      this.splitTimer -= dt;
      if (this.splitTimer <= 0) this.el.split.classList.remove('show');
    }
    this.drawProfile();
  }

  setSpeed(kmh: number): void {
    this.el.speedNum.textContent = String(Math.round(kmh));
  }

  setPos(ord: number): void {
    const names = ['1ST', '2ND', '3RD', '4TH'];
    this.el.posOrd.textContent = names[Math.max(0, Math.min(3, ord - 1))];
    this.el.posOrd.dataset.rank = String(ord);
  }

  setTimer(t: number): void {
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    this.el.timer.textContent = `${m}:${s.toFixed(2).padStart(5, '0')}`;
  }

  setBoost(v01: number): void {
    const n = Math.round(v01 * 10);
    this.boostSegEls.forEach((s, i) => {
      s.classList.toggle('on', i < n);
      s.classList.toggle('hot', i < n && v01 > 0.75);
    });
  }

  trickPopup(text: string, score?: number): void {
    this.el.trickPop.innerHTML =
      `<span class="trick-name">${text}</span>` +
      (score !== undefined ? `<span class="trick-score">+${score}</span>` : '');
    this.el.trickPop.classList.add('show');
    this.trickPopTimer = 1.6;
  }

  splitToast(text: string): void {
    this.el.split.textContent = text;
    this.el.split.classList.add('show');
    this.splitTimer = 2.4;
  }

  wrongWay(on: boolean): void {
    this.el.wrongway.style.opacity = on ? '1' : '0';
  }

  airTime(t: number | null, heightM = 0): void {
    if (t === null) { this.el.airMeter.classList.remove('show'); return; }
    this.el.airMeter.classList.add('show');
    this.el.airMeter.textContent = `AIR ${t.toFixed(1)}s · ${heightM.toFixed(1)}m`;
  }

  countdown(text: string): void {
    const el = this.el.countdown;
    el.classList.remove('hidden');
    el.classList.remove('pop');
    void el.offsetWidth; // restart animation
    el.textContent = text;
    el.classList.add('pop');
    if (text === 'GO!') setTimeout(() => el.classList.add('hidden'), 700);
  }

  hideCountdown(): void { this.el.countdown.classList.add('hidden'); }

  /** +1 right turn / -1 left, magnitude = sharpness; null hides */
  cornerHint(curv: number | null): void {
    const el = this.el.cornerHint;
    if (curv === null || Math.abs(curv) < 0.12) { el.style.opacity = '0'; return; }
    el.style.opacity = '1';
    const deg = THREE.MathUtils.clamp(-curv * 90, -80, 80);
    el.style.transform = `rotate(${deg}deg)`;
  }

  private drawProfile(): void {
    const cv = this.el.profile;
    const ctx = cv.getContext('2d');
    if (!ctx || !this.profileHeights.length) return;
    const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    // backdrop panel
    ctx.fillStyle = 'rgba(24,20,30,0.72)';
    ctx.beginPath();
    ctx.roundRect(0, 8, W, H - 16, 10);
    ctx.fill();

    // elevation polyline
    const n = this.profileHeights.length;
    let mn = Infinity, mx = -Infinity;
    for (const h of this.profileHeights) { if (h < mn) mn = h; if (h > mx) mx = h; }
    ctx.strokeStyle = '#e8b04a';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * (W - 24) + 12;
      const y = H - 18 - ((this.profileHeights[i] - mn) / (mx - mn)) * (H - 36);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // rider dots
    for (let i = 0; i < this.riderDots.length; i++) {
      const d = this.riderDots[i];
      const p = this.progress[i]?.frac ?? 0;
      const x = p * (W - 24) + 12;
      ctx.fillStyle = d.color;
      ctx.strokeStyle = d.isPlayer ? '#fff' : '#241c16';
      ctx.lineWidth = d.isPlayer ? 3 : 2;
      ctx.beginPath();
      ctx.arc(x, H - 26, d.isPlayer ? 5 : 3.6, 0, 7);
      ctx.fill();
      ctx.stroke();
    }
  }

  static fmtTime(t: number): string {
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return `${m}:${s.toFixed(2).padStart(5, '0')}`;
  }
}
