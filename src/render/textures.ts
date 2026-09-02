// Every texture in the game is generated here, in code. Nothing is loaded.
import * as THREE from 'three';

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')!];
}

function tex(canvasEl: HTMLCanvasElement, nearest = false): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(canvasEl);
  if (nearest) { t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; }
  else { t.minFilter = THREE.LinearMipmapLinearFilter; }
  t.colorSpace = THREE.NoColorSpace; // display-space pipeline: sample raw authored values
  return t;
}

/**
 * Cel lighting ramp: N·L mapped through discrete bands.
 * stops: list of [threshold 0..1, brightness 0..1]; rendered as hard steps.
 */
export function makeRamp(stops: Array<[number, number]>): THREE.CanvasTexture {
  const W = 64;
  const [c, ctx] = canvas(W, 4);
  let si = 0;
  for (let x = 0; x < W; x++) {
    const u = x / (W - 1);
    while (si < stops.length - 1 && u >= stops[si + 1][0]) si++;
    // hard-edged: value jumps exactly at thresholds
    const v = Math.round(stops[si][1] * 255);
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.fillRect(x, 0, 1, 4);
  }
  return tex(c, true);
}

/** Standard 4-band ramp used by most props */
export function defaultRamp(): THREE.CanvasTexture {
  return makeRamp([[0.0, 0.42], [0.36, 0.62], [0.58, 0.86], [0.78, 1.0]]);
}
/** Softer 3-band for skin */
export function skinRamp(): THREE.CanvasTexture {
  return makeRamp([[0.0, 0.55], [0.45, 0.8], [0.72, 1.0]]);
}

/** View-space matcap for metal: hard two-tone sphere with an off-centre hotspot */
export function makeMatcap(): THREE.CanvasTexture {
  const S = 256;
  const [c, ctx] = canvas(S, S);
  const g = ctx.createRadialGradient(S * 0.42, S * 0.38, 4, S / 2, S / 2, S / 2);
  g.addColorStop(0, '#fffdf4');
  g.addColorStop(0.28, '#ffe9bd');
  g.addColorStop(0.29, '#e8c98f');
  g.addColorStop(0.55, '#9d8567');
  g.addColorStop(0.56, '#6d5a48');
  g.addColorStop(1, '#3a3129');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  // hard secondary kick bottom-left (bounced dawn light)
  const g2 = ctx.createRadialGradient(S * 0.24, S * 0.74, 2, S * 0.24, S * 0.74, S * 0.34);
  g2.addColorStop(0, 'rgba(255,214,170,0.95)');
  g2.addColorStop(0.5, 'rgba(255,190,140,0.35)');
  g2.addColorStop(1, 'rgba(255,190,140,0)');
  ctx.fillStyle = g2;
  ctx.fillRect(0, 0, S, S);
  return tex(c);
}

/** Toon tree canopy: cross-billboard alpha card, flat 2-tone lobes + dark rim */
export function makeCanopyTexture(seed = 7): THREE.CanvasTexture {
  const S = 256;
  const [c, ctx] = canvas(S, S);
  ctx.clearRect(0, 0, S, S);
  const rand = (() => { let s = seed; return () => { s = (Math.imul(s, 1664525) + 101) >>> 0; return s / 4294967296; }; })();
  const cx = S / 2, cy = S * 0.46;
  // silhouette: overlapping circles
  const lobes: Array<[number, number, number]> = [];
  const nLobes = 7;
  for (let i = 0; i < nLobes; i++) {
    const ang = (i / nLobes) * Math.PI * 2 + rand();
    const rr = S * (0.13 + rand() * 0.09);
    lobes.push([cx + Math.cos(ang) * S * 0.22, cy + Math.sin(ang) * S * 0.19, rr]);
  }
  lobes.push([cx, cy - S * 0.05, S * 0.24]);
  // dark under-layer (acts as built-in outline + shadow tone)
  ctx.fillStyle = '#2a4d33';
  for (const [x, y, r] of lobes) { ctx.beginPath(); ctx.arc(x, y + 4, r + 5, 0, 7); ctx.fill(); }
  // mid tone
  ctx.fillStyle = '#3e7a4a';
  for (const [x, y, r] of lobes) { ctx.beginPath(); ctx.arc(x, y + 1, r, 0, 7); ctx.fill(); }
  // sun-side highlight lobes (upper-left cluster)
  ctx.fillStyle = '#63a45c';
  for (const [x, y, r] of lobes) {
    if (x < cx && y < cy + 20 || rand() > 0.6) {
      ctx.beginPath(); ctx.arc(x - r * 0.18, y - r * 0.22, r * 0.55, 0, 7); ctx.fill();
    }
  }
  // a few hard leaf-notches cut from the edge
  ctx.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 5; i++) {
    const ang = rand() * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(ang) * S * 0.33, cy + Math.sin(ang) * S * 0.3, S * 0.05, 0, 7);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
  return tex(c);
}

