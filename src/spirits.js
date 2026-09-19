import * as THREE from 'three';
import { ELEMENT_INFO } from './themes.js';
import { audio } from './audio.js';
import { createBeamMaterial, BeamPass, beamConfig } from './vfx/BeamMaterial.js';
import { createBeamTubeGeometry } from './vfx/ProceduralGeometry.js';
import { createOrbMaterial } from './vfx/OrbMaterial.js';

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

/* 特殊之灵的显示强调色：冰属性加深为更饱和的钴蓝，
 * 与浅蓝的普通缚灵拉开区分；未列出的元素沿用领域主题色。 */
const SPECIAL_ACCENTS = { ice: '#2f7dff' };
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
  constructor(scene, bursts, vfx) {
    this.scene = scene;
    this.bursts = bursts;
    this.vfx = vfx;
    this.onCollect = null;

    // LV.5+ 激光共享的参数空间管几何（沙盒光束：一根管服务任意长度）
    this._laserTubeGeo = createBeamTubeGeometry(48, 18);
    this._laserOrbGeo = new THREE.IcosahedronGeometry(1, 3);

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

    // 缚灵：幽蓝魂火（共享材质；不受雾影响——浓雾里也要远远看见幽光）
    this._bodyMaterial = new THREE.MeshStandardMaterial({
      color: '#dceaff',
      emissive: '#8fc6ef',
      emissiveIntensity: 2.2,
      roughness: 0.35,
      fog: false
    });
    this._haloMaterial = new THREE.SpriteMaterial({
      map: haloTexture,
      color: '#9cc3e8',
      transparent: true,
      opacity: 0.6,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false
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
    /** LV.5+ 特殊之灵激光射击：由 game.js 每帧同步当前等级。 */
    this.laserTier = 1;

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
          flatShading: true,
          fog: false
        })
      );
      // 顶端元素晶体（单独材质，spawnSpecial 按元素染色）
      const crystal = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.26, 0),
        new THREE.MeshStandardMaterial({
          color: '#dfeeff',
          emissive: '#9fd8ff',
          emissiveIntensity: 2.6,
          roughness: 0.25,
          fog: false
        })
      );
      crystal.position.y = 0.52;
      // 环绕的符文铁环，环上倒悬三根尖刺
      const ring = new THREE.Mesh(
        specialRingGeometry,
        new THREE.MeshBasicMaterial({ color: '#9fd8ff', transparent: true, opacity: 0.85, fog: false })
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

      // LV.5+ 激光：沙盒参数化光束（HALO 大气 / SHELL 空心鞘 / CORE 白热芯）
      // 三层管叠画 + 云端式蓄能球，平时隐藏
      const laserConfig = beamConfig({
        radius: 0.16,
        radiusNear: 0.06,
        radiusCurve: 1.0,
        flare: 0,
        flareWidth: 0.05,
        coreWidth: 0.3,
        shellWidth: 1.0,
        haloWidth: 2.6,
        shellOpacity: 1.4,
        haloOpacity: 0.4,
        // 沙盒出厂值配 HDR 后期；本作无后期，亮度倍率相应提高
        opacity: 1.8,
        glow: 1.8,
        ripple: 0.3,
        streak: 1.0,
        flowSpeed: 9,
        tipGlow: 1.6,
        mouthGlow: 0.8,
        wander: 0.05
      });
      const laserMeshes = [];
      const laserMaterials = [];
      for (const pass of [BeamPass.HALO, BeamPass.SHELL, BeamPass.CORE]) {
        const material = createBeamMaterial(pass, laserConfig);
        const mesh = new THREE.Mesh(this._laserTubeGeo, material);
        mesh.frustumCulled = false;
        mesh.matrixAutoUpdate = false;
        mesh.renderOrder = 11 + (BeamPass.CORE - pass); // 芯最后画
        mesh.visible = false;
        this._group.add(mesh);
        laserMeshes.push(mesh);
        laserMaterials.push(material);
      }
      const laserOrb = new THREE.Mesh(
        this._laserOrbGeo,
        createOrbMaterial({ inner: '#d3f4ff', outer: '#9fd8ff', glow: 2.6 })
      );
      laserOrb.visible = false;
      laserOrb.renderOrder = 9;
      this._group.add(laserOrb);
      const slot = {
        group, core, crystal, ring, halo,
        alive: false,
        element: 'ice',
        pos: new THREE.Vector3(),
        baseY: 1.4,
        phase: Math.random() * Math.PI * 2,
        flash: 0,
        basicHits: 0, // 同色领域内被普通攻击命中的次数（3 次清除）
        wander: new THREE.Vector3(),
        laserMeshes,
        laserMaterials,
        laserConfig,
        laserOrb,
        laserState: {
          origin: new THREE.Vector3(),
          target: new THREE.Vector3(),
          side: new THREE.Vector3(1, 0, 0),
          progress: 0,
          fade: 1,
          widthFade: 1,
          seed: 0,
          coils: 0,
          rings: 0
        },
        laser: {
          state: 'idle', // idle → tele（1.0s 蓄能预警）→ fire（0.22s）→ idle
          t: 0,
          cd: 1.5 + Math.random() * 1.5,
          from: new THREE.Vector3(),
          dir: new THREE.Vector3(),
          len: 0,
          hitDone: false
        }
      };
      this.specials.push(slot);
    }
  }

  /* —— LV.5+ 特殊之灵激光射击 —— */

  /** 激光冷却：LV5 约 2.2 秒，每级缩短 0.35s，LV10 起贴近普攻速率（0.45s），±20% 浮动。 */
  _laserCd() {
    return Math.max(0.45, 2.2 - (this.laserTier - 5) * 0.35) * (0.8 + Math.random() * 0.4);
  }

  /** 收起一条激光的三层光束与蓄能球。 */
  _hideLaser(slot) {
    for (const mesh of slot.laserMeshes) mesh.visible = false;
    slot.laserOrb.visible = false;
  }

  /** 按之灵元素给激光与蓄能球换色。 */
  _tintLaser(slot) {
    const accent = SPECIAL_ACCENTS[slot.element] ?? ELEMENT_INFO[slot.element].accent;
    const c = slot.laserConfig;
    const col = new THREE.Color(accent);
    c.colorCore = '#ffffff';
    c.colorInner = '#' + col.clone().lerp(new THREE.Color('#ffffff'), 0.55).getHexString();
    c.colorOuter = accent;
    c.colorHalo = '#' + col.clone().multiplyScalar(0.28).getHexString();
    slot.laserOrb.material.userData.setPalette({ inner: c.colorInner, outer: accent });
  }

  /** 把当前状态推进三层光束材质：从 from 沿 dir 画 len 长的束。 */
  _syncLaser(slot, from, dir, len, progress, fade, widthFade) {
    const s = slot.laserState;
    s.origin.copy(from);
    s.target.copy(from).addScaledVector(dir, len);
    s.progress = progress;
    s.fade = fade;
    s.widthFade = widthFade;
    for (const material of slot.laserMaterials) material.userData.sync(s);
  }

  _updateLaser(slot, dt, playerPos) {
    const L = slot.laser;
    L.t += dt;

    if (this.laserTier < 5 || this._frozen || !playerPos) {
      if (L.state !== 'idle') {
        L.state = 'idle';
        L.cd = this._laserCd();
        this._hideLaser(slot);
      }
      return;
    }

    switch (L.state) {
      case 'idle': {
        this._hideLaser(slot);
        L.cd -= dt;
        if (L.cd <= 0) {
          // 锁定玩家当前位置：激光从特殊之灵体内单方向射向该点，到点为止
          L.from.set(slot.pos.x, slot.baseY, slot.pos.z);
          L.dir.set(playerPos.x - L.from.x, 1.15 - slot.baseY, playerPos.z - L.from.z);
          L.len = L.dir.length();
          L.dir.divideScalar(L.len); // 单位方向
          if (L.len > 2.2) {
            L.state = 'tele';
            L.t = 0;
            L.hitDone = false;
            this._tintLaser(slot);
            audio.laserCharge(); // 蓄能预警音
          } else {
            L.cd = 0.5; // 离玩家太近不射，稍后再试
          }
        }
        break;
      }
      case 'tele': {
        // 起点始终跟随特殊之灵当前位置：光束从之灵体内射向地图外，不穿过反侧
        L.from.set(slot.pos.x, slot.baseY, slot.pos.z);
        // 蓄能段：只画出炮口附近一小截，闪烁提示弹道；蓄能球随之长大
        const charge = Math.min(1, Math.max(0, L.t / 1.0));
        this._syncLaser(slot, L.from, L.dir, L.len + 170, 0.055, 0.35 + 0.45 * Math.abs(Math.sin(L.t * 12)), 1);
        for (const mesh of slot.laserMeshes) mesh.visible = true;
        slot.laserOrb.visible = true;
        slot.laserOrb.position.copy(L.from);
        slot.laserOrb.scale.setScalar(0.26 + charge * 0.34);
        slot.laserOrb.material.uniforms.uCharge.value = charge;
        if (L.t >= 1.0) {
          L.state = 'fire';
          L.t = 0;
          slot.laserOrb.visible = false;
          // 发射源迸光：强调激光从特殊之灵体内射出
          this.vfx?.sparkBurst(L.from, slot.element, {
            count: 18, speed: 5, life: 0.5, size: 0.9, up: 0.6, radius: 0.3
          });
          audio.laserFire(); // 射击音
        }
        break;
      }
      case 'fire': {
        const dur = 0.22;
        // 起点跟随特殊之灵；光束全弹道点亮，末段宽度和亮度一起收
        L.from.set(slot.pos.x, slot.baseY, slot.pos.z);
        const k = L.t / dur;
        this._syncLaser(slot, L.from, L.dir, L.len + 170, 1, 1 - k, 1 - 0.45 * k);
        // 蓄能球释放瞬间炸掉
        slot.laserOrb.visible = k < 0.4;
        slot.laserOrb.material.uniforms.uCharge.value = Math.max(0, 1 - k * 2.5);
        // 命中判定：玩家到射线（单方向、延伸出地图外）的垂直距离 <1.1m（每发只结算一次）
        if (!L.hitDone) {
          const d = Math.hypot(L.dir.x, L.dir.z) || 1;
          const ux = L.dir.x / d, uz = L.dir.z / d; // 单位方向
          const dxp = playerPos.x - L.from.x;
          const dzp = playerPos.z - L.from.z;
          const a = Math.max(0, Math.min(L.len + 170, dxp * ux + dzp * uz));
          const px = L.from.x + ux * a;
          const pz = L.from.z + uz * a;
          if (Math.hypot(playerPos.x - px, playerPos.z - pz) < 1.1) {
            L.hitDone = true;
            this.onPlayerHit?.(10); // 激光命中：-10% 生命
          }
        }
        if (L.t >= dur) {
          this._hideLaser(slot);
          L.state = 'idle';
          L.cd = this._laserCd();
        }
        break;
      }
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
    if (frozen) {
      // 冻结时收起所有激光
      for (const slot of this.specials) {
        this._hideLaser(slot);
        if (slot.laser.state !== 'idle') {
          slot.laser.state = 'idle';
          slot.laser.cd = this._laserCd();
        }
      }
    }
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
      this._hideLaser(slot);
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
      this._hideLaser(slot);
    }
    this._specialTimer = randomSpecialInterval();
  }

  /**
   * 生成一个特殊元素之灵：随机元素，出现在玩家周围 10~22 米。
   * 颜色即提示——必须用相同元素的技能才能清除。
   * 冰属性加深为更纯正的蓝，避免与浅蓝的普通缚灵混淆。
   */
  spawnSpecial(playerPos) {
    const slot = this.specials.find((s) => !s.alive);
    if (!slot) return;

    const elements = ['ice', 'fire', 'storm'];
    const element = elements[Math.floor(Math.random() * elements.length)];
    const accent = SPECIAL_ACCENTS[element] ?? ELEMENT_INFO[element].accent;
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
    // 激光状态复位
    slot.laser.state = 'idle';
    slot.laser.t = 0;
    slot.laser.cd = 1.2 + Math.random() * 1.2;
    slot.laser.hitDone = false;
    this._hideLaser(slot);

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
   * @returns {{normal: number, special: number, specialHit: number, immune: number}}
   *   specialHit：普攻命中特殊之灵但未击败的次数（同色领域吸收伤害）
   */
  collectAt(point, radius, element = 'basic', worldFamily = 'neutral', hitSet) {
    let normal = 0;
    let special = 0;
    let specialHit = 0;
    let immune = 0;

    for (const spirit of this.spirits) {
      if (!spirit.alive) continue;
      const dx = spirit.pos.x - point.x;
      const dz = spirit.pos.z - point.z;
      if (dx * dx + dz * dz <= radius * radius) {
        spirit.alive = false;
        spirit.respawn = 2.4 + Math.random() * 1.4;
        spirit.group.visible = false;
        // 击杀特效：沙盒爆裂球（薄压力壳）+ 冲击波环 + 拉伸火花
        this.vfx?.killBurst(spirit.pos, 'basic', 1);
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
          // 对应元素技能：直接清除（元素爆裂球 + 冲击波 + 火花，更大更亮）
          slot.alive = false;
          slot.group.visible = false;
          this._hideLaser(slot);
          this.vfx?.killBurst(slot.pos, slot.element, 1.7);
          special++;
        } else if (element === 'basic' && worldFamily === slot.element) {
          // 同色领域内的普通攻击：累积伤害，3 次清除
          slot.basicHits++;
          if (slot.basicHits >= 3) {
            slot.alive = false;
            slot.group.visible = false;
            this._hideLaser(slot);
            this.vfx?.killBurst(slot.pos, slot.element, 1.7);
            special++;
          } else {
            // 受击反馈：短促闪光 + 小簇火花（普攻打击特殊之灵成功吸收）
            slot.flash = SPECIAL_FLASH_TIME;
            specialHit++;
            this.vfx?.sparkBurst(slot.pos, 'basic', {
              count: 12, speed: 3.5, life: 0.45, size: 0.6, up: 0.6, radius: 0.3
            });
          }
        } else {
          // 属性不符 / 领域不对：免疫闪光
          slot.flash = SPECIAL_FLASH_TIME;
          immune++;
        }
      }
    }

    return { normal, special, specialHit, immune };
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
      if (!slot.alive) {
        // 死亡的特殊之灵：确保激光收起
        if (slot.laserMeshes.some((m) => m.visible) || slot.laserOrb.visible) {
          this._hideLaser(slot);
          if (slot.laser.state !== 'idle') {
            slot.laser.state = 'idle';
            slot.laser.cd = this._laserCd();
          }
        }
        continue;
      }
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
        this._hideLaser(slot);
        this.vfx?.killBurst(slot.pos, slot.element, 1.7);
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

      // —— LV.5+ 激光射击 ——
      this._updateLaser(slot, dt, playerPos);
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
            this.vfx?.killBurst(spirit.pos, 'basic', 1);
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
    for (const slot of this.specials) {
      for (const material of slot.laserMaterials) material.dispose();
      slot.laserOrb?.material.dispose();
    }
    this._bodyMaterial.dispose();
    this._haloMaterial.dispose();
    this._bandMaterial.dispose();
  }
}
