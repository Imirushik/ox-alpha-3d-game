// Deterministic hash-based value noise + fBm used for terrain generation.
import { mulberry32 } from './rng';

export function hash2(x: number, y: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967295;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

export function valueNoise2(x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = smooth(xf), v = smooth(yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v; // 0..1
}

/** Fractal brownian motion, returns roughly 0..1 */
export function fbm(x: number, y: number, octaves = 5, lac = 2.03, gain = 0.5): number {
  let amp = 0.5, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise2(x * freq, y * freq);
    norm += amp;
    freq *= lac;
    amp *= gain;
  }
  return sum / norm;
}

/** Ridged multifractal — sharp mountain crests. Returns 0..1 */
export function ridged(x: number, y: number, octaves = 5, lac = 2.07, gain = 0.5): number {
  let amp = 0.5, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(valueNoise2(x * freq, y * freq) * 2 - 1);
    sum += amp * n * n;
    norm += amp;
    freq *= lac;
    amp *= gain;
  }
  return sum / norm;
}

/** Seeded permutation-free domain warp helper */
export function makeWarper(seed: number) {
  const r1 = mulberry32(seed);
  const ox = r1() * 512, oz = r1() * 512;
  const ox2 = r1() * 512, oz2 = r1() * 512;
  return (x: number, z: number, strength: number): [number, number] => {
    const wx = fbm(x * 0.0031 + ox, z * 0.0031 + oz, 3) * 2 - 1;
    const wz = fbm(x * 0.0031 + ox2, z * 0.0031 + oz2, 3) * 2 - 1;
    return [x + wx * strength, z + wz * strength];
  };
}
