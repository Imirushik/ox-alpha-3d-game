// The unified toon shading system. One shader family, many tunings: every
// surface in the game — terrain, dirt, rock, foliage, skin, metal — goes
// through this ramp-lit, hard-banded, hatched, stepped-fog NPR pipeline.
//
// Lighting model:
//   N·L -> 1D ramp texture (NearestFilter) => discrete shade bands
//   shadow bands get a screen-space hatch (background-painter texture)
//   optional hard-threshold specular for metal & helmets
//   fresnel rim so silhouettes cut against terrain
//   distance fog quantised into flat paper layers
import * as THREE from 'three';
import { defaultRamp } from './textures';

// ---- global uniforms shared by every toon material -------------------------
export const G = {
  uSunDir: { value: new THREE.Vector3(-0.35, 0.5, 0.78).normalize() },
  uSunColor: { value: new THREE.Color(0xffe8c0) },
  uAmbient: { value: new THREE.Color(0x9db4d6) },
  uFogColor: { value: new THREE.Color(0xe6ddc4) },
  uFogNear: { value: 260 },
  uFogFar: { value: 2900 },
  uFogBands: { value: 7.0 },
  uTime: { value: 0 },
};

export const GLOBAL_UNIFORMS_GLSL = `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform float uFogBands;
uniform float uTime;
`;

const COMMON_VERT = /* glsl */`
varying vec3 vWorldPos;
varying vec3 vNormalW;
varying vec2 vUv;
#ifdef TERRAIN
attribute float aZone;
attribute float aAO;
varying float vZone;
varying float vAO;
#endif
void main() {
  vUv = uv;
  vec3 p = position;
  #ifdef TERRAIN
    vZone = aZone;
    vAO = aAO;
  #endif
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorldPos = wp.xyz;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const TOON_FRAG = /* glsl */`
precision highp float;
varying vec3 vWorldPos;
varying vec3 vNormalW;
varying vec2 vUv;
#ifdef TERRAIN
varying float vZone;
varying float vAO;
uniform vec3 uZoneCol[7];
uniform vec3 uZoneShadow[7];
#endif

${GLOBAL_UNIFORMS_GLSL}

