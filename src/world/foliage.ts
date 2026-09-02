// Instanced foliage: pines with billboard-cross canopies, rocks, bushes, grass
// tufts. Placement is deterministic per tile; tiles toggle by distance so
// frustum + range culling stay cheap. All materials are toon-shaded with the
// same ramp/hatch/stepped-fog rules as everything else.
import * as THREE from 'three';
import { HeightSampler } from './terrain';
import { ZONE, HALF, WORLD_SIZE } from './heightfield';
import { G, GLOBAL_UNIFORMS_GLSL } from '../render/toon';
import { makeCanopyTexture, makeBarkTexture, makeGrassTexture } from '../render/textures';
import { mulberry32 } from '../core/rng';

const TILE = 220;

// ---------------------------------------------------------------------------
// Shared instanced toon shader. `CARD` variant billboards around world Y.
// ---------------------------------------------------------------------------
function instancedToonMaterial(opts: {
  color: number; shadowTint?: number; map?: THREE.Texture; alphaTest?: number;
  card?: boolean; cardSize?: number; rim?: number;
}): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...G,
      uBaseColor: { value: new THREE.Color(opts.color) },
      uShadowTint: { value: new THREE.Color(opts.shadowTint ?? 0x7d7aa8) },
      uMap: { value: opts.map ?? null },
      uAlphaTest: { value: opts.alphaTest ?? 0 },
      uRimColor: { value: new THREE.Color(0xffe2b8) },
      uRimStrength: { value: opts.rim ?? 0 },
      uCardSize: { value: opts.cardSize ?? 1 },
    },
    defines: opts.map ? { USE_MAP: '' } : {},
    vertexShader: /* glsl */`
      varying vec3 vWorldPos;
      varying vec3 vNormalW;
      varying vec2 vUv;
      #ifdef CARD
      attribute vec2 aCard;
      uniform float uCardSize;
      #endif
      void main() {
        vUv = uv;
        vec3 p = position;
        vec3 n = normal;
        mat4 im = instanceMatrix;
        vec4 anchorL = vec4(0.0, 0.0, 0.0, 1.0);
        vec4 wpAnchor = modelMatrix * im * anchorL;
        #ifdef CARD
          // Y-billboarded cross card in world space
          vec2 toCam = normalize(cameraPosition.xz - wpAnchor.xz);
          vec3 rightW = vec3(toCam.y, 0.0, -toCam.x);
          vec3 offW = rightW * (aCard.x * uCardSize) + vec3(0.0, aCard.y * uCardSize + uCardSize * 0.5, 0.0);
          vWorldPos = wpAnchor.xyz + offW;
          // face normal toward camera for consistent lighting
          n = normalize(vec3(toCam.x, 0.15, toCam.y));
          vUv = aCard * 0.5 + 0.5;
        #else
          vec4 wp = modelMatrix * im * vec4(p, 1.0);
          vWorldPos = wp.xyz;
          n = normalize(mat3(modelMatrix) * mat3(im) * n);
        #endif
        vNormalW = n;
        gl_Position = projectionMatrix * viewMatrix * vec4(vWorldPos, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      varying vec3 vWorldPos;
      varying vec3 vNormalW;
      varying vec2 vUv;
      ${GLOBAL_UNIFORMS_GLSL}
      uniform vec3 uBaseColor;
      uniform vec3 uShadowTint;
      uniform sampler2D uMap;
      uniform float uAlphaTest;
      uniform vec3 uRimColor;
      uniform float uRimStrength;
      void main() {
        vec3 base = uBaseColor;
        #ifdef USE_MAP
          vec4 m = texture2D(uMap, vUv);
          if (m.a < uAlphaTest) discard;
          base *= m.rgb;
        #endif
        vec3 N = normalize(vNormalW);
        if (!gl_FrontFacing) N = -N;
        vec3 V = normalize(cameraPosition - vWorldPos);
        vec3 L = normalize(uSunDir);
        float ndl = dot(N, L);
        // hard 4-band response tuned per family via shadow tint + base color
        float band = ndl > 0.52 ? 1.0 : (ndl > 0.18 ? 0.72 : (ndl > -0.05 ? 0.48 : 0.34));
        vec3 col = base * mix(uShadowTint, vec3(1.04), band);
        // canopy cards get painted-in top light instead of N·L banding
        #ifdef USE_MAP
          col *= 0.9 + smoothstep(-0.5, 0.5, vUv.y) * 0.22;
        #endif
        float fres = pow(1.0 - max(dot(N, V), 0.0), 2.6);
        col += uRimColor * smoothstep(0.62, 0.72, fres) * uRimStrength;
        float dist = length(cameraPosition - vWorldPos);
        float f = clamp((dist - uFogNear) / (uFogFar - uFogNear), 0.0, 1.0);
        float fb = min(floor(f * uFogBands) / (uFogBands - 1.0), 1.0);
        col = mix(col, uFogColor, fb);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
    side: opts.card ? THREE.DoubleSide : THREE.FrontSide,
  });
}

function makeCrossCardGeometry(): { geo: THREE.BufferGeometry } {
  // two crossed quads; aCard encodes corner offsets (-0.5..0.5, -0.5..0.5)
  const pos: number[] = [], card: number[] = [], idx: number[] = [];
  const quad = (rot: boolean, base: number) => {
    const c = [
      [-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5],
    ];
    for (let i = 0; i < 4; i++) {
      const [x, y] = c[i];
      if (rot) pos.push(x, y, 0); else pos.push(0, y, x);
      card.push(x, y);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  quad(false, 0);
  quad(true, 4);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aCard', new THREE.Float32BufferAttribute(card, 2));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Array(8).fill(0), 2));
  geo.setIndex(idx);
  return { geo };
}

// ---------------------------------------------------------------------------
interface Tile {
  cx: number; cz: number;
  meshes: THREE.InstancedMesh[];
}

export class FoliageSystem {
  group = new THREE.Group();
  private tiles: Tile[] = [];
  private mats: Record<string, THREE.ShaderMaterial> = {};

  constructor(private sampler: HeightSampler) {
    const canopyTex = makeCanopyTexture(7);
    const barkTex = makeBarkTexture();
    const grassTex = makeGrassTexture();

    this.mats.trunk = instancedToonMaterial({ color: 0xffffff, map: barkTex, alphaTest: 0.01 });
    this.mats.canopy = instancedToonMaterial({
      color: 0xffffff, map: canopyTex, alphaTest: 0.5, card: true, cardSize: 5.4,
    });
    this.mats.rock = instancedToonMaterial({ color: 0x9a9088, shadowTint: 0x6d687e, rim: 0.12 });
    this.mats.bush = instancedToonMaterial({ color: 0x4c8a4f, shadowTint: 0x39627a });
    this.mats.grass = instancedToonMaterial({
      color: 0xffffff, map: grassTex, alphaTest: 0.5, card: true, cardSize: 1.15,
    });
  }

  /** Deterministic scatter across tiles that lie within reach of the course */
  build(coursePts: THREE.Vector3[]): void {
    const nearCourse = (cx: number, cz: number): boolean => {
      const r2 = 850 * 850;
      for (const p of coursePts) {
        const dx = p.x - cx, dz = p.z - cz;
        if (dx * dx + dz * dz < r2) return true;
      }
      return false;
    };

    const trunkGeo = new THREE.CylinderGeometry(0.28, 0.42, 4.6, 6);
    trunkGeo.translate(0, 2.3, 0);
    const rockGeo = makeRockGeo();
    const bushGeo = makeBushGeo();
    const { geo: cardGeo } = makeCrossCardGeometry();
    // canopies sit on top of the trunk
    const canopyGeo = cardGeo;

    const halfTiles = Math.ceil(HALF / TILE);
    for (let tj = -halfTiles; tj < halfTiles; tj++) {
      for (let ti = -halfTiles; ti < halfTiles; ti++) {
        const cx = ti * TILE + TILE / 2, cz = tj * TILE + TILE / 2;
        if (!nearCourse(cx, cz)) continue;
        const rng = mulberry32((ti & 0xffff) * 7919 + (tj & 0xffff) * 104729 + 13);

        const lists: Record<string, THREE.Matrix4[]> = { trunk: [], canopy: [], rock: [], bush: [], grass: [] };
        const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), pv = new THREE.Vector3();

        const attempts = 150;
        for (let k = 0; k < attempts; k++) {
          const x = cx + (rng() - 0.5) * TILE;
          const z = cz + (rng() - 0.5) * TILE;
          if (Math.abs(x) > HALF - 30 || Math.abs(z) > HALF - 30) continue;
          const zone = this.sampler.zoneAt(x, z);
          const h = this.sampler.heightAt(x, z);
          const roll = rng();
          if ((zone === ZONE.GRASS || zone === ZONE.DIRT) && roll < 0.55) {
            // pine
            const s = 0.75 + rng() * 0.85;
            pv.set(x, h - 0.25, z);
            q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng() * Math.PI * 2);
            sc.set(s, s, s);
            m.compose(pv, q, sc);
            lists.trunk.push(m.clone());
            pv.set(x, h + 3.1 * s, z);
            m.compose(pv, q, sc);
            lists.canopy.push(m.clone());
          } else if ((zone === ZONE.SCREE || zone === ZONE.ROCK || zone === ZONE.SNOW || zone === ZONE.DIRT) && roll < 0.4) {
            const s = 0.6 + rng() * 2.1;
            pv.set(x, h - s * 0.35, z);
            q.setFromEuler(new THREE.Euler(rng() * 0.5, rng() * Math.PI * 2, rng() * 0.5));
            sc.set(s, s * (0.7 + rng() * 0.5), s);
            m.compose(pv, q, sc);
            lists.rock.push(m.clone());
          } else if ((zone === ZONE.GRASS || zone === ZONE.DIRT) && roll < 0.72) {
            const s = 0.7 + rng() * 0.8;
            pv.set(x, h, z);
            q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng() * Math.PI * 2);
            sc.set(s, s * 0.8, s);
            m.compose(pv, q, sc);
            lists.bush.push(m.clone());
          }
          // grass tufts everywhere green, denser pass
          if ((zone === ZONE.GRASS || zone === ZONE.DIRT) && rng() < 0.85) {
            const s = 0.7 + rng() * 0.7;
            pv.set(x + (rng() - 0.5) * 6, h, z + (rng() - 0.5) * 6);
            q.identity();
            sc.set(s, s, s);
            m.compose(pv, q, sc);
            lists.grass.push(m.clone());
          }
        }

        const mkInst = (geo: THREE.BufferGeometry, mat: THREE.ShaderMaterial,
                        arr: THREE.Matrix4[], name: string): void => {
          if (!arr.length) return;
          const im = new THREE.InstancedMesh(geo, mat, arr.length);
          arr.forEach((mx, i) => im.setMatrixAt(i, mx));
          im.instanceMatrix.needsUpdate = true;
          im.frustumCulled = true;
          im.name = name;
          this.group.add(im);
          tile.meshes.push(im);
        };

        const tile: Tile = { cx, cz, meshes: [] };
        mkInst(trunkGeo, this.mats.trunk, lists.trunk, 'trunk');
        mkInst(canopyGeo, this.mats.canopy, lists.canopy, 'canopy');
        mkInst(rockGeo, this.mats.rock, lists.rock, 'rock');
        mkInst(bushGeo, this.mats.bush, lists.bush, 'bush');
        mkInst(cardGeo, this.mats.grass, lists.grass, 'grass');
        if (tile.meshes.length) this.tiles.push(tile);
      }
    }
    document.title; // no-op keeps lints calm
    void WORLD_SIZE;
  }

  /** Distance-toggle tiles; call once per frame with the camera position */
  update(px: number, pz: number): void {
    const r2near = 1150 * 1150, r2far = 1350 * 1350;
    for (const t of this.tiles) {
      const dx = t.cx - px, dz = t.cz - pz;
      const d2 = dx * dx + dz * dz;
      const wantVisible = d2 < r2far;
      const vis = t.meshes[0]?.visible ?? false;
      if (wantVisible !== vis) {
        for (const m of t.meshes) m.visible = wantVisible;
      }
      void r2near;
    }
  }
}

function makeRockGeo(): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const f = 0.72 + ((Math.imul(i, 2654435761) >>> 16) % 1000) / 1000 * 0.56;
    p.setXYZ(i, p.getX(i) * f, p.getY(i) * f * 0.82, p.getZ(i) * f);
  }
  g.computeVertexNormals();
  return g;
}

function makeBushGeo(): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 1);
  g.scale(1.15, 0.75, 1.15);
  g.computeVertexNormals();
  return g;
}
