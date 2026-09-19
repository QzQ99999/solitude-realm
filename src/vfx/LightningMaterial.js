import { ShaderMaterial, AdditiveBlending, Color, DoubleSide, Vector3 } from 'three';
import { noiseGLSL } from './NoiseGLSL.js';
import { sharedUniforms } from './FrameUniforms.js';

/**
 * LightningMaterial.js — 程序化闪电材质。
 *
 * 移植自 elemental-sandbox（MIT）。整道闪电都活在顶点着色器里：
 * 顶点以 `(t, side)` 到达——沿闪电走了多远、在条带的哪条边——然后作为
 * 世界坐标离开。形状由三层堆叠：
 *
 *   1. **轴线** —— 手到命中点的直线，被 sag 压弯。
 *   2. **扇面** —— 每根丝在垂直平面上的固定偏移，从近端 spreadNear 张开到
 *      远端 spread，绕轴按 twist 滚转。它把一根丝与下一根分开。
 *   3. **折角** —— *线性*插值的值噪声倍频。线性是有意的：smoothstep 会把
 *      棱角磨圆，而棱角正是它读作闪电而非软管的全部理由。
 *
 * 条带再靠局部切向叉乘视线转向相机，所以从任何角度看粗细都对。
 */
export const BoltPass = Object.freeze({
  CORE: 0, // 灼热的丝本身
  GLOW: 1 // 丝坐落的宽晕
});

/** 闪电的默认参数（= 沙盒 settings.thunder 的出厂值）。 */
export function thunderConfig(overrides = {}) {
  return {
    sag: 0.22,
    strands: 9,
    spread: 0.75,
    spreadNear: 0.05,
    spreadCurve: 1.6,
    twist: 0.45,
    twistSpeed: 0.8,
    branchDim: 0.72,
    jitter: 0.34,
    jitterScale: 0.85,
    octaves: 4,
    jitterFalloff: 0.55,
    crawl: 3.2,
    pinch: 0.14,
    converge: 0.8,
    width: 0.025,
    widthTip: 0.43,
    widthCurve: 1.09,
    coreWidth: 1.31,
    coreSharp: 4.95,
    glowWidth: 5.7,
    glowFalloff: 2.4,
    glowOpacity: 0.49,
    restrike: 24,
    flicker: 0.3,
    flickerSpeed: 34,
    strandFlash: 0.5,
    tipGlow: 2,
    tipLength: 0.08,
    glow: 2.3,
    opacity: 1,
    colorCore: '#ffffff',
    colorInner: '#c9ecff',
    colorOuter: '#3aa0ff',
    colorHalo: '#0b3fc8',
    ...overrides
  };
}

