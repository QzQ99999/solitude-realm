import * as THREE from 'three';
import { audio } from './audio.js';
import { createBeamMaterial, BeamPass, beamConfig } from './vfx/BeamMaterial.js';
import {
  createBeamTubeGeometry,
  createBoltRibbonGeometry,
  createBeamRingGeometry
} from './vfx/ProceduralGeometry.js';
import { createOrbMaterial } from './vfx/OrbMaterial.js';
import { BurstMode, DecalType } from './vfx/VFXSystem.js';
import { Easing, saturate } from './vfx/math.js';

/**
 * pillars.js — LV.3 起从天而降的元素光柱。
 *
 * 特效整体移植自 elemental-sandbox（MIT）的参数化光束：同一根管按三个
 * 半径叠画（HALO 大气 / SHELL 空心鞘 / CORE 白热芯），外缠螺旋条带，
 * 冲击环沿柱竞速，蓄能球在云端先聚能再释放。全程序化，无贴图。
 *
 * 玩法不变：随机位置落地——先在地面显示 0.5 秒的预警光圈（伴随预警音），
 * 然后光柱轰下，持续 1~3 秒后消散；玩家碰到光柱受到 30% 生命伤害
 * （每根光柱最多结算一次）。光柱颜色跟随当前领域主题色；等级越高，
 * 生成间隔越短、同屏数量上限越高。
 */
const WARN_TIME = 0.5;
const MAX_R = 40;        // 光柱落点距场地中心的最大半径
const HIT_RADIUS = 2.0;  // 判定碰到光柱的距离
const MAX_BEAMS = 6;     // 同屏完整光柱上限（预警圈不受限）
const SKY_HEIGHT = 26;   // 光柱顶端高度

/* 光柱的束型参数：沙盒光束按天柱尺度放大 */
function pillarBeamConfig() {
  return beamConfig({
    radius: 1.55,
    radiusNear: 0.5,
    radiusCurve: 0.85,
    flare: 1.15,
    flareWidth: 0.14,
    wander: 0.04,
    coreWidth: 0.16,
    coreFill: 0.7,
    shellOpacity: 0.9,
    haloWidth: 2.6,
    haloOpacity: 0.13,
    ripple: 0.25,
    streak: 1.2,
    flowSpeed: 8,
    tipGlow: 1.4,
    tipLength: 0.05,
    coils: 3,
    coilTurns: 2.4,
    coilRadius: 1.7,
    coilWidth: 0.09,
    coilOpacity: 1.4,
    coilGlow: 5,
    rings: 6,
    ringSpeed: 1.1,
    ringInner: 2.2,
    ringOuter: 2.8,
    ringOpacity: 0.9,
    ringGlow: 2.0,
    // 沙盒出厂值是配 HDR 后期泛光调的；本作无后期，亮度倍率相应提高
    opacity: 1.8,
    glow: 1.9,
    colorCore: '#ffffff',
    colorInner: '#d3f4ff',
    colorOuter: '#9fb4c8',
    colorHalo: '#20304a',
    colorCoil: '#bcd2ff',
    colorCoilEdge: '#9fb4c8',
    colorRing: '#d3f4ff'
  });
}

const COIL_INSTANCES = 3;
const RING_INSTANCES = 6;

export class PillarField {
  constructor(scene, onHit, vfx) {
    this.scene = scene;
    this.onHit = onHit; // (damage) => void
    this.vfx = vfx;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.beams = [];
    this.active = false;
    this.tier = 1;
    this.accent = new THREE.Color('#9fb4c8');
    this._spawnT = 2.0;

    // 全部光柱共享的参数空间几何（instanceCount 固定，材质各自独立）
    this._tubeGeo = createBeamTubeGeometry(72, 22);
    this._coilGeo = createBoltRibbonGeometry(64, COIL_INSTANCES);
    this._ringGeo = createBeamRingGeometry(RING_INSTANCES, 36);

    this._scratchColor = new THREE.Color();
    this._state = null;
  }

  /** 等级变化：≥3 激活，<3 撤场。 */
  setTier(tier) {
    this.tier = tier;
    const should = tier >= 3;
    if (!should && this.active) this._clearAll();
    this.active = should;
    if (this.active) this._spawnT = Math.min(this._spawnT, 1.5);
  }

  /** 领域主题色：所有存活光柱与预警圈一起换色（改配置，材质每帧回读）。 */
  setAccent(hex) {
    this.accent.set(hex);
    for (const b of this.beams) this._tint(b);
  }

