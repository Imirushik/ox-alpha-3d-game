// The mountain itself: layered-noise heightmap -> droplet hydraulic erosion ->
// authored course carving -> material zones. Everything downstream (clipmap
// renderer, physics, foliage placement) samples this single source of truth.
import { fbm, ridged, makeWarper } from '../core/noise';

export const WORLD_SIZE = 3800;          // metres, square, centred on origin
export const GRID_N = 1024;              // heightfield cells per side
export const CELL = WORLD_SIZE / GRID_N; // ~3.71 m
export const HALF = WORLD_SIZE / 2;

export const ZONE = {
  GRASS: 0, DIRT: 1, ROCK: 2, SCREE: 3, SNOW: 4, TRAIL: 5, STREAM: 6,
} as const;

export interface CourseSample {
  x: number; y: number; z: number;
  s: number;                  // arc length along the course
  dirX: number; dirZ: number; // unit tangent (xz plane)
}

export interface WorldData {
  h: Float32Array;
  trail: Float32Array;   // trail mask 0..1
  zone: Uint8Array;      // material zone id per grid vertex
  ao: Float32Array;      // concavity darkening 0..1
  hMin: number; hMax: number;
  course: CourseSample[];
  courseLength: number;
  jumps: { s: number; type: 'tabletop' | 'gap' }[];
  checkpoints: number[]; // arc lengths of checkpoint gates
}

const N1 = GRID_N + 1;
const IDX = (i: number, j: number) => j * N1 + i;

function sampleBilinear(arr: Float32Array, gx: number, gz: number): number {
  const i = Math.max(0, Math.min(GRID_N - 1, Math.floor(gx)));
  const j = Math.max(0, Math.min(GRID_N - 1, Math.floor(gz)));
  const fx = Math.max(0, Math.min(1, gx - i));
  const fz = Math.max(0, Math.min(1, gz - j));
  const a = arr[IDX(i, j)], b = arr[IDX(i + 1, j)];
  const c = arr[IDX(i, j + 1)], d = arr[IDX(i + 1, j + 1)];
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}

export function gridToWorldX(i: number): number { return (i / GRID_N) * WORLD_SIZE - HALF; }
export function worldToGrid(x: number): number { return ((x + HALF) / WORLD_SIZE) * GRID_N; }

