import * as THREE from 'three';
import { BOUNDARY_RADIUS } from './player.js';

const R = BOUNDARY_RADIUS;
const RING_INNER = 5.4; // 环面向场地内延伸的宽度（容纳向内扩散的碰撞波纹）

/**
 * edge.js — 场地边缘感知层。
 *
 * 在活动半径 BOUNDARY_RADIUS 处铺一圈能量边界环 + 12 座界碑，三层反馈：
 * - 平时：低亮度的旋转刻度虚线环，让玩家随时知道边界在哪；
 * - 接近（9 米内）：整环渐亮，朝向玩家一侧提前泛光，提示"快到边了"；
 * - 顶边碰撞：接触弧高强度脉动 + 从接触点向场地内扩散的冲击波纹，
 *   配合 game.js 的粒子火花与 HUD 提示文字。
 * 颜色跟随当前世界主题的 accent，世界改写时边界一起换色。
 */
export class EdgeBoundary {
  constructor(scene) {
    this.scene = scene;

    this.uniforms = {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color('#9fb4c8') },
      uProximity: { value: 0 }, // 接近程度 0~1
      uPush: { value: 0 }, // 顶边强度 0~1
      uHit: { value: 0 }, // 碰撞冲击 1→0（JS 侧衰减，驱动波纹扩散）
      uDir: { value: new THREE.Vector2(0, -1) }, // 玩家方位（环局部平面坐标）
      uDim: { value: 1 } // 雾天淡化系数 0~1（浓雾里边界隐入雾中，不再是一条硬线）
    };

    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        varying vec2 vLocal;
        void main() {
          vLocal = position.xy;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uColor;
        uniform float uProximity;
        uniform float uPush;
        uniform float uHit;
        uniform vec2 uDir;
        uniform float uDim;
        varying vec2 vLocal;

        const float TAU = 6.28318530718;
        const float RADIUS = ${R.toFixed(1)};

        void main() {
          vec2 nd = normalize(vLocal);
          float r = length(vLocal);

          // 主环带：中心在 R 的高斯光带（显式平方，pow 对负底数是未定义行为）
          float d0 = (r - RADIUS) / 0.5;
          float band = exp(-d0 * d0);

          // 旋转细刻度（60 段）+ 慢速反向流动的粗刻度（12 段）
          float ang = atan(vLocal.y, vLocal.x);
          float ticks = smoothstep(0.3, 0.7, fract(ang / TAU * 60.0 + uTime * 0.05));
          float majors = smoothstep(0.2, 0.8, fract(ang / TAU * 12.0 - uTime * 0.03));

          // 朝向玩家一侧的方位泛光（角向高斯）
          float angToPlayer = acos(clamp(dot(nd, uDir), -1.0, 1.0));
          float d1 = angToPlayer / 0.85;
          float sideArc = exp(-d1 * d1);

          // 分层亮度（常驻亮度按雾天淡化系数收敛，让边界隐入雾中；
          // 接近泛光/顶边/碰撞波纹保持强度——玩法反馈不打折）
          float base = band * (0.05 + 0.16 * uProximity) * (0.4 + 0.6 * ticks) * uDim;
          base += band * majors * (0.05 + 0.08 * uProximity) * uDim;
          float glow = band * sideArc * uProximity * 0.3 * mix(uDim, 1.0, 0.6);
          float push = band * sideArc * uPush * (0.55 + 0.25 * sin(uTime * 16.0));

          // 碰撞冲击波纹：uHit 1→0 期间，弧形波从边界向场地内扩散
          float waveDepth = (1.0 - uHit) * ${RING_INNER.toFixed(1)};
          float depth = max(0.0, RADIUS - r);
          float d2 = (depth - waveDepth) / 0.5;
          float ripple = exp(-d2 * d2) * sideArc * uHit;

          float a = (base + glow + push + ripple);
          if (a < 0.003) discard;
          gl_FragColor = vec4(uColor * (1.0 + uPush * 0.7 + ripple * 0.8), a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `
    });

    this.ring = new THREE.Mesh(new THREE.RingGeometry(R - RING_INNER, R + 1.2, 256, 1), material);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.05;
    this.ring.renderOrder = 2;
    scene.add(this.ring);

    // 12 座界碑：细长发光柱，标记边界的空间位置（远处也能读出弧线走向）
    this.pylonGeometry = new THREE.BoxGeometry(0.14, 1.8, 0.14);
    this.pylonMaterial = new THREE.MeshBasicMaterial({
      color: '#9fb4c8',
      transparent: true,
      opacity: 0.32,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    this.pylons = [];
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2;
      const pylon = new THREE.Mesh(this.pylonGeometry, this.pylonMaterial);
      pylon.position.set(Math.sin(angle) * R, 0.9, Math.cos(angle) * R);
      scene.add(pylon);
      this.pylons.push(pylon);
    }

    this._colorTarget = new THREE.Color('#9fb4c8');
  }

  /** 碰撞瞬间打点：触发一次接触点冲击波纹（重复调用只刷新强度）。 */
  flash(intensity = 1) {
    this.uniforms.uHit.value = Math.max(this.uniforms.uHit.value, intensity);
  }

  /**
   * @param {number} dt
   * @param {number} elapsed
   * @param {import('./player.js').Player} player 读取 edgePush / edgeProximity / edgeAngle
   * @param {string} accent 当前主题强调色
   * @param {number} [fogFar] 当前世界的实时雾距（浓雾时边界自动隐入雾中）
   */
  update(dt, elapsed, player, accent, fogFar = 235) {
    const u = this.uniforms;
    u.uTime.value = elapsed;
    u.uProximity.value = player.edgeProximity;
    u.uPush.value += (player.edgePush - u.uPush.value) * Math.min(1, dt * 10);

    // 冲击衰减：约 0.5 秒走完一圈向内扩散的波纹
    u.uHit.value = Math.max(0, u.uHit.value - dt * 2.1);

    // 雾天淡化：fogFar 45~150 映射到 0.12~1（烈焰浓雾里边界只剩隐约一线）
    const dim = THREE.MathUtils.smoothstep(fogFar, 45, 150);
    const fogDim = 0.12 + 0.88 * dim;
    u.uDim.value += (fogDim - u.uDim.value) * Math.min(1, dt * 1.5);

    // 玩家方位 → 环局部平面坐标（rotation.x=-π/2：local(x,y) → world(x,-y)）
    const px = player.position.x;
    const pz = player.position.z;
    if (px * px + pz * pz > 0.001) {
      u.uDir.value.set(px, -pz).normalize();
    }

    // 颜色平滑跟随主题 accent（世界改写过渡时边界一起变色）
    this._colorTarget.set(accent);
    u.uColor.value.lerp(this._colorTarget, Math.min(1, dt * 3));
    this.pylonMaterial.color.copy(u.uColor.value);
    this.pylonMaterial.opacity = (0.2 + 0.16 * player.edgeProximity + 0.14 * Math.sin(elapsed * 2.2) * 0.5)
      * (0.3 + 0.7 * u.uDim.value);
  }

  dispose() {
    this.scene.remove(this.ring, ...this.pylons);
    this.ring.geometry.dispose();
    this.ring.material.dispose();
    this.pylonGeometry.dispose();
    this.pylonMaterial.dispose();
  }
}
