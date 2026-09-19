import {
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  AdditiveBlending,
  NormalBlending,
  Color,
  Group
} from 'three';
import { noiseGLSL } from './NoiseGLSL.js';
import { commonGLSL } from './CommonGLSL.js';
import { sharedUniforms } from './FrameUniforms.js';
import { ObjectPool } from './ObjectPool.js';

/**
 * GroundDecals.js — 池化的程序化地面贴花。
 *
 * 移植自 elemental-sandbox（MIT）。每张贴花是一片贴地的四边形，带完全
 * 程序化的片元着色器：没有贴花贴图，也没有投影开销。每张贴花一份材质
 * 保证 uniform 独立，three 的程序缓存仍保证每种贴花只编译一次。
 *
 * 用到的类型：
 *   SCORCH    烧焦的地面，带冷却余烬（火/雷）
 *   SHOCKWAVE 一圈向外扩散的细环（所有冲击）
 *   FROST     成片外扩的霜（冰）
 *   ARC       分叉的电流灼痕（雷）
 *   CRACK     放射状龟裂 + 灼热辉光（火）
 *   DUSTRING   贴地的柔软尘环
 */
export const DecalType = Object.freeze({
  SCORCH: 0, // 烧焦地面 + 冷却余烬
  CRACK: 2, // 放射龟裂 + 灼热辉光
  SHOCKWAVE: 3, // 细的外扩环
  DUSTRING: 4, // 贴地尘环
  FROST: 6, // 成片外扩的霜
  ARC: 7 // 分叉的电流灼痕
});

