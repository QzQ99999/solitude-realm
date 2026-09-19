import { MeshStandardMaterial, Color, DoubleSide } from 'three';
import { noiseGLSL } from './NoiseGLSL.js';
import { frame } from './FrameUniforms.js';

/**
 * IceMaterial.js — 程序化着色的冰。
 *
 * 移植自 elemental-sandbox（MIT）。构建在 MeshStandardMaterial 上（冰是
 * *实体*，要走场景的光照），程式化注入在其上：
 *
 *  - **厚度染色** —— 正对的面在晶体内路径最长，向 colorDeep 变暗；
 *    掠射的边缘保持苍白。这让晶体场读作看得*进去*的实体而非蓝色塑料。
 *  - **内部裂隙** —— 世界空间采样的脊状噪声，裂纹平面保持固定物理尺寸，
 *    邻近的晶体像采自同一块冰川。
 *  - **羽状霜与雾凇** —— *局部*空间采样（0..1 沿晶体向上），乳白的脉纹与
 *    从底部爬升的霜各随其轴。
 *  - **闪光** —— 硬阈值的高频场，偏向掠射角（真冰接光处）。
 *  - **诞生闪光** —— 逐实例值从 1 驱动到 0，晶体喷出的一瞬自内而外点亮。
 *
 * 逐实例输入以实例化属性（aSeed、aBirth）到达，因此只用于 InstancedMesh。
 *
 * @param {object} palette { colorDeep, colorIce, colorRim, colorCore }
 */
export function createIceMaterial(palette = {}) {
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.16,
    metalness: 0.0,
    flatShading: true,
    transparent: true,
    // 冰是半透明的：透过近壁能看到远壁。剔除它内部就空了。
    side: DoubleSide,
    // 保留：晶体近乎不透明，写深度才能整片正确排序。
    depthWrite: true,
    opacity: 0.92
  });

  const uniforms = {
    uTime: frame.uTime,
    uColorDeep: { value: new Color(palette.colorDeep ?? '#3e737a') },
    uColorIce: { value: new Color(palette.colorIce ?? '#8adaff') },
    uColorRim: { value: new Color(palette.colorRim ?? '#f2feff') },
    uColorCore: { value: new Color(palette.colorCore ?? '#638797') },
    uDensity: { value: 1.15 },
    uFresnel: { value: 2.3 },
    uFresnelPower: { value: 2.4 },
    uTranslucency: { value: 1.5 },
    uFacetSharp: { value: 0.68 },
    uFracture: { value: 0.62 },
    uFractureScale: { value: 6.5 },
    uVeins: { value: 0.45 },
    uVeinScale: { value: 3.2 },
    uSparkle: { value: 1.1 },
    uSparkleScale: { value: 34 },
    uSparkleSpeed: { value: 0.7 },
    uFrostLine: { value: 0.5 },
    uGlow: { value: 0.85 },
    uEdgeGlow: { value: 1.1 },
    uBirthGlow: { value: 1.6 }
  };

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute float aSeed;
         attribute float aBirth;
         varying vec3  vIceLocal;
         varying vec3  vIceWorld;
         varying float vIceSeed;
         varying float vIceBirth;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vIceLocal = transformed;
         vIceSeed = aSeed;
         vIceBirth = aBirth;
         #ifdef USE_INSTANCING
           vIceWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
         #else
           vIceWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
         #endif`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uTime;
         uniform vec3  uColorDeep;
         uniform vec3  uColorIce;
         uniform vec3  uColorRim;
         uniform vec3  uColorCore;
         uniform float uDensity;
         uniform float uFresnel;
         uniform float uFresnelPower;
         uniform float uTranslucency;
         uniform float uFacetSharp;
         uniform float uFracture;
         uniform float uFractureScale;
         uniform float uVeins;
         uniform float uVeinScale;
         uniform float uSparkle;
         uniform float uSparkleScale;
         uniform float uSparkleSpeed;
         uniform float uFrostLine;
         uniform float uGlow;
         uniform float uEdgeGlow;
         uniform float uBirthGlow;
         varying vec3  vIceLocal;
         varying vec3  vIceWorld;
         varying float vIceSeed;
         varying float vIceBirth;
         ${noiseGLSL}`
      )
      // 法线解析完之后注入：flatShading 下没有 vNormal varying，
      // 所有视角相关项都得读 <normal_fragment_begin> 从导数算出的面法线。
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         {
           vec3  N   = normalize(normal);
           float ndv = clamp(dot(N, normalize(vViewPosition)), 0.0, 1.0);

           // 正对的面让你顺着晶体的长轴看进去；掠射时只擦到边。
           float thickness = clamp(ndv * uDensity, 0.0, 1.0);
           float fres = pow(1.0 - ndv, uFresnelPower) * uFresnel;

           // 世界空间：裂纹平面保持固定物理尺度。
           vec3  fp     = vIceWorld * uFractureScale + vIceSeed * 37.0;
           float cracks = smoothstep(0.55, 0.98, ridged(fp, 4));

           // 局部空间：脉纹跟着各晶体的轴走。
           float veins = fbm3(vIceLocal * uVeinScale * 4.0 + vIceSeed * 11.0) * 0.5 + 0.5;
           veins = smoothstep(0.45, 0.92, veins);

           vec3 body = mix(uColorIce, uColorDeep, thickness);
           body = mix(body, uColorRim, veins * uVeins * 0.55);
           body = mix(body, uColorRim, cracks * uFracture * 0.4);

           // 雾凇聚在晶体离开地面的地方。
           float rime = smoothstep(0.55, 0.0, vIceLocal.y) *
                        (0.5 + 0.5 * fbm3(vIceLocal * 9.0 + vIceSeed * 5.0));
           body = mix(body, uColorRim, clamp(rime, 0.0, 1.0) * uFrostLine);

           // 抬起朝向相机的面，剪影读作一束平面。
           body *= mix(1.0, 0.55 + 0.9 * ndv, uFacetSharp);

           // 硬阈值的高频闪点，偏向掠射角。
           float sp = snoise(vIceWorld * uSparkleScale +
                             vec3(0.0, uTime * uSparkleSpeed, 0.0) + vIceSeed * 23.0);
           sp = pow(clamp(sp, 0.0, 1.0), 14.0) * smoothstep(0.0, 0.7, fres + 0.3);

           diffuseColor.rgb *= body;

           float rimAmount = pow(1.0 - ndv, uFresnelPower);

           vec3 glow = uColorRim * rimAmount * uEdgeGlow;
           glow += uColorCore * (cracks * uFracture * 0.8 + veins * uVeins * 0.35) * uTranslucency;
           glow += uColorRim * sp * uSparkle * 1.5;
           glow += uColorCore * vIceBirth * uBirthGlow;
           glow *= uGlow;

           // 软顶。各项独立且都在掠射角达峰，会相互叠加；没有这道
           // Reinhard 滚降，剪影上的面会加到 10+ 读作白斑。
           glow /= 1.0 + glow * 0.22;

           totalEmissiveRadiance += glow;

           // 边缘薄、实体与裂纹沿线更密。
           diffuseColor.a = clamp(diffuseColor.a * (0.62 + 0.5 * fres) + cracks * 0.12, 0.0, 1.0);
         }`
      );
  };

  material.customProgramCacheKey = () => 'solitude-ice-v1';

  material.userData.uniforms = uniforms;
  return material;
}
