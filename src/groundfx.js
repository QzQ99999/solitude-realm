import * as THREE from 'three';
import { BOUNDARY_RADIUS } from './player.js';

/**
 * groundfx.js — 施法后的全场地特效层。
 *
 * 一块覆盖整个竞技场圆盘的叠加盘（半径 BOUNDARY_RADIUS+1，悬在盘面上方
 * 0.07m），着色器里实现四层效果，让"释放技能"真正改写脚下的大地：
 *   1. 染色浪潮：以落点为圆心的元素色浪潮向外扫过全场地（约 2.4 秒铺满），
 *      扫过之处地面被染上领域色，随后缓缓冷却；
 *   2. 地裂：脊线噪声龟裂 + 自落点放射出的主裂线，随浪潮前端"生长"出来，
 *      裂口发亮闪烁，然后渐渐冷却熄灭；
 *   3. 领域残辉：领域存续期间整场保留低强度脉动染色（呼吸感），
 *      世界退回元素荒原时随之消散；
 *   4. 落点闪光：命中瞬间的径向亮斑。
 */
export class GroundFX {
  constructor(scene) {
    this.uniforms = {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color('#9fb4c8') },
      uImpact: { value: new THREE.Vector2(0, 0) }, // 落点（世界 XZ）
      uSince: { value: 99 }, // 距上次施法的秒数
      uSeed: { value: 1.7 }, // 裂纹随机种子（每次施法刷新）
      uRealm: { value: 0 }, // 领域存续强度 0~1（缓变）
      uPulse: { value: 0 } // 命中冲击脉冲 1→0
    };

    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        varying vec2 vWorld;
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vWorld = world.xz;
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uColor;
        uniform vec2 uImpact;
        uniform float uSince;
        uniform float uSeed;
        uniform float uRealm;
        uniform float uPulse;
        varying vec2 vWorld;

        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }
        float valueNoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
            mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
            u.y
          );
        }
        float fbm(vec2 p) {
          float v = 0.0;
          float a = 0.5;
          for (int k = 0; k < 2; k++) {
            v += a * valueNoise(p);
            p = p * 2.07 + vec2(13.7, 7.3);
            a *= 0.5;
          }
          return v;
        }

        void main() {
          vec2 p = vWorld - uImpact;
          float d = length(p);
          const float TAU = 6.28318530718;

          /* —— 染色浪潮：波前半径 2.4 秒扫过全场地 —— */
          float k = clamp(uSince / 2.4, 0.0, 1.0);
          float waveR = 60.0 * (1.0 - pow(1.0 - k, 2.6));
          float lip = exp(-pow((d - waveR) / 1.6, 2.0)) * exp(-uSince * 0.9);
          float washed = smoothstep(waveR, waveR - 9.0, d);
          float burstWash = washed * exp(-uSince * 0.55) * 0.32;

          /* —— 地裂：龟裂脊线 + 放射主裂线 —— */
          float n = fbm(vWorld * 0.33 + uSeed);
          float ridge = 1.0 - abs(2.0 * n - 1.0);
          float crackA = pow(ridge, 9.0);

          float ang = atan(p.y, p.x);
          float rays = 11.0;
          float ra = ang / TAU * rays;
          float jitter = (hash(vec2(floor(ra), uSeed)) - 0.5) * 0.7
                       + (valueNoise(vec2(ra * 2.3, uSeed)) - 0.5) * 0.5;
          float rd = abs(fract(ra + jitter) - 0.5) * 2.0;
          float rw = 0.05 + 0.06 * valueNoise(vec2(d * 0.55, ra * 4.0 + uSeed));
          float crackB = (1.0 - smoothstep(0.0, rw, rd))
                       * smoothstep(1.6, 4.5, d)
                       * step(d, waveR + 0.001);
          float cracks = max(crackA * 0.85, crackB);
          float crackMask = washed * exp(-uSince * 0.42)
                          * (0.72 + 0.28 * sin(uTime * 6.0 + n * 21.0));

          /* —— 领域残辉：领域存续期间整场呼吸染色 —— */
          float breathe = 0.75 + 0.25 * sin(uTime * 1.7 + d * 0.13);
          float realmGlow = uRealm * 0.17 * breathe
                          * (0.75 + 0.25 * valueNoise(vWorld * 0.22 + 3.1));

          /* —— 落点闪光 —— */
          float flash = uPulse * exp(-d * 0.22) * 0.75;

          vec3 col = uColor * (lip * 1.15 + burstWash + cracks * crackMask * 1.7
                               + realmGlow + flash);
          float a = clamp(max(col.r, max(col.g, col.b)), 0.0, 1.0);
          if (a < 0.004) discard;
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `
    });

    this.mesh = new THREE.Mesh(
      new THREE.CircleGeometry(BOUNDARY_RADIUS + 1, 96),
      material
    );
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.position.y = 0.07;
    this.mesh.renderOrder = 1; // 边界环(2)/粒子(3)/冲击波(4) 之下
    scene.add(this.mesh);

    this._colorTarget = new THREE.Color();
  }

  /**
   * 技能命中：从落点炸开全场地浪潮 + 地裂。
   * @param {{x:number,z:number}} point 落点
   * @param {string} hex 元素强调色
   */
  burst(point, hex) {
    this.uniforms.uColor.value.set(hex);
    this.uniforms.uImpact.value.set(point.x, point.z);
    this.uniforms.uSince.value = 0;
    this.uniforms.uSeed.value = Math.random() * 97.0;
    this.uniforms.uPulse.value = 1;
  }

  /**
   * @param {number} dt
   * @param {string} accent 当前领域强调色（残辉随世界改写换色）
   * @param {boolean} realmActive 世界是否处于某个元素领域
   */
  update(dt, accent, realmActive) {
    const u = this.uniforms;
    u.uTime.value += dt;
    u.uSince.value += dt;
    u.uPulse.value = Math.max(0, u.uPulse.value - dt * 1.8);
    const target = realmActive ? 1 : 0;
    u.uRealm.value += (target - u.uRealm.value) * Math.min(1, dt * (realmActive ? 1.5 : 0.8));
    this._colorTarget.set(accent);
    u.uColor.value.lerp(this._colorTarget, Math.min(1, dt * 2.0));
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
