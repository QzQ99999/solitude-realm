/**
 * hud.js — DOM 界面：世界徽章、提示、分数、技能卡冷却。
 */
export class HUD {
  constructor() {
    this.worldBadge = document.getElementById('worldBadge');
    this.worldGlyph = document.getElementById('worldGlyph');
    this.worldName = document.getElementById('worldName');
    this.lockHint = document.getElementById('lockHint');
    this.lockHint.classList.add('is-hidden'); // 游戏开始前不显示
    this.startScreen = document.getElementById('startScreen');
    this.healthFill = document.getElementById('healthFill');
    this.healthNum = document.getElementById('healthNum');
    this.healthPanel = document.querySelector('.hud-health');
    this.streakEl = document.getElementById('streak');
    this.staminaFill = document.getElementById('staminaFill');
    this.staminaNum = document.getElementById('staminaNum');
    this.fpsNum = document.getElementById('fpsNum');
    this.fpsNum = document.getElementById('fpsNum');
    this.levelBadge = document.getElementById('levelBadge');
    this._levelShown = 1;
    this.gameOverScreen = document.getElementById('gameOverScreen');
    this.pauseScreen = document.getElementById('pauseScreen');
    this.finalScore = document.getElementById('finalScore');
    this.toast = document.getElementById('toast');
    this.edgeHint = document.getElementById('edgeHint');
    this.scoreElement = document.getElementById('score');
    this.scorePanel = document.querySelector('.hud-score');
    this.help = document.getElementById('help');
    this.vignette = document.getElementById('vignette');
    this.castFlashEl = document.getElementById('castFlash');
    this.skills = new Map();
    for (const element of document.querySelectorAll('.skill')) {
      this.skills.set(element.dataset.element, {
        root: element,
        card: null,
        numEl: element.querySelector('.skill__cd-num')
      });
      element.addEventListener('pointerdown', (event) => {
        event.stopPropagation();
        this.onSkill?.(element.dataset.element);
      });
    }

    this._toastTimer = 0;
    this._cooldownShown = new Map();

    /** 技能卡被点击（选择该元素）。 */
    this.onSkill = null;
  }

  /** 世界徽章：世界改写时弹出。 */
  setWorld(theme) {
    this.worldGlyph.textContent = theme.glyph;
    this.worldName.textContent = theme.label;
    this.worldBadge.style.setProperty('--world-accent', theme.accent);
    this.worldBadge.style.setProperty('--world-border', theme.accent + '59');
    this.worldBadge.style.setProperty('--world-glow', theme.accent + '40');
    this.worldBadge.classList.remove('is-pop');
    void this.worldBadge.offsetWidth;
    this.worldBadge.classList.add('is-pop');
  }

  /** 体力条：飞行消耗、松开恢复；耗尽变红提示无法飞行。 */
  setStamina(pct, exhausted) {
    const p = Math.max(0, Math.min(100, pct));
    this.staminaFill.style.width = `${p}%`;
    this.staminaFill.classList.toggle('is-exhausted', exhausted);
    this.staminaNum.textContent = `${Math.round(p)}%`;
    this.staminaNum.style.color = exhausted ? '#ff5a4d' : '#9fd8ff';
  }

  /** 帧率显示（每 0.5 秒更新，颜色分级）。 */
  setFps(fps) {
    this.fpsNum.textContent = fps;
    this.fpsNum.className = fps >= 50 ? 'is-ok' : fps >= 30 ? 'is-mid' : 'is-low';
  }

  /** 受击红屏一闪（重放动画实现）。 */
  hurtFlash() {
    this.vignette.classList.remove('is-hurt');
    void this.vignette.offsetWidth;
    this.vignette.classList.add('is-hurt');
  }

  /** 施法全屏闪光：元素色从屏幕边缘涌入后淡出（重放动画实现）。 */
  castFlash(color) {
    if (!this.castFlashEl) return;
    this.castFlashEl.style.setProperty('--flash-color', color);
    this.castFlashEl.classList.remove('is-flash');
    void this.castFlashEl.offsetWidth;
    this.castFlashEl.classList.add('is-flash');
  }

  /** 连杀计数（名称"生命恢复"）：满血时隐藏，满 9 回复生命后归零。 */
  setStreak(count) {
    this._streak = count;
    this._refreshStreak();
  }