export function makeBarkTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(64, 128);
  ctx.fillStyle = '#6b4a33';
  ctx.fillRect(0, 0, 64, 128);
  ctx.fillStyle = '#59392a';
  for (let x = 0; x < 64; x += 8) ctx.fillRect(x + ((x * 13) % 5), 0, 3, 128);
  ctx.fillStyle = '#83604a';
  for (let x = 4; x < 64; x += 16) ctx.fillRect(x, 0, 2, 128);
  return tex(c);
}

/** Cel cloud sprite: flat white mass, lavender belly, razor edge */
export function makeCloudTexture(seed = 11): THREE.CanvasTexture {
  const W = 512, H = 256;
  const [c, ctx] = canvas(W, H);
  ctx.clearRect(0, 0, W, H);
  const rand = (() => { let s = seed; return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; }; })();
  const puffs: Array<[number, number, number]> = [];
  const n = 9;
  for (let i = 0; i < n; i++) {
    const x = W * 0.14 + (i / (n - 1)) * W * 0.72 + (rand() - 0.5) * 30;
    const y = H * 0.52 - Math.sin((i / (n - 1)) * Math.PI) * H * 0.26 - rand() * 18;
    const r = H * (0.16 + Math.sin((i / (n - 1)) * Math.PI) * 0.14 + rand() * 0.05);
    puffs.push([x, y, r]);
  }
  // shadow belly first (offset down)
  ctx.fillStyle = '#c9b8d8';
  for (const [x, y, r] of puffs) { ctx.beginPath(); ctx.arc(x, y + 10, r, 0, 7); ctx.fill(); }
  // flat body
  ctx.fillStyle = '#fffdf6';
  for (const [x, y, r] of puffs) {
    ctx.beginPath();
    ctx.arc(x, y, r, Math.PI * 0.95, Math.PI * 2.05); // top arc
    ctx.lineTo(x + r * 0.96, y + 8);
    ctx.arc(x, y + 8, r, 0, Math.PI * 0.06, true);
    ctx.closePath();
    ctx.fill();
  }
  return tex(c);
}

/** Radial blob shadow */
export function makeBlobShadowTexture(): THREE.CanvasTexture {
  const S = 128;
  const [c, ctx] = canvas(S, S);
  const g = ctx.createRadialGradient(S / 2, S / 2, 4, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(20,16,28,0.55)');
  g.addColorStop(0.55, 'rgba(20,16,28,0.38)');
  g.addColorStop(1, 'rgba(20,16,28,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(c);
  return t;
}

/** Grass tuft card: a few hard blades, alpha cut */
export function makeGrassTexture(): THREE.CanvasTexture {
  const S = 128;
  const [c, ctx] = canvas(S, S);
  ctx.clearRect(0, 0, S, S);
  ctx.strokeStyle = '#4d8a44';
  ctx.lineWidth = 7;
  ctx.lineCap = 'round';
  const blades = 9;
  for (let i = 0; i < blades; i++) {
    const x = S * (0.15 + (i / (blades - 1)) * 0.7);
    const h = S * (0.35 + ((i * 37) % 10) / 28);
    const bend = (i % 2 === 0 ? -1 : 1) * S * 0.12;
    ctx.beginPath();
    ctx.moveTo(x, S);
    ctx.quadraticCurveTo(x + bend * 0.4, S - h * 0.6, x + bend, S - h);
    ctx.stroke();
    // lighter blade tip
    ctx.strokeStyle = '#79ab53';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x + bend * 0.7, S - h * 0.82);
    ctx.lineTo(x + bend, S - h);
    ctx.stroke();
    ctx.strokeStyle = '#4d8a44';
    ctx.lineWidth = 7;
  }
  return tex(c);
}

/** Wildflower speckle decal for meadows */
export function makeFlowersTexture(): THREE.CanvasTexture {
  const S = 128;
  const [c, ctx] = canvas(S, S);
  ctx.clearRect(0, 0, S, S);
  const rand = (() => { let s = 99; return () => { s = (Math.imul(s, 1664525) + 101) >>> 0; return s / 4294967296; }; })();
  for (let i = 0; i < 26; i++) {
    const cols = ['#f2d43d', '#e86a5e', '#f5f2ea', '#d88ad1'];
    ctx.fillStyle = cols[(rand() * cols.length) | 0];
    const x = rand() * S, y = rand() * S, r = 2 + rand() * 3.5;
    ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
    ctx.fillStyle = 'rgba(90,60,20,0.8)';
    ctx.beginPath(); ctx.arc(x, y, r * 0.4, 0, 7); ctx.fill();
  }
  return tex(c);
}
