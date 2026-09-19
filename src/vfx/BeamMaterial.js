import { ShaderMaterial, AdditiveBlending, Color, DoubleSide, Vector3 } from 'three';
import { noiseGLSL } from './NoiseGLSL.js';
import { sharedUniforms } from './FrameUniforms.js';

/**
 * BeamMaterial.js — 参数化光束材质。
 *
 * 移植自 elemental-sandbox（MIT）：https://github.com/achrefelouafi/LinearAbiltyCastingThreeJS
 *
 * 光束画五遍。前三遍是同一根管按三个半径叠画——这一叠就是整套观感的诀窍：
 *
 *   HALO  —— 最宽，只剩边缘项。光束推开的大气。
 *   SHELL —— 鞘：按边缘加权，读作*空心*，剪影边最亮。
 *   CORE  —— 最窄，反向加权：视线顺炮管穿过最长处最亮。中段因此读作
 *            一根白热实心棒，而不是带描边的圆柱。
 *
 * 外层按边缘、内层按轴向、双面相加：这是一次廉价的体积积分。然后 COIL
 * 与 RING 把结构*放上去*。（原版的第六遍蓄能球抽到 OrbMaterial 里单独用。）
 */
export const BeamPass = Object.freeze({
  CORE: 0, // 白热的棒身
  SHELL: 1, // 包住它的鞘
  HALO: 2, // 宽阔的外层辉光
  COIL: 3, // 绕柱螺旋的条带
  RING: 4 // 向远方竞速的冲击环
});

/** 光束的默认造型参数（= 沙盒 settings.beam 的出厂值）。调用方可按需覆写。 */
export function beamConfig(overrides = {}) {
  return {
    radius: 0.77,
    radiusNear: 0.16,
    radiusCurve: 1.27,
    flare: 1.74,
    flareWidth: 0.09,
    throb: 0,
    throbScale: 4.8,
    throbSpeed: 2.6,
    wander: 0,
    wanderScale: 0.9,
    wanderSpeed: 0.7,
    ripple: 0.2,
    rippleBands: 2.2,
    rippleScale: 4.25,
    rippleSpeed: 2,
    streak: 1.1,
    streakSharp: 0.45,
    streakScale: 4.2,
    streakBands: 1.8,
    streakGlow: 0.55,
    flowSpeed: 7,
    coreWidth: 0.2,
    coreSharp: 1.55,
    coreFill: 0.6,
    shellWidth: 1,
    shellRim: 1.15,
    shellFill: 0.18,
    shellOpacity: 0.95,
    haloWidth: 2.75,
    haloRim: 4.3,
    haloOpacity: 0.14,
    edgePower: 2.2,
    mouthGlow: 1.6,
    mouthLength: 0.1,
    tipGlow: 0.6,
    tipLength: 0.09,
    coils: 4,
    coilTurns: 1.45,
    coilSpeed: -0.69,
    coilRadius: 1.88,
    coilFlare: 0.57,
    coilWidth: 0.1,
    coilWidthTip: 1.9,
    coilSharp: 2.2,
    coilPulse: 0.65,
    coilPulseFreq: 3,
    coilPulseSpeed: 1.6,
    coilGlow: 8,
    coilOpacity: 2,
    rings: 10,
    ringSpeed: 1.31,
    ringInner: 2.42,
    ringOuter: 2.73,
    ringSwell: 0.55,
    ringFade: 0.18,
    ringSharp: 1.6,
    ringGlow: 2.4,
    ringOpacity: 0.7,
    glow: 0.74,
    opacity: 0.29,
    colorCore: '#ffffff',
    colorInner: '#d3f4ff',
    colorOuter: '#3ec6ff',
    colorHalo: '#0d3ce0',
    colorCoil: '#ffdc8c',
    colorCoilEdge: '#ff6a12',
    colorRing: '#9ceeff',
    ...overrides
  };
}