const yieldFrame = () => new Promise<void>((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------
// Base terrain — one big peak toward -Z, valley floor opening toward +Z.
// ---------------------------------------------------------------------------
function generateBase(h: Float32Array): void {
  const warp = makeWarper(1337);
  const PEAK_X = -350, PEAK_Z = -1350;

  for (let j = 0; j <= GRID_N; j++) {
    const z = (j / GRID_N) * WORLD_SIZE - HALF;
    for (let i = 0; i <= GRID_N; i++) {
      const x = (i / GRID_N) * WORLD_SIZE - HALF;
      const [wx, wz] = warp(x, z, 130);

      const dx = x - PEAK_X, dz = z - PEAK_Z;
      const d = Math.sqrt(dx * dx + dz * dz);
      let m = 1 - d / 2500;
      m = Math.max(0, m);
      const mountain = Math.pow(m, 1.35);

      let v = 110 + mountain * 880;
      v += ridged(wx * 0.00165, wz * 0.00165, 5) * 300 * (0.28 + mountain * 0.85);
      v += fbm(wx * 0.0062, wz * 0.0062, 5) * 95 * (0.35 + mountain * 0.65);
      v += fbm(x * 0.021 + 40, z * 0.021 - 17, 4) * 16;
      h[IDX(i, j)] = v;
    }
  }
}

// ---------------------------------------------------------------------------
// Droplet hydraulic erosion (Sebastian Lague style). Also accumulates a flow
// trace used to tint alluvial fans and gully floors downstream.
// ---------------------------------------------------------------------------
function erode(h: Float32Array, flow: Float32Array, depMap: Float32Array,
               onProgress?: (f: number) => void): void {
  let seedState = 987654321 >>> 0;
  const rand = () => {
    seedState = (Math.imul(seedState, 1664525) + 1013904223) >>> 0;
    return seedState / 4294967296;
  };

  // Precompute erosion brush
  const R = 3;
  const bx: number[] = [], by: number[] = [], bw: number[] = [];
  for (let yy = -R; yy <= R; yy++)
    for (let xx = -R; xx <= R; xx++) {
      const d2 = xx * xx + yy * yy;
      if (d2 > R * R) continue;
      bx.push(xx); by.push(yy); bw.push(1 - Math.sqrt(d2) / (R + 1));
    }

  const inertia = 0.06, capacity = 4.5, minSlope = 0.012;
  const erodeAmt = 0.30, depositAmt = 0.28, evaporate = 0.03, gravity = 10;

  for (let drop = 0; drop < 72000; drop++) {
    if ((drop & 8191) === 0) {
      onProgress?.(drop / 72000);
    }
    let px = 1 + rand() * (GRID_N - 2);
    let py = 1 + rand() * (GRID_N - 2);
    let dx = 0, dy = 0, speed = 1, water = 1, sediment = 0;

    for (let life = 0; life < 34; life++) {
      const ipx = px | 0, ipy = py | 0;
      if (ipx < 1 || ipy < 1 || ipx >= GRID_N - 1 || ipy >= GRID_N - 1) break;
      const fx = px - ipx, fy = py - ipy;
      const i00 = ipy * N1 + ipx;
      const h00 = h[i00], h10 = h[i00 + 1], h01 = h[i00 + N1], h11 = h[i00 + N1 + 1];
      const gx = (h10 - h00) * (1 - fy) + (h11 - h01) * fy;
      const gy = (h01 - h00) * (1 - fx) + (h11 - h10) * fx;
      const hOld = h00 * (1 - fx) * (1 - fy) + h10 * fx * (1 - fy) + h01 * (1 - fx) * fy + h11 * fx * fy;

      dx = dx * inertia - gx * (1 - inertia);
      dy = dy * inertia - gy * (1 - inertia);
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < 1e-6) break;
      dx /= len; dy /= len;
      px += dx; py += dy;

      if (px < 1 || py < 1 || px >= GRID_N - 1 || py >= GRID_N - 1) break;
      const nipx = px | 0, nipy = py | 0;
      const nfx = px - nipx, nfy = py - nipy;
      const ni00 = nipy * N1 + nipx;
      const nh00 = h[ni00], nh10 = h[ni00 + 1], nh01 = h[ni00 + N1], nh11 = h[ni00 + N1 + 1];
      const hNew = nh00 * (1 - nfx) * (1 - nfy) + nh10 * nfx * (1 - nfy) + nh01 * (1 - nfx) * nfy + nh11 * nfx * nfy;
      const dh = hNew - hOld;

      // Caps keep droplets from runaway feedback (pit -> speed -> erosion ->
      // deeper pit). Speed and sediment capacity are both bounded.
      const maxSediment = Math.min(
        Math.max(-dh * speed * water * capacity, minSlope),
        6,
      );
      if (sediment > maxSediment || dh > 0) {
        const deposit = Math.min((dh > 0 ? dh : (sediment - maxSediment)) * depositAmt, sediment);
        sediment -= deposit;
        // bilinear deposit
        h[ni00] += deposit * (1 - nfx) * (1 - nfy);
        h[ni00 + 1] += deposit * nfx * (1 - nfy);
        h[ni00 + N1] += deposit * (1 - nfx) * nfy;
        h[ni00 + N1 + 1] += deposit * nfx * nfy;
        depMap[ni00] += deposit * (1 - nfx) * (1 - nfy);
        depMap[ni00 + 1] += deposit * nfx * (1 - nfy);
        depMap[ni00 + N1] += deposit * (1 - nfx) * nfy;
        depMap[ni00 + N1 + 1] += deposit * nfx * nfy;
      } else {
        const amount = Math.min((maxSediment - sediment) * erodeAmt, -dh * 0.6);
        for (let k = 0; k < bx.length; k++) {
          const bxi = nipx + bx[k], byi = nipy + by[k];
          if (bxi < 0 || byi < 0 || bxi > GRID_N || byi > GRID_N) continue;
          const idx = byi * N1 + bxi;
          const w = bw[k];
          const d = amount * w;
          h[idx] -= d;
          flow[idx] += d;
        }
        sediment += amount;
      }

      speed = Math.min(Math.sqrt(Math.max(0, speed * speed + -dh * gravity)), 14);
      water *= 1 - evaporate;
      if (water < 0.02) break;
    }
  }
  onProgress?.(1);
}

// ---------------------------------------------------------------------------
// Course authoring. Hand-placed control points descending the mountain, then
// profile smoothing so grades stay rideable.
// ---------------------------------------------------------------------------
const COURSE_PTS_2D: [number, number][] = [
  [-250, -1450],                       // summit gate
  [-140, -1330], [-240, -1215],        // A: tight technical rock start
  [-115, -1105],
  [-165, -885], [-265, -560],          // B: fast open scree
  [-180, -245],
  [-330, -40], [-520, 55],             // C: bermed switchbacks at treeline
  [-305, 170], [-565, 290], [-340, 400],
  [-455, 565], [-280, 655], [-430, 765], // D: rock garden
  [-350, 905],                         // E approach
  [-335, 995],                         //   tabletop takeoff/landing
  [-385, 1120],                        //   gap over ravine (trench carved)
  [-360, 1265],
  [-425, 1385], [-300, 1490],          // F: exposed ridge sprint
  [-215, 1590],                        // G: drop into stream bed
  [-70, 1675],
  [90, 1560],                          // exit stream, final sprint
  [230, 1470],                         // finish gate
];

interface Stamp { x: number; z: number; s: number; t01: number; sec: string; curv: number; }

function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/** Resample the 2D control polygon via Catmull-Rom at ~6 m spacing */
function resampleCourse(spacing = 6): Stamp[] {
  const pts = COURSE_PTS_2D;
  const stamps: Stamp[] = [];
  let s = 0;
  for (let seg = 0; seg < pts.length - 1; seg++) {
    const p0 = pts[Math.max(0, seg - 1)], p1 = pts[seg], p2 = pts[seg + 1], p3 = pts[Math.min(pts.length - 1, seg + 2)];
    const approxLen = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const steps = Math.max(2, Math.ceil(approxLen / spacing));
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      const x = catmull(p0[0], p1[0], p2[0], p3[0], t);
      const z = catmull(p0[1], p1[1], p2[1], p3[1], t);
      stamps.push({ x, z, s: 0, t01: 0, sec: sectionFor(seg), curv: 0 });
    }
  }
  stamps.push({ x: pts[pts.length - 1][0], z: pts[pts.length - 1][1], s: 0, t01: 0, sec: 'finish', curv: 0 });
  // arc lengths
  for (let i = 1; i < stamps.length; i++) {
    stamps[i].s = stamps[i - 1].s + Math.hypot(stamps[i].x - stamps[i - 1].x, stamps[i].z - stamps[i - 1].z);
  }
  // curvature (signed, from neighbouring tangents)
  for (let i = 1; i < stamps.length - 1; i++) {
    const ax = stamps[i].x - stamps[i - 1].x, az = stamps[i].z - stamps[i - 1].z;
    const bx = stamps[i + 1].x - stamps[i].x, bz = stamps[i + 1].z - stamps[i].z;
    const cross = ax * bz - az * bx;
    const dot = ax * bx + az * bz;
    stamps[i].curv = Math.atan2(cross, dot);
  }

  // ---- start-line approach: extrapolate the corridor ~36 m behind the gate --
  // so the grid doesn't sit on raw uncarved summit shoulder.
  const prepended: Stamp[] = [];
  const first = stamps[0];
  const second = stamps[1];
  let dx0 = first.x - second.x, dz0 = first.z - second.z;
  const dl0 = Math.hypot(dx0, dz0) || 1;
  dx0 /= dl0; dz0 /= dl0;
  for (let k = 6; k >= 1; k--) {
    prepended.push({
      x: first.x + dx0 * 6 * k,
      z: first.z + dz0 * 6 * k,
      s: -6 * k, t01: 0, sec: 'rockStart', curv: 0,
    });
  }
  const all = [...prepended, ...stamps];
  const total = stamps[stamps.length - 1].s;
  for (const st of all) st.t01 = Math.max(0, st.s) / total;
  return all;
}

