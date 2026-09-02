// Terrain rendering: a geometry clipmap (nested rings, each half the extent of
// the next-coarser level, snapped to its own lattice) plus the shared height
// sampler every other system uses. Skirts hide T-junction cracks between
// levels; stepped NPR fog hides the horizon transition entirely.
import * as THREE from 'three';
import { WORLD_SIZE, GRID_N, CELL, HALF, WorldData } from './heightfield';

const N1 = GRID_N + 1;

export class HeightSampler {
  constructor(public wd: WorldData) {}

  heightAt(x: number, z: number): number {
    const gx = ((x + HALF) / WORLD_SIZE) * GRID_N;
    const gz = ((z + HALF) / WORLD_SIZE) * GRID_N;
    const i = Math.max(0, Math.min(GRID_N - 1, Math.floor(gx)));
    const j = Math.max(0, Math.min(GRID_N - 1, Math.floor(gz)));
    const fx = Math.max(0, Math.min(1, gx - i));
    const fz = Math.max(0, Math.min(1, gz - j));
    const h = this.wd.h;
    const a = h[j * N1 + i], b = h[j * N1 + i + 1];
    const c = h[(j + 1) * N1 + i], d = h[(j + 1) * N1 + i + 1];
    return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
  }

  normalAt(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    const e = CELL;
    const hl = this.heightAt(x - e, z), hr = this.heightAt(x + e, z);
    const hd = this.heightAt(x, z - e), hu = this.heightAt(x, z + e);
    return out.set(hl - hr, 2 * e, hd - hu).normalize();
  }

  zoneAt(x: number, z: number): number {
    const gx = ((x + HALF) / WORLD_SIZE) * GRID_N;
    const gz = ((z + HALF) / WORLD_SIZE) * GRID_N;
    const i = Math.max(0, Math.min(GRID_N, Math.round(gx)));
    const j = Math.max(0, Math.min(GRID_N, Math.round(gz)));
    return this.wd.zone[j * N1 + i];
  }

  trailAt(x: number, z: number): number {
    const gx = ((x + HALF) / WORLD_SIZE) * GRID_N;
    const gz = ((z + HALF) / WORLD_SIZE) * GRID_N;
    const i = Math.max(0, Math.min(GRID_N, Math.round(gx)));
    const j = Math.max(0, Math.min(GRID_N, Math.round(gz)));
    return this.wd.trail[j * N1 + i];
  }

  aoAt(x: number, z: number): number {
    const gx = ((x + HALF) / WORLD_SIZE) * GRID_N;
    const gz = ((z + HALF) / WORLD_SIZE) * GRID_N;
    const i = Math.max(0, Math.min(GRID_N, Math.round(gx)));
    const j = Math.max(0, Math.min(GRID_N, Math.round(gz)));
    return this.wd.ao[j * N1 + i];
  }
}

// ---------------------------------------------------------------------------
// Clipmap
// ---------------------------------------------------------------------------
const LEVELS = 7;   // finest extent = CELL*48 ≈ 178 m … coarsest ≈ 11.4 km
const SEGS = 48;

interface Level {
  mesh: THREE.Mesh;
  geo: THREE.BufferGeometry;
  step: number;        // world metres per vertex
  extentHalf: number;  // world metres from centre to outer edge
  hasHole: boolean;
  snapX: number;
  snapZ: number;
  skirtPairs: Array<[number, number]>;
  skirtDrop: number;
}

export class TerrainClipmap {
  group = new THREE.Group();
  private levels: Level[] = [];

  constructor(private sampler: HeightSampler, material: THREE.Material) {
    for (let l = 0; l < LEVELS; l++) {
      this.levels.push(this.buildLevel(l, material));
    }
    // Coarser first for correct early-z
    for (let l = LEVELS - 1; l >= 0; l--) this.group.add(this.levels[l].mesh);
  }