  _refreshStreak() {
    const count = this._streak ?? 0;
    const hp = this._hp ?? 100;
    if (count > 0 && hp < 100) {
      this.streakEl.textContent = `生命恢复 ${Math.min(count, 9)}/9`;
      this.streakEl.classList.add('is-visible');
    } else {
      this.streakEl.classList.remove('is-visible');
    }
  }

  /** 难度挡位徽章（1~10），升档时弹跳强调。 */
  setLevel(tier) {
    if (tier === this._levelShown) return;
    const up = tier > this._levelShown;
    this._levelShown = tier;
    this.levelBadge.textContent = `LV.${tier}`;
    if (up) {
      this.levelBadge.classList.remove('is-bump');
      void this.levelBadge.offsetWidth;
      this.levelBadge.classList.add('is-bump');
    }
  }

  /** 游戏正式开始：隐藏开始画面。 */
  hideStartScreen() {
    this.startScreen.classList.add('is-hidden');
  }

  /** 返回初始界面：重新显示开始画面。 */
  showStartScreen() {
    this.startScreen.classList.remove('is-hidden');
  }

  /** 生命条：宽度随血量收缩，颜色由绿转红。 */
  setHealth(hp) {
    this._hp = hp;
    const pct = Math.max(0, Math.min(100, hp));
    this.healthFill.style.width = `${pct}%`;
    this.healthNum.textContent = `${Math.round(pct)}%`;
    const color = pct > 50 ? '#6fe38a' : pct > 25 ? '#ffb84d' : '#ff5a4d';
    this.healthFill.style.background = color;
    this.healthNum.style.color = color;
    this._refreshStreak();
  }

  /** 帧率显示（每 0.5 秒更新，颜色分级）。 */
  setFps(fps) {
    this.fpsNum.textContent = fps;
    this.fpsNum.className = fps >= 50 ? 'is-ok' : fps >= 30 ? 'is-mid' : 'is-low';
  }

  /** 暂停 / 继续界面。 */
  showPause() {
    this.pauseScreen.classList.remove('is-hidden');
  }

  hidePause() {
    this.pauseScreen.classList.add('is-hidden');
  }

  /** 游戏结束画面。 */
  showGameOver(score) {
    this.finalScore.textContent = score;
    this.gameOverScreen.classList.remove('is-hidden');
  }

  hideGameOver() {
    this.gameOverScreen.classList.add('is-hidden');
  }

  /** 指针锁定提示：未锁定时显示，锁定后隐藏。 */
  setLockHint(visible) {
    this.lockHint.classList.toggle('is-hidden', !visible);
  }

  /** 场地边缘碰撞提示：顶到边界推挤时亮起，松开即隐。 */
  setEdgeHint(visible) {
    this.edgeHint?.classList.toggle('is-visible', visible);
  }

  showToast(message, duration = 1900) {
    this.toast.textContent = message;
    this.toast.classList.add('is-visible');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => this.toast.classList.remove('is-visible'), duration);
  }

  setScore(score) {
    this.scoreElement.textContent = score;
    this.scorePanel.classList.remove('is-bump');
    void this.scorePanel.offsetWidth;
    this.scorePanel.classList.add('is-bump');
  }

  setActive(element) {
    for (const [key, { root }] of this.skills) {
      root.classList.toggle('is-active', key === element);
    }
  }

  /** @param {number} remaining 剩余秒 @param {number} total 总冷却秒 */
  setCooldown(element, remaining, total) {
    const skill = this.skills.get(element);
    if (!skill) return;
    const ratio = Math.max(0, Math.min(1, remaining / Math.max(total, 0.001)));
    if (Math.abs(ratio - (this._cooldownShown.get(element) ?? -1)) < 0.01) return;
    this._cooldownShown.set(element, ratio);
    skill.root.style.setProperty('--cd', ratio);
    skill.root.classList.toggle('is-cooling', ratio > 0.001);
    skill.root.classList.toggle('is-empty', ratio > 0.001);
    // 冷却读秒计数器
    if (skill.numEl) skill.numEl.textContent = ratio > 0.001 ? Math.ceil(remaining) : '';
  }

  toggleHelp() {
    this.help.classList.toggle('is-hidden');
  }
}
