import * as THREE from 'three';
import { noiseGLSL } from './vfx/NoiseGLSL.js';
import { commonGLSL } from './vfx/CommonGLSL.js';

/** 场地半径：玩家活动范围被限制在这个圆内（edge.js 的边界环与之共用）。 */
export const BOUNDARY_RADIUS = 58;

/**
 * 风系护盾着色器：一层旋绕的气流球壳。
 *
 * 菲涅尔边缘 + 绕球面流动的风纹（脊状噪声沿切向拉伸、随时间旋转），
 * 消散时按噪声阈值溶解成片剥落、边缘发亮，同时球体膨胀变淡。
 */
const SHIELD_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uSwelling;

  varying vec3 vNormalW;
  varying vec3 vViewDir;
  varying vec3 vLocal;

  ${noiseGLSL}

  void main() {
    vLocal = position;
    // 呼吸式起伏：低频噪声沿法线轻推顶点
    float n = snoise(normal * 1.8 + vec3(0.0, uTime * 0.5, 13.7)) * 0.06;
    vec3 pos = position + normal * n * (1.0 + uSwelling);
    vec4 world = modelMatrix * vec4(pos, 1.0);
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vViewDir = cameraPosition - world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const SHIELD_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uFade;      // 常规透明度（脉动 + 到期渐隐）
  uniform float uDissolve;  // 0=完好 1=完全消散
  uniform float uSwelling;
  uniform vec3  uColorA;    // 气流基色
  uniform vec3  uColorB;    // 高光色

  varying vec3 vNormalW;
  varying vec3 vViewDir;
  varying vec3 vLocal;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    vec3 N = normalize(vNormalW);
    vec3 V = normalize(vViewDir);
    float ndv = clamp(dot(N, V), 0.0, 1.0);
    float fres = pow(1.0 - ndv, 2.0);

    // 环球面流动的风纹：在切向系里采样脊状噪声，沿纬线方向拉长、随时间旋转
    vec3 sp = vLocal * 2.6 + vec3(0.0, uTime * 0.35, 0.0);
    float swirl = ridged(vec3(sp.x, sp.y * 0.6, sp.z) + vec3(uTime * 0.6, 0.0, 0.0), 4);
    float streak = smoothstep(0.62, 0.96, swirl);

    // 消散：噪声阈值溶解，剥落边缘发亮
    vec2 dis = dissolveMask(fbm3(vLocal * 3.6 + vec3(uTime * 0.4)) * 0.5 + 0.5, uDissolve * 1.35 - 0.12, 0.14);

    float alpha = (0.05 + fres * 0.55 + streak * 0.38) * uFade * dis.x;
    if (alpha < 0.004) discard;

    vec3 color = mix(uColorA, uColorB, clamp(streak + fres * 0.6, 0.0, 1.0));
    color += uColorB * dis.y * 2.2; // 消散边缘的亮边
    gl_FragColor = vec4(color * 1.4, alpha);
  }