  private buildLevel(l: number, material: THREE.Material): Level {
    const step = CELL * Math.pow(2, l);
    const extentHalf = step * SEGS / 2;
    const holeHalf = l === 0 ? 0 : extentHalf / 2; // finer level covers centre
    const n = SEGS;

    const positions: number[] = [];
    const zones: number[] = [];
    const aos: number[] = [];
    const indices: number[] = [];
    const vertIndex = new Int32Array((n + 1) * (n + 1)).fill(-1);

    const pushVert = (iu: number, ju: number): number => {
      // unit coords -1..1
      const key = ju * (n + 1) + iu;
      if (vertIndex[key] >= 0) return vertIndex[key];
      const vi = positions.length / 3;
      positions.push(-1 + (2 * iu) / n, 0, -1 + (2 * ju) / n);
      zones.push(0); aos.push(0);
      vertIndex[key] = vi;
      return vi;
    };

    const inHole = (iu: number, ju: number) => {
      if (!holeHalf) return false;
      const x = -1 + (2 * iu) / n, z = -1 + (2 * ju) / n;
      return Math.abs(x) < 0.5001 && Math.abs(z) < 0.5001;
    };

    for (let ju = 0; ju < n; ju++) {
      for (let iu = 0; iu < n; iu++) {
        if (inHole(iu, ju) && inHole(iu + 1, ju) && inHole(iu, ju + 1) && inHole(iu + 1, ju + 1)) continue;
        const a = pushVert(iu, ju), b = pushVert(iu + 1, ju);
        const c = pushVert(iu, ju + 1), d = pushVert(iu + 1, ju + 1);
        indices.push(a, c, b, b, c, d);
      }
    }

    // ---- skirt: duplicate the hole boundary pushed down --------------------
    const skirtPairs: Array<[number, number]> = [];
    const skirtDrop = Math.max(45, step * 1.6);
    if (holeHalf > 0) {
      const lo = Math.floor(n * 0.25), hi = Math.ceil(n * 0.75);
      const edge = (iu: number, ju: number) => {
        const topIdx = pushVert(iu, ju);
        const botVi = positions.length / 3;
        positions.push(positions[topIdx * 3], 0, positions[topIdx * 3 + 2]);
        zones.push(0); aos.push(0);
        skirtPairs.push([topIdx, botVi]);
        return { topIdx, botVi };
      };
      for (let iu = lo; iu < hi; iu++) {
        const t1 = edge(iu, lo), t2 = edge(iu + 1, lo);
        indices.push(t1.topIdx, t1.botVi, t2.topIdx, t2.topIdx, t1.botVi, t2.botVi);
        const b1 = edge(iu, hi), b2 = edge(iu + 1, hi);
        indices.push(b1.topIdx, b2.topIdx, b1.botVi, b2.topIdx, b2.botVi, b1.botVi);
      }
      for (let ju = lo; ju < hi; ju++) {
        const l1 = edge(lo, ju), l2 = edge(lo, ju + 1);
        indices.push(l1.topIdx, l1.botVi, l2.topIdx, l2.topIdx, l1.botVi, l2.botVi);
        const r1 = edge(hi, ju), r2 = edge(hi, ju + 1);
        indices.push(r1.topIdx, r2.topIdx, r1.botVi, r1.botVi, r2.botVi, r2.botVi);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('aZone', new THREE.Float32BufferAttribute(zones, 1));
    geo.setAttribute('aAO', new THREE.Float32BufferAttribute(aos, 1));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(positions.length), 3));
    geo.setIndex(indices);
    // normals are written analytically from the heightfield on every rebuild,
    // so shading is seamless across clipmap levels (no computeVertexNormals).

    const mesh = new THREE.Mesh(geo, material);
    mesh.scale.set(extentHalf, 1, extentHalf);
    mesh.frustumCulled = true;
    // Bounding sphere must cover the whole ring regardless of snap offset
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 300, 0), extentHalf * 1.6);

    const lvl: Level = { mesh, geo, step, extentHalf, hasHole: holeHalf > 0, snapX: NaN, snapZ: NaN, skirtPairs, skirtDrop };
    return lvl;
  }

  /** Rebuild heights for any level whose snap window moved. Cheap (<2k verts). */
  update(px: number, pz: number): void {
    for (const lvl of this.levels) {
      const sx = Math.round(px / lvl.step) * lvl.step;
      const sz = Math.round(pz / lvl.step) * lvl.step;
      if (sx === lvl.snapX && sz === lvl.snapZ) continue;
      lvl.snapX = sx; lvl.snapZ = sz;
      lvl.mesh.position.set(sx, 0, sz);

      const pos = lvl.geo.getAttribute('position') as THREE.BufferAttribute;
      const zoneAttr = lvl.geo.getAttribute('aZone') as THREE.BufferAttribute;
      const aoAttr = lvl.geo.getAttribute('aAO') as THREE.BufferAttribute;
      const nrmAttr = lvl.geo.getAttribute('normal') as THREE.BufferAttribute;
      const wd = this.sampler.wd;
      const arr = pos.array as Float32Array;
      const n = SEGS;
      const scale = lvl.extentHalf;

      let vi = 0;
      const nv = (n + 1) * (n + 1);
      for (; vi < nv; vi++) {
        const ux = arr[vi * 3], uz = arr[vi * 3 + 2];
        const wx = ux * scale + sx;
        const wz = uz * scale + sz;
        const gy = this.sampleWorld(wx, wz);
        arr[vi * 3 + 1] = gy;
        const gxi = ((wx + HALF) / WORLD_SIZE) * GRID_N;
        const gzi = ((wz + HALF) / WORLD_SIZE) * GRID_N;
        const ii = Math.max(0, Math.min(GRID_N, Math.round(gxi)));
        const jj = Math.max(0, Math.min(GRID_N, Math.round(gzi)));
        const idx = jj * N1 + ii;
        zoneAttr.setX(vi, wd.zone[idx]);
        aoAttr.setX(vi, wd.ao[idx]);
        this.sampler.normalAt(wx, wz, tmpN);
        nrmAttr.setXYZ(vi, tmpN.x, tmpN.y, tmpN.z);
      }
      // hanging skirt verts follow their source vertex, dropped straight down
      for (const [top, bot] of lvl.skirtPairs) {
        arr[bot * 3 + 1] = arr[top * 3 + 1] - lvl.skirtDrop;
        zoneAttr.setX(bot, zoneAttr.getX(top));
        aoAttr.setX(bot, aoAttr.getX(top));
      }
      void nv;
      pos.needsUpdate = true;
      zoneAttr.needsUpdate = true;
      aoAttr.needsUpdate = true;
      nrmAttr.needsUpdate = true;
    }
  }

  private sampleWorld(wx: number, wz: number): number {
    return this.sampler.heightAt(wx, wz);
  }
}

const tmpN = new THREE.Vector3();
