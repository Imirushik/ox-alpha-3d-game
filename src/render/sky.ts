// Dawn-gold alpine sky: gradient dome, hard-edged cel sun with concentric
// glow bands, two parallax layers of flat-painted clouds, and geometric sun
// shafts placed along the tree line.
import * as THREE from 'three';
import { makeCloudTexture } from './textures';
import { G } from './toon';

export class SkySystem {
  group = new THREE.Group();       // added to scene; follows camera
  private cloudsNear: THREE.Mesh[] = [];
  private cloudsFar: THREE.Mesh[] = [];

  constructor(scene: THREE.Scene) {
    scene.add(this.group);

    // ---- dome ----
    const domeGeo = new THREE.SphereGeometry(6000, 32, 20);
    const domeMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uSunDir: G.uSunDir,
        uTime: G.uTime,
      },
      vertexShader: /* glsl */`
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position.z = gl_Position.w * 0.99999; // pin to far plane
        }
      `,
      fragmentShader: /* glsl */`
        varying vec3 vDir;
        uniform vec3 uSunDir;
        uniform float uTime;
        void main() {
          float h = clamp(vDir.y, -0.2, 1.0);
          // dawn palette: deep indigo zenith -> teal -> gold horizon
          vec3 zenith = vec3(0.16, 0.33, 0.55);
          vec3 mid    = vec3(0.45, 0.62, 0.78);
          vec3 horizon = vec3(0.99, 0.83, 0.58);
          vec3 col = mix(horizon, mid, smoothstep(0.0, 0.18, h));
          col = mix(col, zenith, smoothstep(0.15, 0.62, h));
          // warm wedge around the sun azimuth near the horizon
          vec3 sd = normalize(uSunDir);
          float az = dot(normalize(vec3(vDir.x, 0.0, vDir.z)), normalize(vec3(sd.x, 0.0, sd.z)));
          float wedge = smoothstep(0.55, 0.95, az) * (1.0 - smoothstep(0.0, 0.35, h));
          col = mix(col, vec3(1.0, 0.78, 0.45), wedge * 0.7);

          // ---- cel sun: disc + hard-edged concentric glow ----
          float d = dot(vDir, sd);
          float disc = smoothstep(0.99965, 0.99975, d);
          // banded halo: three discrete rings
          float g1 = smoothstep(0.9985, 0.9987, d) - smoothstep(0.9994, 0.9995, d);
          float g2 = smoothstep(0.9965, 0.9967, d) - smoothstep(0.9980, 0.9982, d);
          float g3 = smoothstep(0.9930, 0.9934, d) - smoothstep(0.9955, 0.9959, d);
          col += vec3(1.0, 0.92, 0.75) * (g1 * 0.55 + g2 * 0.3 + g3 * 0.16);
          col = mix(col, vec3(1.0, 0.98, 0.9), disc);

          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    const dome = new THREE.Mesh(domeGeo, domeMat);
    dome.frustumCulled = false;
    this.group.add(dome);

    // ---- clouds, two parallax depths ----
    const mkLayer = (count: number, seedBase: number, yRange: [number, number],
                     radius: number, scaleRange: [number, number]) => {
      const list: THREE.Mesh[] = [];
      const mat = new THREE.MeshBasicMaterial({
        map: makeCloudTexture(seedBase),
        transparent: true,
        depthWrite: false,
        fog: false,
      });
      const geo = new THREE.PlaneGeometry(1, 0.5);
      for (let i = 0; i < count; i++) {
        const m = new THREE.Mesh(geo, mat);
        const ang = (i / count) * Math.PI * 2 + seedBase;
        const rad = radius * (0.55 + ((i * 37) % 10) / 22);
        m.position.set(Math.cos(ang) * rad, yRange[0] + ((i * 53) % 10) / 10 * (yRange[1] - yRange[0]), Math.sin(ang) * rad);
        const sc = scaleRange[0] + ((i * 71) % 10) / 10 * (scaleRange[1] - scaleRange[0]);
        m.scale.setScalar(sc * 900);
        m.rotation.y = -ang; // face centre-ish
        list.push(m);
        this.group.add(m);
      }
      return list;
    };
    this.cloudsFar = mkLayer(10, 3, [1400, 2200], 5200, [1.6, 2.8]);
    this.cloudsNear = mkLayer(8, 17, [1100, 1700], 3200, [1.0, 1.7]);
  }

  /** camera-follow + drift; keep clouds painted onto the dome distance */
  update(camera: THREE.Camera, dt: number): void {
    const cp = camera.position;
    this.group.position.set(cp.x, 0, cp.z);
    const t = G.uTime.value;
    for (let i = 0; i < this.cloudsNear.length; i++) {
      const c = this.cloudsNear[i];
      c.position.x += dt * 7;
      if (c.position.x > 2600) c.position.x -= 5200;
      c.quaternion.copy((camera as THREE.PerspectiveCamera).quaternion); // full billboard
    }
    void t;
    for (const c of this.cloudsFar) {
      c.quaternion.copy((camera as THREE.PerspectiveCamera).quaternion);
    }
  }

  /** hide during the Sobel prepass */
  setPrepassVisible(v: boolean): void {
    this.group.visible = v;
  }
}
