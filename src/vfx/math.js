/** 全系统共用的小数学工具。全部无分配。移植自 elemental-sandbox（MIT）。 */

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const saturate = (v) => clamp(v, 0, 1);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (e0, e1, x) => {
  const t = saturate((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
};

/** 帧率无关的指数阻尼。`rate` = 1 秒后剩余比例。 */
export const damp = (current, target, rate, dt) => lerp(target, current, Math.pow(rate, dt));

export const randRange = (a, b) => a + Math.random() * (b - a);

/** 确定性哈希 → [0,1)。给稳定的逐实例随机用。 */
export function hash11(n) {
  const s = Math.sin(n * 127.1) * 43758.5453123;
  return s - Math.floor(s);
}

/* ------------------------------ 缓动 ------------------------------ */

export const Easing = {
  linear: (t) => t,
  inQuad: (t) => t * t,
  outQuad: (t) => t * (2 - t),
  inOutQuad: (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  inCubic: (t) => t * t * t,
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outQuint: (t) => 1 - Math.pow(1 - t, 5),
  outExpo: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  /** 快起慢落 —— 经典 VFX "pop" 曲线。 */
  pop: (t) => Math.sin(Math.min(1, t) * Math.PI) ** 0.6
};
