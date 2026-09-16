/**
 * themes.js — 世界主题定义。
 *
 * 每个主题描述一整套"世界长相"：天空渐变、星星、雾、大地的基色与发光纹路、
 * 主光/环境光、边缘暗角色、天气粒子类型。施放法术落地时，整套参数会从当前
 * 状态平滑过渡到目标主题 —— 世界因此"变成"该元素的领域。
 */

export const ELEMENTS = ['ice', 'fire', 'storm'];

export const ELEMENT_INFO = {
  ice: { key: 'Q', label: '霜新星', accent: '#56d8ff', family: 'ice' },
  fire: { key: 'E', label: '落炎陨石', accent: '#ff8a3c', family: 'fire' },
  storm: { key: 'R', label: '天雷殛灭', accent: '#a98bff', family: 'storm' }
};

/** 施放元素 → 领域主题 id（本作一一对应）。 */
export const FAMILY_OF = { ice: 'ice', fire: 'fire', storm: 'storm' };

export const THEMES = {
  neutral: {
    id: 'neutral',
    label: '元素荒原 · Neutral Realm',
    glyph: '◇',
    accent: '#9fb4c8',
    weather: 'none',
    skyTop: '#0b1120',
    skyBottom: '#1b2534',
    skyHorizon: '#33475e',
    stars: 1.0,
    fogColor: '#141c28',
    fogNear: 55,
    fogFar: 235,
    groundBase: '#252e3a',
    groundAccent: '#446080',
    veinStrength: 0.22,
    keyColor: '#bcd2ff',
    keyIntensity: 3.4,
    hemiSky: '#334e78',
    hemiGround: '#10161f',
    hemiIntensity: 1.45,
    vignette: 'rgba(4, 8, 16, 0.55)'
  },

  ice: {
    id: 'ice',
    label: '冰封领域 · Frozen Realm',
    glyph: '❄',
    accent: '#56d8ff',
    weather: 'snow',
    skyTop: '#5eb0e0',
    skyBottom: '#c4e9fa',
    skyHorizon: '#e8f7ff',
    stars: 0.15,
    fogColor: '#b9dcEE',
    fogNear: 46,
    fogFar: 190,
    groundBase: '#9fc0d2',
    groundAccent: '#38c8ff',
    veinStrength: 0.85,
    keyColor: '#ffffff',
    keyIntensity: 3.7,
    hemiSky: '#d6f0ff',
    hemiGround: '#6d94aa',
    hemiIntensity: 1.5,
    vignette: 'rgba(150, 205, 235, 0.28)'
  },

  fire: {
    id: 'fire',
    label: '烈焰领域 · Burning Realm',
    glyph: '🔥',
    accent: '#ff8a3c',
    weather: 'embers',
    skyTop: '#1b0908',
    skyBottom: '#5c1e0c',
    skyHorizon: '#ff7a2e',
    stars: 0.3,
    fogColor: '#2c110a',
    fogNear: 40,
    fogFar: 170,
    groundBase: '#261410',
    groundAccent: '#ff5410',
    veinStrength: 1.0,
    keyColor: '#ffd9a8',
    keyIntensity: 3.4,
    hemiSky: '#a8462a',
    hemiGround: '#170a08',
    hemiIntensity: 1.4,
    vignette: 'rgba(58, 10, 4, 0.5)'
  },

  storm: {
    id: 'storm',
    label: '雷暴领域 · Storm Realm',
    glyph: '⚡',
    accent: '#a98bff',
    weather: 'sparks',
    skyTop: '#0c0f2e',
    skyBottom: '#2c3168',
    skyHorizon: '#6f6fff',
    stars: 0.6,
    fogColor: '#181d42',
    fogNear: 36,
    fogFar: 160,
    groundBase: '#1b1e3a',
    groundAccent: '#8f6bff',
    veinStrength: 0.9,
    keyColor: '#cfe0ff',
    keyIntensity: 3.0,
    hemiSky: '#4c5cba',
    hemiGround: '#0e1024',
    hemiIntensity: 1.3,
    vignette: 'rgba(10, 12, 40, 0.55)'
  }
};

/** 主题里所有的颜色字段（线性插值时按 Color 处理）。 */
export const THEME_COLOR_FIELDS = [
  'skyTop',
  'skyBottom',
  'skyHorizon',
  'fogColor',
  'groundBase',
  'groundAccent',
  'keyColor',
  'hemiSky',
  'hemiGround'
];

/** 主题里所有的数值字段。 */
export const THEME_FLOAT_FIELDS = [
  'stars',
  'fogNear',
  'fogFar',
  'veinStrength',
  'keyIntensity',
  'hemiIntensity'
];

/** 主题过渡时长，秒。 */
export const SHIFT_TIME = 2.4;
