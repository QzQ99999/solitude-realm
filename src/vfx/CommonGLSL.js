/**
 * CommonGLSL.js — 共享着色工具：菲涅尔、溶解、渐变。
 *
 * 移植自 elemental-sandbox（MIT）。原版另有依赖场景深度预贴图的软粒子函数
 * softFade；本作没有深度预贴图，故这里替换为恒返回 1 的同名桩函数——
 * 移植过来的着色器主体可以保持原样，软边效果自动退化为无软化。
 */
export const commonGLSL = /* glsl */ `
#ifndef COMMON_LIB_INCLUDED
#define COMMON_LIB_INCLUDED

/**
 * 深度软粒子淡出的桩实现：本作没有不透明场景的深度预贴图，恒返回 1
 * （粒子在任何几何交叠处都不软化）。
 */
float softFade(sampler2D sceneDepth, vec2 screenUV, float fragViewZ, float near, float far, float fadeDist) {
  return 1.0;
}

/** 标准 Schlick 风格的边缘项。 */
float fresnelTerm(vec3 viewDir, vec3 normal, float power, float scale) {
  return clamp(scale * pow(1.0 - abs(dot(normalize(viewDir), normalize(normal))), power), 0.0, 4.0);
}

/** 阈值溶解 + 发光烧蚀边。返回 vec2(alphaMask, edge)。 */
vec2 dissolveMask(float noiseValue, float threshold, float edgeWidth) {
  float mask = step(threshold, noiseValue);
  float edge = smoothstep(threshold, threshold + edgeWidth, noiseValue) - mask;
  return vec2(mask, clamp(edge, 0.0, 1.0));
}

/** 4 段渐变，按 t（0..1）采样（core → mid → edge → tail）。 */
vec3 gradient4(vec3 c0, vec3 c1, vec3 c2, vec3 c3, float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 a = mix(c0, c1, smoothstep(0.0, 0.34, t));
  vec3 b = mix(a, c2, smoothstep(0.30, 0.68, t));
  return mix(b, c3, smoothstep(0.64, 1.0, t));
}

/** 反锯齿 step：在可用时用屏幕空间导数。 */
float aastep(float threshold, float value) {
  float afwidth = fwidth(value) * 0.7;
  return smoothstep(threshold - afwidth, threshold + afwidth, value);
}

#endif
`;
