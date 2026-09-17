/**
 * audio.js — 程序化音效引擎（Web Audio API，零外部素材）。
 *
 * 所有音效都由振荡器 + 噪声 + 滤波器 + 包络实时合成：
 *  - 一次性音效：tone()（振荡器扫频）/ noise()（噪声突发 + 滤波扫频）两个原语拼装；
 *  - 循环音：飞行风声（带通噪声 + LFO 摆频）、各领域环境音（荒原风 / 冰原风啸 /
 *    烈焰低燃 / 雷暴嗡鸣），领域切换时交叉淡入淡出；
 *  - AudioContext 惰性创建：必须在用户手势（点击开始/按下鼠标）里 ensure()，
 *    否则浏览器自动播放策略会挂起。
 */

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noiseBuf = null;
    this.realm = 'neutral';
    this._ambient = null;
    this._music = null;
  }

  /** 在用户手势里调用：创建/恢复 AudioContext。失败则整个引擎静默禁用。 */
  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try {
        this.ctx = new AC();
      } catch {
        return null;
      }
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
      const len = Math.floor(this.ctx.sampleRate * 2);
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      this._startAmbient(this.realm);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  /* ---------------- 合成原语 ---------------- */

  /** 振荡器扫频：f0 → f1，指数包络。 */
  tone({ type = 'sine', f0 = 440, f1 = f0, dur = 0.2, gain = 0.3, attack = 0.005, when = 0 }) {
    const ctx = this.ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime + when;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(1, f0), t0);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  /** 噪声突发：滤波器 f0 → f1 扫频 + 指数包络。 */
  noise({ dur = 0.3, gain = 0.3, type = 'lowpass', f0 = 1000, f1 = f0, q = 1, attack = 0.005, when = 0 }) {
    const ctx = this.ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime + when;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const flt = ctx.createBiquadFilter();
    flt.type = type;
    flt.frequency.setValueAtTime(Math.max(20, f0), t0);
    flt.Q.value = q;
    if (f1 !== f0) flt.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(flt).connect(g).connect(this.master);
    src.start(t0);
    src.stop(t0 + dur + 0.05);
  }

  /* ---------------- 一次性音效 ---------------- */

  /** 开始游戏按钮。 */
  click() {
    this.tone({ type: 'triangle', f0: 880, f1: 1320, dur: 0.07, gain: 0.25 });
    this.noise({ dur: 0.05, gain: 0.08, type: 'highpass', f0: 3200 });
  }

  /** 返回初始界面按钮（下行双音）。 */
  clickBack() {
    this.tone({ type: 'triangle', f0: 660, f1: 440, dur: 0.1, gain: 0.25 });
  }

  /** Esc 暂停（下行两音，音乐同时闪避）。 */
  pause() {
    this.tone({ type: 'sine', f0: 660, dur: 0.12, gain: 0.2 });
    this.tone({ type: 'sine', f0: 440, dur: 0.2, gain: 0.2, when: 0.11 });
    this.duckMusic(true);
  }

  /** 恢复继续（上行两音，音乐解除闪避）。 */
  unpause() {
    this.tone({ type: 'sine', f0: 440, dur: 0.12, gain: 0.2 });
    this.tone({ type: 'sine', f0: 660, dur: 0.2, gain: 0.2, when: 0.11 });
    this.duckMusic(false);
  }

  /** 普通攻击发射（明亮 zap：双层扫频 + 高频噪声，随机音高让每发都清晰可辨）。 */
  shoot() {
    const v = 0.88 + Math.random() * 0.32;
    this.tone({ type: 'square', f0: 1500 * v, f1: 280 * v, dur: 0.13, gain: 0.2 });
    this.tone({ type: 'sawtooth', f0: 720 * v, f1: 130 * v, dur: 0.1, gain: 0.12 });
    this.noise({ dur: 0.1, gain: 0.13, type: 'bandpass', f0: 2800, f1: 900, q: 1.6 });
  }

  /** 普通攻击命中（噪声冲击 + 低频垫）。 */
  hit() {
    this.noise({ dur: 0.13, gain: 0.26, type: 'lowpass', f0: 1800, f1: 320 });
    this.tone({ type: 'sine', f0: 220, f1: 85, dur: 0.12, gain: 0.22 });
  }

  /** 普攻命中特殊之灵但未击败：黑铁圣物匣的金属撞击声。 */
  specialHit() {
    this.tone({ type: 'square', f0: 620, f1: 430, dur: 0.09, gain: 0.13 });
    this.tone({ type: 'sine', f0: 1244, f1: 1080, dur: 0.15, gain: 0.09, when: 0.005 });
    this.noise({ dur: 0.12, gain: 0.13, type: 'bandpass', f0: 2600, q: 2 });
  }

  /** 普攻打在属性不符的特殊之灵上：被弹开的钝声。 */
  deflect() {
    this.tone({ type: 'sine', f0: 300, f1: 175, dur: 0.1, gain: 0.11 });
    this.noise({ dur: 0.07, gain: 0.05, type: 'bandpass', f0: 900, q: 2 });
  }

  /** 光柱预警：0.5 秒上行啸音（能量聚集）。 */
  pillarWarn() {
    this.tone({ type: 'sine', f0: 600, f1: 1250, dur: 0.5, gain: 0.13 });
    this.noise({ dur: 0.5, gain: 0.07, type: 'bandpass', f0: 900, f1: 2600, q: 1.2 });
  }

  /** 光柱落下：重 zap + 低频轰鸣。 */
  pillarStrike() {
    this.noise({ dur: 0.35, gain: 0.28, type: 'highpass', f0: 1000 });
    this.tone({ type: 'sawtooth', f0: 220, f1: 55, dur: 0.4, gain: 0.24 });
    this.tone({ type: 'sine', f0: 90, f1: 40, dur: 0.5, gain: 0.28, when: 0.02 });
  }

  /** 特殊之灵激光蓄能预警（1 秒上行充电音，提示躲避）。 */
  laserCharge() {
    this.tone({ type: 'sawtooth', f0: 700, f1: 1700, dur: 1.0, gain: 0.09 });
    this.tone({ type: 'sine', f0: 1400, f1: 3100, dur: 1.0, gain: 0.05 });
  }

  /** 特殊之灵激光射击（高频 zap）。 */
  laserFire() {
    this.tone({ type: 'sawtooth', f0: 1900, f1: 260, dur: 0.22, gain: 0.16 });
    this.noise({ dur: 0.18, gain: 0.11, type: 'highpass', f0: 1500 });
  }

  /** 角色受击（失真下坠）。 */
  hurt() {
    this.tone({ type: 'sawtooth', f0: 300, f1: 90, dur: 0.28, gain: 0.28 });
    this.noise({ dur: 0.2, gain: 0.18, type: 'lowpass', f0: 900, f1: 200 });
  }

  /** 护盾展开（上行闪亮双音）。 */
  shield() {
    this.tone({ type: 'sine', f0: 500, f1: 1200, dur: 0.28, gain: 0.18 });
    this.tone({ type: 'sine', f0: 750, f1: 1800, dur: 0.28, gain: 0.1, when: 0.03 });
  }

  /** 技能切换（上行短促双音）。 */
  switch() {
    this.tone({ type: 'square', f0: 520, f1: 780, dur: 0.08, gain: 0.14 });
  }

  /** 技能冷却完毕（清脆提示）。 */
  cdReady() {
    this.tone({ type: 'sine', f0: 990, dur: 0.1, gain: 0.18 });
    this.tone({ type: 'sine', f0: 1480, dur: 0.16, gain: 0.18, when: 0.09 });
  }

  /** 按住右键瞄准期间的节拍提示。 */
  aimPulse() {
    this.tone({ type: 'sine', f0: 1560, dur: 0.05, gain: 0.07 });
  }

  /** 等级提升（上行琶音）。 */
  levelUp() {
    [523, 659, 784, 1047].forEach((f, i) =>
      this.tone({ type: 'triangle', f0: f, dur: 0.14, gain: 0.2, when: i * 0.09 }));
  }

  /** 生命恢复（温暖上行）。 */
  heal() {
    this.tone({ type: 'sine', f0: 660, f1: 990, dur: 0.16, gain: 0.18 });
    this.tone({ type: 'sine', f0: 990, f1: 1320, dur: 0.2, gain: 0.13, when: 0.11 });
  }

  /** 体力耗尽（疲软下坠）。 */
  staminaOut() {
    this.tone({ type: 'sawtooth', f0: 400, f1: 120, dur: 0.4, gain: 0.14 });
    this.tone({ type: 'sawtooth', f0: 300, f1: 90, dur: 0.45, gain: 0.1, when: 0.05 });
  }

  /** 特殊元素之灵被击败（爆炸 + 晶体琶音）。 */
  specialKill() {
    this.noise({ dur: 0.5, gain: 0.32, type: 'lowpass', f0: 2400, f1: 200 });
    [880, 1175, 1568].forEach((f, i) =>
      this.tone({ type: 'sine', f0: f, dur: 0.2, gain: 0.16, when: 0.08 + i * 0.07 }));
  }

  /** 角色被击败（下行小调弦乐垫 + 长尾噪声）。 */
  death() {
    [392, 311, 233, 155].forEach((f, i) =>
      this.tone({ type: 'sawtooth', f0: f, f1: f * 0.94, dur: 0.55, gain: 0.22, when: i * 0.35 }));
    this.noise({ dur: 1.6, gain: 0.1, type: 'lowpass', f0: 600, f1: 80, when: 0.2 });
  }

  /** 三系技能落地打击，各有音色。 */
  impact(kind) {
    if (kind === 'ice') {
      // 霜新星：高频冰晶碎裂
      this.noise({ dur: 0.32, gain: 0.2, type: 'highpass', f0: 2200 });
      [1568, 2093, 2637].forEach((f, i) =>
        this.tone({ type: 'sine', f0: f, f1: f * 0.85, dur: 0.24, gain: 0.15, when: i * 0.05 }));
    } else if (kind === 'fire') {
      // 落炎陨石：低频轰鸣 + 宽带火焰
      this.tone({ type: 'sine', f0: 150, f1: 45, dur: 0.5, gain: 0.38 });
      this.noise({ dur: 0.55, gain: 0.28, type: 'lowpass', f0: 1600, f1: 260 });
      this.noise({ dur: 0.3, gain: 0.1, type: 'bandpass', f0: 3000, q: 1.5, when: 0.05 });
    } else {
      // 天雷殛灭：电弧 + 雷垫
      this.noise({ dur: 0.3, gain: 0.28, type: 'bandpass', f0: 3000, f1: 600, q: 0.8 });
      this.tone({ type: 'sawtooth', f0: 180, f1: 60, dur: 0.35, gain: 0.22 });
      this.tone({ type: 'square', f0: 2400, f1: 400, dur: 0.1, gain: 0.08 });
    }
  }

  /* ---------------- 背景音乐（80 BPM 程序化 Chillhop） ---------------- */

  /** 开始背景音乐（已在播放则忽略）。 */
  startMusic() {
    const ctx = this.ensure();
    if (!ctx) return;
    if (!this._music) this._music = new MusicEngine(ctx, this.master);
    this._music.start();
  }

  /** 停止背景音乐（fade 秒淡出）。 */
  stopMusic(fade = 1.5) {
    this._music?.stop(fade);
    this._music = null;
  }

  /** 暂停时音乐闪避（音量压低）。 */
  duckMusic(ducked) {
    this._music?.duck(ducked);
  }

  /* ---------------- 循环音：领域环境音 ---------------- */

  AMBIENT = {
    neutral: { type: 'lowpass', f0: 350, q: 0.6, gain: 0.045, lfoF: 0.13, lfoAmt: 120 },
    ice: { type: 'bandpass', f0: 1100, q: 1.4, gain: 0.05, lfoF: 0.3, lfoAmt: 500 },
    fire: { type: 'lowpass', f0: 260, q: 0.9, gain: 0.06, lfoF: 0.55, lfoAmt: 90 },
    storm: { type: 'bandpass', f0: 500, q: 0.7, gain: 0.055, lfoF: 0.4, lfoAmt: 320 }
  };

  /** 切换领域环境音：旧的 0.6 秒淡出，新的淡入。 */
  setRealm(id) {
    this.realm = this.AMBIENT[id] ? id : 'neutral';
    const ctx = this.ensure();
    if (!ctx) return;
    if (this._ambient && this._ambient.realm === this.realm) return;
    if (this._ambient) {
      const { src, g } = this._ambient;
      const t = ctx.currentTime;
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(Math.max(0.0001, g.gain.value), t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
      src.stop(t + 0.65);
      this._ambient = null;
    }
    this._startAmbient(this.realm);
  }

  _startAmbient(realmId) {
    const cfg = this.AMBIENT[realmId];
    if (!cfg || !this.ctx) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const flt = this.ctx.createBiquadFilter();
    flt.type = cfg.type;
    flt.frequency.value = cfg.f0;
    flt.Q.value = cfg.q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, this.ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(cfg.gain, this.ctx.currentTime + 1.2);
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = cfg.lfoF;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = cfg.lfoAmt;
    lfo.connect(lfoGain).connect(flt.frequency);
    src.connect(flt).connect(g).connect(this.master);
    src.start();
    lfo.start();
    this._ambient = { realm: realmId, src, g, lfo, lfoGain };
  }
}

