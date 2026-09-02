// Procedurally animated rider. There is no baked animation here: joints are
// solved analytically every frame in chassis space. Hands are locked to bar
// grip anchors and feet to pedal anchors by construction (their world
// positions are read back from the animated bike), two-bone IK shapes arms
// and legs, the spine bends into corners, and the head looks where you're
// going. Trick poses are parameterised silhouettes; crashes detach the body
// into a physical tumble.
import * as THREE from 'three';
import { BikeModel } from './models';
import { Bike } from './bike';
import { createHullMaterial } from '../render/outlines';
import { createToonMaterial } from '../render/toon';

const RIDER_OUTLINE = createHullMaterial({ thickness: 0.012 });

const UP = new THREE.Vector3(0, 1, 0);

// limb bone lengths (metres)
const UA = 0.26, FA = 0.26;   // upper arm / forearm
const TH = 0.42, SH = 0.43;   // thigh / shin

function capsuleMesh(r: number, mat: THREE.Material): THREE.Mesh {
  const geo = new THREE.CylinderGeometry(r * 0.8, r, 1, 7);
  const m = new THREE.Mesh(geo, mat);
  return m;
}

/** place a segment mesh between two points */
function setBone(mesh: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3): void {
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  const d = tmpV1.copy(b).sub(a);
  const len = Math.max(d.length(), 0.001);
  mesh.scale.set(1, len, 1);
  d.normalize();
  mesh.quaternion.setFromUnitVectors(UP, d);
}

/** two-bone IK: returns middle joint */
function solveIK(root: THREE.Vector3, target: THREE.Vector3,
                 l1: number, l2: number, pole: THREE.Vector3,
                 outElbow: THREE.Vector3): void {
  const d = tmpV1.copy(target).sub(root);
  let dist = d.length();
  const maxD = l1 + l2 - 0.005;
  if (dist > maxD) { d.multiplyScalar(maxD / dist); dist = maxD; }
  if (dist < 0.02) dist = 0.02;
  d.normalize();
  // law of cosines
  const a1 = Math.acos(Math.max(-1, Math.min(1, (l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist))));
  // pole projected perpendicular to root->target
  const perp = tmpV2.copy(pole).addScaledVector(d, -pole.dot(d));
  if (perp.lengthSq() < 1e-6) perp.set(0, 0, 1).cross(d);
  perp.normalize();
  outElbow.copy(root)
    .addScaledVector(d, Math.cos(a1) * l1)
    .addScaledVector(perp, Math.sin(a1) * l1);
}

const tmpV1 = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpV3 = new THREE.Vector3();

export interface RiderColors { skin: number; kit: number; helmet: number; accent: number; }

export class Rider {
  root = new THREE.Group();     // lives in bike.group (chassis space)
  private torso: THREE.Mesh;
  private head: THREE.Group;
  private armUL: THREE.Mesh; private armLL: THREE.Mesh;
  private armUR: THREE.Mesh; private armLR: THREE.Mesh;
  private legUL: THREE.Mesh; private legLL: THREE.Mesh;
  private legUR: THREE.Mesh; private legLR: THREE.Mesh;

  private gripL = new THREE.Object3D();
  private gripR = new THREE.Object3D();
  private pedalL = new THREE.Object3D();
  private pedalR = new THREE.Object3D();

  // crash state
  crashing = false;
  private crashPos = new THREE.Vector3();
  private crashVel = new THREE.Vector3();
  private crashSpin = new THREE.Vector3();
  private crashQuat = new THREE.Quaternion();
  private flailT = 0;

  // smoothed pose state
  private stand = 0;
  private leanVis = 0;
  private crouchVis = 0;
  private headYaw = 0;
  private headPitch = 0;