uniform sampler2D uRamp;
uniform vec3 uBaseColor;
uniform vec3 uShadowTint;
uniform vec3 uSpecColor;
uniform float uSpecThresh;
uniform float uSpecPower;
uniform vec3 uRimColor;
uniform float uRimStrength;
uniform float uHatchScale;
uniform float uHatchOpacity;
uniform sampler2D uMap;
uniform float uAlphaTest;
uniform float uEmissive;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 443.897);
  p3 += dot(p3, p3.yzx + 19.19);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(cameraPosition - vWorldPos);
  if (!gl_FrontFacing) N = -N;
  vec3 L = normalize(uSunDir);

  vec3 base = uBaseColor;
  vec3 shadowTint = uShadowTint;

  #ifdef TERRAIN
    int zi = int(vZone + 0.5);
    zi = clamp(zi, 0, 6);
    base = uZoneCol[zi];
    shadowTint = uZoneShadow[zi];
    // wildflower speckle in the meadows (zone 0): hard painted dots
    float fl = hash12(floor(vWorldPos.xz * 1.7));
    if (zi == 0 && fl > 0.965) {
      vec3 fcol = fl > 0.985 ? vec3(0.95,0.83,0.25)
                : (fl > 0.975 ? vec3(0.91,0.42,0.37) : vec3(0.96,0.95,0.92));
      base = mix(base, fcol, 0.85);
    }
  #endif

  #ifdef USE_MAP
    vec4 m = texture2D(uMap, vUv);
    if (m.a < uAlphaTest) discard;
    base *= m.rgb;
  #endif

  // ---- ramp lighting --------------------------------------------------------
  float ndl = dot(N, L);
  float ru = clamp(ndl * 0.5 + 0.5, 0.0, 1.0);
  float band = texture2D(uRamp, vec2(ru, 0.5)).r;

  vec3 col = base * mix(shadowTint, vec3(1.05), band);
  col += uSunColor * max(ndl, 0.0) * 0.06;

  // ---- hatch inside the deepest band (screen-aligned, painterly) ------------
  float hatchMask = (1.0 - smoothstep(0.34, 0.42, band)) * uHatchOpacity;
  if (hatchMask > 0.001) {
    float sc = uHatchScale;
    float h1 = step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) / sc));
    float h2 = step(0.5, fract((gl_FragCoord.x - gl_FragCoord.y) / (sc * 2.0)));
    float hatch = mix(h1, h2, 0.5);
    col *= 1.0 - hatchMask * hatch * 0.45;
    col += hatchMask * hatch * base * 0.08;
  }

  // ---- hard-threshold specular ----------------------------------------------
  #ifndef TERRAIN
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(N, H), 0.0), uSpecPower);
  spec = step(uSpecThresh, spec);
  col += uSpecColor * spec;
  #endif

  // ---- fresnel rim ----------------------------------------------------------
  float fres = pow(1.0 - max(dot(N, V), 0.0), 2.6);
  float rim = smoothstep(0.62, 0.72, fres);
  col += uRimColor * rim * uRimStrength;

  col += base * uEmissive;

  #ifdef TERRAIN
    col *= 1.0 - vAO * 0.38;
  #endif

  // ---- quantised atmospheric depth -----------------------------------------
  float dist = length(cameraPosition - vWorldPos);
  float f = clamp((dist - uFogNear) / (uFogFar - uFogNear), 0.0, 1.0);
  float fb = min(floor(f * uFogBands) / (uFogBands - 1.0), 1.0);
  col = mix(col, uFogColor, fb);

  gl_FragColor = vec4(col, 1.0);
}
`;

function assembleMaterial(defines: string[], uniforms: Record<string, THREE.IUniform>,
                          vertExtra = '', fragExtra = ''): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: COMMON_VERT + vertExtra,
    fragmentShader: TOON_FRAG + fragExtra,
    uniforms,
    defines: Object.fromEntries(defines.map((d) => [d, ''])),
  });
}

export interface ToonOpts {
  color: number | THREE.Color;
  shadowTint?: number | THREE.Color;
  ramp?: THREE.Texture;
  specColor?: number;
  /** threshold above which the highlight snaps on; >1 disables */
  specThresh?: number;
  specPower?: number;
  rimColor?: number;
  rimStrength?: number;
  hatchScale?: number;
  hatchOpacity?: number;
  map?: THREE.Texture;
  alphaTest?: number;
  emissive?: number;
}

export function createToonMaterial(opts: ToonOpts): THREE.ShaderMaterial {
  const uniforms: Record<string, THREE.IUniform> = {
    ...G,
    uRamp: { value: opts.ramp ?? defaultRamp() },
    uBaseColor: { value: new THREE.Color(opts.color) },
    uShadowTint: { value: new THREE.Color(opts.shadowTint ?? 0x8a86b8) },
    uSpecColor: { value: new THREE.Color(opts.specColor ?? 0xfff6e0) },
    uSpecThresh: { value: opts.specThresh ?? 2 },
    uSpecPower: { value: opts.specPower ?? 24 },
    uRimColor: { value: new THREE.Color(opts.rimColor ?? 0xffe0b0) },
    uRimStrength: { value: opts.rimStrength ?? 0 },
    uHatchScale: { value: opts.hatchScale ?? 9 },
    uHatchOpacity: { value: opts.hatchOpacity ?? 0 },
    uMap: { value: opts.map ?? null },
    uAlphaTest: { value: opts.alphaTest ?? 0 },
    uEmissive: { value: opts.emissive ?? 0 },
  };
  const defines: string[] = [];
  if (opts.map) defines.push('USE_MAP');
  return assembleMaterial(defines, uniforms);
}

// ---- terrain variant --------------------------------------------------------
export interface TerrainPaletteEntry { col: number; shadow: number; }

export function createTerrainMaterial(palette: TerrainPaletteEntry[]): THREE.ShaderMaterial {
  const uniforms: Record<string, THREE.IUniform> = {
    ...G,
    uRamp: { value: makeTerrainRamp() },
    uZoneCol: { value: palette.map((p) => new THREE.Color(p.col)) },
    uZoneShadow: { value: palette.map((p) => new THREE.Color(p.shadow)) },
    uBaseColor: { value: new THREE.Color(0xffffff) },
    uShadowTint: { value: new THREE.Color(0x8888aa) },
    uSpecColor: { value: new THREE.Color(0xffffff) },
    uSpecThresh: { value: 2 },
    uSpecPower: { value: 16 },
    uRimColor: { value: new THREE.Color(0xffe0b0) },
    uRimStrength: { value: 0 },
    uHatchScale: { value: 11 },
    uHatchOpacity: { value: 0.16 },
    uMap: { value: null },
    uAlphaTest: { value: 0 },
    uEmissive: { value: 0 },
  };
  return assembleMaterial(['TERRAIN'], uniforms);
}

function makeTerrainRamp(): THREE.Texture {
  // terrain gets slightly deeper shadow floor than props
  return defaultRamp();
}