export const audio = new AudioEngine();

/**
 * MusicEngine — 80 BPM 程序化 Chillhop 背景音乐。
 *
 * 按风格提示合成：慢速 boom-bap 鼓组（软底鼓 + 轻边击 + swing 摇摆）、
 * 温暖毛毡钢琴动机、模拟合成器 pad、sub-bass、带延迟回声的清音电吉他、
 * 柔和人声垫、磁带底噪。8 小节和声循环 Am9 → Fmaj7 → Cmaj7 → Gadd9
 * （忧郁→明亮），强度以 4 个 cycle 为周期：钢琴+贝斯 → 加 pad/鼓 →
 * 吉他旋律峰值 → 回落，首尾衔接无缝循环。
 */
class MusicEngine {
  constructor(ctx, dest) {
    const TAU = Math.PI * 2;
    this.ctx = ctx;
    this.BPM = 80;
    this.stepDur = 60 / this.BPM / 4; // 十六分音符 = 0.1875s
    this.swing = 0.032;               // 奇数十六分往后的摇摆量
    this.STEPS = 128;                 // 8 小节 × 16 步
    this.out = ctx.createGain();
    this.out.gain.value = 0.16;
    this.out.connect(dest);

    // 电吉他延迟总线（附点八分延迟 + 低通反馈，hall 感靠多级回声）
    this.delay = ctx.createDelay(2);
    this.delay.delayTime.value = this.stepDur * 6; // 附点八分
    this.dfb = ctx.createGain();
    this.dfb.gain.value = 0.42;
    this.dflt = ctx.createBiquadFilter();
    this.dflt.type = 'lowpass';
    this.dflt.frequency.value = 2100;
    this.delay.connect(this.dfb).connect(this.dflt).connect(this.delay);
    this.delay.connect(this.out);

    // 磁带底噪：极轻的带外噪声循环
    const hiss = ctx.createBufferSource();
    hiss.buffer = this._makeNoise();
    hiss.loop = true;
    const hf = ctx.createBiquadFilter();
    hf.type = 'bandpass';
    hf.frequency.value = 4200;
    hf.Q.value = 0.4;
    const hg = ctx.createGain();
    hg.gain.value = 0.006;
    hiss.connect(hf).connect(hg).connect(this.out);
    hiss.start();

    // 和声：8 小节 4 个和弦，每和弦 2 小节（32 步）
    //      Am9            Fmaj7             Cmaj7              Gadd9
    this.CHORDS = [
      { bass: 55.0, pad: [220.0, 261.63, 329.63, 493.88] },
      { bass: 43.65, pad: [174.61, 220.0, 261.63, 329.63] },
      { bass: 65.41, pad: [261.63, 329.63, 392.0, 493.88] },
      { bass: 49.0, pad: [196.0, 246.94, 293.66, 440.0] }
    ];

    // 毛毡钢琴动机（step: 循环内步位, n: 频率, d: 长度步数）
    this.PIANO = [
      { s: 0, n: 659.26, d: 2 }, { s: 6, n: 523.25, d: 2 }, { s: 10, n: 587.33, d: 2 }, { s: 14, n: 493.88, d: 2 },
      { s: 16, n: 440.0, d: 4 }, { s: 24, n: 392.0, d: 2 }, { s: 28, n: 440.0, d: 3 },
      { s: 32, n: 523.25, d: 2 }, { s: 38, n: 440.0, d: 2 }, { s: 42, n: 349.23, d: 4 },
      { s: 48, n: 392.0, d: 3 }, { s: 54, n: 440.0, d: 2 }, { s: 58, n: 523.25, d: 3 },
      { s: 64, n: 659.26, d: 2 }, { s: 70, n: 587.33, d: 2 }, { s: 74, n: 523.25, d: 2 }, { s: 78, n: 392.0, d: 2 },
      { s: 84, n: 329.63, d: 4 }, { s: 92, n: 392.0, d: 4 },
      { s: 96, n: 587.33, d: 2 }, { s: 102, n: 493.88, d: 2 }, { s: 106, n: 440.0, d: 2 }, { s: 110, n: 392.0, d: 2 },
      { s: 116, n: 440.0, d: 4 }, { s: 124, n: 493.88, d: 4 }
    ];

    // 吉他旋律（峰值 cycle 演奏，经延迟总线）
    this.GUITAR = [
      { s: 2, n: 659.26, d: 3 }, { s: 10, n: 783.99, d: 3 }, { s: 18, n: 659.26, d: 2 }, { s: 26, n: 523.25, d: 4 },
      { s: 34, n: 587.33, d: 3 }, { s: 44, n: 523.25, d: 3 }, { s: 52, n: 440.0, d: 4 },
      { s: 66, n: 783.99, d: 3 }, { s: 74, n: 659.26, d: 2 }, { s: 82, n: 587.33, d: 4 }, { s: 90, n: 523.25, d: 4 },
      { s: 98, n: 880.0, d: 4 }, { s: 106, n: 783.99, d: 3 }, { s: 114, n: 659.26, d: 3 }, { s: 122, n: 587.33, d: 4 }
    ];

    this.step = 0;
    this.cycle = 0; // 强度周期 0..3
    this.nextTime = 0;
    this.timer = null;
    this.ducked = false;
    this.stopping = false;
  }

