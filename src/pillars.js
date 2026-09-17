import * as THREE from 'three';
import { audio } from './audio.js';

/**
 * pillars.js — LV.5 起从天而降的元素光柱。
 *
 * 随机位置落地：先在地面显示 0.5 秒的预警光圈（伴随预警音），然后光柱轰下，
 * 持续 1~3 秒后消散；玩家碰到光柱受到 30% 生命伤害（每根光柱最多结算一次）。
 * 光柱颜色跟随当前领域主题色（冰/火/雷/荒原各不相同）；
 * 等级越高，生成间隔越短、同屏数量上限越高。
 */
const WARN_TIME = 0.5;
const MAX_R = 40;        // 光柱落点距场地中心的最大半径
const HIT_RADIUS = 2.0;  // 判定碰到光柱的距离

export class PillarField {
  constructor(scene, onHit) {
    this.scene = scene;
    this.onHit = onHit; // (damage) => void
    this.group = new THREE.Group();
    scene.add(this.group);
    this.beams = [];
    this.active = false;
    this.tier = 1;
    this.accent = new THREE.Color('#9fb4c8');
    this._spawnT = 2.0;

    this._ringGeo = new THREE.RingGeometry(1.05, 2.3, 40);
    this._coreGeo = new THREE.CylinderGeometry(0.55, 0.72, 30, 14, 1, true);
    this._glowGeo = new THREE.CylinderGeometry(1.5, 1.95, 30, 18, 1, true);
  }

  /** 等级变化：≥3 激活，<3 撤场。 */
  setTier(tier) {
    this.tier = tier;
    const should = tier >= 3;
    if (!should && this.active) this._clearAll();
    this.active = should;
    if (this.active) this._spawnT = Math.min(this._spawnT, 1.5);
  }

  /** 领域主题色：所有存活光柱与预警圈一起换色。 */
  setAccent(hex) {
    this.accent.set(hex);
    for (const b of this.beams) this._tint(b);
  }

  _tint(b) {
    if (b.ring) b.ring.material.color.copy(this.accent);
    if (b.core) {
      b.core.material.color.copy(this.accent).lerp(new THREE.Color('#ffffff'), 0.55);
    }
    if (b.glow) b.glow.material.color.copy(this.accent);
  }

  _clearAll() {
    for (const b of this.beams) this._dispose(b);
    this.beams.length = 0;
  }

  dispose() {
    this._clearAll();
    this._ringGeo.dispose();
    this._coreGeo.dispose();
    this._glowGeo.dispose();
    this.scene.remove(this.group);
  }

  _dispose(b) {
    if (b.ring) { b.ring.geometry = this._ringGeo; b.ring.material.dispose(); this.group.remove(b.ring); }
    if (b.core) { b.core.material.dispose(); this.group.remove(b.core); }
    if (b.glow) { b.glow.material.dispose(); this.group.remove(b.glow); }
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

    for (let i = this.beams.length - 1; i >= 0; i--) {
      const b = this.beams[i];
      b.t += dt;

      if (b.phase === 'warn') {
        // 预警圈：脉动收缩，指向落点
        const k = b.t / WARN_TIME;
        b.ring.material.opacity = 0.55 + 0.4 * Math.sin(elapsed * 22);
        b.ring.scale.setScalar(1.15 - k * 0.35);
        if (b.t >= WARN_TIME) {
          this._strike(b);
        }
        continue;
      }

      // 打击阶段
      b.tSinceStrike += dt;
      const remain = b.life - b.tSinceStrike;
      const fadeIn = Math.min(1, b.tSinceStrike / 0.09);
      const fadeOut = Math.min(1, remain / 0.35);
      const vis = fadeIn * Math.max(0, fadeOut);
      b.core.material.opacity = 0.8 * vis;
      b.glow.material.opacity = 0.34 * vis;
      // 命中瞬间从粗收细的冲击感
      const punch = Math.max(0, 1 - b.tSinceStrike / 0.12);
      b.core.scale.setScalar(1 + punch * 0.9);
      b.glow.scale.setScalar(1 + punch * 1.4);
      // 轻微呼吸
      b.glow.rotation.y += dt * 1.2;

      // 伤害：每根光柱只结算一次
      if (!b.hitDone && playerPos) {
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
      this._ringGeo,
      new THREE.MeshBasicMaterial({
        color: this.accent.clone(), transparent: true, opacity: 0.8,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
      })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, 0.07, z);
    ring.renderOrder = 2;
    this.group.add(ring);

    const b = { phase: 'warn', x, z, t: 0, life: 1 + Math.random() * 2, hitDone: false, ring, core: null, glow: null };
    this._tint(b);
    this.beams.push(b);
    audio.pillarWarn(); // 预警音
  }

  _strike(b) {
    b.phase = 'strike';
    b.tSinceStrike = 0;
    if (b.ring) {
      this.group.remove(b.ring);
      b.ring.material.dispose();
      b.ring = null;
    }
    const core = new THREE.Mesh(
      this._coreGeo,
      new THREE.MeshBasicMaterial({
        transparent: true, opacity: 0.8, depthWrite: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide
      })
    );
    core.position.set(b.x, 15, b.z);
    core.renderOrder = 4;
    const glow = new THREE.Mesh(
      this._glowGeo,
      new THREE.MeshBasicMaterial({
        transparent: true, opacity: 0.34, depthWrite: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide
      })
    );
    glow.position.set(b.x, 15, b.z);
    glow.renderOrder = 4;
    this.group.add(core, glow);
    b.core = core;
    b.glow = glow;
    this._tint(b);
    audio.pillarStrike(); // 打击音
  }
}
