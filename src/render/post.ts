// Post pipeline: Sobel ink-line prepass over a normal+depth buffer, radial
// anime speed lines, impact-frame flash, hard-threshold bloom, and a final
// dawn-gold colour grade. Everything is display-space authored (no PBR
// conversions anywhere).
import * as THREE from 'three';

const FULLSCREEN_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy * 2.0, 0.0, 1.0);
}
`;

export class PostFX {
  private sceneRT: THREE.WebGLRenderTarget;
  private normRT: THREE.WebGLRenderTarget;
  private bloomA: THREE.WebGLRenderTarget;
  private bloomB: THREE.WebGLRenderTarget;

  private prepassScene = new THREE.Scene();
  private fsScene = new THREE.Scene();
  private fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private tri: THREE.Mesh;

  private prepassMat: THREE.ShaderMaterial;
  private brightMat: THREE.ShaderMaterial;
  private blurMat: THREE.ShaderMaterial;
  private compMat: THREE.ShaderMaterial;

  // tunable / animated inputs
  speed01 = 0;       // 0..1 from velocity
  boost01 = 0;       // 0..1 while boosting
  flash = 0;         // impact frame energy 0..1 (decays fast)
  whiteFlash = 0;    // pure additive flash
  desat = 0;         // hitstop desaturation
  edgeStrength = 1.0;
  vanishPoint = new THREE.Vector2(0.5, 0.42);

  constructor(private renderer: THREE.WebGLRenderer,
              private scene: THREE.Scene,
              private camera: THREE.PerspectiveCamera) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());

    this.sceneRT = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
    });
    this.normRT = new THREE.WebGLRenderTarget(Math.ceil(size.x / 2), Math.ceil(size.y / 2), {
      type: THREE.HalfFloatType,
      depthBuffer: true,
    });
    const bw = Math.max(2, Math.floor(size.x / 4)), bh = Math.max(2, Math.floor(size.y / 4));
    const opts = { type: THREE.HalfFloatType, depthBuffer: false } as const;
    this.bloomA = new THREE.WebGLRenderTarget(bw, bh, opts);
    this.bloomB = new THREE.WebGLRenderTarget(bw, bh, opts);

    // ---- normal+depth override material ----
    this.prepassMat = new THREE.ShaderMaterial({
      vertexShader: /* glsl */`
        varying vec3 vN;
        varying float vZ;
        void main() {
          vN = normalize(normalMatrix * normal);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vZ = -mv.z;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */`
        varying vec3 vN;
        varying float vZ;
        void main() {
          gl_FragColor = vec4(normalize(vN) * 0.5 + 0.5, clamp(vZ / 3000.0, 0.0, 1.0));
        }
      `,
    });

    const quadGeo = new THREE.BufferGeometry();
    quadGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    quadGeo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this.tri = new THREE.Mesh(quadGeo, undefined as unknown as THREE.Material);
    this.fsScene.add(this.tri);

    const texSize = new THREE.Vector2();
    renderer.getDrawingBufferSize(texSize);

    // ---- bright pass ----
    this.brightMat = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThresh: { value: 0.86 } },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */`
        varying vec2 vUv;
        uniform sampler2D tSrc;
        uniform vec2 uTexel;
        uniform float uThresh;
        void main() {
          vec3 c = texture2D(tSrc, vUv).rgb;
          // 4-tap downsample for stability
          c += texture2D(tSrc, vUv + uTexel * vec2(1.5, 0.5)).rgb;
          c += texture2D(tSrc, vUv + uTexel * vec2(0.5, 1.5)).rgb;
          c += texture2D(tSrc, vUv + uTexel * vec2(1.5, 1.5)).rgb;
          c *= 0.25;
          float l = max(max(c.r, c.g), c.b);
          gl_FragColor = vec4(c * step(uThresh, l), 1.0);
        }
      `,
    });

    // ---- separable blur ----
    this.blurMat = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null }, uDir: { value: new THREE.Vector2() }, uTexel: { value: new THREE.Vector2() } },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */`
        varying vec2 vUv;
        uniform sampler2D tSrc;
        uniform vec2 uDir;
        uniform vec2 uTexel;
        void main() {
          vec3 c = texture2D(tSrc, vUv).rgb * 0.227;
          vec2 o1 = uDir * uTexel * 1.3846;
          vec2 o2 = uDir * uTexel * 3.2308;
          c += texture2D(tSrc, vUv + o1).rgb * 0.316;
          c += texture2D(tSrc, vUv - o1).rgb * 0.316;
          c += texture2D(tSrc, vUv + o2).rgb * 0.070;
          c += texture2D(tSrc, vUv - o2).rgb * 0.070;
          gl_FragColor = vec4(c, 1.0);
        }
      `,
    });

    // ---- composite ----
    this.compMat = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: null },
        tNorm: { value: null },
        tBloom: { value: null },
        uTexel: { value: new THREE.Vector2(1 / size.x, 1 / size.y) },
        uNormTexel: { value: new THREE.Vector2(2 / size.x, 2 / size.y) },
        uEdgeStrength: { value: 1 },
        uSpeed: { value: 0 },
        uBoost: { value: 0 },
        uFlash: { value: 0 },
        uWhiteFlash: { value: 0 },
        uDesat: { value: 0 },
        uTime: { value: 0 },
        uVanish: { value: this.vanishPoint },
        uInk: { value: new THREE.Color(0x241c16) },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */`
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D tScene;
        uniform sampler2D tNorm;
        uniform sampler2D tBloom;
        uniform vec2 uTexel;
        uniform vec2 uNormTexel;
        uniform float uEdgeStrength;
        uniform float uSpeed;
        uniform float uBoost;
        uniform float uFlash;
        uniform float uWhiteFlash;
        uniform float uDesat;
        uniform float uTime;
        uniform vec2 uVanish;
        uniform vec3 uInk;

        float nDepth(vec2 uv) { return texture2D(tNorm, uv).a * 3000.0; }
        vec3 nNrm(vec2 uv) { return texture2D(tNorm, uv).rgb * 2.0 - 1.0; }
        float hash(float n) { return fract(sin(n) * 43758.5453); }

        void main() {
          vec3 scene = texture2D(tScene, vUv).rgb;

          // ---- Sobel over normal+depth prepass ------------------------------
          // texels with depth 0 are sky (no geometry in prepass): never edges
          float dC = nDepth(vUv);
          float dL = nDepth(vUv - vec2(uNormTexel.x, 0.));
          float dR = nDepth(vUv + vec2(uNormTexel.x, 0.));
          float dU = nDepth(vUv + vec2(0., uNormTexel.y));
          float dD = nDepth(vUv - vec2(0., uNormTexel.y));
          float skyMask = step(0.0001, dC) * step(0.0001, dL) * step(0.0001, dR)
                        * step(0.0001, dU) * step(0.0001, dD);
          float gxD = dR - dL, gyD = dU - dD;
          float depthEdge = length(vec2(gxD, gyD)) * 0.06;

          vec3 nL = nNrm(vUv - vec2(uNormTexel.x, 0.));
          vec3 nR = nNrm(vUv + vec2(uNormTexel.x, 0.));
          vec3 nU = nNrm(vUv + vec2(0., uNormTexel.y));
          vec3 nD = nNrm(vUv - vec2(0., uNormTexel.y));
          float normEdge = 1.0 - max(dot(nL, nR), max(dot(nU, nD), 0.001));

          float edge = max(smoothstep(0.35, 0.75, depthEdge), smoothstep(0.28, 0.55, normEdge));
          edge *= uEdgeStrength * skyMask;
          // fade interior lines out with distance — distant ridges stay paper-flat
          float distFade = 1.0 - smoothstep(700.0, 1800.0, nDepth(vUv));
          edge *= mix(0.35, 1.0, distFade);
          vec3 col = mix(scene, uInk, clamp(edge, 0.0, 1.0) * 0.85);

          // ---- radial speed lines -------------------------------------------
          vec2 dir = vUv - uVanish;
          dir.x *= 1.77; // correct aspect so streaks are radial in screen space
          float r = length(dir);
          float ang = atan(dir.y, dir.x);
          float lines = 0.0;
          float intensity = max(uSpeed * 0.5 - 0.18, 0.0) + uBoost * 1.15;
          if (intensity > 0.01 && r > 0.12) {
            float bins = 90.0;
            float b = floor((ang / 6.2831853 + 0.5) * bins);
            float flicker = hash(b * 7.13 + floor(uTime * 22.0));
            float thresh = 1.0 - min(intensity, 0.92);
            if (flicker > thresh) {
              float taper = smoothstep(0.14, 0.45, r);
              lines = taper * (0.35 + uBoost * 0.65);
            }
            // second finer ring of lines at high intensity
            float b2 = floor((ang / 6.2831853 + 0.5) * bins * 2.7);
            if (uBoost > 0.25 && hash(b2 * 3.71 + floor(uTime * 30.0)) > 0.86) {
              lines += smoothstep(0.2, 0.6, r) * 0.5;
            }
          }
          col = mix(col, uInk * 0.8, clamp(lines, 0.0, 1.0));

          // ---- bloom add -----------------------------------------------------
          col += texture2D(tBloom, vUv).rgb * 0.5;

          // ---- impact frame: posterise + contrast punch ----------------------
          if (uFlash > 0.001) {
            vec3 p = floor(col * 5.0) / 5.0;
            vec3 punched = pow(p * 1.5, vec3(1.4)) + vec3(0.08);
            col = mix(col, punched, uFlash * 0.75);
          }

          // ---- grade: dawn-gold LUT approximation ----------------------------
          float luma = dot(col, vec3(0.299, 0.587, 0.114));
          col = mix(vec3(luma), col, 1.14);                          // saturation
          col += (1.0 - luma) * vec3(-0.015, 0.004, 0.045);          // teal shadows
          col += pow(luma, 2.0) * vec3(0.055, 0.03, -0.015);         // gold highs
          col = col * 1.03 - 0.012;                                  // gentle S-curve

          // hitstop desat
          col = mix(col, vec3(dot(col, vec3(0.3333))) * 0.9, uDesat * 0.7);
          col += uWhiteFlash;

          // quantised vignette (keeps the frame graphic)
          float vig = smoothstep(1.25, 0.45, r / 1.4);
          col *= mix(1.0, vig, 0.25);

          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
  }

  /** Objects hidden during the line-detect prepass (sky reads as clean paper). */
  private prepassExclude: THREE.Object3D[] = [];
  registerPrepassExclude(o: THREE.Object3D): void { this.prepassExclude.push(o); }

  setSize(width: number, height: number): void {
    const s = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    void width; void height;
    this.sceneRT.setSize(s.x, s.y);
    this.normRT.setSize(Math.max(2, Math.ceil(s.x / 2)), Math.max(2, Math.ceil(s.y / 2)));
    this.bloomA.setSize(Math.max(2, Math.floor(s.x / 4)), Math.max(2, Math.floor(s.y / 4)));
    this.bloomB.setSize(Math.max(2, Math.floor(s.x / 4)), Math.max(2, Math.floor(s.y / 4)));
    this.compMat.uniforms.uTexel.value.set(1 / s.x, 1 / s.y);
    this.compMat.uniforms.uNormTexel.value.set(2 / s.x, 2 / s.y);
  }

  render(): void {
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();

    // 1. scene colour
    r.setRenderTarget(this.sceneRT);
    r.render(this.scene, this.camera);

    // 2. normal+depth prepass at half res with override material
    const vis: boolean[] = this.prepassExclude.map((o) => o.visible);
    this.prepassExclude.forEach((o) => (o.visible = false));
    const oldOverride = this.scene.overrideMaterial;
    this.scene.overrideMaterial = this.prepassMat;
    r.setRenderTarget(this.normRT);
    r.render(this.scene, this.camera);
    this.scene.overrideMaterial = oldOverride;
    this.prepassExclude.forEach((o, i) => (o.visible = vis[i]));

    // 3. bloom chain — two blur iterations for a wide, painterly glow
    this.blit(this.sceneRT.texture, this.bloomA, this.brightMat);
    for (let i = 0; i < 2; i++) {
      this.blurMat.uniforms.uDir.value.set(1, 0);
      this.blit(this.bloomA.texture, this.bloomB, this.blurMat);
      this.blurMat.uniforms.uDir.value.set(0, 1);
      this.blit(this.bloomB.texture, this.bloomA, this.blurMat);
    }

    // 4. composite to screen
    const u = this.compMat.uniforms;
    u.tScene.value = this.sceneRT.texture;
    u.tNorm.value = this.normRT.texture;
    u.tBloom.value = this.bloomA.texture;
    u.uSpeed.value = this.speed01;
    u.uBoost.value = this.boost01;
    u.uFlash.value = this.flash;
    u.uWhiteFlash.value = this.whiteFlash;
    u.uDesat.value = this.desat;
    u.uTime.value = G_time;
    u.uEdgeStrength.value = this.edgeStrength;
    u.uVanish.value.copy(this.vanishPoint);
    this.tri.material = this.compMat;
    r.setRenderTarget(null);
    r.render(this.fsScene, this.fsCam);

    r.setRenderTarget(prevTarget);
  }

  private blit(src: THREE.Texture, dst: THREE.WebGLRenderTarget, mat: THREE.ShaderMaterial): void {
    mat.uniforms.tSrc.value = src;
    this.tri.material = mat;
    this.renderer.setRenderTarget(dst);
    this.renderer.render(this.fsScene, this.fsCam);
  }

  dispose(): void {
    this.sceneRT.dispose(); this.normRT.dispose();
    this.bloomA.dispose(); this.bloomB.dispose();
  }
}

// shared clock value written by the engine each frame
export let G_time = 0;
export function setGlobalTime(t: number): void { G_time = t; }