  constructor(model: BikeModel, colors: RiderColors, private heightSampler?: unknown) {
    const matSkin = mkMat(colors.skin, 0xb8896e);
    const matKit = mkMat(colors.kit, 0x5c5a86);
    const matAccent = mkMat(colors.accent, 0x6a5a90);
    const matHelmet = mkMat(colors.helmet, 0x77749c);

    // ---- torso ----
    this.torso = capsuleMesh(0.105, matKit);
    this.torso.scale.set(1, 0.44, 0.7);
    this.root.add(this.torso);

    // ---- head: skull + full-face helmet shell + visor ----
    this.head = new THREE.Group();
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.115, 10, 8), matSkin);
    const shell = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 9, 0, Math.PI * 2, 0, Math.PI * 0.62), matHelmet);
    shell.rotation.x = -0.15;
    const jaw = new THREE.Mesh(new THREE.SphereGeometry(0.115, 10, 8, 0, Math.PI * 2, Math.PI * 0.45, Math.PI * 0.35), matHelmet);
    jaw.position.z = 0.03;
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.06, 0.09), mkMat(0x2b3644, 0x505a78));
    visor.position.set(0, 0.01, 0.11);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.24, 0.26), matAccent);
    stripe.position.set(0, 0.06, 0);
    this.head.add(skull, shell, jaw, visor, stripe);
    const headMeshes: THREE.Mesh[] = [];
    this.head.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && o !== visor) headMeshes.push(o as THREE.Mesh);
    });
    for (const m of headMeshes) {
      const outline = new THREE.Mesh(m.geometry, RIDER_OUTLINE);
      outline.scale.setScalar(1.12);
      m.add(outline);
    }
    this.root.add(this.head);

    // ---- limbs ----
    const limbR = 0.048;
    this.armUL = capsuleMesh(limbR, matKit);
    this.armLL = capsuleMesh(limbR * 0.85, matSkin);
    this.armUR = capsuleMesh(limbR, matKit);
    this.armLR = capsuleMesh(limbR * 0.85, matSkin);
    this.legUL = capsuleMesh(0.07, matKit);
    this.legLL = capsuleMesh(0.055, matKit);
    this.legUR = capsuleMesh(0.07, matKit);
    this.legLR = capsuleMesh(0.055, matKit);
    this.root.add(
      this.armUL, this.armLL, this.armUR, this.armLR,
      this.legUL, this.legLL, this.legUR, this.legLR,
    );

    // hands & shoes
    this.handL = new THREE.Mesh(new THREE.SphereGeometry(0.045, 7, 6), matSkin);
    this.handR = this.handL.clone();
    this.shoeL = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.07, 0.2), matAccent);
    this.shoeR = this.shoeL.clone();
    this.root.add(this.handL, this.handR, this.shoeL, this.shoeR);

    // ---- anchors attached to the bike's moving parts ----
    model.barGroup.add(this.gripL, this.gripR);
    this.gripL.position.set(-0.26, 0, 0.02);
    this.gripR.position.set(0.26, 0, 0.02);
    // pedals live under crank arms; attach to the pedal meshes' parent space
    model.crank.add(this.pedalL, this.pedalR);
    this.pedalL.position.set(-0.13, -0.165, 0);
    this.pedalR.position.set(0.13, -0.165, 0);
  }

  private handL: THREE.Mesh;
  private handR: THREE.Mesh;
  private shoeL: THREE.Mesh;
  private shoeR: THREE.Mesh;

  /** Solve the whole rig. Call after bike model visuals are applied. */
  update(bike: Bike, model: BikeModel, dt: number,
         steer: number, trickPhase: { pose: string | null; t: number },
         lookAheadWorld: THREE.Vector3, pedaling: boolean): void {
    if (this.crashing) { this.updateCrashTumble(bike, dt); return; }

    const w2l = this.root.worldToLocal.bind(this.root);
    // ensure root matrices are current before reading anchors back
    model.group.updateMatrixWorld(true);

    // ---- anchor targets straight off the moving bike ----
    const handTL = w2l(tmpV1.setFromMatrixPosition(this.gripL.matrixWorld)).clone();
    const handTR = w2l(tmpV2.setFromMatrixPosition(this.gripR.matrixWorld)).clone();
    const footTL = w2l(tmpV3.setFromMatrixPosition(this.pedalL.matrixWorld)).clone();
    const footTR = w2l(tmpV1.setFromMatrixPosition(this.pedalR.matrixWorld)).clone();

    // ---- posture blending -----------------------------------------------------
    const rough = bike.zone === 2 || bike.zone === 3 || bike.zone === 6; // rock/scree/stream
    const wantStand = (!bike.onGround) || rough || bike.boosting || bike.crouch > 0.25;
    this.stand += ((wantStand ? 1 : 0) - this.stand) * Math.min(1, dt * 6);
    this.leanVis += (bike.roll - this.leanVis) * Math.min(1, dt * 8);
    this.crouchVis += (bike.crouch - this.crouchVis) * Math.min(1, dt * 10);

    const landCompress = Math.max(0, bike.lastImpact > 0 ? Math.min(bike.compR, 1) * 0.5 : 0);
    bike.lastImpact *= 0.9;

    // pelvis position: seat vs pedals stance
    const pelvisSeated = tmpV1.set(0, 0.62, -0.28);
    const pelvisStand = tmpV2.set(0, 0.72, -0.1);
    const pelvis = pelvisSeated.lerp(pelvisStand, this.stand).clone();
    pelvis.y -= this.crouchVis * 0.16 + landCompress * 0.1;
    pelvis.x += this.leanVis * 0.16;
    pelvis.z -= this.crouchVis * 0.05;

    // spine chain: pelvis -> chest -> neck ; bends into the corner
    const bendX = this.leanVis * 0.14;
    const fwdLean = 0.22 + this.crouchVis * 0.28 + this.stand * 0.12;
    const chest = new THREE.Vector3(pelvis.x + bendX, pelvis.y + 0.34, pelvis.z + fwdLean * 0.5);
    const neck = new THREE.Vector3(chest.x + bendX * 0.6, chest.y + 0.16, chest.z + fwdLean * 0.32);

    setBone(this.torso, pelvis, chest);
    this.torso.scale.x = 1.15; this.torso.scale.z = 0.72;

    // ---- head look-at ----------------------------------------------------------
    const lookLocal = w2l(tmpV2.copy(lookAheadWorld));
    const wantYaw = Math.atan2(lookLocal.x - neck.x, lookLocal.z - neck.z);
    const wantPitch = -Math.atan2(lookLocal.y - neck.y, Math.hypot(lookLocal.x - neck.x, lookLocal.z - neck.z));
    // clamp range
    const cy = THREE.MathUtils.clamp(wantYaw, -1.1, 1.1);
    const cp = THREE.MathUtils.clamp(wantPitch, -0.6, 0.7);
    this.headYaw += (cy - this.headYaw) * Math.min(1, dt * 7);
    this.headPitch += (cp - this.headPitch) * Math.min(1, dt * 7);
    this.head.position.copy(neck).add(new THREE.Vector3(0, 0.12, 0.02));
    this.head.quaternion.setFromEuler(new THREE.Euler(this.headPitch * 0.6, this.headYaw, -this.leanVis * 0.4, 'YXZ'));

    // ---- arms: IK from shoulders to grips (never detached) ----------------------
    const shoulderL = new THREE.Vector3(chest.x - 0.16, chest.y + 0.1, chest.z);
    const shoulderR = new THREE.Vector3(chest.x + 0.16, chest.y + 0.1, chest.z);
    const poleArmL = new THREE.Vector3(-0.6, -1, -0.25).normalize();
    const poleArmR = new THREE.Vector3(0.6, -1, -0.25).normalize();
    const elbowL = new THREE.Vector3(), elbowR = new THREE.Vector3();
    solveIK(shoulderL, handTL, UA, FA, poleArmL, elbowL);
    solveIK(shoulderR, handTR, UA, FA, poleArmR, elbowR);
    setBone(this.armUL, shoulderL, elbowL);
    setBone(this.armLL, elbowL, handTL);
    setBone(this.armUR, shoulderR, elbowR);
    setBone(this.armLR, elbowR, handTR);
    this.handL.position.copy(handTL);
    this.handR.position.copy(handTR);

    // ---- legs: trick poses can retarget feet ------------------------------------
    let footGoalL = footTL.clone(), footGoalR = footTR.clone();
    const poleLegL = new THREE.Vector3(-0.25, 0.25, 1).normalize();
    const poleLegR = new THREE.Vector3(0.25, 0.25, 1).normalize();

    if (trickPhase.pose === 'superman') {
      const k = Math.min(1, trickPhase.t * 2.2);
      // body stretches out flat behind the bars, legs trail along the frame
      pelvis.z -= k * 0.34; pelvis.y += k * 0.1;
      chest.z -= k * 0.3; chest.y += k * 0.16;
      setBone(this.torso, pelvis, chest);
      footGoalL.z -= k * 0.5; footGoalL.y += k * 0.05;
      footGoalR.z -= k * 0.5; footGoalR.y += k * 0.05;
    }

    const hipL = new THREE.Vector3(pelvis.x - 0.09, pelvis.y - 0.02, pelvis.z);
    const hipR = new THREE.Vector3(pelvis.x + 0.09, pelvis.y - 0.02, pelvis.z);
    const kneeL = new THREE.Vector3(), kneeR = new THREE.Vector3();
    solveIK(hipL, footGoalL, TH, SH, poleLegL, kneeL);
    solveIK(hipR, footGoalR, TH, SH, poleLegR, kneeR);
    setBone(this.legUL, hipL, kneeL);
    setBone(this.legLL, kneeL, footGoalL);
    setBone(this.legUR, hipR, kneeR);
    setBone(this.legLR, kneeR, footGoalR);
    this.shoeL.position.copy(footGoalL);
    this.shoeR.position.copy(footGoalR);
    // shoes align roughly with the pedals
    this.shoeL.quaternion.setFromEuler(new THREE.Euler(0, this.leanVis * 0.3, 0));
    this.shoeR.quaternion.copy(this.shoeL.quaternion);

    void pedaling;
  }

  // ---------------------------------------------------------------------------
  beginCrash(bike: Bike): void {
    if (this.crashing) return;
    this.crashing = true;
    this.flailT = 0;
    // detach into world space at the bike's current transform
    const wp = new THREE.Vector3();
    const wq = new THREE.Quaternion();
    this.root.getWorldPosition(wp);
    this.root.getWorldQuaternion(wq);
    const parent = this.root.parent!;
    parent.remove(this.root);
    parent.parent!.add(this.root); // scene-level
    this.root.position.copy(wp);
    this.root.quaternion.copy(wq);
    this.crashQuat.copy(wq);
    this.crashPos.copy(wp);
    this.crashVel.copy(bike.vel).multiplyScalar(0.85);
    this.crashVel.y += 3 + Math.random() * 2.5;
    this.crashSpin.set(
      (Math.random() - 0.5) * 12,
      (Math.random() - 0.5) * 8,
      (Math.random() - 0.5) * 12,
    );
  }

  endCrash(): boolean {
    // returns true once the body has settled enough to respawn onto the bike
    return !this.crashing;
  }

  private updateCrashTumble(bike: Bike, dt: number): void {
    this.flailT += dt;
    this.crashVel.y -= 20 * dt;
    this.crashPos.addScaledVector(this.crashVel, dt);
    const sampler = this.heightSampler as { heightAt(x: number, z: number): number } | undefined;
    if (sampler) {
      const gy = sampler.heightAt(this.crashPos.x, this.crashPos.z) + 0.25;
      if (this.crashPos.y < gy) {
        this.crashPos.y = gy;
        this.crashVel.y = Math.abs(this.crashVel.y) > 2.5 ? Math.abs(this.crashVel.y) * 0.32 : 0;
        this.crashVel.multiplyScalar(1 - 2.4 * dt);
        this.crashSpin.multiplyScalar(1 - 3.5 * dt);
      }
    }
    this.root.position.copy(this.crashPos);
    const spinStep = tmpV1.copy(this.crashSpin).multiplyScalar(dt);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(spinStep.x, spinStep.y, spinStep.z));
    this.crashQuat.multiply(q);
    this.root.quaternion.copy(this.crashQuat);

    // limbs flail: jitter every joint around loose tuck targets
    const t = this.flailT;
    const jit = (f: number) => Math.sin(t * 21 + f * 13.7) * 0.14;
    const pelvis = tmpV1.set(0, 0, 0);
    const chest = tmpV2.set(jit(1), 0.3, jit(2));
    setBone(this.torso, pelvis, chest);
    this.head.position.copy(chest).add(new THREE.Vector3(0, 0.16, 0));
    this.head.quaternion.setFromEuler(new THREE.Euler(jit(3), jit(4), jit(5)));
    const shL = new THREE.Vector3(chest.x - 0.16, chest.y, chest.z);
    const shR = new THREE.Vector3(chest.x + 0.16, chest.y, chest.z);
    const eL = new THREE.Vector3(), eR = new THREE.Vector3();
    const hL = new THREE.Vector3(shL.x + jit(6), shL.y - 0.4 + jit(7), shL.z - 0.3);
    const hR = new THREE.Vector3(shR.x + jit(8), shR.y - 0.4 + jit(9), shR.z - 0.3);
    solveIK(shL, hL, UA, FA, tmpV3.set(-0.5, -1, 0), eL);
    solveIK(shR, hR, UA, FA, tmpV3.set(0.5, -1, 0), eR);
    setBone(this.armUL, shL, eL); setBone(this.armLL, eL, hL);
    setBone(this.armUR, shR, eR); setBone(this.armLR, eR, hR);
    this.handL.position.copy(hL); this.handR.position.copy(hR);
    const hpL = new THREE.Vector3(0, 0, 0);
    const knL = new THREE.Vector3(jit(10), 0.35, 0.25);
    const ftL = new THREE.Vector3(jit(11), 0.1, 0.4);
    const knR = new THREE.Vector3(jit(12), 0.35, 0.25);
    const ftR = new THREE.Vector3(jit(13), 0.1, 0.4);
    solveIK(hpL, ftL, TH, SH, tmpV3.set(0, 1, 1), knL);
    solveIK(hpL, ftR, TH, SH, tmpV3.set(0, 1, 1), knR);
    setBone(this.legUL, hpL, knL); setBone(this.legLL, knL, ftL);
    setBone(this.legUR, hpL, knR); setBone(this.legLR, knR, ftR);
    this.shoeL.position.copy(ftL); this.shoeR.position.copy(ftR);

    void bike;
  }

  /** reattach to the bike group */
  reattach(model: BikeModel): void {
    this.crashing = false;
    const scene = this.root.parent!;
    scene.remove(this.root);
    model.group.add(this.root);
    this.root.position.set(0, 0, 0);
    this.root.quaternion.identity();
  }
}

function mkMat(color: number, shadow: number): THREE.Material {
  return createToonMaterial({ color, shadowTint: shadow, hatchOpacity: 0.08 });
}
