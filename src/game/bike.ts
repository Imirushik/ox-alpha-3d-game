// Arcade raycast-style bike physics with real weight: two-wheel suspension,
// per-surface grip curves, preload/pump, bunny hop, manual, air rotation
// authority, slope-matched landing evaluation, physical crash tumbles, and a
// trick system that feeds the boost meter.
import * as THREE from 'three';
import { HeightSampler } from '../world/terrain';
import { ZONE } from '../world/heightfield';

const GRAVITY = -23;
export const RIDE_CLEARANCE = 0.52;
const TRAVEL = 0.26;
const WHEELBASE = 1.2;

export interface SurfaceParams {
  gripLat: number;
  steerGrip: number;
  rollDrag: number;
  maxSpeed: number;
  drive: number;
}

function surfaceParams(zone: number): SurfaceParams {
  switch (zone) {
    case ZONE.TRAIL: return { gripLat: 7.5, steerGrip: 1.0, rollDrag: 0.22, maxSpeed: 26, drive: 7 };
    case ZONE.ROCK: return { gripLat: 5.2, steerGrip: 0.82, rollDrag: 0.34, maxSpeed: 27, drive: 6 };
    case ZONE.SCREE: return { gripLat: 4.4, steerGrip: 0.78, rollDrag: 0.75, maxSpeed: 23, drive: 5 };
    case ZONE.SNOW: return { gripLat: 3.6, steerGrip: 0.62, rollDrag: 0.5, maxSpeed: 24, drive: 5 };
    case ZONE.GRASS: return { gripLat: 6.2, steerGrip: 0.9, rollDrag: 0.95, maxSpeed: 21, drive: 5.5 };
    case ZONE.DIRT: return { gripLat: 6.8, steerGrip: 0.96, rollDrag: 0.3, maxSpeed: 25, drive: 6.5 };
    default: return { gripLat: 6.0, steerGrip: 0.85, rollDrag: 1.4, maxSpeed: 18, drive: 5 };
  }
}

export type BikeEventType =
  | 'land' | 'hardLand' | 'crash' | 'recover' | 'hop' | 'pump'
  | 'slide' | 'bottomOut' | 'trickBanked' | 'trickFailed' | 'air';

export interface BikeEvent { type: BikeEventType; power?: number; name?: string; score?: number; }

export interface TrickPose {
  name: string;
  duration: number;
  score: number;
  frameRoll?: number;
  barYaw?: number;
  frameYaw?: number;
  pose?: string;
}

export const NAMED_TRICKS: TrickPose[] = [
  { name: 'TABLETOP', duration: 0.7, score: 120, frameRoll: Math.PI / 2 },
  { name: 'X-UP', duration: 0.55, score: 90, barYaw: Math.PI },
  { name: 'SUPERMAN', duration: 0.85, score: 180, pose: 'superman' },
  { name: 'TAILWHIP', duration: 0.75, score: 150, frameYaw: Math.PI * 2 },
  { name: '360', duration: 0.9, score: 200 },
  { name: 'BACKFLIP', duration: 0.95, score: 260 },
];

export interface BikeInput {
  steer: number;
  pedal: boolean;
  brake: boolean;
  crouch: boolean;
  hopPressed: boolean;
  boost: boolean;
  manual: boolean;
  airPitch: number;  // -1 nose down .. +1 lean back
  whipTrigger: boolean;
  namedTrick: number; // 1..6 or 0
}

export class Bike {
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  roll = 0;
  quaternion = new THREE.Quaternion();

  compF = 0;
  compR = 0;

  onGround = true;
  airTime = 0;
  lastImpact = 0;
  zone: number = ZONE.TRAIL;
  surf: SurfaceParams = surfaceParams(ZONE.TRAIL);

  crouch = 0;
  boosting = false;
  boostMeter = 45;

