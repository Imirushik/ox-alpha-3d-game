// Spring-damped chase camera with the full anime racing grammar: FOV kick
// with speed, screenshake scaled to landing force, automatic swing-around on
// big air, corner-whip look-ahead, and a cinematic orbit used for replays.
import * as THREE from 'three';

export interface CamTargetInfo {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  yaw: number;
  speed01: number;      // 0..1 normalised velocity
  boosting: boolean;
  airTime: number;
  bigAir: boolean;
  lookAhead: THREE.Vector3; // point down the track to lean the gaze into corners
}

export class ChaseCam {
  camera: THREE.PerspectiveCamera;
  heightSampler: { heightAt(x: number, z: number): number } | null = null;
  private pos = new THREE.Vector3();
  private look = new THREE.Vector3();
  private shakeAmt = 0;
  private fov = 66;
  private orbitAng = 0;
  mode: 'chase' | 'orbit' | 'finish' = 'chase';
  orbitCenter = new THREE.Vector3();
  orbitSpeed = 0.5;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(66, aspect, 0.1, 7000);
  }

  snapBehind(info: CamTargetInfo): void {
    const back = new THREE.Vector3(Math.sin(info.yaw), 0, Math.cos(info.yaw));
    // start-line framing: higher and further back, riders against the sky
    this.pos.copy(info.pos).addScaledVector(back, -11).add(new THREE.Vector3(0, 5.5, 0));
    this.look.copy(info.pos).add(new THREE.Vector3(0, 1.2, 0));
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.look);
  }

  /** keep the arm out of terrain: sweep from the bike toward the camera */
  private collide(info: CamTargetInfo): void {
    if (!this.heightSampler) return;
    const from = tmpV4.copy(info.pos).add(new THREE.Vector3(0, 1.2, 0));
    const to = this.pos;
    const steps = 10;
    let cut = 1;
    for (let i = 2; i <= steps; i++) {
      const t = i / steps;
      const x = from.x + (to.x - from.x) * t;
      const y = from.y + (to.y - from.y) * t;
      const z = from.z + (to.z - from.z) * t;
      if (this.heightSampler.heightAt(x, z) + 0.7 > y) {
        cut = Math.max(0.25, (i - 1) / steps);
        break;
      }
    }
    if (cut < 1) {
      to.x = from.x + (to.x - from.x) * cut;
      to.y = Math.max(from.y + (to.y - from.y) * cut, info.pos.y + 1.6);
      to.z = from.z + (to.z - from.z) * cut;
    }
  }

  shake(a: number): void { this.shakeAmt = Math.min(0.6, this.shakeAmt + a); }

  update(dt: number, info: CamTargetInfo, slowmoActive: boolean): void {
    if (this.mode === 'orbit') {
      this.orbitAng += dt * this.orbitSpeed;
      const r = 9;
      this.camera.position.set(
        this.orbitCenter.x + Math.sin(this.orbitAng) * r,
        this.orbitCenter.y + 2.4,
        this.orbitCenter.z + Math.cos(this.orbitAng) * r,
      );
      this.camera.lookAt(this.orbitCenter.x, this.orbitCenter.y + 0.6, this.orbitCenter.z);
      return;
    }

    // ---- desired rig position -------------------------------------------------
    const back = new THREE.Vector3(Math.sin(info.yaw), 0, Math.cos(info.yaw));
    const dist = 7.2 + info.speed01 * 2.8;
    const height = 3.1 + info.speed01 * 0.8;

    let desX = info.pos.x - back.x * dist;
    let desZ = info.pos.z - back.z * dist;
    let desY = info.pos.y + height;

    if (info.bigAir && info.airTime > 0.25) {
      // slow swing-around during big air: drift the rig toward a side angle
      const side = new THREE.Vector3(back.z, 0, -back.x);
      const k = Math.min(1, (info.airTime - 0.25) * 1.2);
      desX += side.x * 3.2 * k + back.x * 2.4 * k;
      desZ += side.z * 3.2 * k + back.z * 2.4 * k;
      desY += 1.2 * k;
    }

    // spring damping — snappier at speed so corners "whip"
    const stiff = 5.2 + info.speed01 * 3.4;
    this.pos.x += (desX - this.pos.x) * Math.min(1, stiff * dt);
    this.pos.y += (desY - this.pos.y) * Math.min(1, (stiff * 0.8) * dt);
    this.pos.z += (desZ - this.pos.z) * Math.min(1, stiff * dt);

    // keep out of terrain — hard clamp against the heightfield
    if (this.heightSampler) {
      const groundHere = this.heightSampler.heightAt(this.pos.x, this.pos.z);
      if (this.pos.y < groundHere + 2.0) this.pos.y = groundHere + 2.0;
    }
    if (this.pos.y < info.pos.y + 1.0) this.pos.y = info.pos.y + 1.0;
    this.collide(info);

    // ---- gaze -----------------------------------------------------------------
    const lead = tmpV.copy(info.vel).multiplyScalar(0.28);
    const gaze = tmpV2.copy(info.pos).add(lead).add(tmpV3.set(0, 1.15, 0));
    // blend toward the corner preview point
    gaze.lerp(info.lookAhead, 0.22);
    this.look.lerp(gaze, Math.min(1, dt * 9));

    // ---- shake -----------------------------------------------------------------
    this.shakeAmt *= Math.max(0, 1 - 7 * dt);
    const sh = this.shakeAmt * this.shakeAmt;
    this.camera.position.set(
      this.pos.x + (Math.random() - 0.5) * sh,
      this.pos.y + (Math.random() - 0.5) * sh,
      this.pos.z + (Math.random() - 0.5) * sh,
    );
    this.camera.lookAt(this.look);

    // roll slightly into corners — subtle but sells the whip
    this.camera.rotateZ(-info.speed01 * 0.03 * Math.sign(info.vel.dot(tmpV.set(Math.cos(info.yaw), 0, -Math.sin(info.yaw)))) * 0);

    // ---- FOV kick ---------------------------------------------------------------
    const targetFov = 64 + info.speed01 * 14 + (info.boosting ? 9 : 0) + (slowmoActive ? -6 : 0);
    this.fov += (targetFov - this.fov) * Math.min(1, dt * 4);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }
}

const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpV3 = new THREE.Vector3();
const tmpV4 = new THREE.Vector3();
