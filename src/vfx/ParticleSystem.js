import {
  InstancedBufferGeometry,
  InstancedBufferAttribute,
  BufferAttribute,
  Mesh,
  ShaderMaterial,
  AdditiveBlending,
  NormalBlending,
  Color,
  Vector3,
  Sphere,
  DynamicDrawUsage,
  DoubleSide
} from 'three';
import { noiseGLSL } from './NoiseGLSL.js';
import { commonGLSL } from './CommonGLSL.js';
import { sharedUniforms } from './FrameUniforms.js';

/**
 * ParticleSystem.js — 池化的 GPU 模拟粒子系统。
 *
 * 移植自 elemental-sandbox（MIT）。每个粒子的运动（速度、重力、阻力、湍流、
 * 旋绕）、尺寸曲线、颜色渐变与透明度衰减都在着色器里由少量逐实例属性求值。
 * CPU 只*写入出生数据*；主线程不做逐帧模拟，构造之后零分配。
 *
 * 粒子住在环形缓冲区里：超出容量后循环覆写最旧的槽位——正是特效刷屏时
 * 想要的池化行为。
 *
 * 剪影全部程序化——没有精灵贴图。
 */
export const ParticleShape = Object.freeze({
  SOFT: 0, // 圆形、羽化 —— 余烬、水珠、尘
  SMOKE: 1, // fbm 蚀刻的烟团
  STREAK: 2 // 速度对齐的火花
});

const FLOATS = {
  start: 3,
  origin: 3,
  velocity: 3,
  color: 3,
  spawn: 1,
  life: 1,
  size: 1,
  seed: 1,
  spin: 1
};

const _tmpVec = new Vector3();

