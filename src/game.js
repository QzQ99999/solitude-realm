import * as THREE from 'three';
import { World } from './world.js';
import { Player } from './player.js';
import { SpellManager } from './spells.js';
import { SpiritField } from './spirits.js';
import { HUD } from './hud.js';
import { EdgeBoundary } from './edge.js';
import { GroundFX } from './groundfx.js';
import { FlightTrail } from './trail.js';
import { ELEMENTS, ELEMENT_INFO, FAMILY_OF, THEMES } from './themes.js';

const COOLDOWNS = { ice: 5, fire: 5, storm: 5 }; // 技能统一 5 秒冷却
const STAMINA_DRAIN_TIME = 6; // 满体力持续飞行的秒数
const STAMINA_REGEN_TIME = 9; // 清零后回满的秒数
const STAMINA_REFLY = 25; // 耗尽后需恢复到该百分比才能再次飞行
const MIN_RANGE = 3;
const MAX_RANGE = 26;

/**
 * game.js — 游戏根节点。
 *
 * 一条单向数据流：输入 → 角色移动/瞄准 → 施放法术 → 法术落地回调 →
 * 世界改写 + 之灵判定 + 镜头震动 → HUD 反馈。每帧只做一次更新排序。
 */
export class Game {
  constructor(canvas) {
    this.canvas = canvas;

    /* ---- 渲染 ---- */
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    // 动态分辨率：像素比上限 1.5（高分屏下 2.0 的填充率开销太大），
    // 帧率不足时 frame() 里的控制器会再逐级下调，稳住 90+ FPS
    this._pxRatioCap = Math.min(window.devicePixelRatio, 1.5);
    this._pxRatio = this._pxRatioCap;
    this.renderer.setPixelRatio(this._pxRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.5;

    /* ---- 世界与玩法系统 ---- */
    this.world = new World();
    this.scene = this.world.scene;
    this.camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 0.1, 1400);

    this.player = new Player(this.scene);
    this.spells = new SpellManager(this.scene);
    this.spirits = new SpiritField(this.scene, this.spells.bursts);
    this.edge = new EdgeBoundary(this.scene); // 场地边缘感知层
    this.groundFx = new GroundFX(this.scene); // 施法全场地特效（染色浪潮/地裂）
    this.flightTrail = new FlightTrail(this.scene); // Shift 飞行拖尾光带
    this.hud = new HUD();
    // 之灵数量随分数增长的目标值（初始温和，逐步提升）
    this._normalTarget = 3;
    this._specialTarget = 1;

    /* ---- 状态 ---- */
    this.element = 'ice';
    this.cooldowns = new Map(ELEMENTS.map((element) => [element, 0]));
    this.score = 0;
    this.hp = 100;
    this.over = false;
    this.elapsed = 0;
    this._shake = 0;
    this.keys = new Set();
    this.started = false;
    this._invulnT = 0; // 受击无敌帧剩余时间
    this._killStreak = 0; // 连杀计数：满 9 回复 20% 生命，被撞清零
    this.stamina = 100; // 体力：飞行消耗（9 秒清零），松开恢复（12 秒回满）
    this._exhausted = false; // 体力耗尽：需恢复到 25% 才能再飞行
    this.paused = false; // Esc 暂停
    this._worldRevertT = 0; // 世界还原倒计时：施法改写世界后 6 秒无施法则恢复荒原
    // ?test=streakbreak 自动化验证：注入连杀→受击→检查是否清零
    this._testMode = new URLSearchParams(location.search).get('test');
    this._testT = 0;
    this._instanceId = Math.random().toString(36).slice(2, 6);
    window.__game = this; // 调试/自动化验证句柄

    const startBtn = document.getElementById('startBtn');
    startBtn?.addEventListener('click', () => this.begin());
    // 竞技场加载完成前禁用开始按钮（GLB 异步装载）
    if (startBtn) {
      startBtn.disabled = true;
      startBtn.textContent = '场景装载中…';
    }
    this.world.onArenaReady = (ok) => {
      if (!startBtn) return;
      startBtn.disabled = false;
      startBtn.textContent = ok ? '开始游戏' : '场景加载失败 · 仍可开始';
    };
    document.getElementById('restartBtn')?.addEventListener('click', () => this.restart());
    document.getElementById('backToStartBtn')?.addEventListener('click', () => this.backToStart());
    document.getElementById('pauseBtn')?.addEventListener('click', () => {
      if (this.started && !this.over) this._setPaused(!this.paused);
    });
    // 点击暂停界面任意处继续
    document.getElementById('pauseScreen')?.addEventListener('click', () => {
      if (this.paused) this._setPaused(false);
    });

    /* ---- 相机轨道 ---- */
    this.orbit = { yaw: Math.PI * 0.25, pitch: 0.62, dist: 24 };

    /* ---- 指针与瞄准 ---- */
    this.pointer = new THREE.Vector2(0, 0);
    this._aimNDC = new THREE.Vector2(0, -0.1); // 指针锁定模式下的"虚拟落点光标"
    this._locked = false;
    this.raycaster = new THREE.Raycaster();
    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.aimPoint = new THREE.Vector3(0, 0, -7);
    this._scratchF = new THREE.Vector3();
    this._scratchR = new THREE.Vector3();
    this._aimHit = new THREE.Vector3();
    this._hurtColor = new THREE.Color('#ff4638');

    // 瞄准环：暗色描边垫底 + 亮环 + 大号中心点，置顶渲染保证在地面特效上醒目
    this.reticle = new THREE.Group();
    const ringShadow = new THREE.Mesh(
      new THREE.RingGeometry(0.34, 0.78, 40),
      new THREE.MeshBasicMaterial({ color: '#04070c', transparent: true, opacity: 0.6, depthWrite: false, depthTest: false })
    );
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.42, 0.7, 40),
      new THREE.MeshBasicMaterial({ color: '#9fd8ff', transparent: true, opacity: 1.0, depthWrite: false, depthTest: false })
    );
    const dot = new THREE.Mesh(
      new THREE.CircleGeometry(0.15, 20),
      new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.95, depthWrite: false, depthTest: false })
    );
    ringShadow.renderOrder = 7;
    ring.renderOrder = 8;
    dot.renderOrder = 8;
    ringShadow.rotation.x = ring.rotation.x = dot.rotation.x = -Math.PI / 2;
    this.reticle.add(ringShadow, ring, dot);
    this.reticle.position.y = 0.03;
    this._reticleRing = ring;
    this.scene.add(this.reticle);

    // 右键瞄准指示：最大施法距离环 + 玩家到落点的指向带（宽面片，比细线醒目）
    this.rangeRingShadow = new THREE.Mesh(
      new THREE.RingGeometry(MAX_RANGE - 0.8, MAX_RANGE - 0.32, 96),
      new THREE.MeshBasicMaterial({ color: '#04070c', transparent: true, opacity: 0, depthWrite: false, depthTest: false })
    );
    this.rangeRingShadow.rotation.x = -Math.PI / 2;
    this.rangeRingShadow.position.y = 0.045;
    this.rangeRingShadow.renderOrder = 7;
    this.scene.add(this.rangeRingShadow);
    this.rangeRing = new THREE.Mesh(
      new THREE.RingGeometry(MAX_RANGE - 0.55, MAX_RANGE, 96),
      new THREE.MeshBasicMaterial({ color: '#9fd8ff', transparent: true, opacity: 0, depthWrite: false, depthTest: false })
    );
    this.rangeRing.rotation.x = -Math.PI / 2;
    this.rangeRing.position.y = 0.05;
    this.rangeRing.renderOrder = 8;
    this.scene.add(this.rangeRing);

    // 指向带：扁平面片，从玩家指向落点
    this.aimLine = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 0.18).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        color: '#9fd8ff', transparent: true, opacity: 0,
        depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending
      })
    );
    this.aimLine.renderOrder = 7;
    this.scene.add(this.aimLine);

    /** 右键按住状态：true = 正在瞄准，落点指示亮起 */
    this._aiming = false;
    this._lastPointer = null;
    /** 左键按住状态：普通攻击通道 */
    this._attacking = false;
    this._basicT = 0;
    this._orbPos = new THREE.Vector3();

    // 普通攻击落点指示环：暗色描边 + 亮环
    this.basicRingShadow = new THREE.Mesh(
      new THREE.RingGeometry(0.3, 0.92, 40),
      new THREE.MeshBasicMaterial({ color: '#04070c', transparent: true, opacity: 0.55, depthWrite: false, depthTest: false })
    );
    this.basicRingShadow.rotation.x = -Math.PI / 2;
    this.basicRingShadow.visible = false;
    this.basicRingShadow.renderOrder = 7;
    this.scene.add(this.basicRingShadow);
    this.basicRing = new THREE.Mesh(
      new THREE.RingGeometry(0.42, 0.8, 40),
      new THREE.MeshBasicMaterial({ color: '#9fd8ff', transparent: true, opacity: 0.9, depthWrite: false, depthTest: false })
    );
    this.basicRing.rotation.x = -Math.PI / 2;
    this.basicRing.visible = false;
    this.basicRing.renderOrder = 8;
    this.scene.add(this.basicRing);

    // 粒子点精灵的尺寸跟随渲染像素比，保证动态分辨率下大小一致
    this.spells.bursts.setPixelRatio(this._pxRatio);
    this.world.weather.setPixelRatio(this._pxRatio);

    this._bind();

    this.hud.onSkill = (element) => this._select(element);
    this.player.setElement(ELEMENT_INFO[this.element].accent);
    this.hud.setActive(this.element);

    this.world.onShift = ({ theme }) => {
      this.hud.setWorld(theme);
      if (theme.id !== 'neutral') {
        this.hud.showToast(`世界已改写 → ${theme.glyph} ${theme.label}`);
        this.spirits.setAccent(theme.accent);
        this._shake = Math.min(this._shake + 0.35, 0.6);
      }
    };

    // 之灵撞到玩家：玩家掉血
    this.spirits.onPlayerHit = (damage) => this._onPlayerHit(damage);

    // 特殊元素之灵出现提示
    this.spirits.onSpecialSpawn = (element) => {
      const info = ELEMENT_INFO[element];
      this.hud.showToast(`⚠ 特殊元素之灵出现 — 用「${info.label}」清除可得 30 分`, 2600);
    };
  }

  /* ------------------------------------------------------------------ */

  _bind() {
    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this._applyPixelRatio();
    });

    window.addEventListener('keydown', (event) => {
      if (event.repeat) return;
      // Esc：暂停 / 继续（未锁定时才收得到 Esc 键；锁定中的 Esc 会先解锁并触发暂停）
      if (event.code === 'Escape' && this.started && !this.over) {
        this._setPaused(!this.paused);
        return;
      }
      this.keys.add(event.code);
      if (this.paused) return;
      if (!this.started || this.over) return;
      switch (event.code) {
        case 'KeyQ': this._select('ice'); break;
        case 'KeyE': this._select('fire'); break;
        case 'KeyR': this._select('storm'); break;
        case 'KeyH': this.hud.toggleHelp(); break;
      }
    });
    window.addEventListener('keyup', (event) => this.keys.delete(event.code));

    // 视角旋转：点击画面进入指针锁定后，滑动可无限旋转（不受屏幕边缘限制）。
    // 锁定时：滑动=转视角，按住右键滑动=移动落点（视角冻结）。
    // 未锁定时保留真实指针模式：指针位置即瞄准点，滑动转视角（到屏幕边缘会停）。
    window.addEventListener('pointermove', (event) => {
      if (!this.started || this.over) return;
      const mx = event.movementX ?? 0;
      const my = event.movementY ?? 0;

      if (this._locked) {
        if (this._aiming || this._attacking) {
          // 视角已冻结，滑动只拖动落点（虚拟光标）
          this._aimNDC.x = Math.max(-1, Math.min(1, this._aimNDC.x + mx * 0.0026));
          this._aimNDC.y = Math.max(-1, Math.min(1, this._aimNDC.y - my * 0.0026));
          this.pointer.copy(this._aimNDC);
        } else {
          this.orbit.yaw -= mx * 0.0032;
          this.orbit.pitch = Math.max(0.3, Math.min(1.25, this.orbit.pitch + my * 0.0026));
        }
        return;
      }

      this.pointer.set(
        (event.clientX / window.innerWidth) * 2 - 1,
        -(event.clientY / window.innerHeight) * 2 + 1
      );
      const last = this._lastPointer;
      const moved = last ? { dx: event.clientX - last.x, dy: event.clientY - last.y } : null;
      this._lastPointer = { x: event.clientX, y: event.clientY };
      if (!moved || this._aiming) return;
      if (event.target?.closest?.('.skill, .panel')) return;
      this.orbit.yaw -= moved.dx * 0.0038;
      this.orbit.pitch = Math.max(0.3, Math.min(1.25, this.orbit.pitch + moved.dy * 0.0028));
    });

    // 按住右键：显示技能落点指示；松开右键：在落点释放当前选中的技能。
    // 按住左键：普通攻击——固定视角，显示能量球落点并持续发射；松开停止。
    // 未锁定时的左键只用于进入指针锁定。
    // 每次按下都把落点重置回角色身边（原点 = 人物位置），再由拖动拉远。
    this.canvas.addEventListener('pointerdown', (event) => {
      if (!this.started || this.over || this.paused) return;
      if (event.button === 2) {
        this._aiming = true;
        this._resetAimToPlayer();
        this._updateAim();
      } else if (event.button === 0) {
        if (!this._locked) {
          this._requestLock();
        } else {
          this._attacking = true;
          this._resetAimToPlayer();
          this._updateAim();
          this._basicT = 0; // 立即射出第一发
        }
      }
    });
    window.addEventListener('pointerup', (event) => {
      if (event.button === 2 && this._aiming) {
        this._aiming = false;
        this._updateAim();
        this._castCurrent();
      } else if (event.button === 0) {
        this._attacking = false;
      }
    });
    window.addEventListener('contextmenu', (event) => event.preventDefault());

    document.addEventListener('pointerlockchange', () => {
      this._locked = document.pointerLockElement === this.canvas;
      if (this._locked) {
        this._aimNDC.copy(this.pointer);
        // 锁定成功：停止重试
        clearTimeout(this._lockRetryTimer);
        this._lockRetries = 0;
      } else if (this._aiming) this._aiming = false; // Esc 中途退出锁定，取消瞄准
      // 游戏进行中失去鼠标锁定（含按 Esc 解锁）→ 自动暂停
      if (!this._locked && this.started && !this.over && !this.paused) {
        this._setPaused(true);
      } else {
        this.hud.setLockHint(!this._locked && !this.paused && this.started && !this.over);
      }
    });
    document.addEventListener('pointerlockerror', () => {});

    window.addEventListener(
      'wheel',
      (event) => {
        this.orbit.dist = Math.max(6.5, Math.min(24, this.orbit.dist + event.deltaY * 0.012));
      },
      { passive: true }
    );
  }

  /** 暂停 / 继续：暂停时冻结模拟并显示说明界面，继续时重新锁定鼠标。 */
  _setPaused(paused) {
    if (this.paused === paused) return;
    this.paused = paused;
    if (paused) {
      this._attacking = false;
      this._aiming = false;
      this.keys.clear();
      this.hud.showPause();
      this.hud.setLockHint(false);
      this.hud.setEdgeHint(false); // 暂停时收起边缘提示
      if (document.pointerLockElement) document.exitPointerLock();
    } else {
      this.hud.hidePause();
      this._ensureLock(); // 立即回到锁定鼠标状态（冷却期内自动重试）
    }
  }

  /**
   * 持续尝试锁定鼠标直到成功。
   * 浏览器在用户按 Esc 解锁后有约 1.25 秒冷却期，期间的锁定请求会被拒绝——
   * 这里每 350ms 重试，冷却一过立即锁定，全程无需玩家点击。
   */
  _ensureLock() {
    if (this._locked || this.paused || !this.started || this.over) return;
    this._requestLock();
    this._lockRetries = (this._lockRetries ?? 0) + 1;
    clearTimeout(this._lockRetryTimer);
    if (this._lockRetries <= 12) {
      this._lockRetryTimer = setTimeout(() => this._ensureLock(), 350);
    }
  }

  /** 点击"开始游戏"后调用：正式启动玩法并直接锁定鼠标，元素之灵立即生成。 */
  begin() {
    if (this.started) return;
    this.started = true;
    this.paused = false;
    this.hud.hidePause();
    this.hud.hideStartScreen();
    this.hud.setLockHint(false);
    this._requestLock(); // 按钮点击即用户手势，直接进入指针锁定，无需再点画面
    this.spirits.begin(this.player.position, 3);
    this._updateSpiritTargets(); // 按 LV1 挡位同步之灵数量与级别徽章
    this.hud.showToast('冒险开始 — 元素之灵已出现', 2200);
  }

  /** 之灵撞到玩家：扣血 + 红屏震动，血量归零则游戏结束；连杀中断。 */
  _onPlayerHit(damage) {
    if (this.over) return;
    if (this._invulnT > 0) return; // 受击无敌帧，防止围攻瞬间连击致死
    this.hp = Math.max(0, this.hp - damage);
    this.hud.setHealth(this.hp);
    this.hud.hurtFlash();
    this._shake = Math.min(this._shake + 0.35, 0.7);
    if (this._killStreak > 0) {
      this._killStreak = 0;
      this.hud.setStreak(0);
      this.hud.showToast('连杀中断', 1200);
    }
    this._hitLog = (this._hitLog || []);
    this._hitLog.push(`t${this._testT?.toFixed(1) ?? '-'} 伤${damage} 血${this.hp}% 连杀→${this._killStreak}`);
    if (this.hp <= 0) this._gameOver();
    this._invulnT = 1.5;
  }

  /** 恢复生命（上限 100），带提示。 */
  _heal(percent, reason) {
    if (this.over || this.hp >= 100) return;
    this.hp = Math.min(100, this.hp + percent);
    this.hud.setHealth(this.hp);
    this.hud.showToast(`${reason} — 生命 +${percent}%`, 1500);
  }

  /**
   * 记录连杀：技能击杀推进计数但不触发回血（技能杀的之灵不恢复血量），
   * 只有普通攻击击杀才能兑现满 9 连杀的 20% 回血并重新计数。
   */
  _countKills(kills, canHeal) {
    if (kills <= 0) return;
    this._killStreak += kills;
    this.hud.setStreak(this._killStreak);
    if (this._killStreak >= 9 && canHeal) {
      this._killStreak = 0;
      this.hud.setStreak(0);
      this._heal(20, '连杀 ×9');
    }
  }

  /** 血量归零：游戏结束。 */
  _gameOver() {
    if (this.over) return;
    this.over = true;
    this._attacking = false;
    this._aiming = false;
    this.keys.clear();
    this.spirits.setFrozen(true);
    // 解除鼠标锁定，光标立即出现以便点击按钮
    if (document.pointerLockElement) document.exitPointerLock();
    this.hud.setLockHint(false);
    this.hud.showGameOver(this.score);
  }

  /** 重新开始：重置血量/分数/之灵，直接进入新一局。 */
  restart() {
    this.over = false;
    this.paused = false;
    this.hud.hidePause();
    this.hud.setEdgeHint(false);
    this._edgeWasPushing = false;
    this.hp = 100;
    this.stamina = 100;
    this._exhausted = false;
    this.score = 0;
    this._shake = 0;
    this._killStreak = 0;
    this._attacking = false;
    this._aiming = false;
    this._aimNDC.set(0, -0.1);
    this.pointer.copy(this._aimNDC);
    for (const [key] of this.cooldowns) this.cooldowns.set(key, 0);
    this.spells.reset();
    this.spirits.setFrozen(false);
    this.spirits.respawnAll(this.player.position, 3);
    this.hud.setScore(0);
    this.hud.setHealth(100);
    this.hud.setLevel(1);
    this._updateSpiritTargets();
    this.hud.hideGameOver();
    this.hud.showToast('新的冒险开始 — 元素之灵已出现', 2000);
    this._ensureLock(); // 重新开始即回到锁定鼠标的游玩状态
  }

  /** 返回初始界面：回到开始画面，世界与角色全部重置。 */
  backToStart() {
    this.over = false;
    this.started = false;
    // 若仍处于鼠标锁定（异常路径直接返回标题），先解除，避免开始按钮点不到
    if (document.pointerLockElement) document.exitPointerLock();
    this.paused = false;
    this.hud.hidePause();
    this.hud.setEdgeHint(false);
    this._edgeWasPushing = false;
    this.hp = 100;
    this.stamina = 100;
    this._exhausted = false;
    this.score = 0;
    this._shake = 0;
    this._killStreak = 0;
    this._attacking = false;
    this._aiming = false;
    this.element = 'ice';
    this.player.setElement(ELEMENT_INFO.ice.accent);
    this._aimNDC.set(0, -0.1);
    this.pointer.copy(this._aimNDC);
    for (const [key] of this.cooldowns) this.cooldowns.set(key, 0);
    this.spells.reset();
    this.spirits.setFrozen(false);
    this.spirits.reset();
    this.world.shift('neutral', this.player.position);
    this.hud.setScore(0);
    this.hud.setHealth(100);
    this.hud.setLevel(1);
    this.hud.hideGameOver();
    this.hud.setActive('ice');
    this.hud.setLockHint(false); // 标题画面不显示锁定提示
    this.hud.showStartScreen();
  }

  /**
   * 难度挡位：每 100 分升一档，共 10 档（普通之灵数 + 特殊之灵数）。
   * LV1(0+) 3+1 → LV3(200+) 5+2 → LV10(900+) 12+6 满配。
   */
  static TIERS = [
    { normal: 3, special: 1 },
    { normal: 4, special: 2 },
    { normal: 5, special: 2 },
    { normal: 6, special: 3 },
    { normal: 7, special: 3 },
    { normal: 8, special: 4 },
    { normal: 9, special: 4 },
    { normal: 10, special: 5 },
    { normal: 11, special: 5 },
    { normal: 12, special: 6 }
  ];

  /** 当前难度挡位（1~6）。 */
  get tier() {
    return Math.min(Math.floor(this.score / 100) + 1, Game.TIERS.length);
  }

  /** 按挡位设置场上之灵目标数量。 */
  _updateSpiritTargets() {
    const t = Game.TIERS[this.tier - 1];
    this.spirits.setNormalTarget(t.normal);
    this.spirits.setSpecialTarget(t.special);
    this.hud.setLevel(this.tier);
  }

  /** 每次按下瞄准/攻击时，落点从角色身边重新开始（原点 = 人物位置）。 */
  _resetAimToPlayer() {
    this._aimNDC.set(0, -0.1);
    this.pointer.copy(this._aimNDC);
  }

  /** 进入指针锁定：之后滑动鼠标可无限旋转视角，不受屏幕边缘限制。 */
  _requestLock() {
    try {
      const result = this.canvas.requestPointerLock();
      if (result && result.catch) result.catch(() => {});
    } catch {
      // 浏览器可能因刚退出锁定的冷却暂时拒绝，忽略即可，玩家再点一次。
    }
  }

  _updateAim() {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this._aimHit;
    if (this.raycaster.ray.intersectPlane(this.groundPlane, hit)) {
      const from = this.player.position;
      const dx = hit.x - from.x;
      const dz = hit.z - from.z;
      const dist = Math.hypot(dx, dz);
      if (dist > MAX_RANGE) {
        hit.x = from.x + (dx / dist) * MAX_RANGE;
        hit.z = from.z + (dz / dist) * MAX_RANGE;
      } else if (dist < MIN_RANGE && dist > 0.001) {
        hit.x = from.x + (dx / dist) * MIN_RANGE;
        hit.z = from.z + (dz / dist) * MIN_RANGE;
      }
      this.aimPoint.copy(hit);
    }
  }

  /**
   * 选中技能（Q / E / R 或点击技能卡）：只切换手中技能，不施放。
   * 冷却中的技能也允许先选中，点击时再提示。
   */
  _select(element) {
    if (!ELEMENTS.includes(element)) return;
    if (element !== this.element) {
      this.element = element;
      this.player.setElement(ELEMENT_INFO[element].accent);
      this.hud.setActive(element);
      this.hud.showToast(`已选择 ${ELEMENT_INFO[element].label} — 按住右键瞄准，松开释放`);
    }
    const accent = ELEMENT_INFO[this.element].accent;
    this._reticleRing.material.color.set(accent);
    this.rangeRing.material.color.set(accent);
    this.aimLine.material.color.set(accent);
  }

  /** 左键点击地面：释放当前选中的技能。 */
  _castCurrent() {
    const element = this.element;
    if ((this.cooldowns.get(element) ?? 0) > 0) {
      this.hud.showToast('技能冷却中');
      return;
    }
    this.player.playCast();
    this.spells.cast(element, this.player.position, this.aimPoint.clone(), (point, radius) =>
      this._onImpact(element, point, radius)
    );
    this.cooldowns.set(element, COOLDOWNS[element]);
    this._reticleRing.material.color.set(ELEMENT_INFO[element].accent);
  }

  /** 技能命中：改写世界 + 全场地特效（染色浪潮/地裂）+ 收集之灵。 */
  _onImpact(element, point, radius) {
    const accent = ELEMENT_INFO[element].accent;

    // 世界改写（并重置 6 秒还原计时）
    this.world.shift(FAMILY_OF[element], point);
    this._worldRevertT = 6;

    // 全场地特效：从落点炸开染色浪潮与地裂，全屏闪光强化冲击感
    this.groundFx.burst(point, accent);
    this.hud.castFlash(accent);

    // 之灵判定：普通之灵 +10；对应元素清除特殊之灵 +30
    const result = this.spirits.collectAt(point, radius, element, this.world.current);
    const gained = result.normal * 10 + result.special * 30;
    if (gained > 0) {
      this.score += gained;
      this.hud.setScore(this.score);
    }
    if (result.immune > 0) {
      this.hud.showToast('属性不符 — 特殊之灵需要对应元素的技能', 1500);
    }
    this._countKills(result.normal, false); // 技能击杀推进连杀但不回血
    this._updateSpiritTargets();
    this._shake = Math.min(this._shake + 0.3, 0.7);
  }

  /** 普通攻击路径命中：普通之灵直接收集；特殊之灵在同色领域内累积伤害（每次攻击同一之灵只算一次）。 */
  _basicPathHit(pos, hitSet) {
    const result = this.spirits.collectAt(pos, 1.0, 'basic', this.world.current, hitSet);
    if (result.normal > 0) {
      this.score += result.normal * 10;
      this.hud.setScore(this.score);
    }
    if (result.special > 0) {
      this.score += result.special * 30;
      this.hud.setScore(this.score);
      this._updateSpiritTargets();
      this._heal(10 * result.special, '普攻净化特殊之灵');
    }
    this._countKills(result.normal, true); // 普攻击杀推进连杀并兑现回血
  }

  /** 普通攻击落点爆发。 */
  _basicImpact(point, radius = 1.6, hitSet) {
    const result = this.spirits.collectAt(point, radius, 'basic', this.world.current, hitSet);
    if (result.normal > 0) {
      this.score += result.normal * 10;
      this.hud.setScore(this.score);
    }
    if (result.special > 0) {
      this.score += result.special * 30;
      this.hud.setScore(this.score);
      this._updateSpiritTargets();
      this._heal(10 * result.special, '普攻净化特殊之灵');
    }
    this._countKills(result.normal, true); // 普攻击杀推进连杀并兑现回血
  }

  /* ------------------------------------------------------------------ */

  /** 飞行拖尾：元素色的气流从脚下散开。 */
  _emitFlightTrail(dt) {
    this._trailT = (this._trailT ?? 0) - dt;
    if (this._trailT > 0) return;
    this._trailT = 0.05;
    this._trailPos ??= new THREE.Vector3();
    this._trailPos.set(
      this.player.position.x + (Math.random() - 0.5) * 0.5,
      0.35,
      this.player.position.z + (Math.random() - 0.5) * 0.5
    );
    this.spells.bursts.emit({
      pos: this._trailPos,
      count: 3,
      speed: [0.4, 1.6],
      up: [0.2, 1.2],
      life: [0.25, 0.55],
      size: [9, 22],
      colorA: '#ffffff',
      colorB: ELEMENT_INFO[this.element].accent,
      gravity: 1.5,
      drag: 2.2,
      spread: 0.4
    });
  }

  _updateCamera(dt) {
    const { yaw, pitch, dist } = this.orbit;
    const target = this._cameraTarget ?? (this._cameraTarget = new THREE.Vector3());
    target.set(
      this.player.position.x + Math.sin(yaw) * Math.cos(pitch) * dist,
      Math.sin(pitch) * dist + 1.4,
      this.player.position.z + Math.cos(yaw) * Math.cos(pitch) * dist
    );

    // 震动
    if (this._shake > 0.001) {
      this._shake *= Math.max(0, 1 - dt * 5.5);
      target.x += (Math.random() - 0.5) * this._shake;
      target.y += (Math.random() - 0.5) * this._shake;
      target.z += (Math.random() - 0.5) * this._shake;
    }

    this.camera.position.lerp(target, Math.min(1, dt * 9));
    this.camera.lookAt(
      this.player.position.x,
      1.35,
      this.player.position.z
    );
  }

  /**
   * ?test=streakbreak 自动化验证（正常游玩不触发）：
   * 开始后 1s 注入连杀5 → 4s 受击 25 伤 → 5s 检查结果并写到 #testOut。
   */
  _runStreakTest(dt) {
    if (this._testMode !== 'streakbreak' || !this.started || this.over) return;
    this._testT += dt;
    const out = document.getElementById('testOut');
    if (!out) return;
    const snap = (tag) =>
      `${tag}[实例${this._instanceId} t${this._testT.toFixed(1)} 血${this.hp} 连杀${this._killStreak} 无敌${this._invulnT.toFixed(1)} over${this.over ? 1 : 0}]`;
    if (this._testT >= 1 && this._testT - dt < 1) {
      this._killStreak = 5;
      this.hud.setStreak(5);
      out.textContent = snap('注入连杀5');
    } else if (this._testT >= 4 && this._testT - dt < 4) {
      out.textContent += ' ‖ ' + snap('受击前');
      this._onPlayerHit(25);
      out.textContent += ' ‖ ' + snap('受击后');
    } else if (this._testT >= 5 && this._testT - dt < 5) {
      out.textContent += ' ‖ ' + snap(
        this._killStreak === 0 ? '✅清零正常' : '❌未清零'
      ) + `｜受击日志:${(this._hitLog || ['无']).join(';')}`;
    }  }

  /** 应用当前像素比：渲染缓冲 + 粒子点精灵尺寸一起缩放。 */
  _applyPixelRatio() {
    this.renderer.setPixelRatio(this._pxRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.spells.bursts.setPixelRatio(this._pxRatio);
    this.world.weather.setPixelRatio(this._pxRatio);
  }

  frame(dt) {
    this.elapsed += dt;
    this._runStreakTest(dt);

    // 帧率统计（每 0.5 秒更新显示）
    this._fpsFrames = (this._fpsFrames ?? 0) + 1;
    this._fpsTime = (this._fpsTime ?? 0) + dt;
    if (this._fpsTime >= 0.5) {
      this._recentFps = Math.round(this._fpsFrames / this._fpsTime);
      this.hud.setFps(this._recentFps);
      this._fpsFrames = 0;
      this._fpsTime = 0;
    }

    // 动态分辨率控制器：每 1.5 秒按近期帧率升降像素比（0.7 ~ 上限），
    // 帧率 <88 降档、>100 升档，把帧率稳在 90 上下。
    // 近期帧率 <40 视为标签页被节流/遮挡而非 GPU 瓶颈，不再继续降档。
    this._resT = (this._resT ?? 0) + dt;
    if (this._resT >= 1.5) {
      this._resT = 0;
      const recent = this._recentFps ?? 0;
      if (recent >= 40 && recent < 88 && this._pxRatio > 0.7) {
        this._pxRatio = Math.max(0.7, this._pxRatio - 0.15);
        this._applyPixelRatio();
      } else if (recent > 100 && this._pxRatio < this._pxRatioCap) {
        this._pxRatio = Math.min(this._pxRatioCap, this._pxRatio + 0.1);
        this._applyPixelRatio();
      }
    }

    // 暂停：冻结全部模拟，只渲染定格画面
    if (this.paused) {
      this.renderer.render(this.scene, this.camera);
      return;
    }

    // 移动输入（相对相机朝向）
    const move = new THREE.Vector3();
    const forward = this._scratchF.set(-Math.sin(this.orbit.yaw), 0, -Math.cos(this.orbit.yaw));
    // 屏幕右侧 = 视线方向叉乘世界向上：视线是 (-sinY, -cosY)，所以右是 (cosY, -sinY)
    const right = this._scratchR.set(Math.cos(this.orbit.yaw), 0, -Math.sin(this.orbit.yaw));
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) move.add(forward);
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) move.sub(forward);
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) move.add(right);
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) move.sub(right);
    if (move.lengthSq() > 0) move.normalize();

    // 按住 Shift：贴地飞行。攻击（左键通道）或瞄准（右键）时无法飞行——
    // 攻击动作会打断飞行，松开攻击且 Shift 仍按住时才会再次起飞。
    // 游戏结束后不再移动。
    // 体力系统：飞行消耗（9 秒清零），松开恢复（12 秒回满），耗尽后需恢复到 25% 才能再飞
    const shiftHeld = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    const canFly = shiftHeld && !this._exhausted;
    const flying = canFly && !this._attacking && !this._aiming && !this.over;
    if (flying) {
      this.stamina = Math.max(0, this.stamina - (dt / STAMINA_DRAIN_TIME) * 100);
      if (this.stamina <= 0) this._exhausted = true;
    } else if (this.stamina < 100) {
      this.stamina = Math.min(100, this.stamina + (dt / STAMINA_REGEN_TIME) * 100);
      if (this._exhausted && this.stamina >= STAMINA_REFLY) this._exhausted = false;
    }
    this.hud.setStamina(this.stamina, this._exhausted);
    if (flying && move.lengthSq() > 0) this._emitFlightTrail(dt);
    if (this.over) move.set(0, 0, 0);
    // 受击无敌帧倒计时：1.5 秒递减到 0 后才会再次受到伤害
    this._invulnT = Math.max(0, this._invulnT - dt);

    this._updateAim();
    // 开始前的电影式缓慢环视
    if (!this.started) this.orbit.yaw += dt * 0.06;
    this.player.update(dt, move.lengthSq() > 0 ? move : null, this.aimPoint, this.elapsed, flying);
    this.player.updateShield(this.elapsed, this._invulnT);
    // 飞行拖尾光带：只在飞行时采样轨迹，松开 Shift 后自然消散
    this.flightTrail.update(dt, flying ? this.player.root.position : null, ELEMENT_INFO[this.element].accent);
    this._updateCamera(dt);

    // 场地边缘感知：接近泛亮 → 顶边碰撞时波纹 + 火花 + HUD 提示
    this.edge.update(dt, this.elapsed, this.player, this.world.currentAccent);
    const pushing = this.player.edgePush > 0.3;
    this.hud.setEdgeHint(pushing);
    if (pushing) {
      if (!this._edgeWasPushing) {
        this._shake = Math.min(this._shake + 0.12, 0.7); // 撞上瞬间的轻微反馈
        if (this.elapsed - (this._edgeToastT ?? -99) > 6) {
          this._edgeToastT = this.elapsed;
          this.hud.showToast('已抵达场地边缘 — 无法再往外走了', 1500);
        }
      }
      // 接触点火花 + 边界冲击波纹（节流发射，波纹一圈圈向场内扩散）
      this._edgeSparkT = (this._edgeSparkT ?? 0) - dt;
      if (this._edgeSparkT <= 0) {
        this._edgeSparkT = 0.16;
        this.edge.flash(Math.min(1, this.player.edgePush));
        this.spells.bursts.emit({
          pos: this.player.edgePoint,
          count: 5,
          speed: [1.2, 3.4],
          up: [0.6, 2.4],
          life: [0.3, 0.6],
          size: [7, 15],
          colorA: '#ffffff',
          colorB: this.world.currentAccent,
          gravity: 4.5,
          drag: 2.6,
          spread: 0.5
        });
      }
    }
    this._edgeWasPushing = pushing;

    // 瞄准环跟随 + 呼吸；只按住右键时才显示落点指示，平时完全隐藏
    const aiming = this._aiming;
    const accent = ELEMENT_INFO[this.element].accent;
    this.reticle.visible = aiming;
    this.reticle.position.set(this.aimPoint.x, 0.03 + Math.sin(this.elapsed * 4) * 0.012, this.aimPoint.z);
    this.reticle.rotation.y = this.elapsed * 0.8;
    this.reticle.scale.setScalar(aiming ? 1 + Math.sin(this.elapsed * 10) * 0.08 : 1);
    this._reticleRing.material.color.set(accent);

    // 落点指示：距离环围住玩家，指向带连到落点
    const fade = Math.min(1, dt * 10);
    this.rangeRing.position.set(this.player.position.x, 0.05, this.player.position.z);
    this.rangeRingShadow.position.set(this.player.position.x, 0.045, this.player.position.z);
    this.rangeRing.material.opacity += ((aiming ? 0.6 : 0) - this.rangeRing.material.opacity) * fade;
    this.rangeRingShadow.material.opacity += ((aiming ? 0.5 : 0) - this.rangeRingShadow.material.opacity) * fade;
    this.aimLine.material.opacity = this.aimLine.material.opacity + ((aiming ? 0.9 : 0) - this.aimLine.material.opacity) * fade;
    const adx = this.aimPoint.x - this.player.position.x;
    const adz = this.aimPoint.z - this.player.position.z;
    const adist = Math.max(Math.hypot(adx, adz), 0.001);
    this.aimLine.position.set(
      this.player.position.x + adx / 2, 0.1,
      this.player.position.z + adz / 2
    );
    this.aimLine.rotation.y = -Math.atan2(adz, adx);
    this.aimLine.scale.set(adist, 1, 1);

    // 普通攻击：按住左键时，能量球落点指示亮起并持续发射
    if (this._attacking) {
      this._basicT -= dt;
      if (this._basicT <= 0) {
        this._basicT = 0.32;
        const accent = ELEMENT_INFO[this.element].accent;
        this.player.playCast();
        this.player.getOrbWorldPosition(this._orbPos);
        this.spells.castBasic(
          this._orbPos,
          this.aimPoint.clone(),
          accent,
          (pos, hitSet) => this._basicPathHit(pos, hitSet),
          (point, radius, hitSet) => this._basicImpact(point, radius, hitSet)
        );
      }
      this.basicRing.visible = true;
      this.basicRingShadow.visible = true;
      this.basicRing.position.set(this.aimPoint.x, 0.05, this.aimPoint.z);
      this.basicRingShadow.position.set(this.aimPoint.x, 0.045, this.aimPoint.z);
      this.basicRing.material.color.set(accent);
      this.basicRing.material.opacity = 0.85 + Math.sin(this.elapsed * 10) * 0.15;
      this.basicRing.scale.setScalar(1 + Math.sin(this.elapsed * 10) * 0.08);
    } else {
      this.basicRing.visible = false;
      this.basicRingShadow.visible = false;
    }

    this.spells.update(dt);
    this.spirits.update(dt, this.elapsed, this.player.position);
    this.world.update(dt, this.elapsed, this.player.position, this.hud.vignette);
    // 全场地特效：浪潮/地裂推进；领域残辉跟随当前世界（退回荒原即消散）
    this.groundFx.update(dt, this.world.currentAccent, this.world.current !== 'neutral');

    // 世界还原：上次施法 6 秒内没有再施法，世界退回元素荒原
    if (this.started && !this.over && this._worldRevertT > 0) {
      this._worldRevertT -= dt;
      if (this._worldRevertT <= 0 && this.world.current !== 'neutral') {
        this.world.shift('neutral', this.player.position);
        this.hud.showToast('元素之力消散 — 世界恢复荒原', 1800);
      }
    }

    for (const element of ELEMENTS) {
      const remaining = this.cooldowns.get(element) ?? 0;
      if (remaining > 0) this.cooldowns.set(element, Math.max(0, remaining - dt));
      this.hud.setCooldown(element, this.cooldowns.get(element) ?? 0, COOLDOWNS[element]);
    }

    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.player.dispose();
    this.spells.dispose();
    this.spirits.dispose();
    this.edge.dispose();
    this.groundFx.dispose();
    this.flightTrail.dispose();
    this.world.dispose();
    this.renderer.dispose();
  }
}