`;

function windShieldMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
    uniforms: {
      uTime: { value: 0 },
      uFade: { value: 1 },
      uDissolve: { value: 0 },
      uSwelling: { value: 0 },
      uColorA: { value: new THREE.Color('#9fd8ff') },
      uColorB: { value: new THREE.Color('#ffffff') }
    },
    vertexShader: SHIELD_VERTEX,
    fragmentShader: SHIELD_FRAGMENT
  });
}

/**
 * player.js — 玩家角色：一名持杖的元素使。
 *
 * 全部由基础几何拼成：斗篷圆锥 + 兜帽 + 发光的双眼 + 法杖与杖头宝珠。宝珠
 * 与眼睛的颜色跟随"当前选择的元素"，施法时举杖、宝珠胀亮、身体微微前倾。
 * 移动带上下起伏，转身朝移动/瞄准方向平滑插值。
 */
export class Player {
  constructor(scene) {
    this.root = new THREE.Group(); // 位置 + 朝向
    this.body = new THREE.Group(); // 姿态（飞行前倾等）
    this.root.add(this.body);
    this.scene = scene;
    scene.add(this.root);

    const robeMaterial = new THREE.MeshStandardMaterial({
      color: '#2b3547',
      roughness: 0.75,
      metalness: 0.05,
      flatShading: true
    });
    const trimMaterial = new THREE.MeshStandardMaterial({
      color: '#42536e',
      roughness: 0.6,
      flatShading: true
    });

    // 斗篷
    this.robe = new THREE.Mesh(new THREE.ConeGeometry(0.52, 1.55, 9), robeMaterial);
    this.robe.position.y = 0.78;
    // 肩部披风环
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.36, 0.22, 9), trimMaterial);
    collar.position.y = 1.42;

    // 兜帽与头
    this.head = new THREE.Group();
    const hood = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.52, 8), robeMaterial);
    hood.position.y = 0.28;
    const face = new THREE.Mesh(
      new THREE.SphereGeometry(0.21, 12, 10),
      new THREE.MeshStandardMaterial({ color: '#101620', roughness: 0.9 })
    );
    face.position.set(0, 0.12, 0.1);
    this.head.add(hood, face);
    this.head.position.y = 1.5;

    // 发光双眼 —— 颜色跟随当前元素
    this._eyeMaterial = new THREE.MeshBasicMaterial({ color: '#9fd8ff' });
    const eyeGeometry = new THREE.SphereGeometry(0.028, 6, 6);
    const eyeL = new THREE.Mesh(eyeGeometry, this._eyeMaterial);
    eyeL.position.set(-0.07, 0.14, 0.26);
    const eyeR = new THREE.Mesh(eyeGeometry, this._eyeMaterial);
    eyeR.position.set(0.07, 0.14, 0.26);
    this.head.add(eyeL, eyeR);

    // 法杖：杖身 + 杖头宝珠 + 宝珠光（最初的造型）
    this.staff = new THREE.Group();
    const rod = new THREE.Mesh(
      new THREE.CylinderGeometry(0.035, 0.05, 1.85, 6),
      new THREE.MeshStandardMaterial({ color: '#1a1410', roughness: 0.85 })
    );
    rod.position.y = 0.92;
    this._orbMaterial = new THREE.MeshStandardMaterial({
      color: '#9fd8ff',
      emissive: '#9fd8ff',
      emissiveIntensity: 1.6,
      roughness: 0.3
    });
    this.orb = new THREE.Mesh(new THREE.SphereGeometry(0.14, 14, 12), this._orbMaterial);
    this.orb.position.y = 1.95;
    this.orb.renderOrder = 20; // 在地面贴花之后绘制，避免贴花盖住宝珠
    this.orbLight = new THREE.PointLight('#9fd8ff', 6, 7, 2);
    this.orbLight.position.y = 1.95;
    this.staff.add(rod, this.orb, this.orbLight);
    this.staff.position.set(0.44, 0.05, 0.12);
    this.staff.rotation.x = -0.08;

    // 脚下假阴影（留在世界地面高度，角色升空时缩小变淡）
    this.blob = new THREE.Mesh(
      new THREE.CircleGeometry(0.62, 24),
      new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.34, depthWrite: false })
    );
    this.blob.rotation.x = -Math.PI / 2;
    this.blob.position.y = 0.02;
    scene.add(this.blob);

    // 贴地飞行的推进光晕（元素色，随悬浮高度亮起）
    this.hoverGlow = new THREE.Mesh(
      new THREE.CircleGeometry(0.85, 26),
      new THREE.MeshBasicMaterial({
        color: '#9fd8ff',
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      })
    );
    this.hoverGlow.rotation.x = -Math.PI / 2;
    scene.add(this.hoverGlow);

    // 受击无敌帧的风系护盾：旋绕气流球壳，到期时溶解消散
    this.shield = new THREE.Mesh(new THREE.SphereGeometry(1.35, 40, 26), windShieldMaterial());
    this.shield.visible = false;
    this.shield.renderOrder = 20; // 地面贴花之上
    scene.add(this.shield);
    this._shieldShown = false;   // 上一帧护盾是否可见
    this._dissolveT = 1;         // 消散动画进度（1 = 结束）
    this._dissolveFrom = new THREE.Vector3();

    this.body.add(this.robe, collar, this.head, this.staff);

    /** 运行状态 */
    this.position = new THREE.Vector3(0, 0, 0);
    this.velocity = new THREE.Vector3();
    this.facing = 0;
    this._moveAmount = 0;
    this._castT = 1; // 施法动画进度（1 = 结束）
    this._bobT = 0;
    this._hover = 0; // 当前悬浮高度
    this._tilt = 0; // 飞行前倾角

    // 场地边缘状态（供 edge.js / game.js 读取的碰撞提示输入）
    this.edgePush = 0; // 正在顶边界的强度 0~1（平滑），>0.3 视为碰撞中
    this.edgeProximity = 0; // 距边缘的接近程度 0~1（9 米内渐亮）
    this.edgeAngle = 0; // 接触方位角
    this.edgePoint = new THREE.Vector3(); // 边界环上的接触点（粒子发射用）

    this._scratch = new THREE.Vector3();
  }

  /**
   * 无敌帧风系护盾：invulnT > 0 时罩住玩家的旋绕气流球。
   *
   * 罩上瞬间从 0.6 倍弹开，生效期间风纹旋转 + 轻微脉动；
   * 到期（invulnT 归零）后不再直接隐藏，而是播放 0.45 秒消散：
   * 球体膨胀、按噪声阈值溶解成片剥落、剥落边缘发亮，最后散尽。
   *
   * @param {number} elapsed 全局时间
   * @param {number} invulnT 剩余无敌帧
   * @param {number} [dt] 帧间隔（消散动画需要）
   */
  updateShield(elapsed, invulnT, dt = 1 / 60) {
    const u = this.shield.material.uniforms;
    u.uTime.value = elapsed;

    /* —— 到期检测：上一帧还可见、这一帧无敌帧结束 → 开始消散 —— */
    if (this._shieldShown && invulnT <= 0) {
      this._shieldShown = false;
      this._dissolveT = 0;
      this._dissolveFrom.copy(this.shield.position);
    }

    /* —— 消散动画 —— */
    if (this._dissolveT < 1) {
      this._dissolveT = Math.min(1, this._dissolveT + dt / 0.45);
      const k = this._dissolveT;
      this.shield.visible = true;
      this.shield.position.copy(this._dissolveFrom);
      this.shield.scale.setScalar(1 + k * 0.65);
      u.uDissolve.value = k;
      u.uFade.value = (1 - k) * 0.9;
      u.uSwelling.value = k;
      if (k >= 1) this.shield.visible = false;
      return;
    }

    if (invulnT <= 0) {
      this.shield.visible = false;
      this._shieldShown = false;
      return;
    }

    /* —— 生效中：罩上弹开 + 风纹旋转 + 临到期渐隐 —— */
    if (!this._shieldShown) {
      this._shieldShown = true;
      this.shield.scale.setScalar(0.6); // 罩上瞬间从 0.6 弹开
    }
    const scale = this.shield.scale.x + (1 - this.shield.scale.x) * Math.min(1, dt * 10);
    this.shield.visible = true;
    this.shield.position.set(this.position.x, 1.05, this.position.z);
    const fadeOut = Math.min(1, invulnT / 0.35); // 临到期渐隐
    const flicker = 0.78 + 0.22 * Math.sin(elapsed * 16);
    u.uFade.value = 0.9 * fadeOut * flicker;
    u.uDissolve.value = 0;
    u.uSwelling.value = 0;
    this.shield.scale.setScalar(scale * (1 + 0.03 * Math.sin(elapsed * 11)));
  }

  /** 法杖宝珠的世界坐标（能量球发射点）。 */
  getOrbWorldPosition(out) {
    return this.orb.getWorldPosition(out);
  }

  /** 当前元素变了：宝珠、眼睛、飞行光晕换色。 */
  setElement(accent) {
    this._orbMaterial.color.set(accent);
    this._orbMaterial.emissive.set(accent);
    this.orbLight.color.set(accent);
    this._eyeMaterial.color.set(accent);
    this.hoverGlow.material.color.set(accent);
  }

  playCast() {
    this._castT = 0;
  }

  /**
   * @param {number} dt
   * @param {THREE.Vector3|null} moveDir 单位移动方向（世界系），null = 静止
   * @param {THREE.Vector3|null} aimPoint 瞄准点（静止时缓慢转向它）
   * @param {number} elapsed
   * @param {boolean} flying 按住 Shift：贴地快速飞行
   */
  update(dt, moveDir, aimPoint, elapsed, flying = false) {
    const speed = flying ? 17 : 6.2;
    if (moveDir) {
      this.position.addScaledVector(moveDir, speed * dt);
      const r = Math.hypot(this.position.x, this.position.z);
      let clamped = false;
      if (r > BOUNDARY_RADIUS) {
        this.position.x *= BOUNDARY_RADIUS / r;
        this.position.z *= BOUNDARY_RADIUS / r;
        clamped = true;
      }
      // 边缘碰撞检测：被拦在边界上且仍在朝外推时，记为"顶边"状态
      const invR = r > 0.0001 ? 1 / r : 0;
      const outward = (moveDir.x * this.position.x + moveDir.z * this.position.z) * invR;
      const pushing = clamped && outward > 0.12;
      const pushTarget = pushing ? Math.min(1, 0.5 + outward * 0.6) : 0;
      this.edgePush += (pushTarget - this.edgePush) * Math.min(1, dt * (pushing ? 14 : 6));
      this._faceToward(Math.atan2(moveDir.x, moveDir.z), dt, flying ? 9 : 14);
      this._moveAmount = Math.min(1, this._moveAmount + dt * 6);
    } else {
      this._moveAmount = Math.max(0, this._moveAmount - dt * 6);
      this.edgePush += (0 - this.edgePush) * Math.min(1, dt * 6);
      if (aimPoint) {
        const dx = aimPoint.x - this.position.x;
        const dz = aimPoint.z - this.position.z;
        if (dx * dx + dz * dz > 1) this._faceToward(Math.atan2(dx, dz), dt, 4);
      }
    }

    // 边缘接近度：9 米内线性渐亮；接触方位与接触点同步更新
    const distToEdge = BOUNDARY_RADIUS - Math.hypot(this.position.x, this.position.z);
    this.edgeProximity = Math.max(0, Math.min(1, 1 - distToEdge / 9));
    this.edgeAngle = Math.atan2(this.position.x, this.position.z);
    this.edgePoint.set(
      Math.sin(this.edgeAngle) * BOUNDARY_RADIUS,
      0.08,
      Math.cos(this.edgeAngle) * BOUNDARY_RADIUS
    );

    // 贴地悬浮：按住 Shift 平滑升起，松开平滑落回
    const hoverTarget = flying ? 1.25 : 0;
    this._hover += (hoverTarget - this._hover) * Math.min(1, dt * 4.5);
    // 飞行且在移动时身体前倾
    const tiltTarget = flying && moveDir ? 0.42 : 0;
    this._tilt += (tiltTarget - this._tilt) * Math.min(1, dt * 6);
    this.body.rotation.x = this._tilt;

    // 移动起伏 + 施法时的小跳
    this._bobT += dt * (5 + this._moveAmount * 6);
    let hop = 0;
    if (this._castT < 1) {
      this._castT = Math.min(1, this._castT + dt / 0.55);
      const k = Math.sin(this._castT * Math.PI);
      hop = k * 0.09;
      // 举杖 → 收杖
      this.staff.rotation.x = -0.08 - k * 0.85;
      const orbScale = 1 + k * 0.9;
      this.orb.scale.setScalar(orbScale);
      this.orbLight.intensity = 6 + k * 26;
      this.body.rotation.z = k * 0.06;
    } else {
      this.staff.rotation.x = -0.08;
      this.orb.scale.setScalar(1);
      this.orbLight.intensity = 6;
      this.body.rotation.z = 0;
    }

    this.root.position.set(
      this.position.x,
      this._hover + Math.abs(Math.sin(this._bobT)) * 0.09 * this._moveAmount + hop,
      this.position.z
    );
    this.root.rotation.y = this.facing;

    // 假阴影留在地面：升空越高越小越淡
    this.blob.position.set(this.position.x, 0.02, this.position.z);
    const air = Math.min(1, this._hover / 1.25);
    this.blob.material.opacity = 0.34 * (1 - air * 0.7);
    this.blob.scale.setScalar(1 - air * 0.35);

    // 推进光晕：贴地滑行时亮起并脉动
    const glowOn = air * (moveDir ? 0.55 : 0.3);
    const pulse = 0.85 + 0.15 * Math.sin(elapsed * 14);
    this.hoverGlow.position.set(this.position.x, 0.07, this.position.z);
    this.hoverGlow.material.opacity = glowOn * pulse;
    this.hoverGlow.scale.setScalar(1 + air * 0.25 + pulse * 0.08);
  }

  _faceToward(targetYaw, dt, rate) {
    let delta = targetYaw - this.facing;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    this.facing += delta * Math.min(1, dt * rate);
  }

  dispose() {
    this.scene.remove(this.root, this.blob, this.hoverGlow, this.shield);
    this.root.traverse((object) => {
      if (object.geometry) object.geometry.dispose();
      if (object.material) object.material.dispose();
    });
    this.blob.geometry.dispose();
    this.blob.material.dispose();
    this.hoverGlow.geometry.dispose();
    this.hoverGlow.material.dispose();
    this.shield.geometry.dispose();
    this.shield.material.dispose();
  }
}
