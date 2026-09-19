import { Vector2, Vector3 } from 'three';

/**
 * FrameUniforms.js — 被*每一个*自定义材质按对象标识共享的 uniform。
 *
 * 移植自 elemental-sandbox（MIT）。three.js 把 uniform 存为 `{ value }` 盒子，
 * 把同一个盒子递给许多材质，意味着每帧一次写入就能更新所有材质。几十个
 * VFX 材质的每帧 CPU 开销由此从一整趟遍历缩到几次赋值。
 */
export const frame = {
  uTime: { value: 0 },
  uDelta: { value: 0 },
  uResolution: { value: new Vector2(1, 1) },
  /** 原版用于软粒子的深度预贴图；本作没有，保持 null（着色器里已桩化）。 */
  uSceneDepth: { value: null },
  uCameraNear: { value: 0.1 },
  uCameraFar: { value: 1400 },
  /** 世界空间里*指向*太阳的方向。地面雪/碎屑这类伪法线着色需要与受光网格
   * 一致的主光方向，否则会读成贴纸。 */
  uLightDir: { value: new Vector3(0.45, 0.78, 0.44).normalize() },
  /** 供着色器读取的全局倍率。 */
  uShaderIntensity: { value: 1 },
  uGlobalGlow: { value: 1 }
};

/** 每个 VFX 材质都想要的 uniform 块。 */
export function sharedUniforms(extra = {}) {
  return {
    uTime: frame.uTime,
    uResolution: frame.uResolution,
    uSceneDepth: frame.uSceneDepth,
    uCameraNear: frame.uCameraNear,
    uCameraFar: frame.uCameraFar,
    uLightDir: frame.uLightDir,
    uShaderIntensity: frame.uShaderIntensity,
    uGlobalGlow: frame.uGlobalGlow,
    ...extra
  };
}
