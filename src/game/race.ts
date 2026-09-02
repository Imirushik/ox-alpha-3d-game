// Race orchestration: countdown, timing, checkpoints & splits, live position,
// wrong-way detection, rider-vs-rider collisions, mild rubber-banding, the
// saved best-run ghost, and biggest-air replay data.
import * as THREE from 'three';
import { Bike } from './bike';
import { Track } from '../world/track';
import { HeightSampler } from '../world/terrain';
import { AIController, Personality } from './ai';

export interface Racer {
  name: string;
  bike: Bike;
  isPlayer: boolean;
  colorCss: string;
  ai?: AIController;
  progressS: number;
  hintIdx: number;
  nextCp: number;
  finishTime: number | null;
  wrongWayT: number;
  splitTimes: number[];
  lastProgressS: number;
  progressStallT: number;
}

interface GhostFrame { t: number; p: [number, number, number]; q: [number, number, number, number]; }

const GHOST_KEY = 'sunrise-descent-best-v1';

export type RaceEvent =
  | { type: 'countdown'; text: string }
  | { type: 'go' }
  | { type: 'checkpoint'; idx: number; t: number }
  | { type: 'finish' }
  | { type: 'wrongway'; on: boolean };

export class Race {
  racers: Racer[] = [];
  state: 'idle' | 'countdown' | 'racing' | 'finished' = 'idle';
  time = 0;
  countdownT = 0;
  private lastCountdownShown = -1;
  events: RaceEvent[] = [];
  player!: Racer;

  // ghost
  private ghostRecording: GhostFrame[] = [];
  private recordAcc = 0;
  private ghostData: GhostFrame[] | null = null;
  private ghostBestTime = Infinity;
  ghostMesh: THREE.Group | null = null;

  constructor(public track: Track, private sampler: HeightSampler) {
    try {
      const raw = localStorage.getItem(GHOST_KEY);
      if (raw) {
        const d = JSON.parse(raw) as { time: number; frames: GhostFrame[] };
        this.ghostBestTime = d.time;
        this.ghostData = d.frames;
      }
    } catch { /* no ghost available */ }
  }

  get bestTime(): number { return this.ghostBestTime; }

  addRacer(racer: Racer): void {
    this.racers.push(racer);
    if (racer.isPlayer) this.player = racer;
  }

  start(): void {
    this.state = 'countdown';
    this.countdownT = 3.6;
    this.lastCountdownShown = -1;
    this.time = 0;
    this.events.length = 0;
    this.ghostRecording = [];
    for (const r of this.racers) {
      r.progressS = 0;
      r.hintIdx = 0;
      r.nextCp = 0;
      r.finishTime = null;
      r.wrongWayT = 0;
      r.splitTimes = [];
      r.lastProgressS = 0;
      r.progressStallT = 0;
    }
  }

  update(dt: number): void {
    switch (this.state) {
      case 'countdown': {
        this.countdownT -= dt;
        const n = Math.ceil(this.countdownT);
        if (n !== this.lastCountdownShown && n > 0) {
          this.lastCountdownShown = n;
          this.events.push({ type: 'countdown', text: String(n) });
        }
        if (this.countdownT <= 0) {
          this.state = 'racing';
          this.events.push({ type: 'go' });
        }
        break;
      }
      case 'racing': {
        this.time += dt;
        this.updateProgress();
        this.updateGhostRecord(dt);
        break;
      }
      default: break;
    }
    // racers keep updating even after the player finishes (background)
    if (this.state === 'racing' || this.state === 'finished') this.updateWrongWay(dt);
  }

