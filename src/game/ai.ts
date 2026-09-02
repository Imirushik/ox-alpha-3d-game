// AI riders: spline lookahead steering with speed control from upcoming
// curvature, jump timing they can genuinely get wrong, per-rider personalities
// (aggressive/crash-prone, clean/fast, erratic), and rubber-band hooks driven
// by the race manager.
import * as THREE from 'three';
import { Bike, BikeInput } from './bike';
import { Track } from '../world/track';

export interface Personality {
  name: string;
  skill: number;        // 0..1 base pace
  aggression: number;   // brake later, take worse lines
  mistakeRate: number;  // mistakes per second expectancy
  lineWobble: number;   // metres of lateral wander
}

export const PERSONALITIES: Personality[] = [
  { name: 'KAJI',   skill: 0.94, aggression: 0.9, mistakeRate: 0.05, lineWobble: 0.8 },
  { name: 'MEI',    skill: 0.97, aggression: 0.35, mistakeRate: 0.02, lineWobble: 0.35 },
  { name: 'ROOK',   skill: 0.88, aggression: 0.55, mistakeRate: 0.11, lineWobble: 1.6 },
];

export class AIController {
  input: BikeInput = AIController.neutral();
  private hintIdx = 0;
  private wobblePhase = Math.random() * 100;
  private mistakeT = 0;
  private mistakeActive = 0;
  private nextMistakeIn = 3 + Math.random() * 6;
  maxSpeedMul = 1;   // rubber band hook, set by Race

  constructor(public bike: Bike, private track: Track, public personality: Personality) {}

  static neutral(): BikeInput {
    return {
      steer: 0, pedal: false, brake: false, crouch: false, hopPressed: false,
      boost: false, manual: false, airPitch: 0, whipTrigger: false, namedTrick: 0,
    };
  }