const DECAL_VERTEX = /* glsl */ `
  uniform vec3 uLightDir;      // 世界空间，指向主光
  varying vec2 vUv;
  varying vec3 vLight;         // 同一方向，贴花自己的标架

  void main() {
    vUv = uv;

    // 贴花以随机偏航生成来去相关噪声。把主光方向一次性旋进四边形的标架：
    vec3 ax = normalize(modelMatrix[0].xyz);
    vec3 ay = normalize(modelMatrix[1].xyz);
    vec3 az = normalize(modelMatrix[2].xyz);
    vLight = normalize(vec3(dot(uLightDir, ax), dot(uLightDir, ay), -dot(uLightDir, az)));

    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const DECAL_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uAge;        // 0..1 归一化寿命
  uniform float uSeed;
  uniform float uIntensity;
  uniform float uWidth;      // 裂纹/环的厚度
  uniform float uRadius;     // 足迹半径（米），供世界尺度的颗粒
  uniform vec3  uColorA;
  uniform vec3  uColorB;

  varying vec2 vUv;
  varying vec3 vLight;

  ${noiseGLSL}
  ${commonGLSL}

  /**
   * q（距贴花中心的米数）处积雪的深度，约 0..1。
   * 三个尺度：能看出形状的堆积、结壳开裂的肩状板、顶上的细颗粒。
   */
  float snowDepth(vec2 q, float seed, float sharpness) {
    float drift = fbm3(vec3(q * 0.85, seed)) * 0.5 + 0.5;
    vec2  cell  = voronoi2(q * (1.4 + sharpness * 0.9) + seed * 7.0);
    float slabs = smoothstep(0.0, 0.55, cell.x) * 0.30 + cell.y * 0.12;
    float grain = snoise01(vec3(q * (7.0 + sharpness * 5.0), seed * 3.0)) * 0.15;
    return drift * 0.60 + slabs + grain;
  }

  void main() {
    vec2 c = (vUv - 0.5) * 2.0;
    float d = length(c);
    if (d > 1.0) discard;

    float alpha = 0.0;
    vec3 color = uColorA;
    float fadeOut = 1.0 - smoothstep(0.55, 1.0, uAge);

    #if DECAL == 0                                   /* SCORCH */
      float n = fbm3(vec3(c * 2.4, uSeed * 13.0));
      float burn = smoothstep(1.0, 0.15, d + n * 0.45);
      float embers = pow(max(0.0, snoise(vec3(c * 6.0, uSeed * 9.0 + uTime * 0.35))), 4.0);
      alpha = burn * (0.85 * fadeOut);
      color = mix(uColorA, uColorB, embers * (1.0 - uAge));
      color += embers * uColorB * 2.5 * (1.0 - smoothstep(0.0, 0.6, uAge));

    #elif DECAL == 2                                 /* CRACK */
      float ang = atan(c.y, c.x);
      float branch = ridged(vec3(cos(ang), sin(ang), uSeed * 5.0) * 2.6, 4);
      float spread = smoothstep(0.0, 0.45, uAge);
      float radial = smoothstep(spread, spread * 0.35, d);
      float crack = smoothstep(0.55 - uWidth * 0.35, 0.85, branch) * radial;
      float glow = crack * (1.0 - smoothstep(0.1, 0.8, uAge));
      alpha = clamp(crack * 0.95 * fadeOut, 0.0, 1.0);
      color = mix(uColorA, uColorB, glow);
      color += uColorB * glow * 1.8;

    #elif DECAL == 3                                 /* SHOCKWAVE */
      float radius = mix(0.0, 1.0, pow(uAge, 0.55));
      float ring = smoothstep(uWidth, 0.0, abs(d - radius));
      alpha = ring * (1.0 - uAge) * 0.9;
      color = mix(uColorA, uColorB, ring);

    #elif DECAL == 4                                 /* DUSTRING */
      float radius = mix(0.1, 1.0, pow(uAge, 0.4));
      float n = fbm3(vec3(c * 3.1, uSeed * 7.0 + uTime * 0.2));
      float puff = smoothstep(radius, radius * 0.35, d) * (0.6 + n * 0.5);
      alpha = puff * (1.0 - uAge) * 0.7;
      color = mix(uColorA, uColorB, n * 0.5 + 0.5);

    #elif DECAL == 6                                 /* FROST */
      // 寒气过处被压进地面的雪。
      // 全部在*平面*内采样，贴花**由高度场着色**而非靠掩码染色：
      // 前向差分求法线，用场景主光照明——像粉一样堆起来接住光。
      float seed = uSeed * 37.0;
      float sharp = clamp(uWidth, 0.05, 4.0);
      // 以米为单位采样：小霜斑与冲击下的宽霜面颗粒同尺寸，读作同一种东西。
      vec2 q = c * max(0.35, uRadius);

      /* ---- 堆积：参差的覆盖范围，绝不是圆盘 ---- */
      vec2 warp = vec2(fbm3(vec3(q * 0.55, seed)), fbm3(vec3(q * 0.55, seed + 5.7))) * 0.45;
      float lobes = fbm3(vec3(q * 0.8 + warp, seed + 13.0));
      float grow = pow(uAge, 0.30);
      float reach = d * (1.0 - lobes * 0.40);
      float cover = smoothstep(grow, grow - 0.38, reach);
      if (cover < 0.004) discard;

      /* ---- 起伏 ---- */
      float e = 0.16;
      float h  = snowDepth(q, seed, sharp);
      float hx = snowDepth(q + vec2(e, 0.0), seed, sharp);
      float hy = snowDepth(q + vec2(0.0, e), seed, sharp);
      // 浅凸：雪是软的，陡峭的伪法线读作砂砾。
      vec3 nrm = normalize(vec3((h - hx) / e * 0.30, 1.0, (h - hy) / e * 0.30));

      float lambert = clamp(dot(nrm, normalize(vLight)), 0.0, 1.0);
      // 雪散射很深，自身的影子不会变黑——只会变蓝。
      float shade = 0.36 + 0.64 * pow(lambert, 0.8);

      /* ---- 铺得多厚 ---- */
      float lie = smoothstep(0.10, 0.52, cover * (0.34 + 0.78 * h));

      alpha = lie * fadeOut * 0.95;
      color = mix(uColorB * 0.55, mix(uColorA, vec3(1.0), 0.45), shade);

      // 结壳接住光的地方闪冰光——按时间阶梯，随贴花稳定而闪烁。
      float glint = smoothstep(0.90, 1.0, snoise01(vec3(q * 9.0, floor(uTime * 7.0) * 0.37 + seed)));
      color += glint * pow(lambert, 2.0) * 1.5 * (1.0 - smoothstep(0.0, 0.7, uAge));

      // 前进的唇缘还在结冻，行进时保持点亮。
      float lip = smoothstep(0.10, 0.0, abs(reach - grow)) * (1.0 - smoothstep(0.0, 0.5, uAge));
      color = mix(color, mix(uColorB, vec3(1.0), 0.6), lip * 0.55);
      alpha = clamp(alpha + lip * cover * 0.25 * fadeOut, 0.0, 1.0);

    #else                                            /* ARC */
      // 闪电入地处的灼痕。
      // 丝状场在*平面*内采样，绝不按角度。2D 采样加扭曲查表，
      // 丝才能像电流那样蜿蜒分叉。uWidth 是它分裂的精细度。
      float warp = fbm3(vec3(c * 1.7, uSeed * 3.0)) * 0.5;
      float fil = ridged(vec3(c * (2.4 + uWidth * 4.0) + warp, uSeed * 11.0), 4);
      float veins = smoothstep(0.70, 0.96, fil);

      // 参差的前沿向外张开，痕迹从雷击处展开。
      float grow = pow(uAge, 0.35);
      float edge = d + fbm3(vec3(c * 2.2, uSeed * 5.0)) * 0.25;
      float front = smoothstep(grow, grow * 0.15, edge);
      float hot = veins * front * (1.0 - smoothstep(0.0, 0.45, uAge));

      alpha = clamp(veins * front * 1.1, 0.0, 1.0) * fadeOut;
      color = mix(uColorA, uColorB, clamp(veins * 1.4, 0.0, 1.0));
      color += uColorB * hot * 1.8;
    #endif

    alpha *= uIntensity;
    if (alpha < 0.004) discard;

    gl_FragColor = vec4(color, alpha);
  }
`;