  private updateProgress(): void {
    const trk = this.track;
    const dt = 1 / 120;
    let leaderS = 0;
    const order = [...this.racers].sort((a, b) => b.progressS - a.progressS);

    for (const r of this.racers) {
      // if the rider is far from their tracked window (big tumble, shortcut,
      // teleport), re-project globally so progress never sticks. Prefer
      // forward samples: never let tracking fall back down the mountain.
      if (r.bike.pos.distanceToSquared(trk.samples[r.hintIdx].p) > 60 * 60) {
        const floorS = trk.samples[r.hintIdx].s - 60;
        let best = r.hintIdx, bd = Infinity;
        for (let i = 0; i < trk.samples.length; i += 2) {
          if (trk.samples[i].s < floorS) continue;
          const d = r.bike.pos.distanceToSquared(trk.samples[i].p);
          if (d < bd) { bd = d; best = i; }
        }
        r.hintIdx = best;
      }
      r.hintIdx = trk.project(r.bike.pos, r.hintIdx);
      const sm = trk.samples[r.hintIdx];
      const along = sm.s + (r.bike.pos.x - sm.p.x) * sm.t.x + (r.bike.pos.z - sm.p.z) * sm.t.z;
      // progress can jitter when cutting; require forward movement beyond checkpoint lock
      r.progressS = Math.max(r.progressS * 0.98, Math.min(trk.length + 12, Math.max(0, along)));

      // checkpoints
      while (r.nextCp < trk.wd.checkpoints.length &&
             r.progressS >= trk.wd.checkpoints[r.nextCp] - 4) {
        r.splitTimes.push(this.time);
        if (r.isPlayer) this.events.push({ type: 'checkpoint', idx: r.nextCp, t: this.time });
        r.nextCp++;
      }

      // progress-stall rescue for AI: moving but not advancing (contour-trapped
      // in a hairpin bowl, grinding a wall) -> reset onto the line ahead
      if (r.ai) {
        if (r.progressS - r.lastProgressS < 2) r.progressStallT += dt;
        else { r.progressStallT = 0; r.lastProgressS = r.progressS; }
        if (r.progressStallT > 4 && !r.bike.crashed && r.finishTime === null) {
          r.progressStallT = 0;
          const sm = trk.samples[Math.min(trk.samples.length - 1, r.hintIdx + 4)];
          r.bike.placeAt(sm.p.x, sm.p.z, Math.atan2(sm.t.x, sm.t.z));
          r.bike.vel.set(sm.t.x * 7, 0, sm.t.z * 7);
        }
      }

      // finish
      if (r.finishTime === null && r.progressS >= trk.length - 6) {
        r.finishTime = this.time;
        if (r.isPlayer) this.events.push({ type: 'finish' });
      }
      leaderS = Math.max(leaderS, r.progressS);
    }
    void order; void leaderS;
  }

  /** live standings: finished riders first by time, then by progress */
  standings(): Racer[] {
    return [...this.racers].sort((a, b) => {
      if (a.finishTime !== null && b.finishTime !== null) return a.finishTime - b.finishTime;
      if (a.finishTime !== null) return -1;
      if (b.finishTime !== null) return 1;
      return b.progressS - a.progressS;
    });
  }

  playerOrdinal(): number {
    return this.standings().indexOf(this.player) + 1;
  }

  /** gap to the rider ahead in metres */
  gapAheadMeters(): number {
    const st = this.standings();
    const i = st.indexOf(this.player);
    if (i <= 0) return 0;
    return Math.max(0, st[i - 1].progressS - this.player.progressS);
  }

  private updateWrongWay(dt: number): void {
    for (const r of this.racers) {
      if (!r.isPlayer || r.finishTime !== null) continue;
      const sm = this.track.samples[r.hintIdx];
      const dot = r.bike.vel.x * sm.t.x + r.bike.vel.z * sm.t.z;
      const offTrack = Math.abs(this.track.lateralOffset(r.bike.pos, r.hintIdx)) > 26;
      if (dot < -2.5 || (offTrack && dot < 0)) r.wrongWayT += dt;
      else r.wrongWayT = Math.max(0, r.wrongWayT - dt * 2);
      if (r.wrongWayT > 0.9) this.events.push({ type: 'wrongway', on: true });
      else if (r.wrongWayT <= 0.01) this.events.push({ type: 'wrongway', on: false });
    }
  }