const BEAM_UNIFORMS = /* glsl */ `
  #define PI  3.141592653589793
  #define TAU 6.283185307179586

  uniform float uTime;
  uniform vec3  uOrigin;
  uniform vec3  uTarget;
  uniform vec3  uSide;
  uniform float uSeed;
  uniform float uProgress;
  uniform float uFade;
  uniform float uWidthFade;

  uniform float uRadius;
  uniform float uRadiusNear;
  uniform float uRadiusCurve;
  uniform float uRadiusScale;
  uniform float uFlare;
  uniform float uFlareWidth;
  uniform float uThrob;
  uniform float uThrobScale;
  uniform float uThrobSpeed;
  uniform float uWander;
  uniform float uWanderScale;
  uniform float uWanderSpeed;

  uniform float uRipple;
  uniform float uRippleBands;
  uniform float uRippleScale;
  uniform float uRippleSpeed;

  uniform float uStreak;
  uniform float uStreakSharp;
  uniform float uStreakScale;
  uniform float uStreakBands;
  uniform float uStreakGlow;
  uniform float uFlowSpeed;

  uniform float uCoreSharp;
  uniform float uCoreFill;
  uniform float uEdgePower;
  uniform float uShellRim;
  uniform float uShellFill;
  uniform float uHaloRim;
  uniform float uPassOpacity;

  uniform float uMouthGlow;
  uniform float uMouthLength;
  uniform float uTipGlow;
  uniform float uTipLength;

  uniform float uCoils;
  uniform float uCoilTurns;
  uniform float uCoilSpeed;
  uniform float uCoilRadius;
  uniform float uCoilFlare;
  uniform float uCoilWidth;
  uniform float uCoilWidthTip;
  uniform float uCoilSharp;
  uniform float uCoilPulse;
  uniform float uCoilPulseFreq;
  uniform float uCoilPulseSpeed;

  uniform float uRingCount;
  uniform float uRingSpeed;
  uniform float uRingInner;
  uniform float uRingOuter;
  uniform float uRingSwell;
  uniform float uRingFade;
  uniform float uRingSharp;

  uniform float uOpacity;
  uniform float uGlow;
  uniform vec3  uColorCore;
  uniform vec3  uColorInner;
  uniform vec3  uColorOuter;
  uniform vec3  uColorHalo;
  uniform vec3  uColorCoil;
  uniform vec3  uColorCoilEdge;
  uniform vec3  uColorRing;
`;

const BEAM_VARYINGS = /* glsl */ `
  varying float vT;
  varying float vViewZ;

  #if BEAM_PASS <= 2
    varying float vA;
    varying float vFacing;
  #elif BEAM_PASS == 3
    varying float vSide;
  #else
    varying float vBand;
    varying float vPhase;
  #endif
`;

/**
 * 光束的形状，柱上每个 pass 共享。
 *
 * `beamRadius` 与 `beamAxis` 就是全部几何：管、螺旋带、冲击环都贴着这两个
 * 函数摆位，因此拖动半径/锥角时它们保持焊在一起。谁也不缓存它们——
 * 每顶点、每帧求值。
 */
