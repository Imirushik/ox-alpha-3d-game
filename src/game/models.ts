// Code-built BMX/DH bike. Origin sits at the bottom bracket, chassis-local
// forward is +Z. Exposes the moving parts the physics + rig need to drive:
// fork, bars, both wheels, crank, and suspension compression points.
import * as THREE from 'three';
import { createToonMaterial } from '../render/toon';
import { addOutline } from '../render/outlines';

export interface BikeModel {
  group: THREE.Group;
  frame: THREE.Group;       // spins for tailwhip
  forkGroup: THREE.Group;   // steers + compresses
  barGroup: THREE.Group;
  wheelFront: THREE.Group;
  wheelRear: THREE.Group;
  crank: THREE.Group;
  forkTravelAnchor: THREE.Object3D; // front axle holder, translated by suspension
  swingarm: THREE.Group;
  shockSpring: THREE.Mesh;
}

export interface BikeColors {
  frame: number;
  accents: number;
  helmet: number;
  kit: number;
}

function tube(a: [number, number, number], b: [number, number, number], r: number, mat: THREE.Material): THREE.Mesh {
  const va = new THREE.Vector3(...a), vb = new THREE.Vector3(...b);
  const len = va.distanceTo(vb);
  const geo = new THREE.CylinderGeometry(r, r, len, 7);
  const m = new THREE.Mesh(geo, mat);
  m.position.copy(va).add(vb).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), vb.clone().sub(va).normalize());
  return m;
}

function buildWheel(r: number, mat: THREE.Material, spokeMat: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const tyre = new THREE.Mesh(new THREE.TorusGeometry(r, 0.058, 8, 20), mat);
  tyre.rotation.y = Math.PI / 2;
  g.add(tyre);
  addOutline(g, tyre.geometry, { thickness: 0.012 });
  const rim = new THREE.Mesh(new THREE.TorusGeometry(r - 0.075, 0.02, 6, 16), spokeMat);
  rim.rotation.y = Math.PI / 2;
  g.add(rim);
  for (let i = 0; i < 3; i++) {
    const sp = new THREE.Mesh(new THREE.BoxGeometry(0.012, (r - 0.08) * 2, 0.012), spokeMat);
    sp.rotation.x = (i / 3) * Math.PI;
    g.add(sp);
  }
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.1, 8), spokeMat);
  hub.rotation.z = Math.PI / 2;
  g.add(hub);
  return g;
}