function sectionFor(seg: number): string {
  const z = COURSE_PTS_2D[seg][1];
  if (z < -1000) return 'rockStart';
  if (z < -150) return 'scree';
  if (z < 480) return 'switchbacks';
  if (z < 850) return 'rockGarden';
  if (z < 1330) return 'jumps';
  if (z < 1560) return 'ridge';
  return 'stream';
}

/**
 * Smooth the course's height profile: sample raw terrain, then relax so that
 * grades stay below ~22% and the descent is monotone-ish. Returns per-stamp Y.
 */
function buildProfile(stamps: Stamp[], h: Float32Array): Float64Array {
  const n = stamps.length;
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    y[i] = sampleBilinear(h, worldToGrid(stamps[i].x), worldToGrid(stamps[i].z));
  }
  // heavy longitudinal smoothing (window grows with passes)
  for (let pass = 0; pass < 80; pass++) {
    const win = 2 + ((pass / 12) | 0) * 2;
    const tmp = Float64Array.from(y);
    for (let i = 0; i < n; i++) {
      let sum = 0, cnt = 0;
      for (let k = -win; k <= win; k++) {
        const j = Math.max(0, Math.min(n - 1, i + k));
        sum += tmp[j]; cnt++;
      }
      y[i] = sum / cnt;
    }
  }
  // clamp grades: max downhill 24%, allow tiny uphill 2%
  for (let i = 1; i < n; i++) {
    const ds = stamps[i].s - stamps[i - 1].s;
    y[i] = Math.min(y[i], y[i - 1] - ds * 0.02);           // force net descent
    y[i] = Math.max(y[i], y[i - 1] - ds * 0.34);           // cap steepness
    y[i] = Math.min(y[i], y[i - 1] + ds * 0.03);           // discourage uphill
  }
  return y;
}