const BOLT_VERTEX = /* glsl */ `
  #define PI  3.141592653589793
  #define TAU 6.283185307179586

  uniform float uTime;
  uniform vec3  uOrigin;
  uniform vec3  uTarget;
  uniform vec3  uSide;
  uniform float uSag;
  uniform float uSeed;
  uniform float uRestrike;

  uniform float uStrands;
  uniform float uSpread;
  uniform float uSpreadNear;
  uniform float uSpreadCurve;
  uniform float uTwist;
  uniform float uTwistSpeed;

  uniform float uJitter;
  uniform float uJitterScale;
  uniform float uOctaves;
  uniform float uJitterFalloff;
  uniform float uCrawl;
  uniform float uPinch;
  uniform float uConverge;

  uniform float uWidth;
  uniform float uWidthTip;
  uniform float uWidthCurve;
  uniform float uCoreWidth;
  uniform float uWidthScale;
  uniform float uStrandFlash;
  uniform float uFlickerSpeed;
  uniform float uFade;

  attribute float aStrand;

  varying float vT;
  varying float vSide;
  varying float vStrand;
  varying float vFlash;
  varying float vViewZ;

  ${noiseGLSL}

  /** *线性*斜坡的值噪声 —— 分段线性输出，锋利的棱角。 */
  float vnoise(float x, float seed) {
    float i = floor(x);
    float f = x - i;
    return mix(hash11(i + seed), hash11(i + 1.0 + seed), f) * 2.0 - 1.0;
  }

  /**
   * 一根丝相对轴线的偏移，在垂直平面内。span 是施法长度，
   * 让 uJitterScale 始终是每*米*的折角数。
   */
  vec2 kink(float t, float seed, float span) {
    vec2 o = vec2(0.0);
    float amp = 1.0;
    float freq = max(uJitterScale, 0.01) * span;
    float scroll = uTime * uCrawl;

    // 固定次数 + 逐倍频门控：动态次数不可移植，
    // 而且五次乘加比分支便宜。
    for (int i = 0; i < 5; i++) {
      float on = step(float(i), uOctaves - 1.0);
      o.x += on * amp * vnoise(t * freq + scroll, seed + 13.0 * float(i));
      o.y += on * amp * vnoise(t * freq + scroll * 1.17, seed + 71.3 + 13.0 * float(i));
      amp *= uJitterFalloff;
      freq *= 2.0;
      scroll *= 1.63;
    }
    return o;
  }

  vec3 boltPoint(float t, float seed, float radial, vec3 n1, vec3 n2, float span) {
    vec3 axis = mix(uOrigin, uTarget, t);
    axis.y += uSag * sin(t * PI);

    // 永远钉死在手上；命中端按 uConverge 的要求钉死——
    // 闪电落在没瞄准的地方读作 bug。
    float pinch = max(uPinch, 1e-3);
    float ends = smoothstep(0.0, pinch, t) *
                 mix(1.0, smoothstep(0.0, pinch, 1.0 - t), clamp(uConverge, 0.0, 1.0));

    vec2 offset = kink(t, seed, span) * uJitter * ends;

    float angle = seed * TAU + (t * uTwist + uTime * uTwistSpeed) * TAU;
    float reach = mix(uSpreadNear, uSpread, pow(clamp(t, 0.0, 1.0), max(uSpreadCurve, 0.01)));
    offset += vec2(cos(angle), sin(angle)) * reach * radial;

    return axis + n1 * offset.x + n2 * offset.y;
  }

  void main() {
    float t = position.x;
    float side = position.y;
    vT = t;
    vSide = side;

    /* ---- 偏移所在的标架 ---- */
    vec3 delta = uTarget - uOrigin;
    float span = max(length(delta), 0.01);
    vec3 dir = delta / span;
    // Gram-Schmidt 而不是裸侧向：轴向下倾，uSide 只是近似垂直。
    vec3 n1 = uSide - dir * dot(uSide, dir);
    n1 = length(n1) > 1e-4 ? normalize(n1) : normalize(cross(dir, vec3(0.0, 1.0, 0.0)));
    vec3 n2 = normalize(cross(dir, n1));

    /* ---- 这是哪根丝，它穿着什么形状 ---- */
    // strike 序号每秒把所有丝换到 uRestrike 次新形状；kink() 里的爬行
    // 在间隙里连续滑动。两者一起避免持续闪电像一条静止的带子。
    float strike = floor(uTime * max(uRestrike, 0.01));
    float seed = hash11(aStrand * 7.13 + uSeed + strike * 3.77) * 97.0;
    float radial = uStrands <= 1.0 ? 0.0 : aStrand / (uStrands - 1.0);
    vStrand = radial;

    vec3 here = boltPoint(t, seed, radial, n1, n2, span);

    // 有限差分切向，远端镜像。
    float step_ = 0.02;
    float ahead = t + step_;
    float flip = 1.0;
    if (ahead > 1.0) { ahead = t - step_; flip = -1.0; }
    vec3 next = boltPoint(ahead, seed, radial, n1, n2, span);
    vec3 tangent = (next - here) * flip;
    tangent = length(tangent) > 1e-5 ? normalize(tangent) : dir;

    /* ---- 把条带转向相机 ---- */
    vec3 toCamera = normalize(cameraPosition - here);
    vec3 binormal = cross(tangent, toCamera);
    float bl = length(binormal);
    binormal = bl > 1e-4 ? binormal / bl : n1;

    /* ---- 宽度 ---- */
    // 逐丝的结巴闪烁，量化到 uFlickerSpeed：整束闪在同一时钟上。
    float flash = mix(1.0, hash11(floor(uTime * uFlickerSpeed) + aStrand * 3.7 + uSeed), uStrandFlash);
    vFlash = flash;

    float halfWidth = uWidth * uWidthScale;
    halfWidth *= mix(1.0, uWidthTip, pow(clamp(t, 0.0, 1.0), max(uWidthCurve, 0.01)));
    halfWidth *= mix(uCoreWidth, 1.0, radial);
    halfWidth *= flash * uFade;

    // 全程世界空间。
    vec4 mv = viewMatrix * vec4(here + binormal * side * halfWidth, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const BOLT_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uSeed;
  uniform float uProgress;
  uniform float uTipGlow;
  uniform float uTipLength;
  uniform float uCoreSharp;
  uniform float uGlowFalloff;
  uniform float uBranchDim;
  uniform float uFlicker;
  uniform float uFlickerSpeed;
  uniform float uPassOpacity;
  uniform float uOpacity;
  uniform float uGlow;
  uniform float uFade;
  uniform vec3  uColorCore;
  uniform vec3  uColorInner;
  uniform vec3  uColorOuter;
  uniform vec3  uColorHalo;

  varying float vT;
  varying float vSide;
  varying float vStrand;
  varying float vFlash;
  varying float vViewZ;

  ${noiseGLSL}

  void main() {
    // 前沿之前没有闪电。条带整体绘制、在这里裁剪而不是缩放：
    // 前沿推进时*形状*不变——只是它存在多少在变。
    float tip = max(uTipLength, 1e-3);
    float drawn = smoothstep(uProgress, uProgress - tip, vT);
    if (drawn <= 0.002) discard;

    float v = clamp(abs(vSide), 0.0, 1.0);

    #ifdef BOLT_GLOW
      float profile = pow(1.0 - v, max(uGlowFalloff, 0.05));
      vec3 color = mix(uColorHalo, uColorOuter, profile);
      float alpha = profile;
    #else
      float profile = pow(1.0 - v, max(uCoreSharp, 0.05));
      vec3 color = mix(uColorOuter, uColorInner, smoothstep(0.0, 0.5, profile));
      color = mix(color, uColorCore, smoothstep(0.45, 1.0, profile));
      float alpha = profile;
    #endif

    // 前沿是空气真正被击穿的地方。
    color += uColorCore * smoothstep(uProgress - tip * 2.0, uProgress, vT) * uTipGlow;

    // 量化而非正弦：真闪电在亮度间结巴，不会呼吸。
    float flicker = 1.0 - uFlicker * hash11(floor(uTime * uFlickerSpeed) + uSeed);

    alpha *= drawn * flicker * vFlash * uFade * uPassOpacity * uOpacity;
    alpha *= mix(1.0, clamp(uBranchDim, 0.0, 1.0), vStrand);

    if (alpha < 0.003) discard;

    color *= uGlow;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * 闪电的一个 pass。两个 pass 共享除 `uWidthScale` / `uPassOpacity` 外的全部
 * uniform，`userData.sync()` 可以把同一个状态递给两个。
 *
 * @param {number} pass   BoltPass.*
 * @param {object} config thunderConfig() 的返回值（可被调用方持续覆写）
 */
export function createLightningMaterial(pass = BoltPass.CORE, config) {
  const c = config;
  const glow = pass === BoltPass.GLOW;

  const material = new ShaderMaterial({
    defines: glow ? { BOLT_GLOW: '' } : {},
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uOrigin: { value: new Vector3() },
      uTarget: { value: new Vector3(0, 0, 1) },
      uSide: { value: new Vector3(1, 0, 0) },
      uSag: { value: c.sag },
      uSeed: { value: 0 },
      uRestrike: { value: c.restrike },
      uProgress: { value: 0 },
      uFade: { value: 1 },

      uStrands: { value: c.strands },
      uSpread: { value: c.spread },
      uSpreadNear: { value: c.spreadNear },
      uSpreadCurve: { value: c.spreadCurve },
      uTwist: { value: c.twist },
      uTwistSpeed: { value: c.twistSpeed },
      uBranchDim: { value: c.branchDim },

      uJitter: { value: c.jitter },
      uJitterScale: { value: c.jitterScale },
      uOctaves: { value: c.octaves },
      uJitterFalloff: { value: c.jitterFalloff },
      uCrawl: { value: c.crawl },
      uPinch: { value: c.pinch },
      uConverge: { value: c.converge },

      uWidth: { value: c.width },
      uWidthTip: { value: c.widthTip },
      uWidthCurve: { value: c.widthCurve },
      uCoreWidth: { value: c.coreWidth },
      uGlowFalloff: { value: c.glowFalloff },
      uCoreSharp: { value: c.coreSharp },
      uWidthScale: { value: glow ? c.glowWidth : 1 },
      uPassOpacity: { value: glow ? c.glowOpacity : 1 },

      uFlicker: { value: c.flicker },
      uFlickerSpeed: { value: c.flickerSpeed },
      uStrandFlash: { value: c.strandFlash },
      uTipGlow: { value: c.tipGlow },
      uTipLength: { value: c.tipLength },

      uOpacity: { value: c.opacity },
      uGlow: { value: c.glow },
      uColorCore: { value: new Color(c.colorCore) },
      uColorInner: { value: new Color(c.colorInner) },
      uColorOuter: { value: new Color(c.colorOuter) },
      uColorHalo: { value: new Color(c.colorHalo) }
    }),
    vertexShader: BOLT_VERTEX,
    fragmentShader: BOLT_FRAGMENT
  });

  /**
   * 推入当前施法状态。
   * @param {object} state { origin, target, side, progress, fade, seed, strands }
   */
  material.userData.sync = (state) => {
    const u = material.uniforms;

    u.uOrigin.value.copy(state.origin);
    u.uTarget.value.copy(state.target);
    u.uSide.value.copy(state.side);
    u.uSeed.value = state.seed;
    u.uProgress.value = state.progress;
    u.uFade.value = state.fade;
    u.uStrands.value = state.strands;

    // 配置可被调用方热改（换色等）——每帧回读。
    u.uGlow.value = c.glow;
    u.uOpacity.value = c.opacity;
    u.uColorCore.value.set(c.colorCore);
    u.uColorInner.value.set(c.colorInner);
    u.uColorOuter.value.set(c.colorOuter);
    u.uColorHalo.value.set(c.colorHalo);
  };

  return material;
}