  crashed = false;
  crashTimer = 0;
  recoverGrace = 0;
  crashAngVel = new THREE.Vector3();
  private spinAccum = 0;
  private flipAccum = 0;
  private lastTrick: TrickPose | null = null;
  private trickT = -1;
  activeTrickName = '';
  bankedScore = 0;
  runTrickTotal = 0;
  biggestAirHeight = 0;
  biggestAirRecord: Array<{ p: [number, number, number]; q: [number, number, number, number] }> = [];
  private recordingAir = false;
  private pendingAirFrames: Array<{ p: [number, number, number]; q: [number, number, number, number] }> = [];

  events: BikeEvent[] = [];
  wheelWorldF = new THREE.Vector3();
  wheelWorldR = new THREE.Vector3();
  groundNormal = new THREE.Vector3(0, 1, 0);
  sliding = false;
  manualBalance = 0;

  constructor(private sampler: HeightSampler, public isPlayer = false) {}

  get speed(): number { return this.vel.length(); }
  get speedKmh(): number { return this.vel.length() * 3.6; }

  placeAt(x: number, z: number, yaw: number): void {
    this.pos.set(x, this.sampler.heightAt(x, z) + RIDE_CLEARANCE, z);
    this.vel.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = 0; this.roll = 0;
    this.crashed = false;
    this.onGround = true;
    this.airTime = 0;
    this.syncQuaternion();
  }