  _tint(b) {
    if (b.ring) b.ring.material.color.copy(this.accent);
    const c = b.config;
    if (!c) return;
    const accent = this._scratchColor.copy(this.accent);
    c.colorCore = '#ffffff';
    c.colorInner = '#' + accent.clone().lerp(new THREE.Color('#ffffff'), 0.55).getHexString();
    c.colorOuter = '#' + accent.getHexString();
    c.colorHalo = '#' + accent.clone().multiplyScalar(0.28).getHexString();
    c.colorCoil = '#' + accent.clone().lerp(new THREE.Color('#ffffff'), 0.3).getHexString();
    c.colorCoilEdge = '#' + accent.getHexString();
    c.colorRing = '#' + accent.clone().lerp(new THREE.Color('#ffffff'), 0.7).getHexString();
    if (b.orb) {
      b.orb.material.userData.setPalette({
        inner: c.colorInner,
        outer: c.colorOuter
      });
    }
  }

  _clearAll() {
    for (const b of this.beams) this._dispose(b);
    this.beams.length = 0;
  }

  dispose() {
    this._clearAll();
    this._tubeGeo.dispose();
    this._coilGeo.dispose();
    this._ringGeo.dispose();
    this.scene.remove(this.group);
  }

  _dispose(b) {
    if (b.ring) { b.ring.material.dispose(); this.group.remove(b.ring); }
    if (b.orb) { b.orb.material.dispose(); this.group.remove(b.orb); }
    for (const mesh of b.meshes) { mesh.material.dispose(); this.group.remove(mesh); }
    b.meshes.length = 0;
  }

  update(dt, elapsed, playerPos) {
    if (!this.active) return;

    // 生成节拍：等级越高间隔越短；同屏上限 = 等级×2-3（LV3:3 → LV4:5 → LV5:7 …）
    const maxBeams = Math.max(3, Math.min(this.tier * 2 - 3, 19));
    this._spawnT -= dt;
    if (this._spawnT <= 0) {
      this._spawnT = Math.max(1.2, 3.0 - (this.tier - 3) * 0.22) * (0.7 + Math.random() * 0.6);
      if (this.beams.length < maxBeams) this._spawn(playerPos);
    }

    let striking = this.beams.filter((b) => b.phase === 'strike').length;

    for (let i = this.beams.length - 1; i >= 0; i--) {
      const b = this.beams[i];
      b.t += dt;

      if (b.phase === 'warn') {
        // 预警圈：脉动收缩，指向落点
        const k = b.t / WARN_TIME;
        b.ring.material.opacity = 0.55 + 0.4 * Math.sin(elapsed * 22);
        b.ring.scale.setScalar(1.15 - k * 0.35);

        // 云端蓄能球：预警期从天上凝聚，越涨越大
        const charge = saturate(b.t / WARN_TIME);
        b.orb.visible = true;
        b.orb.position.set(b.x, SKY_HEIGHT - 5 - charge * 3, b.z);
        b.orb.scale.setScalar(0.35 + charge * 0.85);
        b.orb.material.uniforms.uCharge.value = charge;

        if (b.t >= WARN_TIME) {
          if (striking >= MAX_BEAMS) continue; // 槽位满了：继续预警等待
          this._strike(b);
          striking++;
        }
        continue;
      }

      // 打击阶段
      b.tSinceStrike += dt;
      const remain = b.life - b.tSinceStrike;
      // 打击前沿 0.09 秒内从云端冲到地面
      b.state.progress = Math.min(1, b.tSinceStrike / 0.09);
      b.state.fade = Math.min(1, Math.max(0, remain / 0.35));
      // 消散前宽度先收成细丝再熄灭
      b.state.widthFade = remain < 0.18 ? Math.max(0.06, remain / 0.18) : 1;
      for (const material of b.materials) material.userData.sync(b.state);

      // 蓄能球在释放瞬间炸掉
      b.orb.visible = false;

      // 伤害：每根光柱只结算一次
      if (!b.hitDone && playerPos && b.tSinceStrike > 0.04) {
        const d = Math.hypot(playerPos.x - b.x, playerPos.z - b.z);
        if (d < HIT_RADIUS) {
          b.hitDone = true;
          this.onHit?.(30);
        }
      }

      if (remain <= 0) {
        this._dispose(b);
        this.beams.splice(i, 1);
      }
    }
  }

