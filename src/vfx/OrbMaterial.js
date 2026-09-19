import { ShaderMaterial, AdditiveBlending, Color, FrontSide, Vector3 } from 'three';
import { noiseGLSL } from './NoiseGLSL.js';
import { commonGLSL } from './CommonGLSL.js';
import { sharedUniforms } from './FrameUniforms.js';

/**
 * OrbMaterial.js — 蓄能球：一枚被噪声啃噬的能量球。
 *
 * 从 elemental-sandbox（MIT）的 BeamMaterial 第六个 pass（ORB）抽出：
 * 普通攻击的能量弹、激光的蓄能头、光柱的蓄能球都用它。
 *
 * 表面细丝按硬阈值爬动：宽带会把球填满，读不出"被束缚的能量"。
 */
const ORB_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uSeed;
  uniform float uOrbTurbulence;
  uniform float uOrbScale;
  uniform float uOrbFlow;

  varying vec3  vNormalW;
  varying vec3  vViewDir;
  varying float vDisp;

  ${noiseGLSL}

  void main() {
    // 唯一走模型矩阵的 pass：调用方负责摆放与缩放。
    vec3 np = normal * uOrbScale + vec3(uSeed * 3.1) - vec3(0.0, uTime * uOrbFlow, 0.0);
    float n = fbm4(np) * 0.6 + ridged(np * 1.4, 4) * 0.4;
    vDisp = n;

    vec4 world = modelMatrix * vec4(position + normal * n * uOrbTurbulence, 1.0);
    vec3 here = world.xyz;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vViewDir = cameraPosition - here;

    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const ORB_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uSeed;
  uniform float uOrbFlow;
  uniform float uOrbBands;
  uniform float uOrbRim;
  uniform float uCharge;
  uniform float uOpacity;
  uniform float uGlow;
  uniform vec3  uColorCore;
  uniform vec3  uColorInner;
  uniform vec3  uColorOuter;

  varying vec3  vNormalW;
  varying vec3  vViewDir;
  varying float vDisp;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    float facing = abs(dot(normalize(vViewDir), normalize(vNormalW)));
    float rim = pow(1.0 - facing, max(uOrbRim, 0.05));
    float heat = clamp(vDisp * 0.5 + 0.5, 0.0, 1.0);
    // 在表面上爬的细丝，硬阈值：宽带会把球填满，立刻失去"被束缚的能量"感。
    float fil = smoothstep(0.74, 0.98,
      ridged(vNormalW * uOrbBands + vec3(0.0, uTime * uOrbFlow * 2.0, 0.0) + uSeed, 4));

    vec3 color = mix(uColorOuter, uColorInner, heat);
    color = mix(color, uColorCore, clamp(fil + rim * 0.35, 0.0, 1.0));
    color += uColorCore * fil * 1.6;
    float alpha = (0.2 + rim * 0.9 + fil * 0.75) * uCharge * uOpacity;
    if (alpha < 0.003) discard;

    color *= uGlow;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * @param {object} [opts] { seed, turbulence, scale, flow, bands, rim,
 *                          core, inner, outer, glow, opacity }
 */
export function createOrbMaterial(opts = {}) {
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: FrontSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uSeed: { value: opts.seed ?? Math.random() * 10 },
      uOrbTurbulence: { value: opts.turbulence ?? 0.22 },
      uOrbScale: { value: opts.scale ?? 2.2 },
      uOrbFlow: { value: opts.flow ?? 0.9 },
      uOrbBands: { value: opts.bands ?? 5 },
      uOrbRim: { value: opts.rim ?? 1.8 },
      uCharge: { value: 1 },
      uOpacity: { value: opts.opacity ?? 1 },
      uGlow: { value: opts.glow ?? 2.8 },
      uColorCore: { value: new Color(opts.core ?? '#ffffff') },
      uColorInner: { value: new Color(opts.inner ?? '#d3f4ff') },
      uColorOuter: { value: new Color(opts.outer ?? '#3ec6ff') }
    }),
    vertexShader: ORB_VERTEX,
    fragmentShader: ORB_FRAGMENT
  });

  /** 按 16 进制串热更换配色（元素切换 / 领域换色）。 */
  material.userData.setPalette = ({ core, inner, outer, glow }) => {
    if (core) material.uniforms.uColorCore.value.set(core);
    if (inner) material.uniforms.uColorInner.value.set(inner);
    if (outer) material.uniforms.uColorOuter.value.set(outer);
    if (glow !== undefined) material.uniforms.uGlow.value = glow;
  };

  return material;
}
