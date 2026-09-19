import * as THREE from 'three';
import { frame, sharedUniforms } from './FrameUniforms.js';
import { ParticleEngine, ParticleShape, RateEmitter } from './ParticleSystem.js';
import { BurstSystem, BurstMode } from './BurstSphere.js';
import { DecalSystem, DecalType } from './GroundDecals.js';

/**
 * VFXSystem.js — 从 elemental-sandbox 移植的程序化特效总线。
 *
 * 持有帧共享 uniform、GPU 粒子引擎、爆裂球池与地面贴花池，游戏每帧调用
 * 一次 update(dt, camera, renderer)。各玩法系统（法术/之灵/光柱）通过它
 * 发特效，保持"一次写入更新全部材质"的低 CPU 开销。
 */
export class VFXSystem {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;

    this.bursts = new BurstSystem(scene);
    this.decals = new DecalSystem(scene);
    this.particles = new ParticleEngine(scene);
    this._scratchColor = new THREE.Color();
    this._emit = {};
    this._dir = new THREE.Vector3();

    /* ---- 共享粒子系统：各特效按名字取用，同名即同池 ---- */

    // 速度拉伸的火花（普攻/光束/闪电甩出的线状火花）
    this.sparks = this.particles.get('sparks', {
      capacity: 4000,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true
    });
    this.sparks.uniforms.uDrag.value = 1.4;
    this.sparks.uniforms.uEndSize.value = 0.25;
    this.sparks.uniforms.uSizeIn.value = 0.02;
    this.sparks.uniforms.uFadeIn.value = 0.03;
    this.sparks.uniforms.uFadeOut.value = 0.45;

    // 柔光尘（悬浮的余辉小点）
    this.motes = this.particles.get('motes', {
      capacity: 2400,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true
    });
    this.motes.uniforms.uDrag.value = 1.2;
    this.motes.uniforms.uEndSize.value = 0.16;
    this.motes.uniforms.uSizeIn.value = 0.05;
    this.motes.uniforms.uFadeIn.value = 0.07;
    this.motes.uniforms.uFadeOut.value = 0.4;

    // 烟/雾（非叠加，会遮蔽 —— 给落点深度感）
    this.smoke = this.particles.get('smoke', {
      capacity: 1600,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true
    });
    this.smoke.uniforms.uDrag.value = 1.7;
    this.smoke.uniforms.uEndSize.value = 3.0;
    this.smoke.uniforms.uSizeIn.value = 0.12;
    this.smoke.uniforms.uFadeIn.value = 0.16;
    this.smoke.uniforms.uFadeOut.value = 0.3;
    this.smoke.uniforms.uOpacity.value = 0.55;

    this._sparkEmitter = new RateEmitter();
    this._moteEmitter = new RateEmitter();
  }

  /** 元素名 → 一次爆裂的配色 { a, b, c }（爆/亮/暗三站）。 */
  static ELEMENT_BURST = {
    ice: { a: '#a9e4ff', b: '#cdefff', c: '#f2feff' },
    fire: { a: '#ffd27a', b: '#ff6a12', c: '#fff3d0' },
    storm: { a: '#a98bff', b: '#d3f4ff', c: '#ffffff' },
    basic: { a: '#9fd8ff', b: '#d3f4ff', c: '#ffffff' }
  };

  /**
   * 元素色火花爆发（GPU 粒子 + 速度拉伸）。
   * @param {THREE.Vector3} pos
   * @param {string} element 'ice'|'fire'|'storm'|'basic'
   * @param {object} [opts] { count, speed, life, gravity, size, up }
   */
  sparkBurst(pos, element, opts = {}) {
    const palette = VFXSystem.ELEMENT_BURST[element] ?? VFXSystem.ELEMENT_BURST.basic;
    const count = opts.count ?? 60;
    this.sparks.setGradient('#ffffff', palette.c, palette.b, palette.a);
    this.sparks.uniforms.uGravity.value.set(0, opts.gravity ?? -11, 0);
    this.sparks.uniforms.uSizeScale.value = opts.size ?? 1.2;
    this.sparks.uniforms.uLifeScale.value = opts.life ?? 0.8;
    this.sparks.uniforms.uGlow.value = 1.6;

    const e = this._emit;
    e.position = pos;
    e.radius = opts.radius ?? 0.25;
    e.direction = this._dir.set(0, opts.up ?? 0.7, 0).normalize();
    e.speed = opts.speed ?? 9;
    e.speedVariance = 0.85;
    e.spread = 1.0;
    e.size = 0.22;
    e.sizeVariance = 0.8;
    e.life = 0.6;
    e.lifeVariance = 0.6;
    e.spin = 0;
    e.tint = null;
    e.time = frame.uTime.value;
    this.sparks.emit(count, e);
  }

  /**
   * 元素击杀爆裂：爆裂球壳 + 冲击波贴花 + 火花，击杀特效的总入口。
   * @param {THREE.Vector3} pos
   * @param {string} element 'ice'|'fire'|'storm'|'basic'
   * @param {number} [scale] 1 = 普通之灵，更大 = 特殊之灵
   */
  killBurst(pos, element, scale = 1) {
    const palette = VFXSystem.ELEMENT_BURST[element] ?? VFXSystem.ELEMENT_BURST.basic;
    const modes = {
      ice: BurstMode.FROST,
      fire: BurstMode.FIRE,
      storm: BurstMode.STORM,
      basic: BurstMode.AIR
    };
    this.bursts.spawn(modes[element] ?? BurstMode.AIR, pos, {
      radius: 0.2 * scale,
      endRadius: (element === 'basic' ? 2.6 : 3.4) * scale,
      life: 0.55 + 0.15 * scale,
      intensity: 1.1,
      opacity: 0.95,
      fresnel: element === 'basic' ? 2.2 : 1.6,
      displace: 0.45,
      colorA: palette.a,
      colorB: palette.b,
      colorC: palette.c
    });
    this.decals.spawn(DecalType.SHOCKWAVE, pos, {
      radius: 2.2 * scale,
      life: 0.5,
      width: 0.05,
      intensity: 0.85,
      colorA: palette.b,
      colorB: '#ffffff'
    });
    this.sparkBurst(pos, element, {
      count: Math.round(46 * scale),
      speed: 8 * scale,
      life: 0.9,
      size: 1.1
    });
  }

  /** 每帧：推进共享时钟、同步分辨率、更新池、上传粒子脏区间。 */
  update(dt, camera, renderer) {
    frame.uTime.value += dt;
    frame.uDelta.value = dt;

    if (renderer) {
      const size = renderer.getSize(new THREE.Vector2());
      const pr = renderer.getPixelRatio();
      frame.uResolution.value.set(size.x * pr, size.y * pr);
    }
    if (camera) {
      frame.uCameraNear.value = camera.near;
      frame.uCameraFar.value = camera.far;
    }

    this.bursts.update(dt);
    this.decals.update(dt);
    this.particles.flush();
  }

  /** 重新开始：清空所有进行中的特效与残留。 */
  clear() {
    this.bursts.clear();
    this.decals.clear();
    this.particles.reset();
    this._sparkEmitter.reset();
    this._moteEmitter.reset();
  }

  dispose() {
    this.bursts.dispose();
    this.decals.dispose();
    this.particles.dispose();
  }
}

export { sharedUniforms, frame, BurstMode, DecalType, ParticleShape };
