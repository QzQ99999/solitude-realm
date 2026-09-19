import {
  Mesh,
  IcosahedronGeometry,
  ShaderMaterial,
  AdditiveBlending,
  Color,
  Group,
  DoubleSide
} from 'three';
import { noiseGLSL } from './NoiseGLSL.js';
import { commonGLSL } from './CommonGLSL.js';
import { sharedUniforms } from './FrameUniforms.js';
import { ObjectPool } from './ObjectPool.js';
import { Easing } from './math.js';

/**
 * BurstSphere.js — 池化的膨胀球壳，每种元素命中的爆裂都用它。
 *
 * 移植自 elemental-sandbox（MIT）。共享一枚 20 面球几何、每个池化实例一份
 * 材质（uniform 独立），一个着色器带六个编译期模式。
 */
export const BurstMode = Object.freeze({
  FIRE: 0, // 翻卷的火球
  AIR: 2, // 薄薄的压力壳
  FROST: 4, // 冻结的水汽壳，撕成晶片
  STORM: 5 // 电离空气：细丝在近乎透明的壳上竞速
});

const BURST_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uAge;
  uniform float uDisplace;
  uniform float uSeed;
  uniform float uTurbulence;

  varying vec3  vNormalW;
  varying vec3  vViewDir;
  varying float vDisp;

  ${noiseGLSL}

  void main() {
    // 翻卷的表面：多倍频噪声沿法线外推，随爆裂膨胀向外滚动。
    vec3 np = normal * (1.6 + uAge * 1.4) + vec3(uSeed * 13.0) - vec3(0.0, uTime * 0.6, 0.0);
    float n = fbm4(np) * 0.6 + ridged(np * 1.3, 4) * 0.4;
    vDisp = n;

    float amount = uDisplace * (0.35 + uAge * 0.9) * uTurbulence;
    vec3 pos = position + normal * n * amount;

    vec4 world = modelMatrix * vec4(pos, 1.0);
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vViewDir = cameraPosition - world.xyz;

    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const BURST_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uAge;
  uniform float uSeed;
  uniform float uIntensity;
  uniform float uFresnel;
  uniform float uOpacity;
  uniform vec3  uColorA;
  uniform vec3  uColorB;
  uniform vec3  uColorC;

  varying vec3  vNormalW;
  varying vec3  vViewDir;
  varying float vDisp;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    float fres = fresnelTerm(vViewDir, vNormalW, 2.2, 1.0) * uFresnel;
    float heat = clamp(vDisp * 0.5 + 0.5, 0.0, 1.0);

    // 爆裂生命期内把壳溶解掉。
    vec2 dis = dissolveMask(heat, uAge * 1.15 - 0.15, 0.3);

    float alpha = uOpacity;
    vec3 color;

    #if BURST_MODE == 0                     /* FIRE */
      color = gradient4(uColorA, uColorB, uColorC, uColorC * 0.15, 1.0 - heat);
      color += dis.y * uColorA * 3.0;
      alpha *= (1.0 - uAge) * (0.55 + fres * 0.8) * dis.x;

    #elif BURST_MODE == 2                   /* AIR */
      color = mix(uColorA, uColorB, fres);
      alpha *= (1.0 - uAge) * fres * 0.85 * dis.x;

    #elif BURST_MODE == 4                   /* FROST */
      // 冻结的水汽而非爆炸：顶点阶段算好的翻卷噪声兼作结晶掩码，
      // 壳在晶片处变得玻璃般不透明、晶片之间仍然透亮——
      // 它是撕开来的，不是淡出的球。
      float plates = smoothstep(0.42, 0.95, heat);
      float rime = smoothstep(0.55, 0.05, voronoi2(vNormalW.xy * 9.0 + vNormalW.z * 3.0 + uSeed).x);
      color = mix(uColorA, uColorB, heat * 0.9);
      color = mix(color, uColorC * (0.7 + 0.6 * rime), plates);
      color += uColorC * fres * 1.3;
      alpha *= (1.0 - uAge) * (0.16 + fres * 0.95 + plates * 0.7) * dis.x;

    #else                                   /* STORM */
      // 电离的空气，不是火球。壳必须保持*空*：壳身几乎不贡献，
      // 看到的是在表面竞速的细丝加菲涅尔边缘。脊状噪声沿法线方向滚动，
      // 给出随膨胀滑行的分叉电弧。故意硬阈值。
      float fil = ridged(vNormalW * (5.0 + uAge * 7.0) + vec3(uSeed * 9.0) +
                         vec3(0.0, uTime * 3.4, 0.0), 4);
      float arcs = smoothstep(0.80, 0.97, fil) * (1.0 - uAge * 0.6);
      float rim = pow(fres, 1.6);
      color = mix(uColorA, uColorB, heat * 0.5);
      color = mix(color, uColorC, arcs);
      color += uColorC * rim * 1.2 + uColorC * arcs * 2.4;
      alpha *= (1.0 - uAge) * (rim * 0.55 + arcs * 0.9) * dis.x;
    #endif

    alpha = clamp(alpha, 0.0, 1.0);
    if (alpha < 0.004) discard;

    color *= uIntensity;
    gl_FragColor = vec4(color, alpha);
  }