export function buildBike(colors: BikeColors): BikeModel {
  const group = new THREE.Group();
  const frame = new THREE.Group();
  group.add(frame);

  const frameMat = createToonMaterial({
    color: colors.frame,
    shadowTint: 0x5c5a86,
    specColor: 0xfff2d8,
    specThresh: 0.965,
    specPower: 40,
    rimColor: 0xffe4bb,
    rimStrength: 0.22,
    hatchOpacity: 0.12,
  });
  const darkMat = createToonMaterial({ color: 0x33302e, shadowTint: 0x4a4870, hatchOpacity: 0.14 });
  const accentMat = createToonMaterial({ color: colors.accents, shadowTint: 0x6a5a90 });
  const tyreMat = createToonMaterial({ color: 0x37322f, shadowTint: 0x504d70, hatchOpacity: 0.1 });
  const metalMat = createToonMaterial({ color: 0xcfc8bd, shadowTint: 0x8b87a8 });

  const WR = 0.34;

  // ---- wheels ----
  const wheelRear = buildWheel(WR, tyreMat, metalMat);
  wheelRear.position.set(0, WR, -0.58);
  const wheelFrontHolder = new THREE.Object3D(); // moved by suspension travel
  wheelFrontHolder.position.set(0, WR, 0.62);
  const wheelFront = buildWheel(WR, tyreMat, metalMat);
  wheelFrontHolder.add(wheelFront);
  frame.add(wheelRear);

  // ---- swingarm ----
  const swingarm = new THREE.Group();
  swingarm.add(tube([0, 0.06, 0], [0, WR, -0.58], 0.032, darkMat));
  swingarm.add(tube([0.09, 0.02, -0.05], [0.09, WR - 0.02, -0.55], 0.024, darkMat));
  swingarm.add(tube([-0.09, 0.02, -0.05], [-0.09, WR - 0.02, -0.55], 0.024, darkMat));
  frame.add(swingarm);
  swingarm.add(wheelRear); // rear wheel rides on the swingarm
  wheelRear.position.set(0, WR, -0.58);

  // ---- main triangle ----
  const bb: [number, number, number] = [0, 0.06, 0];
  const headTop: [number, number, number] = [0, 0.62, 0.5];
  const headBottom: [number, number, number] = [0, 0.34, 0.56];
  const seatTop: [number, number, number] = [0, 0.66, -0.28];
  frame.add(tube(bb, headBottom, 0.042, frameMat));
  frame.add(tube(headTop, seatTop, 0.04, frameMat));
  frame.add(tube(seatTop, bb, 0.038, frameMat));
  frame.add(tube(headTop, headBottom, 0.05, frameMat)); // head tube
  frame.add(tube(headBottom, [0, 0.28, -0.18], 0.03, frameMat));
  frame.add(tube([0, 0.28, -0.18], bb, 0.028, accentMat));
  // top tube outline pass
  const hullTargets = [
    tube(bb, headBottom, 0.042, frameMat),
    tube(headTop, seatTop, 0.04, frameMat),
  ];
  for (const t of hullTargets) addOutline(frame, t.geometry, { thickness: 0.011 });

  // saddle
  const saddle = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.05, 0.24), darkMat);
  saddle.position.set(0, 0.71, -0.3);
  saddle.rotation.x = -0.08;
  frame.add(saddle);

  // ---- fork assembly ----
  const forkGroup = new THREE.Group();   // pivots for steering
  forkGroup.position.set(0, 0.5, 0.52);
  forkGroup.rotation.x = 0.18;           // rake
  const forkTravelAnchor = new THREE.Object3D();
  forkTravelAnchor.position.set(0, -(WR + 0.5 - 0.06) + 0.12, 0.1); // axle rest offset below pivot
  forkGroup.add(forkTravelAnchor);
  // stanchions (upper, fixed) + lowers (move with anchor)
  const stanL = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.34, 7), metalMat);
  stanL.position.set(0.075, -0.2, 0.05);
  const stanR = stanL.clone();
  stanR.position.x = -0.075;
  forkGroup.add(stanL, stanR);
  for (const sx of [0.075, -0.075]) {
    const lower = tube([sx, -0.36, 0.05], [sx, -0.76, 0.09], 0.03, accentMat);
    forkTravelAnchor.add(lower);
  }
  // axle plate connects anchor to wheel visually
  forkTravelAnchor.add(tube([0.075, -0.74, 0.09], [-0.075, -0.74, 0.09], 0.025, darkMat));
  wheelFront.position.set(0, -0.74, 0.09);
  forkTravelAnchor.add(wheelFront);
  frame.add(forkGroup);

  // ---- bars ----
  const barGroup = new THREE.Group();
  barGroup.position.set(0, 0.16, 0.02);
  const stem = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.12), darkMat);
  barGroup.add(stem);
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.6, 7), darkMat);
  bar.rotation.z = Math.PI / 2;
  barGroup.add(bar);
  const gripGeo = new THREE.CylinderGeometry(0.027, 0.027, 0.11, 7);
  const gripL = new THREE.Mesh(gripGeo, accentMat);
  gripL.rotation.z = Math.PI / 2;
  gripL.position.set(-0.26, 0, 0);
  const gripR = gripL.clone();
  gripR.position.x = 0.26;
  barGroup.add(gripL, gripR);
  forkGroup.add(barGroup);

  // ---- crank + pedals ----
  const crank = new THREE.Group();
  crank.position.set(0, 0.06, 0);
  const armGeo = new THREE.BoxGeometry(0.03, 0.17, 0.03);
  const armL = new THREE.Mesh(armGeo, darkMat);
  armL.position.set(-0.08, -0.08, 0);
  const armR = new THREE.Mesh(armGeo, darkMat);
  armR.position.set(0.08, -0.08, 0);
  const pedalGeo = new THREE.BoxGeometry(0.1, 0.02, 0.09);
  const pedalMat = createToonMaterial({ color: colors.kit, shadowTint: 0x5c5a86 });
  const pedL = new THREE.Mesh(pedalGeo, pedalMat);
  pedL.position.set(-0.13, -0.165, 0);
  const pedR = new THREE.Mesh(pedalGeo, pedalMat);
  pedR.position.set(0.13, -0.165, 0);
  crank.add(armL, armR, pedL, pedR);
  const chainring = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.012, 6, 14), metalMat);
  chainring.rotation.y = Math.PI / 2;
  crank.add(chainring);
  frame.add(crank);

  // rear shock visual (scales with compression)
  const shockSpring = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.16, 7), accentMat);
  shockSpring.position.set(0, 0.32, -0.1);
  shockSpring.rotation.x = 0.7;
  frame.add(shockSpring);

  return {
    group, frame, forkGroup, barGroup,
    wheelFront, wheelRear, crank,
    forkTravelAnchor, swingarm, shockSpring,
  };
}