const BEAM_SHAPE = /* glsl */ `
  /** t 处柱子的半宽，米。 */
  float beamRadius(float t) {
    float u = clamp(t, 0.0, 1.0);
    float r = mix(uRadiusNear, uRadius, pow(u, max(uRadiusCurve, 0.01)));
    // 沿柱传出的压力波。很小——这是光束的呼吸，不是香肠。
    r *= 1.0 + uThrob * sin((u * uThrobScale - uTime * uThrobSpeed) * TAU);
    // ...以及落点处张开的锥口。
    r *= 1.0 + uFlare * smoothstep(1.0 - max(uFlareWidth, 1e-3), 1.0, u);
    return max(r * uRadiusScale * uWidthFade, 1e-4);
  }

  /** 柱子的局部标架。n1/n2 张成横跨它的平面。 */
  void beamFrame(out vec3 dir, out vec3 n1, out vec3 n2) {
    vec3 delta = uTarget - uOrigin;
    float span = max(length(delta), 0.01);
    dir = delta / span;
    // Gram-Schmidt：轴自手部向下倾，uSide 只是近似垂直。
    vec3 lateral = uSide - dir * dot(uSide, dir);
    n1 = length(lateral) > 1e-4 ? normalize(lateral) : normalize(cross(dir, vec3(0.0, 1.0, 0.0)));
    n2 = normalize(cross(dir, n1));
  }

  /**
   * 柱轴上 t 处的一点。
   *
   * 低频漂移，两端钉死。刻意*平滑*：闪电的魅力是分段线性、保留棱角的噪声，
   * 这里正相反——会打结的光束就是闪电了。
   */
  vec3 beamAxis(float t, vec3 n1, vec3 n2) {
    vec3 p = mix(uOrigin, uTarget, t);
    float ends = sin(clamp(t, 0.0, 1.0) * PI);
    float dx = snoise(vec3(t * uWanderScale, uTime * uWanderSpeed, uSeed));
    float dy = snoise(vec3(t * uWanderScale + 31.7, uTime * uWanderSpeed, uSeed + 7.3));
    return p + (n1 * dx + n2 * dy) * uWander * ends;
  }
`;