`;

export class BurstSystem {
  constructor(scene) {
    this.group = new Group();
    this.group.name = 'Bursts';
    scene.add(this.group);

    this.geometry = new IcosahedronGeometry(1, 4);
    this.pools = new Map();
    this.active = [];
  }

  _poolFor(mode) {
    let pool = this.pools.get(mode);
    if (!pool) {
      pool = new ObjectPool(
        () => this._create(mode),
        (burst) => {
          burst.mesh.visible = false;
          this.group.remove(burst.mesh);
        }
      );
      this.pools.set(mode, pool);
    }
    return pool;
  }

  _create(mode) {
    const material = new ShaderMaterial({
      defines: { BURST_MODE: mode },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: AdditiveBlending,
      side: DoubleSide,
      toneMapped: false,
      uniforms: sharedUniforms({
        uAge: { value: 0 },
        uSeed: { value: Math.random() },
        uDisplace: { value: 0.45 },
        uTurbulence: { value: 1 },
        uIntensity: { value: 1 },
        uFresnel: { value: 1 },
        uOpacity: { value: 1 },
        uColorA: { value: new Color(1, 0.9, 0.6) },
        uColorB: { value: new Color(1, 0.45, 0.1) },
        uColorC: { value: new Color(0.4, 0.08, 0.03) }
      }),
      vertexShader: BURST_VERTEX,
      fragmentShader: BURST_FRAGMENT
    });

    const mesh = new Mesh(this.geometry, material);
    mesh.renderOrder = 14;
    mesh.frustumCulled = false;

    return { mesh, material, mode, age: 0, life: 1, radius: 1, endRadius: 2 };
  }

  /**
   * @param {number} mode BurstMode.*
   * @param {THREE.Vector3} position
   */
  spawn(mode, position, options = {}) {
    const {
      radius = 0.4,
      endRadius = 3,
      life = 0.9,
      intensity = 1,
      opacity = 1,
      fresnel = 1,
      displace = 0.45,
      turbulence = 1,
      colorA = null,
      colorB = null,
      colorC = null,
      squash = 1
    } = options;

    const burst = this._poolFor(mode).acquire();
    const u = burst.material.uniforms;

    burst.age = 0;
    burst.life = Math.max(0.05, life);
    burst.radius = radius;
    burst.endRadius = endRadius;
    burst.squash = squash;

    u.uAge.value = 0;
    u.uSeed.value = Math.random() * 10;
    u.uIntensity.value = intensity;
    u.uOpacity.value = opacity;
    u.uFresnel.value = fresnel;
    u.uDisplace.value = displace;
    u.uTurbulence.value = turbulence;
    if (colorA) u.uColorA.value.copy(colorA);
    if (colorB) u.uColorB.value.copy(colorB);
    if (colorC) u.uColorC.value.copy(colorC);

    burst.mesh.position.copy(position);
    burst.mesh.scale.setScalar(radius);
    burst.mesh.visible = true;
    this.group.add(burst.mesh);
    this.active.push(burst);
    return burst;
  }

  update(dt) {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const burst = this.active[i];
      burst.age += dt;
      const t = Math.min(1, burst.age / burst.life);
      burst.material.uniforms.uAge.value = t;

      // 快膨胀、缓收尾 —— 经典的爆炸剪影。
      const scale = burst.radius + (burst.endRadius - burst.radius) * Easing.outQuint(t);
      burst.mesh.scale.set(scale, scale * burst.squash, scale);

      if (t >= 1) {
        this.active.splice(i, 1);
        this._poolFor(burst.mode).release(burst);
      }
    }
  }

  clear() {
    for (const burst of this.active) this._poolFor(burst.mode).release(burst);
    this.active.length = 0;
  }

  dispose() {
    this.clear();
    for (const pool of this.pools.values()) pool.dispose((burst) => burst.material.dispose());
    this.pools.clear();
    this.geometry.dispose();
    this.group.parent?.remove(this.group);
  }
}
