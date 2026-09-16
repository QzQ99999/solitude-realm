import * as THREE from 'three';
import { ELEMENT_INFO } from './themes.js';

const SPIRIT_COUNT = 12; // 之灵池容量：随分数增长最多同时 12 颗在场
const AREA = 40;

/* 追逐参数：生成后永远追逐玩家，速度比步行(6.2)快、比飞行(17)慢。 */
const CHASE_SPEED = 7.2;
const TOUCH_RADIUS = 1.5;
const TOUCH_DAMAGE_NORMAL = 25; // 普通之灵撞到玩家扣的血

/* 特殊元素之灵 */
const SPECIAL_INTERVAL_MIN = 1; // 每次出现的间隔下限，秒
const SPECIAL_INTERVAL_MAX = 10; // 每次出现的间隔上限，秒
const SPECIAL_MAX_ALIVE = 2; // 场上最多同时存在两个
const SPECIAL_FLASH_TIME = 0.35; // 属性不符时的免疫闪光时长
const SPECIAL_SPEED = 4.0; // 移动速度慢于普通之灵的追逐速度(7.2)
const SPECIAL_TOUCH_RADIUS = 1.8; // 撞到玩家的距离
const TOUCH_DAMAGE_SPECIAL = 50; // 特殊之灵撞到玩家扣的血
const SPAWN_MIN_RANGE = 20; // 生成时距离角色的最小距离（米）

/** 随机生成下一次特殊之灵的出现间隔（1~30 秒）。 */
function randomSpecialInterval() {
  return SPECIAL_INTERVAL_MIN + Math.random() * (SPECIAL_INTERVAL_MAX - SPECIAL_INTERVAL_MIN);
}

/**
 * spirits.js — 元素之灵：漂浮在竞技场上的幽魂，是法术的"靶子"。
 *
 * 普通之灵是「缚灵」—— 从斗技场裂隙里逸出的怨念魂火，被一圈锈蚀的
 * 铁枷锁束缚着；特殊之灵是「堕圣遗物」—— 悬浮的黑铁圣物匣，匣身裂隙
 * 里透出元素色的邪光，外圈环绕着符文铁环与倒悬的尖刺。命中判定、追逐、
 * 重生逻辑不变；被法术命中时炸成一蓬粒子、加分，然后在别处重生。
 */