export class DecalSystem {
  constructor(scene) {
    this.group = new Group();
    this.group.name = 'GroundDecals';
    scene.add(this.group);

    this.geometry = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.active = [];

    // 每类一个池，材质里的 `#define` 每个实例保持恒定。
    this.pools = new Map();
  }

  _poolFor(type) {
    let pool = this.pools.get(type);
    if (!pool) {
      pool = new ObjectPool(() => this._createDecal(type), (decal) => {
        decal.mesh.visible = false;
        this.group.remove(decal.mesh);
      });
      this.pools.set(type, pool);
    }
    return pool;
  }

  _createDecal(type) {
    const additive =
      type === DecalType.SHOCKWAVE || type === DecalType.ARC;
    const material = new ShaderMaterial({
      defines: { DECAL: type },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: additive ? AdditiveBlending : NormalBlending,
      toneMapped: false,
      uniforms: sharedUniforms({
        uAge: { value: 0 },
        uSeed: { value: Math.random() },
        uIntensity: { value: 1 },
        uWidth: { value: 0.12 },
        uRadius: { value: 1 },
        uColorA: { value: new Color(0.1, 0.06, 0.05) },
        uColorB: { value: new Color(1, 0.5, 0.15) }
      }),
      vertexShader: DECAL_VERTEX,
      fragmentShader: DECAL_FRAGMENT
    });

    const mesh = new Mesh(this.geometry, material);
    mesh.renderOrder = additive ? 8 : 6;
    mesh.frustumCulled = false;

    return { mesh, material, type, age: 0, life: 1, radius: 1, growth: 0 };
  }

  /**
   * @param {number} type   DecalType.*
   * @param {THREE.Vector3|{x:number,z:number}} position
   * @param {object} options { radius, life, colorA, colorB, intensity, width, growth, height }
   */
  spawn(type, position, options = {}) {
    const {
      radius = 2,
      life = 2,
      colorA = null,
      colorB = null,
      intensity = 1,
      width = 0.12,
      growth = 0,
      height = 0.02
    } = options;

    const decal = this._poolFor(type).acquire();
    const u = decal.material.uniforms;

    decal.age = 0;
    decal.life = Math.max(0.05, life);
    decal.radius = radius;
    decal.growth = growth;

    u.uAge.value = 0;
    u.uSeed.value = Math.random();
    u.uIntensity.value = intensity;
    u.uWidth.value = width;
    u.uRadius.value = radius;
    if (colorA) u.uColorA.value.set(colorA);
    if (colorB) u.uColorB.value.set(colorB);

    decal.mesh.position.set(position.x, height, position.z);
    decal.mesh.rotation.y = Math.random() * Math.PI * 2;
    decal.mesh.scale.setScalar(radius * 2);
    decal.mesh.visible = true;

    this.group.add(decal.mesh);
    this.active.push(decal);
    return decal;
  }

  update(dt) {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const decal = this.active[i];
      decal.age += dt;
      const t = decal.age / decal.life;
      decal.material.uniforms.uAge.value = t;

      if (decal.growth !== 0) {
        decal.mesh.scale.setScalar(decal.radius * 2 * (1 + decal.growth * t));
      }

      if (t >= 1) {
        this.active.splice(i, 1);
        this._poolFor(decal.type).release(decal);
      }
    }
  }

  clear() {
    for (const decal of this.active) this._poolFor(decal.type).release(decal);
    this.active.length = 0;
  }

  dispose() {
    this.clear();
    for (const pool of this.pools.values()) pool.dispose((decal) => decal.material.dispose());
    this.pools.clear();
    this.geometry.dispose();
    this.group.parent?.remove(this.group);
  }
}