export class ParticleSystem {
  constructor({
    name,
    capacity = 2000,
    shape = ParticleShape.SOFT,
    additive = true,
    curl = false,
    stretch = false
  }) {
    this.name = name;
    this.capacity = capacity;
    this.cursor = 0;

    /* ---------------- 几何 ---------------- */
    const geometry = new InstancedBufferGeometry();
    geometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3)
    );
    geometry.setAttribute(
      'uv',
      new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2)
    );
    geometry.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));

    this.data = {};
    this.attributes = {};
    for (const [key, itemSize] of Object.entries(FLOATS)) {
      const array = new Float32Array(capacity * itemSize);
      const attribute = new InstancedBufferAttribute(array, itemSize).setUsage(DynamicDrawUsage);
      this.data[key] = array;
      this.attributes[key] = attribute;
      geometry.setAttribute(`a${key[0].toUpperCase()}${key.slice(1)}`, attribute);
    }
    // 一切从死开始（出生时间远在过去，生命为零）。
    this.data.life.fill(0);
    geometry.instanceCount = capacity;
    geometry.boundingSphere = new Sphere(new Vector3(), 1e4);
    this.geometry = geometry;

    /* ---------------- 材质 ---------------- */
    const defines = { SHAPE: shape };
    if (curl) defines.USE_CURL = '';
    if (stretch) defines.USE_STRETCH = '';

    this.material = new ShaderMaterial({
      defines,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: additive ? AdditiveBlending : NormalBlending,
      side: DoubleSide,
      toneMapped: false,
      uniforms: sharedUniforms({
        uGravity: { value: new Vector3(0, -4.5, 0) },
        uDrag: { value: 0.9 },
        uTurbulence: { value: 0.6 },
        uTurbFrequency: { value: 0.45 },
        uTurbSpeed: { value: 0.35 },
        uSpeedScale: { value: 1 },
        uSizeScale: { value: 1 },
        uLifeScale: { value: 1 },
        uEndSize: { value: 0.4 },
        uSizeIn: { value: 0.08 },
        uFadeIn: { value: 0.08 },
        uFadeOut: { value: 0.55 },
        uOpacity: { value: 1 },
        uGlow: { value: 1 },
        uStretch: { value: 0.15 },
        uColor0: { value: new Color(1, 1, 1) },
        uColor1: { value: new Color(1, 0.7, 0.3) },
        uColor2: { value: new Color(0.6, 0.15, 0.05) },
        uColor3: { value: new Color(0.08, 0.06, 0.06) }
      }),
      vertexShader: PARTICLE_VERTEX,
      fragmentShader: PARTICLE_FRAGMENT
    });

    this.mesh = new Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = additive ? 12 : 10;
    this.mesh.name = `Particles:${name}`;

    this._ranges = [];
    this._dirty = false;
  }

  get uniforms() {
    return this.material.uniforms;
  }

  /**
   * 发射 `count` 个粒子。`params` 只被读取、不被保留——调用方应复用同一个
   * 临时对象，保持帧内零分配。
   */
  emit(count, p) {
    if (count <= 0) return;
    count = Math.min(count, this.capacity);

    const {
      position,
      radius = 0,
      direction = null,
      speed = 1,
      speedVariance = 0.35,
      spread = 0.5,
      size = 0.2,
      sizeVariance = 0.4,
      life = 1,
      lifeVariance = 0.3,
      spin = 0,
      tint = null,
      time = 0
    } = p;

    const d = this.data;

    for (let n = 0; n < count; n++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.capacity;
      this._markDirty(i);

      const i3 = i * 3;

      // --- 位置 ---
      let ox = 0;
      let oy = 0;
      let oz = 0;
      if (radius > 0) {
        const u = Math.random();
        const r = radius * Math.cbrt(u);
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        const s = Math.sin(phi);
        ox = r * s * Math.cos(theta);
        oy = r * Math.cos(phi);
        oz = r * s * Math.sin(theta);
      }
      d.start[i3 + 0] = position.x + ox;
      d.start[i3 + 1] = position.y + oy;
      d.start[i3 + 2] = position.z + oz;

      // --- 速度 ---
      if (direction) {
        _tmpVec.copy(direction);
      } else {
        _tmpVec.set(0, 1, 0);
      }
      if (spread > 0) {
        _tmpVec.x += (Math.random() - 0.5) * 2 * spread;
        _tmpVec.y += (Math.random() - 0.5) * 2 * spread;
        _tmpVec.z += (Math.random() - 0.5) * 2 * spread;
      }
      _tmpVec.normalize().multiplyScalar(speed * (1 + (Math.random() - 0.5) * 2 * speedVariance));

      d.velocity[i3 + 0] = _tmpVec.x;
      d.velocity[i3 + 1] = _tmpVec.y;
      d.velocity[i3 + 2] = _tmpVec.z;

      // --- 标量 ---
      d.spawn[i] = time;
      d.life[i] = Math.max(0.05, life * (1 + (Math.random() - 0.5) * 2 * lifeVariance));
      d.size[i] = Math.max(0.001, size * (1 + (Math.random() - 0.5) * 2 * sizeVariance));
      d.seed[i] = Math.random();
      d.spin[i] = (Math.random() - 0.5) * 2 * spin;

      // --- 染色 ---
      if (tint) {
        d.color[i3 + 0] = tint.r;
        d.color[i3 + 1] = tint.g;
        d.color[i3 + 2] = tint.b;
      } else {
        d.color[i3 + 0] = 1;
        d.color[i3 + 1] = 1;
        d.color[i3 + 2] = 1;
      }
    }
  }

  _markDirty(index) {
    this._dirty = true;
    const ranges = this._ranges;
    // 发射是连续的，合并进上一段几乎总是一次比较。
    const last = ranges[ranges.length - 1];
    if (last && index === last[0] + last[1]) {
      last[1]++;
    } else {
      ranges.push([index, 1]);
    }
  }

  /** 只上传本帧变化过的槽位。 */
  flush() {
    if (!this._dirty) return;
    for (const [key, itemSize] of Object.entries(FLOATS)) {
      const attribute = this.attributes[key];
      attribute.needsUpdate = true;
      attribute.clearUpdateRanges?.();
      for (const [start, count] of this._ranges) {
        attribute.addUpdateRange?.(start * itemSize, count * itemSize);
      }
    }
    this._ranges.length = 0;
    this._dirty = false;
  }

  /** 用 4 段 16 进制色设置生命周期渐变的便捷方法。 */
  setGradient(c0, c1, c2, c3) {
    const u = this.uniforms;
    u.uColor0.value.set(c0);
    u.uColor1.value.set(c1);
    u.uColor2.value.set(c2);
    u.uColor3.value.set(c3 ?? c2);
  }

  reset() {
    this.data.life.fill(0);
    this.data.spawn.fill(-1e4);
    for (const key of Object.keys(FLOATS)) this.attributes[key].needsUpdate = true;
    this._ranges.length = 0;
    this._dirty = false;
    this.cursor = 0;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/**
 * RateEmitter —— 把"每秒 N 个"换成"这一帧该发几个"的小节拍器，
 * 帧率无关。移植自 elemental-sandbox。
 */
export class RateEmitter {
  constructor() {
    this._acc = 0;
  }

  reset() {
    this._acc = 0;
  }

  /** @returns {number} 本帧应发射的数量（可能是小数，向上取整由调用方决定） */
  tick(dt, rate) {
    this._acc += rate * dt;
    const count = Math.floor(this._acc);
    if (count > 0) this._acc -= count;
    return count;
  }
}

/**
 * ParticleEngine —— 命名系统的注册表。能力按名字取系统，同名即同池。
 */
export class ParticleEngine {
  constructor(scene) {
    this.scene = scene;
    this.systems = new Map();
  }

  get(name, options) {
    let system = this.systems.get(name);
    if (!system) {
      system = new ParticleSystem({ name, ...options });
      this.systems.set(name, system);
      this.scene.add(system.mesh);
    }
    return system;
  }

  /** 每帧最后调用：上传脏区间。 */
  flush() {
    for (const system of this.systems.values()) system.flush();
  }

  reset() {
    for (const system of this.systems.values()) system.reset();
  }

  dispose() {
    for (const system of this.systems.values()) {
      this.scene.remove(system.mesh);
      system.dispose();
    }
    this.systems.clear();
  }
}

/* ---------------------------------------------------------------------- */
/* 着色器                                                                  */
/* ---------------------------------------------------------------------- */

const PARTICLE_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform vec3  uGravity;
  uniform float uDrag;
  uniform float uTurbulence;
  uniform float uTurbFrequency;
  uniform float uTurbSpeed;
  uniform float uSpeedScale;
  uniform float uSizeScale;
  uniform float uLifeScale;
  uniform float uEndSize;
  uniform float uSizeIn;
  uniform float uStretch;

  attribute vec3  aStart;
  attribute vec3  aOrigin;
  attribute vec3  aVelocity;
  attribute vec3  aColor;
  attribute float aSpawn;
  attribute float aLife;
  attribute float aSize;
  attribute float aSeed;
  attribute float aSpin;

  varying vec2  vUv;
  varying float vT;
  varying float vSeed;
  varying vec3  vTint;

  ${noiseGLSL}

  void main() {
    vUv = uv;
    vSeed = aSeed;
    vTint = aColor;

    float life = aLife * uLifeScale;
    float age = uTime - aSpawn;
    float t = age / max(life, 1e-4);
    vT = t;

    // 死粒子被推到裁剪体之外；GPU 在光栅化之前丢弃整个三角形。
    if (age < 0.0 || t > 1.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    vec3 vel = aVelocity * uSpeedScale;

    // 解析式指数阻力 —— 精确，且与帧率无关。
    float k = max(uDrag, 1e-3);
    float travel = (1.0 - exp(-k * age)) / k;
    vec3 pos = aStart + vel * travel + 0.5 * uGravity * age * age;

    // 湍流：廉价的确定性摆动，重型烟/焰系统升级为真正的旋度噪声。
    #ifdef USE_CURL
      pos += curlNoise(aStart * uTurbFrequency + vec3(0.0, uTime * uTurbSpeed, 0.0) + aSeed * 4.0)
             * uTurbulence * age;
    #else
      vec3 wobble = vec3(
        sin(age * 3.1 + aSeed * 41.0),
        cos(age * 2.3 + aSeed * 17.0),
        sin(age * 2.7 + aSeed * 73.0)
      );
      pos += wobble * uTurbulence * age * 0.55;
    #endif

    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);

    // 生命周期内的尺寸。
    float grow = smoothstep(0.0, max(uSizeIn, 1e-3), t);
    float size = aSize * uSizeScale * mix(1.0, uEndSize, t) * grow;

    vec2 corner = position.xy * size;

    #ifdef USE_STRETCH
      vec3 velView = (modelViewMatrix * vec4(vel, 0.0)).xyz;
      vec2 dir = normalize(velView.xy + vec2(1e-5));
      vec2 perp = vec2(-dir.y, dir.x);
      float stretch = 1.0 + uStretch * length(vel);
      corner = dir * (position.y * size * stretch) + perp * (position.x * size);
    #else
      float rot = aSpin * age + aSeed * 6.2831;
      corner = rot2(rot) * corner;
    #endif

    mvPosition.xy += corner;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const PARTICLE_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uOpacity;
  uniform float uGlow;
  uniform float uFadeIn;
  uniform float uFadeOut;
  uniform vec3  uColor0;
  uniform vec3  uColor1;
  uniform vec3  uColor2;
  uniform vec3  uColor3;

  varying vec2  vUv;
  varying float vT;
  varying float vSeed;
  varying vec3  vTint;

  ${noiseGLSL}
  ${commonGLSL}

  float shapeMask(vec2 uv) {
    vec2 c = (uv - 0.5) * 2.0;
    float d = length(c);

    #if SHAPE == 0                       // SOFT
      return smoothstep(1.0, 0.0, d);

    #elif SHAPE == 1                     // SMOKE
      float n = fbm3(vec3(c * 1.6, vSeed * 21.0 + uTime * 0.25));
      return smoothstep(1.0, 0.05, d + n * 0.42) * 0.9;

    #else                                // STREAK
      float core = smoothstep(1.0, 0.0, abs(c.x) * 3.4);
      float len = smoothstep(1.0, 0.0, abs(c.y));
      return core * len;
    #endif
  }

  void main() {
    if (vT < 0.0 || vT > 1.0) discard;

    float mask = shapeMask(vUv);
    if (mask <= 0.004) discard;

    // 生命周期内的透明度。
    float fade = smoothstep(0.0, max(uFadeIn, 1e-3), vT) *
                 (1.0 - smoothstep(clamp(uFadeOut, 0.0, 0.999), 1.0, vT));

    float alpha = mask * fade * uOpacity;
    if (alpha < 0.004) discard;

    vec3 color = gradient4(uColor0, uColor1, uColor2, uColor3, vT) * vTint;
    color *= uGlow;

    // 非预乘：three 的 Additive/Normal 混合模式都会自己乘源 alpha。
    gl_FragColor = vec4(color, alpha);
  }
`;