  _makeNoise() {
    const len = Math.floor(this.ctx.sampleRate * 2);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  start() {
    if (this.timer) return;
    this.stopping = false;
    this.out.gain.cancelScheduledValues(this.ctx.currentTime);
    this.out.gain.setTargetAtTime(this.ducked ? 0.04 : 0.16, this.ctx.currentTime, 0.8);
    this.nextTime = this.ctx.currentTime + 0.15;
    this.timer = setInterval(() => this._tick(), 250);
  }

  stop(fade = 1.5) {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    const t = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setTargetAtTime(0.0001, t, fade / 3);
    const engine = this;
    setTimeout(() => engine.out.disconnect(), fade * 1000 + 400);
  }

  /** 暂停时压低音量（闪避），恢复时抬起。 */
  duck(ducked) {
    this.ducked = ducked;
    this.out.gain.setTargetAtTime(ducked ? 0.035 : 0.16, this.ctx.currentTime, 0.5);
  }

  _tick() {
    // 前瞻 1.5 秒排程（标签页后台 setInterval 被限流时也不掉拍）
    while (this.nextTime < this.ctx.currentTime + 1.5) {
      this._scheduleStep(this.step, this.cycle, this.nextTime);
      this.step++;
      if (this.step >= this.STEPS) {
        this.step = 0;
        this.cycle = (this.cycle + 1) % 4; // 强度周期循环
      }
      this.nextTime += this.stepDur;
    }
  }

  _scheduleStep(step, cycle, time) {
    const when = time + (step % 2 === 1 ? this.swing : 0); // swing 摇摆
    const chord = this.CHORDS[Math.floor(step / 32)];
    const inBar = step % 16;
    const drumOn = cycle >= 1 && !(cycle === 3 && step >= 96); // 峰值后回落段撤鼓

    // —— 鼓组：软底鼓（1、2拍后半、3拍）+ 安静边击（2、4拍） ——
    if (drumOn) {
      if (inBar === 0) this._kick(when);
      if (inBar === 7) this._kick(when, 0.8);
      if (inBar === 10) this._kick(when, 0.9);
      if (inBar === 4 || inBar === 12) this._rim(when);
    }

    // —— Sub-bass：每和弦根音长音 + 第 3 小节补一点 ——
    if (step % 32 === 0) this._bass(chord.bass, when, this.stepDur * 10);
    if (step % 32 === 20) this._bass(chord.bass * 2, when, this.stepDur * 3, 0.6);

    // —— 毛毡钢琴动机（贯穿所有 cycle） ——
    for (const note of this.PIANO) {
      if (note.s === step) this._piano(note.n, when, note.d * this.stepDur, cycle === 0 ? 0.16 : 0.13);
    }

    // —— 模拟合成器 pad（cycle≥1 铺满，cycle 0 半量） ——
    if (step % 32 === 0 && cycle >= 1) {
      const g = cycle === 0 ? 0.02 : cycle === 3 ? 0.03 : 0.042;
      for (const f of chord.pad) this._pad(f, when, this.stepDur * 30, g);
    }

    // —— 人声垫（峰值周期的和弦变换处，轻到几乎听不出来） ——
    if (cycle === 2 && step % 32 === 0) {
      for (const f of chord.pad.slice(1, 3)) this._voice(f, when, this.stepDur * 26);
    }

    // —— 清音电吉他旋律（峰值周期，经延迟总线） ——
    if (cycle >= 2) {
      for (const note of this.GUITAR) {
        if (note.s === step) this._guitar(note.n, when, note.d * this.stepDur, cycle === 2 ? 0.09 : 0.06);
      }
    }
  }

  /* —— 乐器音色 —— */

  _kick(when, vel = 1) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(120, when);
    o.frequency.exponentialRampToValueAtTime(42, when + 0.12);
    g.gain.setValueAtTime(0.5 * vel, when);
    g.gain.exponentialRampToValueAtTime(0.001, when + 0.22);
    o.connect(g).connect(this.out);
    o.start(when);
    o.stop(when + 0.25);
  }