export class SpiritField {
  constructor(scene, bursts) {
    this.scene = scene;
    this.bursts = bursts;
    this.onCollect = null;

    // 光晕贴图（canvas 径向渐变）
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.35, 'rgba(255,255,255,0.45)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 64, 64);
    const haloTexture = new THREE.CanvasTexture(canvas);

    this._group = new THREE.Group();
    scene.add(this._group);

    // 缚灵：幽蓝魂火（共享材质）
    this._bodyMaterial = new THREE.MeshStandardMaterial({
      color: '#dceaff',
      emissive: '#8fc6ef',
      emissiveIntensity: 2.2,
      roughness: 0.35
    });
    this._haloMaterial = new THREE.SpriteMaterial({
      map: haloTexture,
      color: '#9cc3e8',
      transparent: true,
      opacity: 0.6,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    // 锈蚀铁枷锁（共享材质）
    this._bandMaterial = new THREE.MeshStandardMaterial({
      color: '#232833',
      roughness: 0.55,
      metalness: 0.75
    });

    this.spirits = [];
    for (let i = 0; i < SPIRIT_COUNT; i++) {
      const group = new THREE.Group();
      // 魂火：拉长的八面体，像一簇竖直飘摇的火苗
      const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.3, 0), this._bodyMaterial);
      core.scale.set(0.82, 1.7, 0.82);
      // 束缚魂火的铁枷锁环，随机倾角
      const band = new THREE.Mesh(new THREE.TorusGeometry(0.4, 0.04, 6, 22), this._bandMaterial);
      band.rotation.set(Math.random() * 1.2 + 0.5, 0, Math.random() * Math.PI);
      const halo = new THREE.Sprite(this._haloMaterial);
      halo.scale.setScalar(2.2);
      group.add(core, band, halo);
      this._group.add(group);

      this.spirits.push({
        group,
        core,
        band,
        halo,
        alive: false,
        respawn: 0,
        pos: new THREE.Vector3(),
        wander: new THREE.Vector3(),
        phase: Math.random() * Math.PI * 2,
        baseY: 1.1 + Math.random() * 0.8,
        chasing: false
      });
      this._place(this.spirits[i]);
    }
    // 游戏开始前隐藏，begin() 后才生成
    for (const spirit of this.spirits) spirit.group.visible = false;

    this._accent = new THREE.Color('#9fd8ff');
    /** 之灵撞到玩家时的回调，参数为本次扣血量。 */
    this.onPlayerHit = null;
    this._frozen = false;
    this._normalTarget = 3;
    this._specialTarget = 1;

    /* ---- 特殊元素之灵「堕圣遗物」：黑铁圣物匣 + 元素邪光晶体 + 符文铁环 ---- */
    this.specials = [];
    this._specialTimer = randomSpecialInterval();
    this.onSpecialSpawn = null;

    /* 开始游戏流程：点击开始后元素之灵立即生成 */
    this.active = false;
    this._pendingStart = false;
    this._startCountdown = 0;
    this._spawnNormalCount = 5;

    const specialRingGeometry = new THREE.TorusGeometry(0.82, 0.055, 8, 42);
    const spikeGeometry = new THREE.ConeGeometry(0.1, 0.34, 5);
    for (let i = 0; i < 6; i++) { // 特殊之灵池容量：随分数增长最多同时 6 颗在场
      const group = new THREE.Group();
      // 黑铁匣身：裂隙里透出元素色的邪光
      const core = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.46, 1),
        new THREE.MeshStandardMaterial({
          color: '#151922',
          emissive: '#9fd8ff',
          emissiveIntensity: 1.6,
          roughness: 0.45,
          metalness: 0.7,
          flatShading: true
        })
      );
      // 顶端元素晶体（单独材质，spawnSpecial 按元素染色）
      const crystal = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.26, 0),
        new THREE.MeshStandardMaterial({
          color: '#dfeeff',
          emissive: '#9fd8ff',
          emissiveIntensity: 2.6,
          roughness: 0.25
        })
      );
      crystal.position.y = 0.52;
      // 环绕的符文铁环，环上倒悬三根尖刺
      const ring = new THREE.Mesh(
        specialRingGeometry,
        new THREE.MeshBasicMaterial({ color: '#9fd8ff', transparent: true, opacity: 0.85 })
      );
      ring.rotation.x = 1.35;
      for (let s = 0; s < 3; s++) {
        const spike = new THREE.Mesh(spikeGeometry, this._bandMaterial);
        const angle = (s / 3) * Math.PI * 2;
        spike.position.set(Math.cos(angle) * 0.82, 0, Math.sin(angle) * 0.82);
        spike.rotation.z = Math.PI; // 尖朝下，倒悬
        spike.rotation.y = -angle;
        ring.add(spike);
      }
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: haloTexture,
        color: '#9fd8ff',
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      }));
      halo.scale.setScalar(3.4);
      group.add(core, crystal, ring, halo);
      group.visible = false;
      this._group.add(group);

      this.specials.push({
        group, core, crystal, ring, halo,
        alive: false,
        element: 'ice',
        pos: new THREE.Vector3(),
        baseY: 1.4,
        phase: Math.random() * Math.PI * 2,
        flash: 0,
        basicHits: 0, // 同色领域内被普通攻击命中的次数（3 次清除）
        wander: new THREE.Vector3()
      });
    }
  }

  /** 世界主题变了：之灵染上当前领域的强调色。 */
  setAccent(hex) {
    this._accent.set(hex);
  }

  /** 场上普通之灵目标数量（随分数增长）。 */
  setNormalTarget(count) {
    this._normalTarget = Math.min(count, this.spirits.length);
  }

  /** 场上特殊之灵目标数量（随分数增长）。 */
  setSpecialTarget(count) {
    this._specialTarget = Math.min(count, this.specials.length);
  }

  /** 场上特殊之灵目标数量（随分数增长）。 */
  setSpecialTarget(count) {
    this._specialTarget = Math.min(count, this.specials.length);
  }

  /** 场上普通之灵目标数量（随分数增长）。 */
  setNormalTarget(count) {
    this._activeNormals = Math.min(count, this.spirits.length);
  }

  /** 游戏开始：立即生成所有普通之灵（距角色至少 20 米），围绕 playerPos 分布。 */
  begin(playerPos, normalCount = 3) {
    this.active = true;
    this._normalTarget = normalCount;
    this._spawnAll(playerPos, normalCount);
  }

  /** 批量生成普通之灵。 */
  _spawnAll(playerPos, count) {
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + Math.random() * 0.8;
      const radius = 20 + Math.random() * 20;
      const spirit = this.spirits[i];
      if (!spirit) continue;
      spirit.alive = true;
      spirit.chasing = false;
      spirit.pos.set(
        (playerPos ? playerPos.x : 0) + Math.cos(angle) * radius,
        spirit.baseY,
        (playerPos ? playerPos.z : 0) + Math.sin(angle) * radius
      );
      spirit.group.visible = true;
    }
  }

  /** 游戏结束：冻结所有之灵。 */
  setFrozen(frozen) {
    this._frozen = frozen;
  }

  /** 设置场上普通之灵/特殊之灵的目标数量（随分数增长）。 */
  setTargets(normalCount, specialCount) {
    this._normalTarget = normalCount;
    this._specialTarget = specialCount;
  }

  /** 重新开始：清空特殊之灵，全部普通之灵在角色周围 20~40 米重生。 */
  respawnAll(playerPos, normalCount = 3) {
    this._normalTarget = normalCount;
    for (let i = 0; i < this.spirits.length; i++) {
      const spirit = this.spirits[i];
      if (i < normalCount) {
        spirit.alive = true;
        spirit.chasing = false;
        this._place(spirit, playerPos);
        spirit.group.visible = true;
      } else {
        spirit.alive = false;
        spirit.group.visible = false;
      }
    }
    for (const slot of this.specials) {
      slot.alive = false;
      slot.group.visible = false;
    }
    this._specialTimer = randomSpecialInterval();
  }

  /** 返回初始界面：隐藏所有之灵，等待下一次 begin()。 */
  reset() {
    this.active = false;
    this._pendingStart = false;
    for (const spirit of this.spirits) {
      spirit.alive = false;
      spirit.chasing = false;
      spirit.group.visible = false;
    }
    for (const slot of this.specials) {
      slot.alive = false;
      slot.group.visible = false;
    }
    this._specialTimer = randomSpecialInterval();
  }

  /**
   * 生成一个特殊元素之灵：随机元素，出现在玩家周围 10~22 米。
   * 颜色即提示——必须用相同元素的技能才能清除。
   */
  spawnSpecial(playerPos) {
    const slot = this.specials.find((s) => !s.alive);
    if (!slot) return;

    const elements = ['ice', 'fire', 'storm'];
    const element = elements[Math.floor(Math.random() * elements.length)];
    const accent = ELEMENT_INFO[element].accent;
    slot.element = element;
    slot.alive = true;
    slot.flash = 0;
    slot.basicHits = 0;

    const angle = Math.random() * Math.PI * 2;
    const dist = SPAWN_MIN_RANGE + Math.random() * 15; // 距角色至少 20 米
    const originX = playerPos ? playerPos.x : 0;
    const originZ = playerPos ? playerPos.z : 0;
    slot.pos.set(originX + Math.cos(angle) * dist, slot.baseY, originZ + Math.sin(angle) * dist);
    slot.wander.set(0, 0, 0);

    slot.core.material.emissive.set(accent);
    slot.crystal.material.emissive.set(accent);
    slot.ring.material.color.set(accent);
    slot.halo.material.color.set(accent);
    slot.group.visible = true;
    slot.group.position.set(slot.pos.x, slot.baseY, slot.pos.z);

    this.onSpecialSpawn?.(element, accent);
  }

  _place(spirit, playerPos, minRange = 20, maxRange = 40) {
    const angle = Math.random() * Math.PI * 2;
    const radius = minRange + Math.random() * (maxRange - minRange);
    const originX = playerPos ? playerPos.x : 0;
    const originZ = playerPos ? playerPos.z : 0;
    spirit.pos.set(originX + Math.cos(angle) * radius, spirit.baseY, originZ + Math.sin(angle) * radius);
    spirit.group.position.copy(spirit.pos);
    spirit.group.visible = spirit.alive;
  }

  /**
   * 命中判定。
   * @param {THREE.Vector3} point  命中点
   * @param {number} radius        命中半径
   * @param {string} element       造成命中的元素：'ice'|'fire'|'storm'|'basic'
   *   - 普通之灵：任何来源都能收集；
   *   - 特殊之灵：对应元素技能直接清除；
   *     普通攻击在**同色领域**（worldFamily 与之灵元素相同）命中 3 次也可清除。
   * @param {string} worldFamily   当前世界领域 id（'neutral'|'ice'|'fire'|'storm'）
   * @param {Set} [hitSet]         本次攻击已结算过的特殊之灵（普攻飞行多帧时防止重复计伤）
   * @returns {{normal: number, special: number, immune: number}}
   */
  collectAt(point, radius, element = 'basic', worldFamily = 'neutral', hitSet) {
    let normal = 0;
    let special = 0;
    let immune = 0;

    for (const spirit of this.spirits) {
      if (!spirit.alive) continue;
      const dx = spirit.pos.x - point.x;
      const dz = spirit.pos.z - point.z;
      if (dx * dx + dz * dz <= radius * radius) {
        spirit.alive = false;
        spirit.respawn = 2.4 + Math.random() * 1.4;
        spirit.group.visible = false;
        this.bursts.emit({
          pos: spirit.pos, count: 46, speed: [2, 8], up: [2, 9], life: [0.4, 1.0],
          size: [8, 20], colorA: '#ffffff', colorB: '#' + this._accent.getHexString(),
          gravity: -6, drag: 1.4
        });
        normal++;
      }
    }

    for (const slot of this.specials) {
      if (!slot.alive) continue;
      const dx = slot.pos.x - point.x;
      const dz = slot.pos.z - point.z;
      if (dx * dx + dz * dz <= radius * radius) {
        if (element === 'basic') {
          // 同一次普攻（飞行多帧 + 落点）对同一特殊之灵只结算一次
          if (hitSet?.has(slot)) continue;
          hitSet?.add(slot);
        }
        if (element !== 'basic' && slot.element === element) {
          // 对应元素技能：直接清除
          slot.alive = false;
          slot.group.visible = false;
          this.bursts.emit({
            pos: slot.pos, count: 90, speed: [3, 11], up: [3, 12], life: [0.5, 1.2],
            size: [10, 24], colorA: '#ffffff', colorB: '#' + this._accent.getHexString(),
            gravity: -6, drag: 1.3
          });
          special++;
        } else if (element === 'basic' && worldFamily === slot.element) {
          // 同色领域内的普通攻击：累积伤害，3 次清除
          slot.basicHits++;
          if (slot.basicHits >= 3) {
            slot.alive = false;
            slot.group.visible = false;
            this.bursts.emit({
              pos: slot.pos, count: 90, speed: [3, 11], up: [3, 12], life: [0.5, 1.2],
              size: [10, 24], colorA: '#ffffff', colorB: '#' + this._accent.getHexString(),
              gravity: -6, drag: 1.3
            });
            special++;
          } else {
            // 受击反馈：短促闪光
            slot.flash = SPECIAL_FLASH_TIME;
          }
        } else {
          // 属性不符 / 领域不对：免疫闪光
          slot.flash = SPECIAL_FLASH_TIME;
          immune++;
        }
      }
    }

    return { normal, special, immune };
  }

  update(dt, elapsed, playerPos) {
    // 游戏结束：冻结所有之灵
    if (this._frozen) return;

    // 点击"开始游戏"前：不生成、不追逐，之灵全部隐藏
    if (!this.active) return;

    /* ---- 特殊元素之灵：随机间隔出现、追击玩家、免疫闪光 ---- */
    this._specialTimer -= dt;
    if (this._specialTimer <= 0) {
      this._specialTimer = randomSpecialInterval();
      const aliveCount = this.specials.filter((s) => s.alive).length;
      if (aliveCount < this._specialTarget) this.spawnSpecial(playerPos);
    }

    for (const slot of this.specials) {
      if (!slot.alive) continue;

      slot.flash = Math.max(0, slot.flash - dt);
      slot.phase += dt;

      // 特殊之灵：不受距离影响，生成后一直追向玩家
      // （速度 4.2 慢于普通追逐 7.6），追到身边接触玩家。
      let moving = false;
      let hitPlayer = false;
      if (playerPos) {
        const dx = playerPos.x - slot.pos.x;
        const dz = playerPos.z - slot.pos.z;
        const dist = Math.hypot(dx, dz);
        if (dist > 0.001) {
          slot.pos.x += (dx / dist) * SPECIAL_SPEED * dt;
          slot.pos.z += (dz / dist) * SPECIAL_SPEED * dt;
          moving = true;
          if (dist < SPECIAL_TOUCH_RADIUS) hitPlayer = true;
        }
      }
      if (hitPlayer) {
        slot.alive = false;
        slot.group.visible = false;
        this.bursts.emit({
          pos: slot.pos, count: 90, speed: [3, 11], up: [3, 12], life: [0.5, 1.2],
          size: [10, 24], colorA: '#ffffff', colorB: '#' + this._accent.getHexString(),
          gravity: -6, drag: 1.3
        });
        this.onPlayerHit?.(TOUCH_DAMAGE_SPECIAL);
        continue;
      }
      if (!moving) {
        // 缓慢漂移
        if (slot.wander.lengthSq() < 0.001 || Math.random() < dt * 0.4) {
          const angle = Math.random() * Math.PI * 2;
          slot.wander.set(Math.cos(angle), 0, Math.sin(angle)).multiplyScalar(0.35);
        }
        slot.pos.addScaledVector(slot.wander, dt);
        const r = Math.hypot(slot.pos.x, slot.pos.z);
        if (r > AREA + 8) slot.wander.multiplyScalar(-1);
      }

      slot.group.position.set(
        slot.pos.x,
        slot.baseY + Math.sin(elapsed * 1.6 + slot.pos.x) * 0.26,
        slot.pos.z
      );
      slot.ring.rotation.z += dt * 1.3;
      slot.ring.rotation.x += dt * 0.45;
      const flashK = slot.flash / SPECIAL_FLASH_TIME;
      slot.core.rotation.y += dt * (1.2 + flashK * 6);
      slot.core.material.emissiveIntensity = 1.6 + flashK * 8;
      // 顶端晶体自转 + 呼吸，受击时骤亮
      slot.crystal.rotation.y -= dt * (1.8 + flashK * 6);
      slot.crystal.material.emissiveIntensity = 2.6 + flashK * 9
        + Math.sin(elapsed * 3.1 + slot.phase) * 0.5;
      slot.halo.scale.setScalar(3.2 + flashK * 1.4 + Math.sin(elapsed * 2.6 + slot.pos.z) * 0.2);
    }

    for (let i = 0; i < this.spirits.length; i++) {
      const spirit = this.spirits[i];
      const inPlay = i < this._normalTarget;
      if (!spirit.alive) {
        spirit.respawn -= dt;
        if (spirit.respawn <= 0 && inPlay) {
          spirit.alive = true;
          spirit.chasing = false;
          this._place(spirit, playerPos);
          spirit.group.visible = true;
        }
        continue;
      }

      // 追逐：生成后不受距离限制，一直追向玩家（速度 7.6 快于步行 6.2）
      if (playerPos) {
        const dx = playerPos.x - spirit.pos.x;
        const dz = playerPos.z - spirit.pos.z;
        const dist = Math.hypot(dx, dz);

        if (dist > 0.001) {
          spirit.pos.x += (dx / dist) * CHASE_SPEED * dt;
          spirit.pos.z += (dz / dist) * CHASE_SPEED * dt;
          // 撞到玩家：玩家扣血，之灵消散
          if (dist < TOUCH_RADIUS) {
            spirit.alive = false;
            spirit.respawn = 2.4 + Math.random() * 1.4;
            spirit.group.visible = false;
            this.bursts.emit({
              pos: spirit.pos, count: 46, speed: [2, 8], up: [2, 9], life: [0.4, 1.0],
              size: [8, 20], colorA: '#ffffff', colorB: '#' + this._accent.getHexString(),
              gravity: -6, drag: 1.4
            });
            this.onPlayerHit?.(TOUCH_DAMAGE_NORMAL);
            continue;
          }
        }
      }

      if (!spirit.chasing) {
        // 慢速游荡：每隔一阵换一个漂移方向
        spirit.phase += dt;
        if (spirit.phase > 3.5 || spirit.wander.lengthSq() < 0.001) {
          spirit.phase = 0;
          const angle = Math.random() * Math.PI * 2;
          spirit.wander.set(Math.cos(angle), 0, Math.sin(angle)).multiplyScalar(0.55);
        }
        spirit.pos.addScaledVector(spirit.wander, dt);
        const r = Math.hypot(spirit.pos.x, spirit.pos.z);
        if (r > AREA) spirit.wander.multiplyScalar(-1);
      }

      spirit.group.position.set(
        spirit.pos.x,
        spirit.baseY + Math.sin(elapsed * (spirit.chasing ? 3.4 : 1.7) + spirit.pos.x) * 0.22,
        spirit.pos.z
      );
      spirit.core.rotation.y += dt * (spirit.chasing ? 2.6 : 1.4);
      spirit.core.rotation.x += dt * 0.6;
      // 铁枷锁缓慢反旋，追逐时转速加快、环面翻平（像张开的枷锁）
      spirit.band.rotation.y -= dt * (spirit.chasing ? 2.2 : 0.8);
      spirit.band.rotation.x = 0.9 + Math.sin(elapsed * 1.3 + spirit.phase) * 0.35;
      spirit.halo.scale.setScalar(
        (2.0 + Math.sin(elapsed * 3.1 + spirit.pos.z) * 0.25) * (spirit.chasing ? 1.3 : 1)
      );
      // 普通之灵保持固定蓝白色，不随世界变色——彩色的才是特殊之灵
    }

    if (this._touched > 0) this.onTouch?.(this._touched);
  }

  dispose() {
    this.scene.remove(this._group);
    this._group.traverse((object) => {
      if (object.geometry) object.geometry.dispose();
    });
    this._bodyMaterial.dispose();
    this._haloMaterial.dispose();
    this._bandMaterial.dispose();
  }
}
