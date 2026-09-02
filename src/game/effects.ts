// Hard-edged cel dust puffs, blob shadows, and the impact-frame vocabulary
// (flash + hitstop) shared with the post pipeline.
import * as THREE from 'three';
import { HeightSampler } from '../world/terrain';
import { makeBlobShadowTexture } from '../render/textures';
import { G } from '../render/toon';

// ---------------------------------------------------------------------------
class Puff {
  mesh: THREE.Mesh;
  vel = new THREE.Vector3();
  life = 0;
  maxLife = 1;
  baseScale = 1;
  active = false;
  constructor(mat: THREE.Material) {
    this.mesh = new THREE.Mesh(PUFF_GEO, mat);
    this.mesh.visible = false;
  }
}

// chunky icosahedron — reads as a drawn blob, never a soft sprite
const PUFF_GEO = new THREE.IcosahedronGeometry(1, 0);

export class DustSystem {
  group = new THREE.Group();
  private pool: Puff[] = [];
  private mats: THREE.MeshBasicMaterial[];

  constructor(scene: THREE.Scene, count = 130) {
    scene.add(this.group);
    this.mats = [
      new THREE.MeshBasicMaterial({ color: 0xcbb08a }), // dirt
      new THREE.MeshBasicMaterial({ color: 0xb9b3a4 }), // rock/scree
      new THREE.MeshBasicMaterial({ color: 0x93a86e }), // grass
      new THREE.MeshBasicMaterial({ color: 0xe8ecf2 }), // snow
    ];
    for (let i = 0; i < count; i++) {
      const p = new Puff(this.mats[0]);
      this.pool.push(p);
      this.group.add(p.mesh);
    }
  }

  spawn(pos: THREE.Vector3, spread: number, scale: number, matIdx: number, upBias = 1): void {
    for (const p of this.pool) {
      if (p.active) continue;
      p.active = true;
      p.life = 0;
      p.maxLife = 0.45 + Math.random() * 0.4;
      p.baseScale = scale * (0.7 + Math.random() * 0.6);
      p.mesh.material = this.mats[matIdx] ?? this.mats[0];
      p.mesh.position.copy(pos);
      p.mesh.position.x += (Math.random() - 0.5) * spread;
      p.mesh.position.z += (Math.random() - 0.5) * spread;
      p.vel.set((Math.random() - 0.5) * 2.4, (1.2 + Math.random()) * upBias, (Math.random() - 0.5) * 2.4);
      p.mesh.visible = true;
      p.mesh.scale.setScalar(p.baseScale * 0.3);
      return;
    }
  }

  update(dt: number): void {
    for (const p of this.pool) {
      if (!p.active) continue;
      p.life += dt;
      const t = p.life / p.maxLife;
      if (t >= 1) {
        p.active = false;
        p.mesh.visible = false;
        continue;
      }
      p.mesh.position.addScaledVector(p.vel, dt);
      p.vel.multiplyScalar(1 - 2.2 * dt);
      p.vel.y -= 1.4 * dt;
      // hard-edged growth then instant pop-out
      const s = t < 0.75 ? p.baseScale * (0.3 + t * 1.1) : p.baseScale * (1.12 - (t - 0.75) * 3.2);
      p.mesh.scale.setScalar(Math.max(0.001, s));
      // face the camera-ish for consistent silhouette (cheap billboarding)
      p.mesh.rotation.y += dt * 2;
    }
  }

  /** helper: material index by terrain zone */
  static matForZone(zone: number): number {
    if (zone === 2 || zone === 3) return 1;
    if (zone === 4) return 3;
    if (zone === 0) return 2;
    return 0;
  }
}

// ---------------------------------------------------------------------------
export class BlobShadows {
  private items: Array<{ mesh: THREE.Mesh }> = [];

  constructor(scene: THREE.Scene, count: number) {
    const tex = makeBlobShadowTexture();
    const geo = new THREE.PlaneGeometry(1.7, 2.4);
    for (let i = 0; i < count; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: tex, transparent: true, depthWrite: false,
      });
      const m = new THREE.Mesh(geo, mat);
      m.rotation.x = -Math.PI / 2;
      m.renderOrder = 2;
      scene.add(m);
      this.items.push({ mesh: m });
    }
  }

  update(idx: number, pos: THREE.Vector3, sampler: HeightSampler, airFade: boolean): void {
    const it = this.items[idx];
    if (!it) return;
    const gy = sampler.heightAt(pos.x, pos.z);
    it.mesh.visible = !airFade || (pos.y - gy) < 6;
    it.mesh.position.set(pos.x, gy + 0.08, pos.z);
    const h = Math.min(1, (pos.y - gy) / 5);
    it.mesh.scale.setScalar(1 + h * 0.7);
    (it.mesh.material as THREE.MeshBasicMaterial).opacity = 1 - h * 0.65;
  }
}

// ---------------------------------------------------------------------------
export class ImpactFX {
  flash = 0;
  whiteFlash = 0;
  desat = 0;
  hitstopTimer = 0;

  trigger(power: number, hard: boolean): void {
    const k = Math.min(1, power / 18);
    if (hard) {
      this.flash = 0.85 * k + 0.15;
      this.whiteFlash = 0.28 * k;
      this.desat = 0.8;
      this.hitstopTimer = 0.05 + k * 0.05;
    } else {
      this.flash = 0.32 * k;
      this.whiteFlash = 0.06 * k;
      this.desat = 0.25;
      this.hitstopTimer = 0.02;
    }
  }

  update(dt: number): void {
    // decays over ~2 frames of flash energy
    this.flash *= Math.max(0, 1 - dt * 14);
    this.whiteFlash *= Math.max(0, 1 - dt * 16);
    this.desat *= Math.max(0, 1 - dt * 10);
    if (this.hitstopTimer > 0) this.hitstopTimer -= dt;
  }
}
