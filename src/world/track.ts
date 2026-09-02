// The course: spline helpers, the dirt ribbon mesh with hard-edged trail
// banding, start/checkpoint/finish gates, and progress-projection utilities
// used by the race logic, AI, and HUD.
import * as THREE from 'three';
import { WorldData } from './heightfield';
import { HeightSampler } from './terrain';
import { G } from '../render/toon';
import { addOutline } from '../render/outlines';

export interface TrackSample {
  p: THREE.Vector3;
  t: THREE.Vector3; // unit tangent (xz-normalised, y from grade)
  s: number;
}

export class Track {
  samples: TrackSample[] = [];
  length: number;
  curve: THREE.CatmullRomCurve3;

  constructor(public wd: WorldData, private sampler: HeightSampler) {
    const pts = wd.course.map((c) => new THREE.Vector3(c.x, c.y, c.z));
    this.curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.5);
    // dense uniform resample for fast queries (~3 m)
    const n = Math.ceil(wd.courseLength / 3);
    let sPrev = 0;
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      const p = this.curve.getPoint(u);
      const t = this.curve.getTangent(u);
      t.y *= 0.35;
      t.normalize();
      const s = i === 0 ? 0 : sPrev + p.distanceTo(this.samples[i - 1].p);
      sPrev = s;
      this.samples.push({ p, t, s });
    }
    this.length = sPrev;
  }

  sampleIndexAtS(s: number): number {
    // uniform-ish spacing -> direct index estimate, then correct locally
    const est = Math.round((s / this.length) * (this.samples.length - 1));
    let i = Math.max(0, Math.min(this.samples.length - 1, est));
    while (i > 0 && this.samples[i].s > s) i--;
    while (i < this.samples.length - 1 && this.samples[i + 1].s < s) i++;
    return i;
  }

  posAtS(s: number, out: THREE.Vector3): THREE.Vector3 {
    const i = this.sampleIndexAtS(Math.max(0, Math.min(this.length, s)));
    const a = this.samples[i];
    const b = this.samples[Math.min(this.samples.length - 1, i + 1)];
    const f = b.s > a.s ? (s - a.s) / (b.s - a.s) : 0;
    return out.copy(a.p).lerp(b.p, Math.max(0, Math.min(1, f)));
  }

  tangentAtS(s: number, out: THREE.Vector3): THREE.Vector3 {
    const i = this.sampleIndexAtS(Math.max(0, Math.min(this.length, s)));
    return out.copy(this.samples[i].t);
  }

  /** nearest sample index near a world position; `hint` limits the search.
   * The hinted search is forward-biased: on switchbacks the legs sit close in
   * space, and an unbiased nearest-point search jumps between them. */
  project(p: THREE.Vector3, hint = -1): number {
    const n = this.samples.length;
    let best = 0, bd = Infinity;
    if (hint >= 0) {
      const lo = Math.max(0, hint - 12), hi = Math.min(n - 1, hint + 70);
      for (let i = lo; i <= hi; i++) {
        const d = p.distanceToSquared(this.samples[i].p);
        if (d < bd) { bd = d; best = i; }
      }
      return best;
    }
    for (let i = 0; i < n; i += 2) {
      const d = p.distanceToSquared(this.samples[i].p);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  /** signed lateral offset from track centre at projected index */
  lateralOffset(p: THREE.Vector3, idx: number): number {
    const sm = this.samples[idx];
    const dx = p.x - sm.p.x, dz = p.z - sm.p.z;
    return dx * -sm.t.z + dz * sm.t.x; // right-positive
  }

  /** upcoming curvature magnitude for HUD corner hints + AI braking */
  curvatureAhead(idx: number, lookMeters = 60): number {
    const iEnd = Math.min(this.samples.length - 1, idx + Math.ceil(lookMeters / 3));
    let sum = 0;
    let prevAng = Math.atan2(this.samples[idx].t.z, this.samples[idx].t.x);
    for (let i = idx + 1; i <= iEnd; i++) {
      const ang = Math.atan2(this.samples[i].t.z, this.samples[i].t.x);
      let da = ang - prevAng;
      while (da > Math.PI) da -= Math.PI * 2;
      while (da < -Math.PI) da += Math.PI * 2;
      sum += da;
      prevAng = ang;
    }
    return sum;
  }

  // ------------------------------------------------------------------------
  buildRibbon(): THREE.Mesh {
    const S = this.samples;
    const halfW = 4.4;
    const pos: number[] = [], uv: number[] = [], idx: number[] = [];
    const nrm = new THREE.Vector3();
    for (let i = 0; i < S.length; i++) {
      const sm = S[i];
      this.sampler.normalAt(sm.p.x, sm.p.z, nrm);
      const rx = -sm.t.z, rz = sm.t.x;
      const yL = this.sampler.heightAt(sm.p.x - rx * halfW, sm.p.z - rz * halfW) + 0.14;
      const yR = this.sampler.heightAt(sm.p.x + rx * halfW, sm.p.z + rz * halfW) + 0.14;
      const yC = sm.p.y + 0.16;
      // slight crown so edges sit lower than centre line
      pos.push(sm.p.x - rx * halfW, yL, sm.p.z - rz * halfW);
      pos.push(sm.p.x + rx * halfW, yR, sm.p.z + rz * halfW);
      uv.push(0, sm.s / 7, 1, sm.s / 7);
      void yC;
      if (i > 0) {
        const a = (i - 1) * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
      void nrm;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();

    const mat = new THREE.ShaderMaterial({
      uniforms: { ...G },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        varying vec3 vWorldPos;
        varying vec3 vNormalW;
        void main() {
          vUv = uv;
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldPos = wp.xyz;
          vNormalW = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        varying vec2 vUv;
        varying vec3 vWorldPos;
        varying vec3 vNormalW;
        ${'__GLOBALS__'}
        float hash12(vec2 p) {
          vec3 p3 = fract(vec3(p.xyx) * 443.897);
          p3 += dot(p3, p3.yzx + 19.19);
          return fract((p3.x + p3.y) * p3.z);
        }
        void main() {
          float across = abs(vUv.x - 0.5) * 2.0; // 0 centre .. 1 edge
          vec3 base = vec3(0.47, 0.32, 0.185);      // dirt
          vec3 worn = vec3(0.60, 0.425, 0.245);     // beaten centre line
          vec3 edge = vec3(0.30, 0.195, 0.11);      // dark trail lip

          // hard cel bands across the trail
          vec3 col = base;
          col = mix(col, worn, step(across, 0.34));
          col = mix(col, edge, step(0.86, across));
          // twin tyre polish lines
          float tyre = max(step(abs(across - 0.52), 0.07), step(abs(across + 0.0), 0.0));
          tyre = max(tyre, step(abs(across - 0.48), 0.07) * 0.0);
          col = mix(col, worn * 1.06, clamp(tyre, 0.0, 1.0));

          // longitudinal wear mottling — large soft patches, not checkerboard
          float wear = hash12(vec2(floor(vUv.y * 0.55), floor(across * 2.0)));
          col *= 0.95 + step(0.6, wear) * 0.09;

          // lighting: ramp the terrain normal through 3 bands
          vec3 N = normalize(vNormalW);
          vec3 L = normalize(uSunDir);
          float ndl = dot(N, L);
          float band = ndl > 0.45 ? 1.0 : (ndl > 0.02 ? 0.62 : 0.4);
          col *= mix(vec3(0.62, 0.60, 0.78), vec3(1.04), band);

          // quantised fog, matching everything else
          float dist = length(cameraPosition - vWorldPos);
          float f = clamp((dist - uFogNear) / (uFogFar - uFogNear), 0.0, 1.0);
          float fb = min(floor(f * uFogBands) / (uFogBands - 1.0), 1.0);
          col = mix(col, uFogColor, fb);
          gl_FragColor = vec4(col, 1.0);
        }
      `.replace('__GLOBALS__', `
        uniform vec3 uSunDir; uniform vec3 uFogColor;
        uniform float uFogNear; uniform float uFogFar; uniform float uFogBands;
      `),
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 0;
    return mesh;
  }

  // ------------------------------------------------------------------------
  buildGates(scene: THREE.Scene): { checkpointS: number[] } {
    const mkPost = (): THREE.BufferGeometry => {
      const g = new THREE.CylinderGeometry(0.28, 0.36, 7.5, 7);
      return g;
    };
    const postGeo = mkPost();

    const gate = (x: number, z: number, label: string, accent: number) => {
      const grp = new THREE.Group();
      // flat pale posts with ink outlines (small on screen, reads clean)
      const pm = new THREE.MeshBasicMaterial({ color: 0xf3ead6 });
      const pl = new THREE.Mesh(postGeo, pm);
      pl.position.set(-5.2, 3.75, 0);
      addOutline(pl, postGeo, { thickness: 0.055 });
      const pr = new THREE.Mesh(postGeo, pm);
      pr.position.set(5.2, 3.75, 0);
      addOutline(pr, postGeo, { thickness: 0.055 });
      grp.add(pl, pr);

      // banner
      const [cv, ctx] = [document.createElement('canvas'), null] as [HTMLCanvasElement, CanvasRenderingContext2D | null];
      cv.width = 512; cv.height = 128;
      const c2 = cv.getContext('2d')!;
      c2.fillStyle = '#' + accent.toString(16).padStart(6, '0');
      c2.fillRect(0, 0, 512, 128);
      c2.fillStyle = '#241c16';
      c2.fillRect(0, 0, 512, 14);
      c2.fillRect(0, 114, 512, 14);
      c2.font = 'italic 900 84px Arial Black, sans-serif';
      c2.textAlign = 'center';
      c2.textBaseline = 'middle';
      c2.fillStyle = '#fdf6e8';
      c2.fillText(label, 256, 68);
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.NoColorSpace;
      const banner = new THREE.Mesh(
        new THREE.PlaneGeometry(11.6, 2.9),
        new THREE.MeshBasicMaterial({ map: tex }),
      );
      banner.position.set(0, 6.4, 0);
      // back face (rotY π alone: text reads correctly from the approach side)
      const bannerBack = new THREE.Mesh(
        new THREE.PlaneGeometry(11.6, 2.9),
        new THREE.MeshBasicMaterial({ map: tex }),
      );
      bannerBack.position.set(0, 6.4, 0);
      bannerBack.rotation.y = Math.PI;
      grp.add(banner, bannerBack);

      grp.position.set(x, this.sampler.heightAt(x, z), z);
      // face along track direction
      const idx = this.project(new THREE.Vector3(x, 0, z));
      const sm = this.samples[Math.min(idx + 1, this.samples.length - 1)];
      grp.rotation.y = Math.atan2(sm.t.x, sm.t.z);
      scene.add(grp);
    };

    const c0 = this.wd.course[0];
    gate(c0.x, c0.z, 'DROP IN', 0xd8542e);
    for (const cs of this.wd.checkpoints) {
      const p = new THREE.Vector3();
      this.posAtS(cs, p);
      gate(p.x, p.z, 'CHECKPOINT', 0x2e8c8c);
    }
    const pe = this.wd.course[this.wd.course.length - 1];
    gate(pe.x, pe.z, 'FINISH', 0xc7a13a);
    return { checkpointS: this.wd.checkpoints };
  }
}

// helper pairing a mesh with its outline shell under one transform
export function buildTrack(wd: WorldData, sampler: HeightSampler): Track {
  return new Track(wd, sampler);
}