  _rim(when) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this._makeNoise();
    const flt = ctx.createBiquadFilter();
    flt.type = 'bandpass';
    flt.frequency.value = 1900;
    flt.Q.value = 2.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.09, when);
    g.gain.exponentialRampToValueAtTime(0.001, when + 0.06);
    src.connect(flt).connect(g).connect(this.out);
    src.start(when, Math.random());
    src.stop(when + 0.08);
  }

  _bass(f, when, dur, vel = 1) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(0.17 * vel, when + 0.06);
    g.gain.setValueAtTime(0.17 * vel, when + dur - 0.1);
    g.gain.exponentialRampToValueAtTime(0.001, when + dur);
    o.connect(g).connect(this.out);
    o.start(when);
    o.stop(when + dur + 0.05);
  }

  /** 毛毡钢琴：柔和正弦 + 八度泛音，慢起音。 */
  _piano(f, when, dur, vel) {
    const ctx = this.ctx;
    for (const [mult, g0] of [[1, 1], [2, 0.22], [4, 0.05]]) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f * mult;
      const a = 0.02 * g0, peak = vel * g0;
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(peak, when + a);
      g.gain.exponentialRampToValueAtTime(0.001, when + dur + 0.3);
      o.connect(g).connect(this.out);
      o.start(when);
      o.stop(when + dur + 0.35);
    }
  }

  /** 暖 pad：低通三角波，极慢起音。 */
  _pad(f, when, dur, vel) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const flt = ctx.createBiquadFilter();
    flt.type = 'lowpass';
    flt.frequency.value = 900;
    const g = ctx.createGain();
    o.type = 'triangle';
    o.frequency.value = f;
    o.detune.value = (Math.random() - 0.5) * 8;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(vel, when + 1.4);
    g.gain.setValueAtTime(vel, when + dur - 1.2);
    g.gain.linearRampToValueAtTime(0.0001, when + dur);
    o.connect(flt).connect(g).connect(this.out);
    o.start(when);
    o.stop(when + dur + 0.1);
  }

  /** 人声垫：正弦 + 颤音（LFO 调制音高），像遥远的吟唱。 */
  _voice(f, when, dur) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.value = f * 2;
    const vib = ctx.createOscillator();
    vib.frequency.value = 5.2;
    const vibG = ctx.createGain();
    vibG.gain.value = 3.5;
    vib.connect(vibG).connect(o.detune);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(0.035, when + 1.6);
    g.gain.setValueAtTime(0.035, when + dur - 1.4);
    g.gain.linearRampToValueAtTime(0.0001, when + dur);
    o.connect(g).connect(this.out);
    o.start(when);
    vib.start(when);
    o.stop(when + dur + 0.1);
    vib.stop(when + dur + 0.1);
  }

  /** 清音电吉他：三角波拨弦 + 高频衰减，送入延迟总线产生回声。 */
  _guitar(f, when, dur, vel) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const flt = ctx.createBiquadFilter();
    const g = ctx.createGain();
    o.type = 'triangle';
    o.frequency.value = f;
    flt.type = 'lowpass';
    flt.frequency.setValueAtTime(3400, when);
    flt.frequency.exponentialRampToValueAtTime(1100, when + dur + 0.4);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(vel, when + 0.008);
    g.gain.exponentialRampToValueAtTime(0.001, when + dur + 0.5);
    o.connect(flt).connect(g);
    g.connect(this.out);
    g.connect(this.delay);
    o.start(when);
    o.stop(when + dur + 0.55);
  }
}