// ---------------------------------------------------------------------------
// Carving: stamp the smoothed corridor into the heightfield, add authored
// features (berms, tabletop, ravine trench, ridge flanks, stream bed).
// ---------------------------------------------------------------------------
function carveCourse(h: Float32Array, stamps: Stamp[], profile: Float64Array,
                     trail: Float32Array, streamMask: Float32Array,
                     nearField: Float32Array): void {
  const halfW = 5.0;     // full-width dirt corridor half-width (metres)
  const falloffW = 16.0; // blend out to this distance
  const relaxW = 70.0;   // terrain-relaxation reach beyond the corridor

  for (let si = 0; si < stamps.length; si++) {
    const st = stamps[si];
    const cx = worldToGrid(st.x), cz = worldToGrid(st.z);
    const ci = Math.round(cx), cj = Math.round(cz);
    const reach = Math.ceil((halfW + falloffW) / CELL);
    const yHere = profile[si];
    const sec = st.sec;

    // local tangent & normal in grid space
    const pn = stamps[Math.max(0, si - 1)], nx = stamps[Math.min(stamps.length - 1, si + 1)];
    const tx = nx.x - pn.x, tz = nx.z - pn.z;
    const tl = Math.hypot(tx, tz) || 1;
    const ux = tx / tl, uz = tz / tl;         // unit tangent (world)
    const rX = -uz, rZ = ux;                  // unit right-normal

    for (let dj = -reach; dj <= reach; dj++) {
      for (let di = -reach; di <= reach; di++) {
        const gi = ci + di, gj = cj + dj;
        if (gi < 0 || gj < 0 || gi > GRID_N || gj > GRID_N) continue;
        const wx = gridToWorldX(gi) - st.x;
        const wz = gridToWorldX(gj) - st.z;
        const lateral = wx * rX + wz * rZ;
        const along = wx * ux + wz * uz;
        const dist = Math.hypot(lateral, along);
        if (dist > halfW + falloffW) continue;

        // target height: profile + feature shaping
        let target = yHere;
        const alat = Math.abs(lateral);

        // Berms: outside of switchback corners rises like a wall
        if (sec === 'switchbacks' && alat > halfW * 0.4 && alat < halfW * 2.4) {
          const side = Math.sign(lateral * st.curv);
          if (side > 0) target += (alat - halfW * 0.4) * 0.55;
        }
        // Ridge sprint: raise both flanks hard => exposure on both sides
        if (sec === 'ridge' && alat > halfW) {
          target += Math.min(alat - halfW, 16) * 0.75;
        }
        // Stream bed: cut a deeper channel through section G
        if (sec === 'stream') {
          target -= 2.6 * Math.exp(-(alat * alat) / (2.2 * 2.2));
          if (alat < 6.5) streamMask[gj * N1 + gi] = 1;
        }
        // Rock garden: roughen the floor inside the corridor
        if (sec === 'rockGarden' && dist < halfW) {
          target += (fbm(gridToWorldX(gi) * 0.31, gridToWorldX(gj) * 0.31, 3) - 0.5) * 1.5;
        }

        // blend weight: hard inside corridor, feathered falloff
        let w: number;
        if (dist <= halfW) w = 1;
        else {
          const f = (dist - halfW) / falloffW;
          w = 1 - f * f * (3 - 2 * f); // smoothstep down
        }
        const idx = gj * N1 + gi;
        h[idx] = h[idx] * (1 - w) + target * w;
        trail[idx] = Math.max(trail[idx], w);
        // record relaxation weight: zero inside the carved corridor (the carve
        // owns that surface), ramping up across the flank zone. Relaxing the
        // flanks is what tames the summit cliffs without flattening the trail.
        const nw = Math.min(1, Math.max(0,
          (dist - halfW - falloffW) / (relaxW - halfW - falloffW)));
        nearField[idx] = Math.max(nearField[idx], nw);
      }
    }
  }

  // ---- Authored jumps -------------------------------------------------------
  // Tabletop: symmetric gaussian mound across the trail near end of rock garden
  stampFeature(h, stamps, profile, findS(stamps, 1005), 3.4, 11, true);
  // Gap jump: ravine trench perpendicular to the trail
  stampRavine(h, stamps, profile, trail, findS(stamps, 1150));

  // ---- Corridor relaxation ---------------------------------------------------
  // The raw mountain near the summit shoulder is far steeper than anything
  // rideable. Blend the terrain toward a low-passed version of itself wherever
  // the course runs, fading to untouched wilderness with distance. This keeps
  // ridgelines dramatic in the distance but sane where racers actually are.
  const smooth = boxBlur(h, 6, 2);
  for (let i = 0; i < h.length; i++) {
    const nw = nearField[i];
    if (nw > 0.001) {
      h[i] = h[i] * (1 - nw * 0.72) + smooth[i] * nw * 0.72;
    }
  }
}