  // ---------------------------------------------------------------------------
  // Collisions between all racers: soft sphere push + momentum exchange.
  // Hard hits can bring both down — but only when really warranted.
  // ---------------------------------------------------------------------------
  resolveCollisions(): void {
    for (let i = 0; i < this.racers.length; i++) {
      for (let j = i + 1; j < this.racers.length; j++) {
        const A = this.racers[i].bike, B = this.racers[j].bike;
        const dx = B.pos.x - A.pos.x, dy = B.pos.y - A.pos.y, dz = B.pos.z - A.pos.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        const minD = 1.15;
        if (d2 > minD * minD || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        const nx = dx / d, nz = dz / d;
        const push = (minD - d) / 2;
        A.pos.x -= nx * push; A.pos.z -= nz * push;
        B.pos.x += nx * push; B.pos.z += nz * push;
        // exchange velocity along contact normal
        const rel = (B.vel.x - A.vel.x) * nx + (B.vel.z - A.vel.z) * nz;
        if (rel < 0) {
          const imp = rel * 0.55;
          A.vel.x += nx * imp; A.vel.z += nz * imp;
          B.vel.x -= nx * imp; B.vel.z -= nz * imp;
          // only a genuinely violent T-bone takes anyone down
          if (-rel > 11 && Math.random() < 0.35) {
            (Math.abs(rel) > 14 ? B : A).startCrash('contact');
          }
        }
      }
    }
  }

  /** Mild rubber-banding keeps the pack honest without deciding the race. */
  applyRubberBand(): void {
    for (const r of this.racers) {
      if (!r.ai) continue;
      const delta = this.player.progressS - r.progressS;
      const mul = THREE.MathUtils.clamp(1 + delta * 0.00045, 0.93, 1.07);
      r.ai.maxSpeedMul = mul;
    }
  }

  // ---------------------------------------------------------------------------
  // Ghost recording / playback
  // ---------------------------------------------------------------------------
  private updateGhostRecord(dt: number): void {
    this.recordAcc += dt;
    if (this.recordAcc >= 0.08) {
      this.recordAcc = 0;
      const p = this.player.bike;
      this.ghostRecording.push({
        t: this.time,
        p: [p.pos.x, p.pos.y, p.pos.z],
        q: [p.quaternion.x, p.quaternion.y, p.quaternion.z, p.quaternion.w],
      });
    }
  }

  maybeSaveGhost(): boolean {
    const t = this.player.finishTime;
    if (t === null || t >= this.ghostBestTime) return false;
    this.ghostBestTime = t;
    this.ghostData = this.ghostRecording.slice();
    try {
      localStorage.setItem(GHOST_KEY, JSON.stringify({ time: t, frames: this.ghostData }));
    } catch { /* storage full/unavailable */ }
    return true;
  }

  /** advance the ghost mesh; returns false when there is nothing to show */
  updateGhost(dt: number, runTime: number): boolean {
    if (!this.ghostMesh || !this.ghostData || this.state !== 'racing') {
      if (this.ghostMesh) this.ghostMesh.visible = false;
      return false;
    }
    void dt;
    const f = this.ghostData;
    // binary-ish scan from cached index would be nicer; frames are dense enough
    let i = 0;
    while (i < f.length - 1 && f[i + 1].t < runTime) i++;
    if (i >= f.length - 1) { this.ghostMesh.visible = false; return false; }
    const a = f[i], b = f[i + 1];
    const k = (runTime - a.t) / Math.max(1e-5, b.t - a.t);
    this.ghostMesh.visible = true;
    this.ghostMesh.position.set(
      a.p[0] + (b.p[0] - a.p[0]) * k,
      a.p[1] + (b.p[1] - a.p[1]) * k,
      a.p[2] + (b.p[2] - a.p[2]) * k,
    );
    this.ghostMesh.quaternion.set(a.q[0], a.q[1], a.q[2], a.q[3]);
    return true;
  }

  buildGhostMesh(scene: THREE.Scene): void {
    const g = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({
      color: 0xbfe8ea, transparent: true, opacity: 0.34, depthWrite: false,
    });
    const frame = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.28, 1.15), mat);
    frame.position.y = 0.42;
    const wr = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.05, 6, 14), mat);
    wr.rotation.y = Math.PI / 2; wr.position.set(0, 0.32, -0.56);
    const wf = wr.clone(); wf.position.set(0, 0.32, 0.6);
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.13, 0.5, 3, 7), mat);
    body.position.set(0, 0.85, -0.08);
    g.add(frame, wr, wf, body);
    g.visible = false;
    scene.add(g);
    this.ghostMesh = g;
    void this.sampler;
  }
}
