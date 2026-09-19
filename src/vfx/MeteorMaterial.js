import { MeshStandardMaterial, Color, Vector3 } from 'three';
import { noiseGLSL } from './NoiseGLSL.js';
import { frame } from './FrameUniforms.js';

/**
 * MeteorMaterial.js — 燃烧的岩石：陨石本体与它崩出的碎块。
 *
 * 移植自 elemental-sandbox（MIT）。构建在 MeshStandardMaterial 上（岩石是
 * 实体，要走光照），程式化注入在其上：
 *
 *  - **熔岩缝** —— 招牌。裂纹是 fbm 场的零交叉：`1 - smoothstep(0, width,
 *    abs(fbm))` 在噪声变号处画出一片纤细分叉的薄面——裂缝真正的样子，
 *    蜿蜒分叉，从不是一道划痕。更细的第二倍频添上分出的小枝。
 *  - **局部空间采样** —— 裂纹焊在岩石上随它翻滚。
 *  - **烟灰** —— 每条缝两侧的焦黑晕，辉光才不像画上去的。
 *  - **充能** —— uCharge 随陨石压向目标 0 → 1：缝变宽变亮，
 *    岩石 visibly 升温，爆炸是你看着来的。
 *  - **迎风面灼热** —— 顺行进方向的面上白热，背面保持暗。
 *  - **逐块冷却** —— aHeat 逐实例从 1 驱到 0，溅出的碎块落地即暗。
 */