/** separable box blur, `radius` cells, `passes` iterations */
function boxBlur(src: Float32Array, radius: number, passes: number): Float32Array {
  let a = Float32Array.from(src);
  let b = new Float32Array(a.length);
  for (let p = 0; p < passes; p++) {
    // horizontal
    for (let j = 0; j <= GRID_N; j++) {
      let sum = 0;
      const row = j * N1;
      for (let k = -radius; k <= radius; k++) sum += a[row + Math.max(0, Math.min(GRID_N, k))];
      for (let i = 0; i <= GRID_N; i++) {
        b[row + i] = sum / (radius * 2 + 1);
        const add = a[row + Math.min(GRID_N, i + radius + 1)];
        const sub = a[row + Math.max(0, i - radius)];
        sum += add - sub;
      }
    }
    // vertical
    for (let i = 0; i <= GRID_N; i++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += b[Math.max(0, Math.min(GRID_N, k)) * N1 + i];
      for (let j = 0; j <= GRID_N; j++) {
        a[j * N1 + i] = sum / (radius * 2 + 1);
        const add = b[Math.min(GRID_N, j + radius + 1) * N1 + i];
        const sub = b[Math.max(0, j - radius) * N1 + i];
        sum += add - sub;
      }
    }
  }
  return a;
}

function findS(stamps: Stamp[], nearZ: number): number {
  let best = stamps[0], bd = Infinity;
  for (const st of stamps) {
    const d = Math.abs(st.z - nearZ);
    if (d < bd) { bd = d; best = st; }
  }
  return best.s;
}

function stampIndexAt(stamps: Stamp[], s: number): number {
  for (let i = 1; i < stamps.length; i++) if (stamps[i].s >= s) return i;
  return stamps.length - 1;
}

function stampFeature(h: Float32Array, stamps: Stamp[], profile: Float64Array,
                      sCenter: number, heightM: number, sigmaM: number, flatTop: boolean): void {
  const ci = stampIndexAt(stamps, sCenter);
  const reachS = sigmaM * 3.2;
  for (let si = 0; si < stamps.length; si++) {
    const ds = stamps[si].s - sCenter;
    if (Math.abs(ds) > reachS) continue;
    let bump = Math.exp(-(ds * ds) / (2 * sigmaM * sigmaM)) * heightM;
    if (flatTop && Math.abs(ds) < sigmaM * 0.45) bump = heightM;
    applyAlongNormal(h, stamps, profile, si, bump, 5.0, 8.0);
  }
  void ci;
}