  _spawn(playerPos) {
    // 落点：半径 40 以内，距玩家至少 6m
    let x = 0, z = 0;
    for (let tries = 0; tries < 20; tries++) {
      const ang = Math.random() * Math.PI * 2;
      const rad = 5 + Math.random() * (MAX_R - 5);
      x = Math.cos(ang) * rad;
      z = Math.sin(ang) * rad;
      if (!playerPos || Math.hypot(x - playerPos.x, z - playerPos.z) > 6) break;
    }

    const ring = new THREE.Mesh(
      this._ringGeo2 ?? (this._ringGeo2 = new THREE.RingGeometry(1.05, 2.3, 40)),
      new THREE.MeshBasicMaterial({
        color: this.accent.clone(), transparent: true, opacity: 0.8,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false
      })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, 0.07, z);
    ring.renderOrder = 2;
    this.group.add(ring);

    // 云端蓄能球（沙盒 ORB 材质）
    const orb = new THREE.Mesh(
      this._orbGeo ?? (this._orbGeo = new THREE.IcosahedronGeometry(1, 3)),
      createOrbMaterial({ inner: '#d3f4ff', outer: '#9fb4c8', glow: 2.6 })
    );
    orb.visible = false;
    orb.renderOrder = 9;
    this.group.add(orb);

    const b = {
      phase: 'warn', x, z, t: 0, life: 1 + Math.random() * 2, hitDone: false,
      ring, orb, meshes: [], materials: [],
      config: pillarBeamConfig(),
      state: {
        origin: new THREE.Vector3(x, SKY_HEIGHT, z),
        target: new THREE.Vector3(x, 0.05, z),
        side: new THREE.Vector3(1, 0, 0),
        progress: 0, fade: 1, widthFade: 1,
        seed: Math.random() * 100,
        coils: COIL_INSTANCES, rings: RING_INSTANCES
      }
    };
    this._tint(b);
    this._buildBeamMeshes(b);
    this.beams.push(b);
    audio.pillarWarn(); // 预警音
  }

  /** 五个 pass：三层管（HALO/SHELL/CORE）+ 螺旋带 + 冲击环。 */
  _buildBeamMeshes(b) {
    const passes = [
      [BeamPass.HALO, this._tubeGeo, 11],
      [BeamPass.SHELL, this._tubeGeo, 12],
      [BeamPass.CORE, this._tubeGeo, 13],
      [BeamPass.COIL, this._coilGeo, 13],
      [BeamPass.RING, this._ringGeo, 13]
    ];
    for (const [pass, geometry, renderOrder] of passes) {
      const material = createBeamMaterial(pass, b.config);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.visible = false;
      mesh.renderOrder = renderOrder;
      this.group.add(mesh);
      b.meshes.push(mesh);
      b.materials.push(material);
    }
  }

  _strike(b) {
    b.phase = 'strike';
    b.tSinceStrike = 0;
    if (b.ring) {
      this.group.remove(b.ring);
      b.ring.material.dispose();
      b.ring = null;
    }
    for (const mesh of b.meshes) mesh.visible = true;

    // 光柱砸地：薄压力壳 + 冲击波环 + 尘环 + 火花
    const ground = new THREE.Vector3(b.x, 0.5, b.z);
    this.vfx?.bursts.spawn(BurstMode.AIR, ground, {
      radius: 0.3, endRadius: 3.2, life: 0.45,
      intensity: 1.0, opacity: 0.9, fresnel: 2.0, displace: 0.3,
      colorA: b.config.colorOuter, colorB: '#ffffff', colorC: b.config.colorInner
    });
    this.vfx?.decals.spawn(DecalType.SHOCKWAVE, { x: b.x, z: b.z }, {
      radius: 5.2, life: 0.5, width: 0.05, intensity: 0.9,
      colorA: b.config.colorOuter, colorB: '#ffffff'
    });
    this.vfx?.decals.spawn(DecalType.DUSTRING, { x: b.x, z: b.z }, {
      radius: 3.6, life: 0.9, intensity: 0.6,
      colorA: '#3d5c74', colorB: b.config.colorInner, height: 0.05
    });
    this.vfx?.sparkBurst(ground, 'basic', { count: 60, speed: 8, life: 0.7, size: 1.1, up: 1.2 });
    audio.pillarStrike(); // 打击音
  }
}