export function createMeteorMaterial() {
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.94,
    metalness: 0.0,
    // 与晶体一样的棱面化：低多边形岩石读作岩石而非贴了噪声的球。
    flatShading: true
  });

  const uniforms = {
    uTime: frame.uTime,
    uColorRock: { value: new Color('#6e675f') },
    uColorChar: { value: new Color('#17130f') },
    uColorCrack: { value: new Color('#ff6a12') },
    uColorHot: { value: new Color('#fff3d0') },
    uCrackScale: { value: 0.95 },
    uCrackWidth: { value: 0.045 },
    uCrackBranches: { value: 0.5 },
    uCrackGlow: { value: 2.2 },
    uFlow: { value: 0.7 },
    uFlowSpeed: { value: 0.9 },
    uRockScale: { value: 3.4 },
    uFacetTint: { value: 0.5 },
    uCavity: { value: 0.25 },
    uSoot: { value: 0.6 },
    uRimHeat: { value: 0.7 },
    uLead: { value: 0.9 },
    uLeadSharp: { value: 2.6 },
    /** 行进的单位方向，世界空间 —— 驱动迎风面灼热。 */
    uHeading: { value: new Vector3(0, -1, 0) },
    uCharge: { value: 0 },
    uGlow: { value: 0.75 }
  };

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute float aSeed;
         attribute float aHeat;
         varying vec3  vRockLocal;
         varying vec3  vRockNormalW;
         varying float vRockSeed;
         varying float vRockHeat;`
      )
      // objectNormal 由 <beginnormal_vertex> 声明，先于本段执行。
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vRockLocal = transformed;
         vRockSeed = aSeed;
         vRockHeat = aHeat;
         #ifdef USE_INSTANCING
           vRockNormalW = normalize(mat3(modelMatrix) * (instanceMatrix * vec4(objectNormal, 0.0)).xyz);
         #else
           vRockNormalW = normalize(mat3(modelMatrix) * objectNormal);
         #endif`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uTime;
         uniform vec3  uColorRock;
         uniform vec3  uColorChar;
         uniform vec3  uColorCrack;
         uniform vec3  uColorHot;
         uniform float uCrackScale;
         uniform float uCrackWidth;
         uniform float uCrackBranches;
         uniform float uCrackGlow;
         uniform float uFlow;
         uniform float uFlowSpeed;
         uniform float uRockScale;
         uniform float uFacetTint;
         uniform float uCavity;
         uniform float uSoot;
         uniform float uRimHeat;
         uniform float uLead;
         uniform float uLeadSharp;
         uniform vec3  uHeading;
         uniform float uCharge;
         uniform float uGlow;
         varying vec3  vRockLocal;
         varying vec3  vRockNormalW;
         varying float vRockSeed;
         varying float vRockHeat;
         ${noiseGLSL}`
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         {
           vec3  N   = normalize(normal);
           float ndv = clamp(dot(N, normalize(vViewPosition)), 0.0, 1.0);
           float rim = pow(1.0 - ndv, 2.2);

           /* 缝：作为横截面而非一条线。
            *
            *   fissure —— 张开的缝。这里没有岩石，只有下面的岩浆。
            *   lip     —— 两侧宽得多的焦黑带。裂缝先是影子才是光。
            *   core    —— 缝的正中，唯一白热到发光的部分。
            *
            * 全程局部空间：整个网络焊在岩石上随它翻滚。
            */
           vec3  p  = vRockLocal * uCrackScale + vRockSeed * 19.0;
           float f1 = fbm3(p);
           float f2 = fbm3(p * 2.7 + 11.3);

           // 充能把缝撬开。
           float width = max(0.004, uCrackWidth * (1.0 + uCharge * 0.8));
           float distance = min(abs(f1), abs(f2) / max(uCrackBranches, 0.05));

           float fissure = 1.0 - smoothstep(width * 0.35, width, distance);
           float lip     = 1.0 - smoothstep(width, width * 2.0, distance);
           float core    = 1.0 - smoothstep(0.0, width * 0.45, distance);

           // 岩浆不是静止的：亮度沿缝的内壁爬行。
           float pulse = snoise(vRockLocal * 4.0 + vec3(0.0, uTime * uFlowSpeed, 0.0) + vRockSeed * 7.0);
           float flow  = mix(1.0, 0.45 + 0.75 * (pulse * 0.5 + 0.5), uFlow);

           /* --- 岩石本身 --- */
           float mottle = fbm3(vRockLocal * uRockScale + vRockSeed * 31.0) * 0.5 + 0.5;
           vec3  rock   = mix(uColorRock, uColorChar, smoothstep(0.3, 0.85, mottle));

           // 逐面明度抖动：每个平面有自己的色调——
           // 把切割的石头和噪声涂出来的球分开，代价两次导数。
           vec3  faceN = normalize(cross(dFdx(vRockLocal), dFdy(vRockLocal)));
           float facet = hash13(faceN * 37.0 + vRockSeed + 0.5);
           rock *= 1.0 + (facet - 0.5) * uFacetTint;

           // 廉价的曲率遮蔽：坑与切面比团块更靠内，半径兼作凹陷项。
           float cavity = smoothstep(0.55, 1.0, length(vRockLocal));
           rock *= mix(1.0 - uCavity, 1.0, cavity);

           // 每条缝周围焦黑，缝内全焦。
           rock = mix(rock, uColorChar, lip * uSoot);
           rock *= 1.0 - fissure * 0.92;

           // 各面硬朗的明暗对比，剪影读作一束平面。
           rock *= mix(0.55, 1.15, ndv);
           diffuseColor.rgb *= rock;

           /* --- 燃烧的部分 --- */
           float heat = fissure * flow * vRockHeat;
           vec3  glow = mix(uColorCrack, uColorHot, core * core) * heat * uCrackGlow;

           // 剪影四周的热鞘 + 迎风面的压缩热。都按充能平方：
           // 出手时是条冷岩，坠落到一半才整体烧起来。
           float charge2 = uCharge * uCharge;
           glow += uColorCrack * rim * uRimHeat * vRockHeat * charge2;

           float lead = pow(clamp(dot(normalize(vRockNormalW), uHeading), 0.0, 1.0), uLeadSharp);
           glow += uColorHot * lead * uLead * vRockHeat * charge2;

           glow *= uGlow;

           // 与冰相同的软顶。
           glow /= 1.0 + glow * 0.22;

           totalEmissiveRadiance += glow;
         }`
      );
  };

  material.customProgramCacheKey = () => 'solitude-meteor-v1';

  material.userData.uniforms = uniforms;

  /**
   * 同步充能与航向。
   * @param {number} charge 0..1
   * @param {THREE.Vector3} [heading] 行进方向（世界空间，单位化）
   */
  material.userData.sync = (charge = 0, heading = null) => {
    uniforms.uCharge.value = charge;
    if (heading) uniforms.uHeading.value.copy(heading);
  };

  return material;
}