function stampRavine(h: Float32Array, stamps: Stamp[], profile: Float64Array,
                     trail: Float32Array, sCenter: number): void {
  const ci = stampIndexAt(stamps, sCenter);
  const st = stamps[ci];
  const pn = stamps[Math.max(0, ci - 1)], nx = stamps[Math.min(stamps.length - 1, ci + 1)];
  const ux = nx.x - pn.x, uz = nx.z - pn.z;
  const tl = Math.hypot(ux, uz) || 1;
  const rX = -uz / tl, rZ = ux / tl;
  const depth = 7.5, width = 13;

  const ciG = Math.round(worldToGrid(st.x)), cjG = Math.round(worldToGrid(st.z));
  const reach = Math.ceil((width * 2.2) / CELL) + 4;
  for (let dj = -reach; dj <= reach; dj++) {
    for (let di = -reach; di <= reach; di++) {
      const gi = ciG + di, gj = cjG + dj;
      if (gi < 0 || gj < 0 || gi > GRID_N || gj > GRID_N) continue;
      const wx = gridToWorldX(gi) - st.x, wz = gridToWorldX(gj) - st.z;
      const lateral = wx * rX + wz * rZ;       // across the trail = along ravine
      const alat = Math.abs(lateral);
      const w = Math.exp(-(alat * alat) / (width * width * 0.5));
      const idx = gj * N1 + gi;
      h[idx] -= depth * w;
      if (alat < width * 0.75) trail[idx] *= 1 - 0.85 * w; // scrub trail mask in the gap
    }
  }
  // takeoff lip: raise the trail just before the gap
  for (let si = 0; si < stamps.length; si++) {
    const ds = stamps[si].s - sCenter;
    if (ds > -1 && ds < 14) {
      const bump = Math.exp(-((ds - 4) ** 2) / 18) * 1.6;
      applyAlongNormal(h, stamps, profile, si, bump, 4.0, 6.0);
    }
  }
}

/** Add `amount` metres to the terrain around stamp `si`, blended laterally */
function applyAlongNormal(h: Float32Array, stamps: Stamp[], profile: Float64Array,
                          si: number, amount: number, halfW: number, falloff: number): void {
  const st = stamps[si];
  const ci = Math.round(worldToGrid(st.x)), cj = Math.round(worldToGrid(st.z));
  const pn = stamps[Math.max(0, si - 1)], nx = stamps[Math.min(stamps.length - 1, si + 1)];
  const tx = nx.x - pn.x, tz = nx.z - pn.z;
  const tl = Math.hypot(tx, tz) || 1;
  void profile;
  const reach = Math.ceil((halfW + falloff) / CELL);
  for (let dj = -reach; dj <= reach; dj++) {
    for (let di = -reach; di <= reach; di++) {
      const gi = ci + di, gj = cj + dj;
      if (gi < 0 || gj < 0 || gi > GRID_N || gj > GRID_N) continue;
      const wx = gridToWorldX(gi) - st.x, wz = gridToWorldX(gj) - st.z;
      const dist = Math.hypot(wx, wz);
      if (dist > halfW + falloff) continue;
      let w: number;
      if (dist <= halfW) w = 1;
      else {
        const f = (dist - halfW) / falloff;
        w = 1 - f * f * (3 - 2 * f);
      }
      h[gj * N1 + gi] += amount * w;
    }
  }
}