  update(dt: number): void {
    const bike = this.bike, trk = this.track;

    // ---- stuck recovery: anything slower than a crawl for 3s gets replaced ----
    if (bike.speed < 1.2 && !bike.crashed && trk.samples[this.hintIdx ?? 0] !== undefined) {
      this.stuckT += dt;
      if (this.stuckT > 3) {
        this.stuckT = 0;
        const sm = trk.samples[Math.min(trk.samples.length - 1, this.hintIdx + 2)];
        bike.placeAt(sm.p.x, sm.p.z, Math.atan2(sm.t.x, sm.t.z));
      }
    } else {
      this.stuckT = 0;
    }

    // ---- off-course rescue: gullies and walls can swallow a rider; if they
    // are too far off the line or stalled in one spot, reset to the corridor.
    // The time lost is the punishment; a DNF-stuck AI is not.
    const lat = Math.abs(trk.lateralOffset(bike.pos, this.hintIdx));
    const progressed = bike.pos.distanceToSquared(this.lastPos) > 4; // moved >2m
    if (progressed) { this.lastPos.copy(bike.pos); this.rescueT = 0; }
    else { this.rescueT += dt; }
    if ((lat > 20 || this.rescueT > 5) && !bike.crashed) {
      this.rescueT = 0;
      const sm = trk.samples[Math.min(trk.samples.length - 1, this.hintIdx + 3)];
      bike.placeAt(sm.p.x, sm.p.z, Math.atan2(sm.t.x, sm.t.z));
      bike.vel.addScaledVector(new THREE.Vector3(sm.t.x, 0, sm.t.z), 6);
    }

    this.hintIdx = trk.project(bike.pos, this.hintIdx);
    const sm = trk.samples[this.hintIdx];

    // ---- mistakes ------------------------------------------------------------
    this.nextMistakeIn -= dt * (this.personality.mistakeRate / 0.05);
    if (this.nextMistakeIn <= 0 && this.mistakeActive <= 0) {
      this.mistakeActive = 0.45 + Math.random() * 0.5;
      this.mistakeKind = Math.random() < 0.55 ? 'lateBrake' : 'wideLine';
      this.nextMistakeIn = 8 + Math.random() * 14;
    }
    if (this.mistakeActive > 0) this.mistakeActive -= dt;

    // ---- steering toward a lookahead point -----------------------------------
    const lookDist = 9 + bike.speed * 0.62;
    const targetIdx = trk.sampleIndexAtS(sm.s + lookDist);
    const tp = trk.samples[targetIdx].p;
    const wob = Math.sin(performance.now() * 0.0006 + this.wobblePhase)
      * this.personality.lineWobble * (this.mistakeActive > 0 ? 3.2 : 1);

    const dx = tp.x - bike.pos.x, dz = tp.z - bike.pos.z;
    const desiredYaw = Math.atan2(dx + (-sm.t.z) * 0, dz);
    // add lateral wander offset to the aim point
    const aimYaw = Math.atan2(tp.x - sm.p.x * 0 + wob * -sm.t.z, tp.z - sm.p.z * 0 + wob * sm.t.x);
    void desiredYaw;

    let dyaw = aimYaw - bike.yaw;
    while (dyaw > Math.PI) dyaw -= Math.PI * 2;
    while (dyaw < -Math.PI) dyaw += Math.PI * 2;
    let steer = THREE.MathUtils.clamp(dyaw * 2.4, -1, 1);
    if (bike.onGround === false) steer *= 0.4;

    // ---- speed control from upcoming curvature ---------------------------------
    // curvatureAhead returns total heading change (radians) over the window;
    // convert to per-metre curvature for a proper v = sqrt(aLat / k) limit.
    const lookM = 34 + bike.speed * 2.4;
    const totalAngle = Math.abs(trk.curvatureAhead(this.hintIdx, lookM));
    const k = Math.max(totalAngle / lookM, 1e-4);
    const aLat = 6.5 * (0.5 + this.personality.skill * 0.5);
    const vCorner = Math.sqrt(aLat / k);
    const braking = bike.speed > vCorner * (this.mistakeActive > 0 && this.mistakeKind === 'lateBrake' ? 1.35 : 1.08);
    const nearJump = this.nearJumpTakeoff();

    const pedal = !braking && !nearJump.brakeZone &&
      bike.vel.length() < (bike.surf.maxSpeed * this.maxSpeedMul * (0.86 + this.personality.skill * 0.14));
    const brake = braking && !nearJump.takeoffRun;

    // ---- jump behaviour ---------------------------------------------------------
    let airPitch = 0;
    if (!bike.onGround) {
      // style points for aggressive riders; they can flub the landing too
      airPitch = this.personality.aggression > 0.6 ? -0.25 : 0;
    } else if (nearJump.lip && this.personality.aggression > 0.5) {
      // preload pump at the lip sometimes
      this.input.crouch = true;
    }

    this.input.steer = steer;
    this.input.pedal = pedal;
    this.input.brake = brake;
    this.input.crouch = this.input.crouch && nearJump.lip && this.personality.aggression > 0.5;
    this.input.manual = false;
    this.input.hopPressed = false;
    this.input.boost = false;
    this.input.airPitch = airPitch;
    this.input.whipTrigger = false;
    this.input.namedTrick = 0;
  }

  private mistakeKind: 'lateBrake' | 'wideLine' = 'wideLine';
  private stuckT = 0;
  private rescueT = 0;
  private lastPos = new THREE.Vector3();

  private jumpCacheS = [-1, -1];

  private nearJumpTakeoff(): { lip: boolean; takeoffRun: boolean; brakeZone: boolean } {
    const s = this.track.samples[this.hintIdx].s;
    const res = { lip: false, takeoffRun: false, brakeZone: false };
    for (const j of this.track.wd.jumps) {
      const d = j.s - s;
      if (d > 4 && d < 30) res.brakeZone = false; // never brake INTO a jump zone
      if (d > -2 && d < 6) res.lip = true;
      if (d > 6 && d < 22) res.takeoffRun = true;
    }
    void this.jumpCacheS;
    return res;
  }
}
