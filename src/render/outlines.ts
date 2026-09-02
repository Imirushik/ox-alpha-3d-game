// Inverted-hull ink outlines. Vertices pushed along view-space normals,
// BackSide, width scaled by distance so screen-space thickness stays roughly
// constant. Line weight varies like a drawn stroke: heavier on the shadow
// side of the form, lighter where the sun hits.
import * as THREE from 'three';
import { G } from './toon';

export interface HullOpts {
  color?: number;
  /** world-space push at reference distance */
  thickness?: number;
}

export function createHullMaterial(opts: HullOpts = {}): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: {
      uInk: { value: new THREE.Color(opts.color ?? 0x27201a) },
      uThickness: { value: opts.thickness ?? 0.02 },
      uSunDir: G.uSunDir,
    },
    vertexShader: /* glsl */`
      uniform float uThickness;
      uniform vec3 uSunDir;
      varying float vWeight;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vec3 nView = normalize(normalMatrix * normal);
        // constant screen-space width: scale push by clip-space distance
        float distScale = clamp(-mv.z / 30.0, 0.25, 8.0);
        // hand-drawn weight: shadow-side strokes run thicker
        vec3 nWorld = normalize(mat3(modelMatrix) * normal);
        float ndl = dot(nWorld, normalize(uSunDir));
        float strokeW = mix(1.35, 0.72, clamp(ndl * 0.5 + 0.5, 0.0, 1.0));
        vWeight = strokeW;
        mv.xyz += nView * uThickness * distScale * strokeW;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 uInk;
      varying float vWeight;
      void main() { gl_FragColor = vec4(uInk * mix(0.85, 1.0, vWeight), 1.0); }
    `,
  });
}

let sharedMat: THREE.ShaderMaterial | null = null;

/** Wrap a geometry in an outline shell parented to `parent` (inherits transform). */
export function addOutline(
  parent: THREE.Object3D,
  geometry: THREE.BufferGeometry,
  opts: HullOpts & { material?: THREE.ShaderMaterial } = {},
): THREE.Mesh {
  if (!opts.material && !sharedMat) sharedMat = createHullMaterial();
  const mesh = new THREE.Mesh(geometry, opts.material ?? sharedMat!);
  mesh.renderOrder = 1; // draw after base mesh so hull reads cleanly
  parent.add(mesh);
  return mesh;
}