// ---------------------------------------------------------------------------
// Material zone classification — hard cel transitions between zones
// ---------------------------------------------------------------------------
function classifyZones(h: Float32Array, trail: Float32Array, flow: Float32Array,
                       depMap: Float32Array, streamMask: Float32Array,
                       zone: Uint8Array, ao: Float32Array): { hMin: number; hMax: number } {
  let hMin = Infinity, hMax = -Infinity;
  for (let i = 0; i < h.length; i++) {
    if (h[i] < hMin) hMin = h[i];
    if (h[i] > hMax) hMax = h[i];
  }
  const range = hMax - hMin;
  const n1 = N1;
  const slopeAt = (i: number, j: number) => {
    const hl = h[IDX(Math.max(0, i - 1), j)], hr = h[IDX(Math.min(GRID_N, i + 1), j)];
    const hd = h[IDX(i, Math.max(0, j - 1))], hu = h[IDX(i, Math.min(GRID_N, j + 1))];
    const sx = (hr - hl) / (2 * CELL), sy = (hu - hd) / (2 * CELL);
    return Math.hypot(sx, sy);
  };

  for (let j = 0; j <= GRID_N; j++) {
    for (let i = 0; i <= GRID_N; i++) {
      const idx = IDX(i, j);
      const na = (h[idx] - hMin) / range;   // normalised altitude
      const slope = slopeAt(i, j);

      // concavity → AO darkening (gullies read darker, crests lighter)
      const lap =
        (h[IDX(Math.min(GRID_N, i + 1), j)] + h[IDX(Math.max(0, i - 1), j)] +
         h[IDX(i, Math.min(GRID_N, j + 1))] + h[IDX(i, Math.max(0, j - 1))] - 4 * h[idx]);
      ao[idx] = Math.max(0, Math.min(1, -lap * 0.09));

      let z: number;
      if (trail[idx] > 0.55) z = ZONE.TRAIL;
      else if (streamMask[idx] > 0.5) z = ZONE.STREAM;
      else if (na > 0.82 || (na > 0.74 && slope < 0.85)) z = ZONE.SNOW;
      else if (na > 0.62 || (na > 0.48 && slope > 0.72)) z = ZONE.SCREE;
      else if (slope > 1.05 || (na > 0.42 && slope > 0.85)) z = ZONE.ROCK;
      else if (na > 0.30 || flow[idx] > 0.35 || depMap[idx] > 0.06) z = ZONE.DIRT;
      else z = ZONE.GRASS;
      zone[idx] = z;
    }
  }
  return { hMin, hMax };
}

// ---------------------------------------------------------------------------
// Public builder
// ---------------------------------------------------------------------------
export async function buildWorld(onProgress?: (frac: number, msg: string) => void):
  Promise<WorldData> {
  const total = N1 * N1;
  const h = new Float32Array(total);
  const trail = new Float32Array(total);
  const streamMask = new Float32Array(total);

  onProgress?.(0.02, 'raising bedrock');
  await yieldFrame();
  generateBase(h);
  onProgress?.(0.15, 'storm season — eroding');
  await yieldFrame();

  const flow = new Float32Array(total);
  const depMap = new Float32Array(total);
  await erodeAsync(h, flow, depMap, (f) => onProgress?.(0.15 + f * 0.55, 'hydraulic erosion'));

  const stamps = resampleCourse(6);
  onProgress?.(0.74, 'cutting the trail');
  await yieldFrame();
  const profile = buildProfile(stamps, h);
  const nearField = new Float32Array(total);
  carveCourse(h, stamps, profile, trail, streamMask, nearField);

  onProgress?.(0.86, 'painting material zones');
  await yieldFrame();
  const zone = new Uint8Array(total);
  const ao = new Float32Array(total);
  const { hMin, hMax } = classifyZones(h, trail, flow, depMap, streamMask, zone, ao);

  // Build course samples with final carved heights + tangents
  const course: CourseSample[] = [];
  for (let i = 0; i < stamps.length; i++) {
    const st = stamps[i];
    const gi = worldToGrid(st.x), gj = worldToGrid(st.z);
    const y = sampleBilinear(h, gi, gj);
    const pn = stamps[Math.max(0, i - 1)], nx = stamps[Math.min(stamps.length - 1, i + 1)];
    let dx = nx.x - pn.x, dz = nx.z - pn.z;
    const dl = Math.hypot(dx, dz) || 1;
    course.push({ x: st.x, y, z: st.z, s: st.s, dirX: dx / dl, dirZ: dz / dl });
  }
  const courseLength = course[course.length - 1].s;
  const jumps = [
    { s: findS(stamps, 1005), type: 'tabletop' as const },
    { s: findS(stamps, 1150), type: 'gap' as const },
  ];
  const checkpoints = [0.25, 0.5, 0.78].map((f) => f * courseLength);

  onProgress?.(1, 'ready');
  return { h, trail, zone, ao, hMin, hMax, course, courseLength, jumps, checkpoints };
}

async function erodeAsync(h: Float32Array, flow: Float32Array, dep: Float32Array,
                          onProg: (f: number) => void): Promise<void> {
  // Run erosion in slices so the loading bar animates smoothly.
  let done = false;
  const slice = () => {
    erode(h, flow, dep, onProg);
    done = true;
  };
  // Erosion is pure JS math (~1–2 s total); run it in one go but yield first
  // so the UI paints its progress message before we block.
  await yieldFrame();
  slice();
  await yieldFrame();
  void done;
}