  private syncQuaternion(): void {
    this.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, this.roll, 'YXZ'));
  }

  update(dt: number, input: BikeInput): void {
    if (this.crashed) { this.updateCrash(dt); return; }

    this.zone = this.sampler.zoneAt(this.pos.x, this.pos.z);
    this.surf = surfaceParams(this.zone);

    const fwd = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const right = new THREE.Vector3(fwd.z, 0, -fwd.x);

    // ---- ground probing -----------------------------------------------------
    const fx = this.pos.x + fwd.x * WHEELBASE / 2, fz = this.pos.z + fwd.z * WHEELBASE / 2;
    const rx = this.pos.x - fwd.x * WHEELBASE / 2, rz = this.pos.z - fwd.z * WHEELBASE / 2;
    const hF = this.sampler.heightAt(fx, fz);
    const hR = this.sampler.heightAt(rx, rz);
    this.wheelWorldF.set(fx, hF, fz);
    this.wheelWorldR.set(rx, hR, rz);

    const supportF = hF + RIDE_CLEARANCE;
    const supportR = hR + RIDE_CLEARANCE;
    const wasGround = this.onGround;
    const manual = input.manual && this.onGround && !this.crashed;
    const support = manual ? supportR : Math.max(supportF, supportR);
    const pen = support - this.pos.y;
    this.onGround = pen > -0.02 || (this.onGround && pen > -0.12 && this.vel.y < 1);

    if (this.onGround) {
      if (!wasGround) this.onLanding();
      this.airTime = 0;
      this.sampler.normalAt(
        this.pos.x + fwd.x * (manual ? -WHEELBASE / 2 : 0),
        this.pos.z + fwd.z * (manual ? -WHEELBASE / 2 : 0),
        this.groundNormal,
      );
    } else {
      if (wasGround) {
        this.spinAccum = 0; this.flipAccum = 0;
        this.lastTrick = null; this.trickT = -1;
        this.events.push({ type: 'air' });
        this.recordingAir = true;
        this.pendingAirFrames = [];
      }
      this.groundNormal.set(0, 1, 0);
      this.airTime += dt;
    }

    // ---- gravity ------------------------------------------------------------
    this.vel.y += GRAVITY * dt;

    // ---- drive / brake / boost ----------------------------------------------
    this.boosting = input.boost && this.boostMeter > 1 && !this.crashed;
    if (this.boosting) this.boostMeter = Math.max(0, this.boostMeter - 30 * dt);
    if (this.onGround) {
      if (input.pedal && !manual) {
        const maxV = this.surf.maxSpeed + (this.boosting ? 8 : 0);
        const vAlong = Math.max(0, this.vel.dot(fwd));
        if (vAlong < maxV) {
          this.vel.addScaledVector(fwd, this.surf.drive * (this.boosting ? 2.3 : 1) * dt);
        }
      }
      this.sliding = false;
      if (input.brake && !manual) {
        const sp = this.vel.length();
        const drop = Math.min(sp, 13 * dt);
        this.vel.addScaledVector(this.vel.clone().normalize(), -drop);
        if (sp > 9) {
          this.sliding = true;
          if (Math.random() < dt * 22) this.events.push({ type: 'slide', power: sp });
        }
      }
      // rolling drag
      const sp2 = this.vel.length();
      if (sp2 > 0.01) {
        const drag = Math.min(sp2, this.surf.rollDrag * dt * (input.pedal ? 0.35 : 1));
        this.vel.addScaledVector(this.vel.clone().normalize(), -drag);
      }
    } else {
      // air drag is negligible
    }

    // ---- pump / preload / hop -------------------------------------------------
    if (this.onGround) {
      if (input.crouch) {
        this.crouch = Math.min(1, this.crouch + dt * 1.7);
      } else if (this.crouch > 0.3) {
        // released preload: impulse along ground normal, scaled by speed & charge
        const power = 2.6 + Math.min(this.speed, 20) * 0.16;
        this.vel.addScaledVector(this.groundNormal, power * this.crouch);
        this.events.push({ type: 'pump', power: this.crouch });
        this.crouch = 0;
      } else {
        this.crouch = Math.max(0, this.crouch - dt * 4);
      }
      if (input.hopPressed) {
        this.vel.addScaledVector(this.groundNormal, 5.4 + this.crouch * 2.2);
        this.crouch = 0;
        this.events.push({ type: 'hop' });
      }
    } else {
      this.crouch = Math.max(0, this.crouch - dt * 6);
      // air rotation authority
      this.yaw -= input.steer * 3.4 * dt;
      this.pitch += input.airPitch * 4.4 * dt;
      this.pitch *= 1 - 0.12 * dt;
      this.roll *= 1 - 0.4 * dt;
      if (input.whipTrigger) this.roll += Math.PI * 0.9;
      this.spinAccum += Math.abs(input.steer) * 3.4 * dt;
      this.flipAccum += Math.abs(input.airPitch) * 4.4 * dt;

      // record biggest-air replay frames (20 Hz)
      if (this.isPlayer && this.recordingAir && this.airTime % 0.05 < dt) {
        this.biggestAirRecord.push({
          p: [this.pos.x, this.pos.y, this.pos.z],
          q: [this.quaternion.x, this.quaternion.y, this.quaternion.z, this.quaternion.w],
        });
      }

      // named trick triggers
      if (input.namedTrick > 0 && !this.lastTrick) {
        const t = NAMED_TRICKS[input.namedTrick - 1];
        this.lastTrick = t;
        this.trickT = 0;
        this.activeTrickName = t.name;
      }
      if (this.trickT >= 0 && this.lastTrick) {
        this.trickT += dt;
        if (this.trickT >= this.lastTrick.duration) this.trickT = this.lastTrick.duration;
      }
    }

    // ---- steering on the ground -----------------------------------------------
    if (this.onGround) {
      const speedFactor = Math.min(1, this.speed / 13);
      const slideMod = this.sliding ? 1.55 : 1;
      const yawRate = input.steer * (1.9 - speedFactor * 1.15) * this.surf.steerGrip * slideMod;
      this.yaw -= yawRate * dt;
      if (manual) {
        // balance wobble while manualing
        this.manualBalance += dt;
        this.pitch = 0.24 + Math.sin(this.manualBalance * 7) * 0.02 * Math.min(1, this.manualBalance);
      } else {
        this.manualBalance = 0;
        // target pitch/roll from terrain + lean; slerped via Euler targets below
        const slopePitch = Math.atan2(hF - hR, WHEELBASE);
        const latSlope = this.lateralSlope(fwd);
        const lean = input.steer * Math.min(1, this.speed / 11) * 0.42 + latSlope * 0.35;
        this.pitch += (slopePitch - this.pitch) * Math.min(1, 14 * dt);
        this.roll += (lean - this.roll) * Math.min(1, 10 * dt);
      }
    }

    // ---- suspension compression (visual + bottom-out feedback) -----------------
    const targetCompF = THREE.MathUtils.clamp((supportF - this.pos.y) / TRAVEL, 0, 1);
    const targetCompR = THREE.MathUtils.clamp((supportR - this.pos.y) / TRAVEL, 0, 1);
    this.compF += (targetCompF - this.compF) * Math.min(1, 18 * dt);
    this.compR += (targetCompR - this.compR) * Math.min(1, 16 * dt);
    this.compF = Math.max(0, this.compF + (this.onGround ? this.crouch * 0.35 : -this.compF * dt * 6));
    if ((targetCompF > 0.96 || targetCompR > 0.96) && this.onGround && this.speed > 6) {
      if (Math.random() < dt * 8) this.events.push({ type: 'bottomOut' });
    }

    // ---- integrate position + ground constraint -------------------------------
    this.pos.addScaledVector(this.vel, dt);

    const supX = this.pos.x + fwd.x * (manual ? -WHEELBASE / 2 : 0);
    const supZ = this.pos.z + fwd.z * (manual ? -WHEELBASE / 2 : 0);
    const supNow = (manual ? this.sampler.heightAt(supX, supZ)
      : Math.max(
          this.sampler.heightAt(this.pos.x + fwd.x * WHEELBASE / 2, this.pos.z + fwd.z * WHEELBASE / 2),
          this.sampler.heightAt(this.pos.x - fwd.x * WHEELBASE / 2, this.pos.z - fwd.z * WHEELBASE / 2),
        )) + RIDE_CLEARANCE;

    if (this.pos.y <= supNow) {
      const n = this.groundNormal;
      const vn = this.vel.dot(n);
      if (vn < 0) {
        this.vel.addScaledVector(n, -vn);
        if (!wasGround || vn < -3.5) {
          this.lastImpact = Math.min(-vn, 30);
          if (this.lastImpact > 17.5 && !wasGround) this.startCrash('slam');
        }
      }
      this.pos.y = Math.max(this.pos.y, supNow);
      // stick when following downslope
      if (this.vel.y < -14 && this.wasSteepDown()) this.pos.y = supNow;
    }

    this.syncQuaternion();
  }

  private wasSteepDown(): boolean { return this.vel.y < -14; }

  private lateralSlope(fwd: THREE.Vector3): number {
    const rx = -fwd.z, rz = fwd.x;
    const hl = this.sampler.heightAt(this.pos.x - rx, this.pos.z - rz);
    const hr = this.sampler.heightAt(this.pos.x + rx, this.pos.z + rz);
    return Math.atan2(hr - hl, 2);
  }

  // ---------------------------------------------------------------------------
  private onLanding(): void {
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.quaternion);
    const ang = up.angleTo(this.groundNormal);

    // air height estimate from hangtime
    const hang = this.airTime;
    const apexM = Math.max(0, (GRAVITY * hang * hang) / -8);
    if (this.isPlayer && apexM > this.biggestAirHeight) {
      this.biggestAirHeight = apexM;
      this.biggestAirRecord = this.pendingAirFrames.slice();
    }
    this.recordingAir = false;

    // resolve pending trick
    let trickScore = 0;
    let trickName = '';
    if (this.lastTrick && this.trickT >= this.lastTrick.duration * 0.85) {
      trickScore = this.lastTrick.score;
      trickName = this.lastTrick.name;
    }
    // rotation bonuses
    const spinDeg = (this.spinAccum * 180) / Math.PI;
    const flipDeg = (this.flipAccum * 180) / Math.PI;
    if (spinDeg > 300) { trickScore = Math.max(trickScore, 200); trickName = trickName ? trickName + ' + 360' : '360 SPIN'; }
    if (flipDeg > 320) { trickScore = Math.max(trickScore, 280); trickName = trickName ? trickName + ' + FLIP' : 'BACKFLIP'; }

    const clean = ang < 0.45 && this.lastImpact < 16;
    if (clean && trickScore > 0) {
      this.bankedScore += trickScore;
      this.runTrickTotal += trickScore;
      this.boostMeter = Math.min(100, this.boostMeter + trickScore * 0.09);
      this.events.push({ type: 'trickBanked', name: trickName, score: trickScore });
    } else if (trickScore > 0) {
      this.events.push({ type: 'trickFailed' });
    }
    this.lastTrick = null;
    this.trickT = -1;
    this.activeTrickName = '';

    // AI riders are more forgiving on themselves so races stay spectatable;
    // the player eats the full punishment.
    const crashAng = this.isPlayer ? 0.75 : 0.95;
    const crashImpact = this.isPlayer ? 19 : 23;
    if (ang >= crashAng || this.lastImpact > crashImpact) {
      this.startCrash('badLanding');
      return;
    }
    if (ang >= 0.45) {
      // washout: scrub speed, kick the tail out
      this.vel.multiplyScalar(0.72);
      this.roll += (Math.random() > 0.5 ? 1 : -1) * 0.35;
      this.events.push({ type: 'hardLand', power: this.lastImpact });
    } else {
      this.events.push({ type: 'land', power: this.lastImpact });
    }
  }

  startCrash(_cause: string): void {
    if (this.crashed) return;
    this.crashed = true;
    this.crashTimer = 2.3;
    this.crashAngVel.set(
      (Math.random() - 0.5) * 9,
      (Math.random() - 0.5) * 7,
      (Math.random() - 0.5) * 9,
    );
    this.vel.multiplyScalar(0.45);
    this.boosting = false;
    this.activeTrickName = '';
    this.lastTrick = null;
    this.events.push({ type: 'crash' });
  }

  private updateCrash(dt: number): void {
    this.crashTimer -= dt;
    // tumbling: strong friction, random tumble spin, glued to terrain
    this.vel.y += GRAVITY * dt;
    this.pos.addScaledVector(this.vel, dt);
    const gy = this.sampler.heightAt(this.pos.x, this.pos.z) + RIDE_CLEARANCE * 0.55;
    if (this.pos.y < gy) {
      this.pos.y = gy;
      this.vel.y = Math.abs(this.vel.y) > 2 ? Math.abs(this.vel.y) * 0.3 : 0;
    }
    const sp = this.vel.length();
    if (sp > 0.05) this.vel.addScaledVector(this.vel.clone().normalize(), -Math.min(sp, 7 * dt));
    this.yaw += this.crashAngVel.y * dt;
    this.pitch += this.crashAngVel.x * dt * Math.min(1, sp * 0.4);
    this.roll += this.crashAngVel.z * dt * Math.min(1, sp * 0.4);
    this.syncQuaternion();

    if (this.crashTimer <= 0) {
      this.crashed = false;
      this.pitch = 0; this.roll = 0;
      const fwd = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      this.vel.copy(fwd).multiplyScalar(Math.min(sp, 6)).setY(0);
      this.pos.y = this.sampler.heightAt(this.pos.x, this.pos.z) + RIDE_CLEARANCE;
      this.syncQuaternion();
      this.recoverGrace = 1.2;
      this.events.push({ type: 'recover' });
    }
  }

  /** current named-trick animation phase 0..1, or -1 */
  getTrickPhase(out: { pose: TrickPose | null }): number {
    out.pose = this.trickT >= 0 ? this.lastTrick : null;
    if (out.pose) return this.trickT / out.pose.duration;
    return -1;
  }

  /** reset per-run scoring aggregates */
  bankScoreReset(): void {
    this.runTrickTotal = 0;
    this.biggestAirHeight = 0;
    this.biggestAirRecord = [];
    this.bankedScore = 0;
  }

  /** slow-mo gate: only the first big float of an air earns the cinematic */
  biggestAirPending(): boolean {
    return this.airTime < 1.4;
  }
}