const BEAM_VERTEX = /* glsl */ `
  ${BEAM_UNIFORMS}
  ${BEAM_VARYINGS}

  #if BEAM_PASS == 3
    attribute float aStrand;
  #endif
  #if BEAM_PASS == 4
    attribute float aRing;
  #endif

  ${noiseGLSL}
  ${BEAM_SHAPE}

  #if BEAM_PASS == 3
    /** 一根螺旋条带上的一点。 */
    vec3 coilPoint(float t, float phase, vec3 n1, vec3 n2) {
      float angle = (t * uCoilTurns + uTime * uCoilSpeed + phase) * TAU;
      float r = beamRadius(t) * uCoilRadius * (1.0 + uCoilFlare * pow(clamp(t, 0.0, 1.0), 3.0));
      return beamAxis(t, n1, n2) + (n1 * cos(angle) + n2 * sin(angle)) * r;
    }
  #endif

  void main() {
    vec3 dir, n1, n2;
    beamFrame(dir, n1, n2);

    #if BEAM_PASS <= 2                                    /* 柱体 */
      float t = position.x;
      float a = position.y;
      float angle = a * TAU;
      vec3 nrm = n1 * cos(angle) + n2 * sin(angle);

      // 把炮管打散，让它是一根气柱而不是机制管。噪声顺着流动爬向远方，
      // 而不是贴在管上不动。
      float rip = snoise(vec3(
        cos(angle) * uRippleBands,
        sin(angle) * uRippleBands,
        t * uRippleScale - uTime * uRippleSpeed + uSeed
      ));
      float r = beamRadius(t) * (1.0 + uRipple * rip);

      vec3 here = beamAxis(t, n1, n2) + nrm * r;
      vT = t;
      vA = a;
      // 1 = 顺炮管看，0 = 剪影。两种管的加权都由这一个数构造。
      vFacing = abs(dot(normalize(cameraPosition - here), nrm));

    #elif BEAM_PASS == 3                                  /* 螺旋带 */
      float t = position.x;
      vSide = position.y;
      vT = t;

      float phase = uCoils <= 1.0 ? 0.0 : aStrand / uCoils;
      phase += hash11(aStrand * 5.31 + uSeed) * 0.12;

      vec3 here = coilPoint(t, phase, n1, n2);

      // 有限差分切向，远端镜像，让最后一个节点也有邻居可看。
      float step_ = 0.015;
      float ahead = t + step_;
      float flip = 1.0;
      if (ahead > 1.0) { ahead = t - step_; flip = -1.0; }
      vec3 tangent = (coilPoint(ahead, phase, n1, n2) - here) * flip;
      tangent = length(tangent) > 1e-5 ? normalize(tangent) : dir;

      vec3 binormal = cross(tangent, normalize(cameraPosition - here));
      float bl = length(binormal);
      binormal = bl > 1e-4 ? binormal / bl : n1;

      float halfWidth = uCoilWidth * mix(1.0, uCoilWidthTip, clamp(t, 0.0, 1.0));
      // 炮口处收到一点，让条带从光束里长出来。
      halfWidth *= smoothstep(0.0, 0.05, t) * uWidthFade * uFade;
      here += binormal * position.y * halfWidth;

    #else                                                 /* 冲击环 */
      // 沿柱均匀布环、被时钟推向远方：整列环是时间的纯函数——CPU 无队列。
      float phase = fract(aRing / max(uRingCount, 1.0) + uTime * uRingSpeed + uSeed * 0.37);
      float t = phase;
      float angle = position.y * TAU;
      float r = beamRadius(t) * mix(uRingInner, uRingOuter, position.x) * (1.0 + uRingSwell * phase);

      vec3 here = beamAxis(t, n1, n2) + (n1 * cos(angle) + n2 * sin(angle)) * r;
      vT = t;
      vBand = position.x;
      vPhase = phase;
    #endif

    vec4 mv = viewMatrix * vec4(here, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const BEAM_FRAGMENT = /* glsl */ `
  ${BEAM_UNIFORMS}
  ${BEAM_VARYINGS}

  ${noiseGLSL}

  void main() {
    vec3 color = vec3(0.0);
    float alpha = 0.0;

    // 前沿之前没有光束。柱子整体建成、在这里裁剪而不是缩放，因此前沿推进时
    // 它的*形状*不变——只是它存在多少在变。
    float tip = max(uTipLength, 1e-3);
    float drawn = smoothstep(uProgress, uProgress - tip, vT);
    if (drawn <= 0.002) discard;

    #if BEAM_PASS <= 2                                  /* 柱体 */
      float angle = vA * TAU;
      // 向远方流淌的细丝，沿轴拉得很扁：这是被推进炮膛的气体。
      float flow = ridged(vec3(
        vT * uStreakScale - uTime * uFlowSpeed,
        cos(angle) * uStreakBands,
        sin(angle) * uStreakBands + uSeed
      ), 4);
      float streak = smoothstep(mix(0.42, 0.86, clamp(uStreakSharp, 0.0, 1.0)), 0.99, flow) * uStreak;

      float facing = clamp(vFacing, 0.0, 1.0);
      float axisward = pow(facing, max(uCoreSharp, 0.05));
      float rim = pow(1.0 - facing, max(uEdgePower, 0.05));

      #if BEAM_PASS == 0                                /* CORE */
        color = mix(uColorInner, uColorCore, clamp(0.35 + streak, 0.0, 1.0));
        alpha = uCoreFill * mix(0.28, 1.0, axisward) + streak * 0.35;

      #elif BEAM_PASS == 1                              /* SHELL */
        color = mix(uColorOuter, uColorInner, clamp(rim * 0.55 + streak, 0.0, 1.0));
        color += uColorCore * streak * uStreakGlow;
        alpha = rim * uShellRim + uShellFill * mix(0.12, 1.0, axisward) + streak * 0.4;

      #else                                             /* HALO */
        float wide = pow(1.0 - facing, max(uHaloRim, 0.05));
        color = mix(uColorHalo, uColorOuter, wide);
        alpha = wide;
      #endif

      // 炮口：光柱正被喂出来的地方。
      float mouth = smoothstep(uMouthLength, 0.0, vT);
      color += uColorCore * mouth * uMouthGlow;
      alpha += mouth * uMouthGlow * 0.2;

      // 行进中的前沿——落地后，是仍在烧进地面的白热端。
      float lead = smoothstep(uProgress - tip * 2.0, uProgress, vT);
      color += uColorCore * lead * uTipGlow;
      alpha += lead * uTipGlow * 0.18;

    #elif BEAM_PASS == 3                                /* 螺旋带 */
      float v = clamp(abs(vSide), 0.0, 1.0);
      float profile = pow(1.0 - v, max(uCoilSharp, 0.05));
      // 沿条带跑出去的电荷，避免螺旋读作绕柱的静止管道。
      float pulse = 0.5 + 0.5 * sin((vT * uCoilPulseFreq - uTime * uCoilPulseSpeed) * TAU);
      color = mix(uColorCoilEdge, uColorCoil, profile);
      color += uColorCore * pulse * profile * uCoilPulse;
      alpha = profile * mix(1.0 - clamp(uCoilPulse, 0.0, 0.9) * 0.5, 1.0, pulse);

    #else                                               /* 冲击环 */
      float band = 1.0 - abs(vBand * 2.0 - 1.0);
      float profile = pow(clamp(band, 0.0, 1.0), max(uRingSharp, 0.05));
      // 盘片奔向远方时变薄，背后的压力在掉。
      color = mix(uColorRing, uColorCore, profile);
      alpha = profile * mix(1.0, uRingFade, vPhase);
    #endif

    alpha *= drawn;
    alpha *= uFade * uOpacity * uPassOpacity;
    if (alpha < 0.003) discard;

    color *= uGlow;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * 光束的一个 pass。
 *
 * 每个 pass 共享同一 uniform 块和同一个 `userData.sync()`，能力把同一个
 * 状态对象递给全部五个；差别只在编译期 `BEAM_PASS` 与两个 pass 自有的
 * uniform：`uRadiusScale`（它是三层管半径里的哪一层）与 `uPassOpacity`。
 *
 * @param {number} pass     BeamPass.*
 * @param {object} config   beamConfig() 的返回值（可被调用方持续覆写）
 */
export function createBeamMaterial(pass = BeamPass.CORE, config) {
  const c = config;
  const material = new ShaderMaterial({
    defines: { BEAM_PASS: pass },
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
      uSeed: { value: 0 },
      uProgress: { value: 0 },
      uFade: { value: 1 },
      uWidthFade: { value: 1 },

      uRadius: { value: c.radius },
      uRadiusNear: { value: c.radiusNear },
      uRadiusCurve: { value: c.radiusCurve },
      uRadiusScale: { value: 1 },
      uFlare: { value: c.flare },
      uFlareWidth: { value: c.flareWidth },
      uThrob: { value: c.throb },
      uThrobScale: { value: c.throbScale },
      uThrobSpeed: { value: c.throbSpeed },
      uWander: { value: c.wander },
      uWanderScale: { value: c.wanderScale },
      uWanderSpeed: { value: c.wanderSpeed },

      uRipple: { value: c.ripple },
      uRippleBands: { value: c.rippleBands },
      uRippleScale: { value: c.rippleScale },
      uRippleSpeed: { value: c.rippleSpeed },

      uStreak: { value: c.streak },
      uStreakSharp: { value: c.streakSharp },
      uStreakScale: { value: c.streakScale },
      uStreakBands: { value: c.streakBands },
      uStreakGlow: { value: c.streakGlow },
      uFlowSpeed: { value: c.flowSpeed },

      uCoreSharp: { value: c.coreSharp },
      uCoreFill: { value: c.coreFill },
      uEdgePower: { value: c.edgePower },
      uShellRim: { value: c.shellRim },
      uShellFill: { value: c.shellFill },
      uHaloRim: { value: c.haloRim },
      uPassOpacity: { value: 1 },

      uMouthGlow: { value: c.mouthGlow },
      uMouthLength: { value: c.mouthLength },
      uTipGlow: { value: c.tipGlow },
      uTipLength: { value: c.tipLength },

      uCoils: { value: c.coils },
      uCoilTurns: { value: c.coilTurns },
      uCoilSpeed: { value: c.coilSpeed },
      uCoilRadius: { value: c.coilRadius },
      uCoilFlare: { value: c.coilFlare },
      uCoilWidth: { value: c.coilWidth },
      uCoilWidthTip: { value: c.coilWidthTip },
      uCoilSharp: { value: c.coilSharp },
      uCoilPulse: { value: c.coilPulse },
      uCoilPulseFreq: { value: c.coilPulseFreq },
      uCoilPulseSpeed: { value: c.coilPulseSpeed },

      uRingCount: { value: c.rings },
      uRingSpeed: { value: c.ringSpeed },
      uRingInner: { value: c.ringInner },
      uRingOuter: { value: c.ringOuter },
      uRingSwell: { value: c.ringSwell },
      uRingFade: { value: c.ringFade },
      uRingSharp: { value: c.ringSharp },

      uOpacity: { value: c.opacity },
      uGlow: { value: c.glow },
      uColorCore: { value: new Color(c.colorCore) },
      uColorInner: { value: new Color(c.colorInner) },
      uColorOuter: { value: new Color(c.colorOuter) },
      uColorHalo: { value: new Color(c.colorHalo) },
      uColorCoil: { value: new Color(c.colorCoil) },
      uColorCoilEdge: { value: new Color(c.colorCoilEdge) },
      uColorRing: { value: new Color(c.colorRing) }
    }),
    vertexShader: BEAM_VERTEX,
    fragmentShader: BEAM_FRAGMENT
  });

  /**
   * 把当前施法状态推进 uniform。
   * @param {object} state { origin, target, side, progress, fade, widthFade, seed, coils, rings }
   */
  material.userData.sync = (state) => {
    const u = material.uniforms;

    u.uOrigin.value.copy(state.origin);
    u.uTarget.value.copy(state.target);
    u.uSide.value.copy(state.side);
    u.uSeed.value = state.seed;
    u.uProgress.value = state.progress;
    u.uFade.value = state.fade;
    u.uWidthFade.value = state.widthFade;

    // 配置里可能被调用方热改（配色随领域换色等）——每帧回读。
    u.uRadius.value = c.radius;
    u.uRadiusNear.value = c.radiusNear;
    u.uFlare.value = c.flare;
    u.uGlow.value = c.glow;
    u.uOpacity.value = c.opacity;
    u.uColorCore.value.set(c.colorCore);
    u.uColorInner.value.set(c.colorInner);
    u.uColorOuter.value.set(c.colorOuter);
    u.uColorHalo.value.set(c.colorHalo);
    u.uColorCoil.value.set(c.colorCoil);
    u.uColorCoilEdge.value.set(c.colorCoilEdge);
    u.uColorRing.value.set(c.colorRing);

    u.uCoils.value = state.coils;
    u.uRingCount.value = state.rings;

    // 这个 pass 是三层管半径里的哪一层，画得多重。
    switch (pass) {
      case BeamPass.CORE:
        u.uRadiusScale.value = c.coreWidth;
        u.uPassOpacity.value = 1;
        u.uGlow.value = c.glow;
        break;
      case BeamPass.SHELL:
        u.uRadiusScale.value = c.shellWidth;
        u.uPassOpacity.value = c.shellOpacity;
        u.uGlow.value = c.glow;
        break;
      case BeamPass.HALO:
        u.uRadiusScale.value = c.haloWidth;
        u.uPassOpacity.value = c.haloOpacity;
        u.uGlow.value = c.glow * 0.8;
        break;
      case BeamPass.COIL:
        u.uRadiusScale.value = 1;
        u.uPassOpacity.value = c.coilOpacity;
        u.uGlow.value = c.coilGlow;
        break;
      case BeamPass.RING:
        u.uRadiusScale.value = 1;
        u.uPassOpacity.value = c.ringOpacity;
        u.uGlow.value = c.ringGlow;
        break;
    }
  };

  return material;
}
