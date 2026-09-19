/**
 * audio.js — 「命运回响」音频引擎（Web Audio API，零外部素材）。
 *
 * v2 全面重做：从「小游戏合成音」升级为中世纪奇幻史诗质感。
 *
 *  母线结构（关键的高级感来源）：
 *   voice → dry  ──────────────┐
 *   voice → wet → 大教堂混响 ──┤→ 混音总线 → 压缩器 → 主输出
 *  混响 IR 由程序生成（3.8s 指数衰减 + 低通塑形 + 早期反射），一切声音
 *  都置身同一座大理石圣殿，音效因此拥有空间、重量与余韵。
 *
 *  背景音乐：66 BPM · D 小调史诗管弦（程序化）——
 *   持续低音 drone / 修道院圣咏垫（共振峰滤波）/ 弦乐八分律动 /
 *   战争鼓组（太鼓式 boom + 汤姆鼓滚奏）/ 铜管涌潮 / 命运钟声 /
 *   竖琴点缀 / Braam 号角撞击 / 渐强 riser。
 *   和声 i–VI–III–VII（Dm–Bb–F–C），4 个强度周期演进：
 *   序·命运低语 → 行军 → 决战 → 余烬，首尾衔接无缝循环。
 *
 *  AudioContext 惰性创建：必须在用户手势（点击开始/按下鼠标）里 ensure()，
 *  否则浏览器自动播放策略会挂起。
 */

/** MIDI 音符号 → 频率。 */
const nf = (m) => 440 * Math.pow(2, (m - 69) / 12);
/** a~b 间随机数。 */
const rand = (a, b) => a + Math.random() * (b - a);

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noiseBuf = null;
    this.realm = 'neutral';
    this._ambient = null;
    this._music = null;
    this._bank = {};        // 已解码裁剪的采样缓冲
    this._loopBufs = {};    // 环境循环缓冲（整段保留）
    this._bankLoading = null;
    /* 测试钩子：可注入 OfflineAudioContext 做离线渲染检查。 */
    this._ctxFactory = null;
  }

  /** 在用户手势里调用：创建/恢复 AudioContext。失败则整个引擎静默禁用。 */
  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC && !this._ctxFactory) return null;
      try {
        this.ctx = this._ctxFactory ? this._ctxFactory() : new AC();
      } catch {
        return null;
      }
      this._buildMasterChain();
      const len = Math.floor(this.ctx.sampleRate * 2);
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      this._startAmbient(this.realm);
    }
    if (this.ctx.state === 'suspended' && this.ctx.resume) {
      const p = this.ctx.resume();
      if (p && p.catch) p.catch(() => { /* OfflineAudioContext 不可 resume，忽略 */ });
    }
    return this.ctx;
  }

  /** 母线：混音总线 → 压缩器（黏合与响度）→ 主输出；大教堂混响作为湿声总线。 */
  _buildMasterChain() {
    const ctx = this.ctx;

    this.mix = ctx.createGain();
    this.mix.gain.value = 1;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 22;
    comp.ratio.value = 2.5;
    comp.attack.value = 0.006;
    comp.release.value = 0.3;

    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    // 末端安全限制器：尖锐瞬态叠加溜过压缩器时兜底防爆音
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 2;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.08;
    this.mix.connect(comp).connect(this.master).connect(limiter).connect(ctx.destination);

    // 大教堂混响：程序生成 IR（暗色长尾 + 早期反射）
    this.verb = ctx.createConvolver();
    this.verb.buffer = this._buildIR();
    this.verbReturn = ctx.createGain();
    this.verbReturn.gain.value = 1.0;
    this.verb.connect(this.verbReturn).connect(this.mix);

    // 音效总线（干声 + 湿声发送）
    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = 1;
    this.sfxBus.connect(this.mix);
    this.sfxSend = ctx.createGain();
    this.sfxSend.gain.value = 0.34;
    this.sfxSend.connect(this.verb);

    // 重击总线：普攻命中 / 三系技能落地等大冲击专用。
    // 独立快攻击压缩器把这些瞬间"钉"在一起——听感更猛、更有体重。
    this.punch = ctx.createGain();
    this.punch.gain.value = 1;
    const punchComp = ctx.createDynamicsCompressor();
    punchComp.threshold.value = -18;
    punchComp.knee.value = 10;
    punchComp.ratio.value = 5;
    punchComp.attack.value = 0.002;
    punchComp.release.value = 0.1;
    this.punch.connect(punchComp).connect(this.mix);

    // 音乐总线（音乐引擎自管干湿比例，统一经 musicBus 汇入）
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = 1;
    this.musicBus.connect(this.mix);
  }

  /** 生成大教堂脉冲响应：立体声、指数衰减、单极低通塑形、离散早期反射。 */
  _buildIR() {
    const ctx = this.ctx;
    const sr = ctx.sampleRate;
    const dur = 3.8;
    const len = Math.floor(sr * dur);
    const buf = ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        const fadeIn = Math.min(1, i / (sr * 0.02)); // 20ms 起振（预延迟感）
        const env = Math.pow(1 - t, 2.4) * fadeIn;
        const n = Math.random() * 2 - 1;
        lp += 0.42 * (n - lp); // 单极低通 ≈ 4kHz，暗色温暖的厅堂尾音
        d[i] = lp * env;
      }
      // 早期反射：几组离散拍点，营造石墙尺度
      const taps = [0.011, 0.019, 0.028, 0.041, 0.058, 0.077];
      const gains = [0.55, 0.44, 0.36, 0.29, 0.22, 0.16];
      for (let k = 0; k < taps.length; k++) {
        const idx = Math.floor(taps[k] * sr) + (ch ? 37 : 0);
        if (idx < len) d[idx] += gains[k] * (k % 2 ? -1 : 1);
      }
    }
    // 归一化到保守峰值，湿声比例交给 send 增益控制
    let peak = 0;
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(d[i]));
    }
    const g = 0.4 / peak;
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] *= g;
    }
    return buf;
  }

  /* ---------------- 合成原语（带混响发送） ---------------- */

  /** tanh 饱和曲线：k 越大越猛（2 轻微胶水感，4+ 明显的轰鸣颗粒）。 */
  _driveCurve(k) {
    const n = 1024;
    const curve = new Float32Array(n);
    const norm = Math.tanh(k);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * k) / norm;
    }
    return curve;
  }

  /**
   * 振荡器扫频：f0 → f1，指数包络。
   * wet: 0~1 混响发送量；drive > 1 时经 tanh 饱和（失真增重）；
   * heavy: true 时改走重击总线（独立压缩器钉住大冲击）。
   */
  tone({ type = 'sine', f0 = 440, f1 = f0, dur = 0.2, gain = 0.3, attack = 0.005, when = 0, wet = 0.25, detune = 0, glide = false, drive = 0, heavy = false }) {
    const ctx = this.ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime + when;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.detune.value = detune;
    osc.frequency.setValueAtTime(Math.max(1, f0), t0);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    if (drive > 1) {
      const sh = ctx.createWaveShaper();
      sh.curve = this._driveCurve(drive);
      sh.oversample = '2x';
      osc.connect(sh).connect(g);
    } else {
      osc.connect(g);
    }
    g.connect(heavy ? this.punch : this.sfxBus);
    if (wet > 0) {
      const w = ctx.createGain();
      w.gain.value = wet;
      g.connect(w).connect(this.sfxSend);
    }
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  /** 噪声突发：滤波器 f0 → f1 扫频 + 指数包络。 */
  noise({ dur = 0.3, gain = 0.3, type = 'lowpass', f0 = 1000, f1 = f0, q = 1, attack = 0.005, when = 0, wet = 0.25, heavy = false }) {
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
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(flt).connect(g);
    g.connect(heavy ? this.punch : this.sfxBus);
    if (wet > 0) {
      const w = ctx.createGain();
      w.gain.value = wet;
      g.connect(w).connect(this.sfxSend);
    }
    src.start(t0, Math.random());
    src.stop(t0 + dur + 0.05);
  }

  /** 线性包络噪声（用于 riser / swell 这类渐强）。 */
  swell({ dur = 2, gain = 0.1, type = 'bandpass', f0 = 400, f1 = 3500, q = 1, when = 0, wet = 0.4 }) {
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
    g.gain.linearRampToValueAtTime(gain, t0 + dur * 0.92);
    g.gain.linearRampToValueAtTime(0.0001, t0 + dur);
    src.connect(flt).connect(g);
    g.connect(this.sfxBus);
    if (wet > 0) {
      const w = ctx.createGain();
      w.gain.value = wet;
      g.connect(w).connect(this.sfxSend);
    }
    src.start(t0, Math.random());
    src.stop(t0 + dur + 0.05);
  }

  /** 非谐金属/钟磬：分音比 [1, 2.32, 3.01, 4.27, 5.63]，铁器撞击与钟声共用。 */
  metal(f, when, dur, gain, wet = 0.4, ratios = [1, 2.32, 3.01, 4.27, 5.63], vgains = [1, 0.55, 0.4, 0.26, 0.16]) {
    ratios.forEach((r, i) => {
      if (f * r > 12000) return;
      this.tone({
        type: 'sine', f0: f * r, f1: f * r * 0.995,
        dur: dur * [1, 0.72, 0.55, 0.4, 0.28][i],
        gain: gain * vgains[i], attack: 0.004, when, wet
      });
    });
  }

  /* ---------------- 真实采样库（Mixkit 免费许可） ----------------
   * 普攻与技能的"魔法质感"来自真实录制的法术音效；每个样本按能量包络
   * 预裁剪（取主冲击段 + 淡出长尾）。加载失败时所有音效自动回退纯合成。
   * 程序化亚低频层始终保留——采样给质感，合成给体重。 */
  SFX_BANK = {
    shoot:    { file: 'shoot-a',   start: 0.86, dur: 0.9,  fade: 0.28 }, // 从辉光爆点起（跳过死寂）
    shootB:   { file: 'shoot-b',   start: 1.58, dur: 1.0,  fade: 0.3 },  // 从能量击点起（跳过风声渐起）
    hit:      { file: 'hit',       start: 0.0,  dur: 1.1,  fade: 0.35 },
    castA:    { file: 'cast-a',    start: 1.0,  dur: 2.0,  fade: 0.5 },
    castB:    { file: 'cast-b',    start: 1.7,  dur: 2.2,  fade: 0.6 },
    fireCast: { file: 'cast-fire', start: 0.0,  dur: 3.2,  fade: 0.6 },
    fireHit:  { file: 'fire',      start: 0.0,  dur: 3.6,  fade: 0.7 },
    storm:    { file: 'storm',     start: 0.1,  dur: 5.0,  fade: 1.2 },
    ice:      { file: 'ice',       start: 0.0,  dur: 1.44, fade: 0.3 },
    wind:     { file: 'wind',      start: 3.6,  dur: 4.0,  fade: 0.8 },
    pillar:   { file: 'pillar',    start: 0.42, dur: 3.0,  fade: 0.8 }    // Strong close thunder explosion
  };

  /** 页面加载早期调用：抓取并解码全部样本（裁剪成短缓冲）+ 环境循环素材。 */
  loadBank() {
    const ctx = this.ensure();
    if (!ctx || this._bankLoading) return this._bankLoading || Promise.resolve();
    this._bankLoading = Promise.all([
      // 短样本：按能量包络裁剪
      ...Object.entries(this.SFX_BANK).map(async ([name, cfg]) => {
        try {
          const res = await fetch(`sfx/${cfg.file}.mp3`);
          if (!res.ok) throw new Error(res.status);
          const decoded = await ctx.decodeAudioData(await res.arrayBuffer());
          this._bank[name] = this._trimSample(decoded, cfg);
        } catch { /* 单个样本失败：该音效回退纯合成 */ }
      }),
      // 环境循环：整段保留（雷领域雨声）
      ...Object.entries(this.AMBIENT_LOOPS).map(async ([name, file]) => {
        try {
          const res = await fetch(`sfx/${file}`);
          if (!res.ok) throw new Error(res.status);
          this._loopBufs[name] = await ctx.decodeAudioData(await res.arrayBuffer());
        } catch { /* 循环缺失：该领域只有合成环境音 */ }
      })
    ]);
    return this._bankLoading;
  }

  /** 裁剪出主冲击段并做淡入（6ms 防爆音）与淡出。 */
  _trimSample(src, { start, dur, fade }) {
    const sr = src.sampleRate;
    const s0 = Math.min(Math.floor(start * sr), Math.max(0, src.length - 1));
    const len = Math.min(Math.floor(dur * sr), src.length - s0);
    const out = this.ctx.createBuffer(2, len, sr);
    const fadeOut = Math.min(Math.floor(fade * sr), len >> 1);
    const fadeIn = Math.min(Math.floor(0.006 * sr), len >> 2);
    for (let ch = 0; ch < 2; ch++) {
      const sd = src.getChannelData(Math.min(ch, src.numberOfChannels - 1));
      const dd = out.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        let g = 1;
        if (i < fadeIn) g *= i / fadeIn;
        if (i > len - fadeOut) g *= Math.max(0, (len - i) / fadeOut);
        dd[i] = sd[s0 + i] * g;
      }
    }
    return out;
  }

  /**
   * 播放采样。返回 false 表示库未加载（调用方回退纯合成）。
   * rate 做随机音高变化，让同一音效每次发声都不同。
   */
  sample(name, { gain = 1, when = 0, wet = 0.35, heavy = false, rate = 1 } = {}) {
    const ctx = this.ensure();
    if (!ctx || !this._bank || !this._bank[name]) return false;
    const t0 = ctx.currentTime + when;
    const src = ctx.createBufferSource();
    src.buffer = this._bank[name];
    src.playbackRate.value = Math.max(0.5, rate);
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g);
    g.connect(heavy ? this.punch : this.sfxBus);
    if (wet > 0) {
      const w = ctx.createGain();
      w.gain.value = wet;
      g.connect(w).connect(this.sfxSend);
    }
    src.start(t0);
    return true;
  }

  /* ---------------- 一次性音效（真实采样 + 程序化加固） ---------------- */

  /** 开始游戏：圣殿封印开启——石质闷响 + 研磨 + 高频微光。 */
  click() {
    this.tone({ type: 'sine', f0: 130, f1: 56, dur: 0.22, gain: 0.34, wet: 0.3 });
    this.noise({ dur: 0.28, gain: 0.12, type: 'lowpass', f0: 950, f1: 260, wet: 0.3 });
    this.noise({ dur: 0.04, gain: 0.06, type: 'highpass', f0: 2400 });
    this.metal(1174.7, 0.03, 0.7, 0.045, 0.5);
  }

  /** 返回初始界面：下行柔和拨响 + 低频落地。 */
  clickBack() {
    this.tone({ type: 'triangle', f0: 392, f1: 196, dur: 0.22, gain: 0.16, wet: 0.35 });
    this.tone({ type: 'sine', f0: 98, f1: 62, dur: 0.2, gain: 0.2, wet: 0.25, when: 0.02 });
  }

  /** Esc 暂停：暗色圣咏双音下行（音乐同时闪避）。 */
  pause() {
    this.tone({ type: 'triangle', f0: 293.66, dur: 0.5, gain: 0.1, attack: 0.02, wet: 0.5 });
    this.tone({ type: 'triangle', f0: 220, dur: 0.7, gain: 0.1, attack: 0.02, when: 0.16, wet: 0.5 });
    this.duckMusic(true);
  }

  /** 恢复继续：圣咏双音上行（音乐解除闪避）。 */
  unpause() {
    this.tone({ type: 'triangle', f0: 220, dur: 0.4, gain: 0.1, attack: 0.02, wet: 0.5 });
    this.tone({ type: 'triangle', f0: 293.66, dur: 0.7, gain: 0.11, attack: 0.02, when: 0.14, wet: 0.5 });
    this.tone({ type: 'sine', f0: 587.33, dur: 0.6, gain: 0.04, attack: 0.02, when: 0.14, wet: 0.5 });
    this.duckMusic(false);
  }

  /** 普通攻击：出膛瞬态（发射感）+ 真实辉光弹尾音（随机采样 + 音高变化）。 */
  shoot() {
    const v = 0.9 + Math.random() * 0.24;
    // —— 出膛瞬态：能量弹离开法杖的瞬间（不发闷、不拖沓） ——
    this.tone({ type: 'sine', f0: 240 * v, f1: 1150 * v, dur: 0.07, gain: 0.1, wet: 0.15 }); // 上行弹射
    this.noise({ dur: 0.03, gain: 0.07, type: 'highpass', f0: 2600 });                        // 气爆
    this.tone({ type: 'sine', f0: 185, f1: 64, dur: 0.11, gain: 0.13, wet: 0.2 });           // 低频推背
    // —— 辉光弹尾音：真实采样从爆点起播（已跳过风声前奏） ——
    if (this.sample(Math.random() < 0.5 ? 'shoot' : 'shootB', { gain: 0.5, rate: v, wet: 0.3, when: 0.02 })) return;
    // 回退：纯合成弹芯
    this.tone({ type: 'sawtooth', f0: 1350 * v, f1: 185 * v, dur: 0.17, gain: 0.15, drive: 3.2, wet: 0.25 });
    this.noise({ dur: 0.15, gain: 0.12, type: 'bandpass', f0: 3000 * v, f1: 600, q: 1.2, wet: 0.3 });
  }

  /** 普通攻击命中：真实魔法撞击 + 亚低频坠底（打进地里的重量）。 */
  hit() {
    const v = 0.92 + Math.random() * 0.16;
    if (this.sample('hit', { gain: 0.55, rate: v, wet: 0.32, heavy: true })) {
      this.tone({ type: 'sine', f0: 170 * v, f1: 46, dur: 0.26, gain: 0.28, wet: 0.28, heavy: true });
      return;
    }
    // 回退：纯合成
    this.tone({ type: 'sine', f0: 170 * v, f1: 46, dur: 0.26, gain: 0.36, wet: 0.28, heavy: true });
    this.tone({ type: 'sawtooth', f0: 470 * v, f1: 88, dur: 0.19, gain: 0.19, drive: 3.6, wet: 0.28, heavy: true });
    this.noise({ dur: 0.19, gain: 0.21, type: 'lowpass', f0: 2100, f1: 210, wet: 0.3, heavy: true });
    this.noise({ dur: 0.03, gain: 0.09, type: 'highpass', f0: 3600 });
    this.metal(2300, 0.01, 0.14, 0.035, 0.4);
  }

  /** 技能释放（Q/E/R 出手瞬间）：真实法术 whoosh，各系不同气质。 */
  spellCast(kind) {
    if (!this.ensure()) return;
    let ok = false;
    if (kind === 'fire') {
      // 燃烧的施法呼啸
      ok = this.sample('fireCast', { gain: 0.45, rate: rand(0.95, 1.05), wet: 0.45 });
    } else if (kind === 'ice') {
      // 寒风骤起 + 奥术 whoosh
      ok = this.sample('wind', { gain: 0.28, rate: rand(1.1, 1.25), wet: 0.4 });
      this.sample('castA', { gain: 0.28, rate: rand(1.05, 1.18), wet: 0.5 });
      ok = ok || this._bank && this._bank.castA;
    } else {
      // 天雷聚合：疾风 whoosh
      ok = this.sample('castB', { gain: 0.42, rate: rand(0.98, 1.1), wet: 0.45 });
    }
    if (ok) return;
    // 回退：程序化上行 whoosh
    this.tone({ type: 'sawtooth', f0: 220, f1: 660, dur: 0.3, gain: 0.06, attack: 0.06, wet: 0.4 });
    this.noise({ dur: 0.35, gain: 0.09, type: 'bandpass', f0: 600, f1: 2600, q: 1.2, wet: 0.4 });
  }

  /** 普攻命中特殊之灵未破：黑铁圣物匣的厚重铁鸣。 */
  specialHit() {
    const v = 0.94 + Math.random() * 0.12;
    this.metal(590 * v, 0, 0.42, 0.14, 0.45);
    this.noise({ dur: 0.06, gain: 0.12, type: 'highpass', f0: 2600, wet: 0.3 });
    this.tone({ type: 'sine', f0: 95, f1: 52, dur: 0.16, gain: 0.2, wet: 0.25 });
  }

  /** 普攻打在属性不符的特殊之灵上：被石壁弹开的钝声。 */
  deflect() {
    this.tone({ type: 'sine', f0: 245, f1: 168, dur: 0.1, gain: 0.1, wet: 0.3 });
    this.noise({ dur: 0.08, gain: 0.05, type: 'bandpass', f0: 760, q: 2, wet: 0.3 });
  }

  /** 光柱预警：0.5 秒圣咏式上行（神罚将至的低语），带颤音。 */
  pillarWarn() {
    this.tone({ type: 'sawtooth', f0: 220, f1: 293.66, dur: 0.5, gain: 0.07, attack: 0.09, wet: 0.5 });
    this.tone({ type: 'sine', f0: 440, f1: 587.33, dur: 0.5, gain: 0.04, attack: 0.09, wet: 0.5 });
    this.noise({ dur: 0.5, gain: 0.05, type: 'bandpass', f0: 700, f1: 2200, q: 1.4, wet: 0.5 });
  }

  /** 光柱落下：神罚轰击——真实雷爆采样 + 失真重锤 + 亚低频大坑（打击感拉满）。 */
  pillarStrike() {
    // 真实雷爆（Strong close thunder explosion，从雷击点起播）
    const ok = this.sample('pillar', { gain: 0.7, rate: rand(0.96, 1.04), wet: 0.5, heavy: true });
    // 程序化重锤：亚低频大坑 + 失真爆心 + 裂地瞬态，保证打击感
    this.tone({ type: 'sine', f0: 120, f1: 30, dur: 0.9, gain: 0.4, attack: 0.006, wet: 0.45, heavy: true });
    this.tone({ type: 'sawtooth', f0: 420, f1: 58, dur: 0.4, gain: 0.16, drive: 4.0, wet: 0.4, heavy: true });
    this.noise({ dur: 0.09, gain: 0.24, type: 'highpass', f0: 1800, wet: 0.4, heavy: true });
    if (ok) return;
    this.noise({ dur: 1.5, gain: 0.2, type: 'lowpass', f0: 1900, f1: 110, wet: 0.55 });
    this.metal(1244.5, 0.02, 0.9, 0.035, 0.6);
  }

  /** 特殊之灵激光蓄能：1 秒危险充能——低鸣上爬 + 加速脉冲嘀嗒 + 高频颤鸣（清晰可闻）。 */
  laserCharge() {
    // 低频危险上爬
    this.tone({ type: 'sawtooth', f0: 175, f1: 620, dur: 1.0, gain: 0.16, attack: 0.12, wet: 0.4, heavy: true });
    this.tone({ type: 'sine', f0: 68, f1: 128, dur: 1.0, gain: 0.13, attack: 0.1, wet: 0.35, heavy: true });
    // 加速嘀嗒：0 / 0.3 / 0.55 / 0.75 / 0.9s，音调逐级抬高（经典蓄力提示）
    [0, 0.3, 0.55, 0.75, 0.9].forEach((t, i) =>
      this.tone({ type: 'sine', f0: 620 + i * 260, dur: 0.06, gain: 0.1, when: t, wet: 0.35 }));
    // 高频颤鸣
    this.tone({ type: 'sine', f0: 1200, f1: 2700, dur: 1.0, gain: 0.055, attack: 0.25, wet: 0.4 });
    this.noise({ dur: 1.0, gain: 0.055, type: 'bandpass', f0: 900, f1: 2600, q: 2.2, wet: 0.4 });
  }

  /** 特殊之灵激光射击：灼灼焚穿——亮劈 + 失真电锯坠 + 低频重补底（威胁感拉满）。 */
  laserFire() {
    this.noise({ dur: 0.06, gain: 0.24, type: 'highpass', f0: 4200, wet: 0.35, heavy: true });
    this.tone({ type: 'sawtooth', f0: 1500, f1: 175, dur: 0.28, gain: 0.24, drive: 3.4, wet: 0.35, heavy: true });
    this.tone({ type: 'square', f0: 340, f1: 60, dur: 0.22, gain: 0.12, drive: 2.6, wet: 0.3 });
    this.noise({ dur: 0.2, gain: 0.12, type: 'bandpass', f0: 3400, f1: 900, q: 1.4, wet: 0.35 });
    this.tone({ type: 'sine', f0: 130, f1: 42, dur: 0.34, gain: 0.32, when: 0.02, wet: 0.35, heavy: true });
  }

  /** 角色受击：重钝 + 护甲哗啦 + 不协和刺痛音程（小二度）。 */
  hurt() {
    this.tone({ type: 'sine', f0: 150, f1: 52, dur: 0.3, gain: 0.32, wet: 0.3 });
    this.noise({ dur: 0.22, gain: 0.16, type: 'lowpass', f0: 760, f1: 160, wet: 0.3 });
    this.tone({ type: 'triangle', f0: 233.08, dur: 0.3, gain: 0.07, when: 0.02, wet: 0.45 });
    this.tone({ type: 'triangle', f0: 220, dur: 0.3, gain: 0.07, when: 0.02, wet: 0.45 });
  }

  /** 风系护盾展开：真实风暴风声 + 空灵五度和音（D5+A5 颤音微光）。 */
  shield() {
    this.sample('wind', { gain: 0.4, rate: rand(1.15, 1.3), wet: 0.4 });
    this.noise({ dur: 0.45, gain: 0.13, type: 'bandpass', f0: 500, f1: 2600, q: 1.1, wet: 0.4 });
    this.tone({ type: 'sine', f0: 587.33, dur: 0.7, gain: 0.07, attack: 0.08, wet: 0.5 });
    this.tone({ type: 'sine', f0: 880, dur: 0.7, gain: 0.05, attack: 0.1, wet: 0.5 });
    this.tone({ type: 'triangle', f0: 146.83, dur: 0.5, gain: 0.07, attack: 0.04, wet: 0.4 });
  }

  /** 技能切换：符文拨动——石质轻叩 + 微弱钟磬。 */
  switch() {
    this.tone({ type: 'sine', f0: 195, f1: 128, dur: 0.07, gain: 0.16, wet: 0.2 });
    this.noise({ dur: 0.03, gain: 0.05, type: 'highpass', f0: 2000 });
    this.metal(2349, 0.015, 0.3, 0.02, 0.35);
  }

  /** 技能冷却完毕：一声清越钟磬（克制的贵族式提示）。 */
  cdReady() {
    this.metal(880, 0, 0.8, 0.06, 0.5);
    this.tone({ type: 'sine', f0: 1760, dur: 0.3, gain: 0.025, when: 0.01, wet: 0.5 });
  }

  /** 按住右键瞄准期间的节拍提示：极轻的木质节拍器。 */
  aimPulse() {
    this.tone({ type: 'sine', f0: 1175, dur: 0.035, gain: 0.045, wet: 0.12 });
  }

  /** 等级提升：铜管号角齐鸣三连上行 + 圣咏支撑——命运前进的时刻。 */
  levelUp() {
    const seq = [146.83, 174.61, 220]; // D3 F3 A3
    seq.forEach((f, i) => {
      this.tone({ type: 'sawtooth', f0: f * 0.97, f1: f, dur: 0.16, gain: 0.11, attack: 0.02, when: i * 0.1, wet: 0.4 });
      this.tone({ type: 'sawtooth', f0: f * 0.97 * 1.006, f1: f * 1.006, dur: 0.16, gain: 0.08, attack: 0.02, when: i * 0.1, wet: 0.4 });
    });
    // 落在 D4 长号 + 五度支撑
    this.tone({ type: 'sawtooth', f0: 290, f1: 293.66, dur: 0.9, gain: 0.12, attack: 0.03, when: 0.3, wet: 0.45 });
    this.tone({ type: 'sawtooth', f0: 436, f1: 440, dur: 0.9, gain: 0.08, attack: 0.03, when: 0.3, wet: 0.45 });
    this.tone({ type: 'sine', f0: 146.83, dur: 0.9, gain: 0.12, attack: 0.03, when: 0.3, wet: 0.4 });
    this.noise({ dur: 0.5, gain: 0.05, type: 'highpass', f0: 5200, when: 0.3, wet: 0.55 });
  }

  /** 生命恢复：竖琴上行滑奏 + 温暖圣咏微光。 */
  heal() {
    [587.33, 659.26, 698.46, 880, 1174.66].forEach((f, i) =>
      this.tone({ type: 'triangle', f0: f, dur: 0.5, gain: 0.06, attack: 0.004, when: i * 0.055, wet: 0.5 }));
    this.tone({ type: 'triangle', f0: 293.66, dur: 0.8, gain: 0.05, attack: 0.12, when: 0.1, wet: 0.55 });
  }

  /** 体力耗尽：一口气泄掉——气声下滑 + 疲软坠音。 */
  staminaOut() {
    this.noise({ dur: 0.6, gain: 0.07, type: 'bandpass', f0: 950, f1: 240, q: 1.2, wet: 0.3 });
    this.tone({ type: 'triangle', f0: 330, f1: 158, dur: 0.5, gain: 0.07, attack: 0.03, wet: 0.35 });
  }

  /** 特殊元素之灵被击败：圣物匣崩解——失真崩心 + 晶片迸散 + 圣咏绽放 + 亚低频落定。 */
  specialKill() {
    this.tone({ type: 'sine', f0: 125, f1: 40, dur: 0.55, gain: 0.34, wet: 0.35, heavy: true });
    this.tone({ type: 'sawtooth', f0: 520, f1: 95, dur: 0.24, gain: 0.14, drive: 3.4, wet: 0.35, heavy: true });
    this.noise({ dur: 0.35, gain: 0.17, type: 'highpass', f0: 3000, wet: 0.45 });
    const shards = [1568, 1975.5, 2349, 2793, 3322];
    shards.forEach((f, i) =>
      this.tone({ type: 'sine', f0: f * rand(0.98, 1.02), dur: rand(0.25, 0.4), gain: 0.06, when: 0.05 + i * 0.035, wet: 0.55 }));
    this.tone({ type: 'triangle', f0: 293.66, dur: 1.3, gain: 0.055, attack: 0.15, when: 0.1, wet: 0.6 });
    this.tone({ type: 'triangle', f0: 440, dur: 1.3, gain: 0.04, attack: 0.2, when: 0.1, wet: 0.6 });
  }

  /** 角色被击败：黑暗 Braam + 圣咏下行安魂 + 远处丧钟。 */
  death() {
    // Braam：低音号角群（微降音头）
    [36.71, 73.42, 110].forEach((f, i) =>
      this.tone({ type: 'sawtooth', f0: f * 0.96, f1: f, dur: 2.6, gain: 0.075, attack: 0.25, when: i * 0.02, wet: 0.55 }));
    this.tone({ type: 'sine', f0: 36.71, dur: 2.8, gain: 0.16, attack: 0.2, wet: 0.45 });
    // 圣咏下行：D4 → C4 → Bb3 → A3
    [293.66, 261.63, 233.08, 220].forEach((f, i) => {
      this.tone({ type: 'sawtooth', f0: f, dur: 0.85, gain: 0.05, attack: 0.15, when: 0.35 + i * 0.5, wet: 0.6 });
      this.tone({ type: 'sine', f0: f * 2, dur: 0.7, gain: 0.02, attack: 0.15, when: 0.35 + i * 0.5, wet: 0.6 });
    });
    this.metal(146.83, 1.6, 2.4, 0.05, 0.65, [1, 2.4, 3.9, 5.4], [1, 0.5, 0.3, 0.2]);
    this.noise({ dur: 3.2, gain: 0.06, type: 'lowpass', f0: 700, f1: 70, when: 0.3, wet: 0.5 });
  }

  /** 三系技能落地打击：真实采样（冰碎/火爆/惊雷）+ 程序化亚低频重量。 */
  impact(kind) {
    if (kind === 'ice') {
      if (this.sample('ice', { gain: 0.6, rate: rand(0.9, 1.1), wet: 0.5, heavy: true })) {
        this.tone({ type: 'sine', f0: 120, f1: 34, dur: 0.5, gain: 0.3, wet: 0.35, heavy: true });
        const crystalline = [1568, 2093, 2637, 3136, 3951];
        crystalline.forEach((f, i) =>
          this.tone({ type: 'sine', f0: f * rand(0.97, 1.03), f1: f * 0.9, dur: rand(0.2, 0.35), gain: 0.045, when: 0.02 + i * 0.03, wet: 0.55 }));
        this.noise({ dur: 0.5, gain: 0.09, type: 'bandpass', f0: 5800, f1: 1700, q: 1.2, wet: 0.5 });
        return;
      }
      // 回退：纯合成
      this.tone({ type: 'sine', f0: 120, f1: 34, dur: 0.5, gain: 0.32, wet: 0.35, heavy: true });
      this.tone({ type: 'sawtooth', f0: 380, f1: 95, dur: 0.3, gain: 0.12, drive: 3.4, wet: 0.35, heavy: true });
      this.noise({ dur: 0.11, gain: 0.26, type: 'highpass', f0: 3400, wet: 0.4, heavy: true });
      const crystalline = [1568, 2093, 2637, 3136, 3951, 4699];
      crystalline.forEach((f, i) =>
        this.tone({ type: 'sine', f0: f * rand(0.97, 1.03), f1: f * 0.9, dur: rand(0.2, 0.35), gain: 0.06, when: 0.02 + i * 0.03, wet: 0.55 }));
      this.noise({ dur: 0.55, gain: 0.13, type: 'bandpass', f0: 5800, f1: 1700, q: 1.2, wet: 0.5 });
    } else if (kind === 'fire') {
      if (this.sample('fireHit', { gain: 0.62, rate: rand(0.93, 1.05), wet: 0.5, heavy: true })) {
        this.tone({ type: 'sine', f0: 150, f1: 30, dur: 0.95, gain: 0.4, attack: 0.005, wet: 0.4, heavy: true });
        this.noise({ dur: 0.09, gain: 0.16, type: 'bandpass', f0: 2800, q: 0.7, wet: 0.4, heavy: true });
        return;
      }
      this.tone({ type: 'sine', f0: 150, f1: 30, dur: 0.95, gain: 0.5, attack: 0.005, wet: 0.4, heavy: true });
      this.tone({ type: 'sawtooth', f0: 320, f1: 52, dur: 0.5, gain: 0.26, drive: 4.2, wet: 0.4, heavy: true });
      this.noise({ dur: 0.09, gain: 0.26, type: 'bandpass', f0: 2800, q: 0.7, wet: 0.4, heavy: true });
      this.noise({ dur: 1.5, gain: 0.28, type: 'lowpass', f0: 1700, f1: 130, wet: 0.5 });
    } else {
      if (this.sample('storm', { gain: 0.62, rate: rand(0.95, 1.05), wet: 0.5, heavy: true })) {
        this.noise({ dur: 0.05, gain: 0.26, type: 'highpass', f0: 4600, wet: 0.4, heavy: true });
        this.tone({ type: 'sine', f0: 95, f1: 32, dur: 0.85, gain: 0.26, wet: 0.4, heavy: true });
        return;
      }
      this.noise({ dur: 0.05, gain: 0.34, type: 'highpass', f0: 4600, wet: 0.4, heavy: true });
      this.tone({ type: 'square', f0: 190, f1: 52, dur: 0.24, gain: 0.12, drive: 3.0, wet: 0.3 });
      this.tone({ type: 'sine', f0: 95, f1: 32, dur: 0.85, gain: 0.3, wet: 0.4, heavy: true });
      this.noise({ dur: 2.2, gain: 0.26, type: 'lowpass', f0: 560, f1: 52, q: 0.7, when: 0.03, wet: 0.55 });
      this.noise({ dur: 1.0, gain: 0.11, type: 'lowpass', f0: 320, f1: 85, when: 0.55, wet: 0.55 });
    }
  }

  /* ---------------- 背景音乐（史诗管弦引擎） ---------------- */

  /** 开始背景音乐（已在播放则忽略）。 */
  startMusic() {
    const ctx = this.ensure();
    if (!ctx) return;
    if (!this._music) this._music = new EpicMusicEngine(ctx, this.musicBus, this.verb);
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

  /** 领域环境循环素材（整段解码、循环播放，文件位于 public/sfx/）。 */
  AMBIENT_LOOPS = {
    rain: 'rain.mp3'
  };

  AMBIENT = {
    neutral: { type: 'lowpass', f0: 320, q: 0.55, gain: 0.05, lfoF: 0.11, lfoAmt: 110, drone: [38], droneGain: 0.016 },
    ice:     { type: 'bandpass', f0: 1250, q: 2.2, gain: 0.05, lfoF: 0.23, lfoAmt: 620, drone: [38, 45], droneGain: 0.011, shimmer: 1174.66 },
    fire:    { type: 'lowpass', f0: 240, q: 0.8, gain: 0.065, lfoF: 0.5, lfoAmt: 85, drone: [38], droneGain: 0.02 },
    storm:   { type: 'bandpass', f0: 520, q: 0.75, gain: 0.05, lfoF: 0.37, lfoAmt: 340, drone: [33, 38], droneGain: 0.014, loop: { buf: 'rain', gain: 0.055 } }
  };

  /** 切换领域环境音：旧的 0.8 秒淡出，新的淡入。 */
  setRealm(id) {
    this.realm = this.AMBIENT[id] ? id : 'neutral';
    const ctx = this.ensure();
    if (!ctx) return;
    if (this._ambient && this._ambient.realm === this.realm) return;
    if (this._ambient) {
      const { out, sources } = this._ambient;
      const t = ctx.currentTime;
      out.gain.cancelScheduledValues(t);
      out.gain.setValueAtTime(Math.max(0.0001, out.gain.value), t);
      out.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
      sources.forEach((s) => { try { s.stop(t + 0.85); } catch { /* 已停止 */ } });
      this._ambient = null;
    }
    this._startAmbient(this.realm);
  }

  _startAmbient(realmId) {
    const cfg = this.AMBIENT[realmId];
    if (!cfg || !this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    // 环境音统一经一个输出增益（便于交叉淡化），并少量送入大教堂混响
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(1, t + 1.6);
    out.connect(this.sfxBus);
    const aw = ctx.createGain();
    aw.gain.value = 0.3;
    out.connect(aw).connect(this.sfxSend);

    const sources = [];
    const nodes = [];

    // 风声层：带通噪声 + LFO 摆频
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const flt = ctx.createBiquadFilter();
    flt.type = cfg.type;
    flt.frequency.value = cfg.f0;
    flt.Q.value = cfg.q;
    const g = ctx.createGain();
    g.gain.value = cfg.gain;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = cfg.lfoF;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = cfg.lfoAmt;
    lfo.connect(lfoGain).connect(flt.frequency);
    src.connect(flt).connect(g).connect(out);
    src.start();
    lfo.start();
    sources.push(src, lfo);

    // 音高化 drone 层：与音乐同为 D 调中心，让环境与配乐融为一体
    (cfg.drone || []).forEach((midi, i) => {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = nf(midi);
      o.detune.value = i % 2 ? 5 : -5;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 300;
      const dg = ctx.createGain();
      dg.gain.value = cfg.droneGain;
      // 慢呼吸包络
      const br = ctx.createOscillator();
      br.frequency.value = 0.06 + i * 0.017;
      const brG = ctx.createGain();
      brG.gain.value = cfg.droneGain * 0.4;
      br.connect(brG).connect(dg.gain);
      o.connect(lp).connect(dg).connect(out);
      o.start();
      br.start();
      sources.push(o, br);
      nodes.push(o, br);
    });

    // 冰原专属：高空「冰晶吟唱」微光
    if (cfg.shimmer) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = cfg.shimmer;
      const vib = ctx.createOscillator();
      vib.frequency.value = 0.4;
      const vibG = ctx.createGain();
      vibG.gain.value = 4;
      vib.connect(vibG).connect(o.detune);
      const sg = ctx.createGain();
      sg.gain.value = 0.006;
      o.connect(sg).connect(out);
      o.start();
      vib.start();
      sources.push(o, vib);
    }

    // 领域循环素材（雷领域的真实雨声）
    if (cfg.loop && this._loopBufs[cfg.loop.buf]) {
      const src = ctx.createBufferSource();
      src.buffer = this._loopBufs[cfg.loop.buf];
      src.loop = true;
      const lg = ctx.createGain();
      lg.gain.value = cfg.loop.gain;
      src.connect(lg).connect(out);
      src.start();
      sources.push(src);
    }

    this._ambient = { realm: realmId, out, sources };
  }
}

export const audio = new AudioEngine();

/**
 * EpicMusicEngine — 66 BPM · D 小调史诗管弦（程序化）。
 *
 * 8 小节和声循环 i–VI–III–VII（Dm → Bb → F → C），每和弦 2 小节。
 * 4 个强度 cycle 演进，总循环约 2 分钟：
 *   cycle 0「序·命运低语」 drone + 远处圣咏 + 命运钟声 + 竖琴
 *   cycle 1「行军」       + 弦乐八分律动 + 心跳战鼓
 *   cycle 2「决战」       全编制：战争鼓组 + 铜管涌潮 + Braam + 大镲
 *   cycle 3「余烬」       鼓撤 → 钟声与竖琴回归 + 渐强 riser 接回序章
 */
export class EpicMusicEngine {
  constructor(ctx, dest, verb) {
    this.ctx = ctx;
    this.BPM = 66;
    this.stepDur = 60 / this.BPM / 4; // 十六分音符 ≈ 0.227s
    this.STEPS = 128;                 // 8 小节 × 16 步

    // 引擎主电平（stop 淡出 / duck 闪避都作用在这一个节点上）
    this.level = ctx.createGain();
    this.level.gain.value = 0.0001;
    this.level.connect(dest);
    this.wetOut = ctx.createGain();
    this.wetOut.gain.value = 0.9;
    this.level.connect(this.wetOut).connect(verb);

    // 干湿总线（乐器按各自湿度接入）
    this.dry = ctx.createGain();
    this.dry.gain.value = 0.62;
    this.dry.connect(this.level);
    this.wet = ctx.createGain();
    this.wet.gain.value = 1;
    this.wet.connect(this.level);

    // 和声：Dm → Bb → F → C（bass / 弦乐律动根音+五度 / 圣咏 / 铜管 / 竖琴音集）
    this.CHORDS = [
      { bass: 38, ost: 50, ost5: 45, choir: [50, 57, 62, 65], brass: [50, 53, 57], harp: [62, 65, 69, 74, 77] },
      { bass: 34, ost: 46, ost5: 41, choir: [58, 65, 70, 74], brass: [58, 62, 65], harp: [70, 74, 77, 82] },
      { bass: 41, ost: 53, ost5: 48, choir: [53, 60, 65, 69], brass: [53, 57, 60], harp: [65, 69, 72, 77] },
      { bass: 36, ost: 48, ost5: 43, choir: [55, 60, 64, 67], brass: [48, 52, 55], harp: [67, 72, 76, 79] }
    ];

    // 弦乐律动：每小节 8 个八分位的音高偏移（半音，相对根音）与重音
    this.OST = [
      { o: 0, a: 1.0 }, { o: 0, a: 0.75 }, { o: -7, a: 0.8 }, { o: 0, a: 0.75 },
      { o: 12, a: 1.1 }, { o: 0, a: 0.75 }, { o: -7, a: 0.8 }, { o: 0, a: 0.75 }
    ];

    // 战争鼓组（cycle 2）：2 小节块内的步位 → [类型, 力度]
    this.DRUMS = {
      0: ['boom', 1.0], 1: ['tom', 0.35], 6: ['tom', 0.55], 10: ['tom', 0.6],
      13: ['tom', 0.45], 16: ['boom', 0.85], 17: ['tom', 0.3], 22: ['tom', 0.5],
      24: ['tom', 0.55], 26: ['tom', 0.6], 28: ['tom', 0.7], 30: ['tom', 0.8]
    };
    // 心跳战鼓（cycle 1）：lub-dub
    this.HEART = { 0: ['boom', 0.5], 3: ['boom', 0.32] };

    // 各 cycle 的圣咏音量比例
    this.CHOIR_VEL = [0.5, 0.75, 1.0, 0.6];

    this.step = 0;
    this.cycle = 0;
    this.nextTime = 0;
    this.timer = null;
    this.ducked = false;
    this.stopping = false;
  }

  start() {
    if (this.timer) return;
    this.stopping = false;
    this.level.gain.cancelScheduledValues(this.ctx.currentTime);
    this.level.gain.setTargetAtTime(this.ducked ? 0.2 : 1, this.ctx.currentTime, 0.9);
    this.nextTime = this.ctx.currentTime + 0.2;
    this.timer = setInterval(() => this._tick(), 250);
  }

  stop(fade = 1.5) {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.stopping = true;
    const t = this.ctx.currentTime;
    this.level.gain.cancelScheduledValues(t);
    this.level.gain.setTargetAtTime(0.0001, t, fade / 3);
    const engine = this;
    setTimeout(() => { try { engine.level.disconnect(); engine.wetOut.disconnect(); } catch { /* 已断开 */ } }, fade * 1000 + 500);
  }

  /** 暂停时压低音量（闪避），恢复时抬起。 */
  duck(ducked) {
    this.ducked = ducked;
    if (this.stopping) return;
    this.level.gain.setTargetAtTime(ducked ? 0.2 : 1, this.ctx.currentTime, 0.5);
  }

  _tick() {
    // 前瞻 1.5 秒排程（标签页后台 setInterval 被限流时也不掉拍）
    while (this.nextTime < this.ctx.currentTime + 1.5) {
      this._scheduleStep(this.step, this.cycle, this.nextTime);
      this.step++;
      if (this.step >= this.STEPS) {
        this.step = 0;
        this.cycle = (this.cycle + 1) % 4;
      }
      this.nextTime += this.stepDur;
    }
  }

  _scheduleStep(step, cycle, time) {
    const chord = this.CHORDS[Math.floor(step / 32)];
    const inBar = step % 16;
    const inBlock = step % 32;
    const bar = Math.floor(step / 16);
    const h = () => rand(-0.006, 0.006); // 微人性化时差
    const hv = () => rand(0.92, 1.08);   // 微人性化力度

    /* —— 持续低音 drone：每个 cycle 起点重铺，贯穿全曲的命运根基 —— */
    if (step === 0) {
      this._drone(36.71, time, 2.2, 0.03);          // D1
      this._drone(73.42, time, 2.2, 0.032);         // D2
      this._drone(110, time, 2.2, 0.016);           // A2
    }

    /* —— 命运钟声 / Braam / 大镲：cycle 起点的仪式感 —— */
    if (step === 0) {
      if (cycle === 0) this._bell(nf(50), time, 0.14);
      if (cycle === 2) {
        this._braam(time);
        this._crash(time);
      }
      if (cycle === 3) {
        this._bell(nf(50), time, 0.07);
        this._bell(nf(50) * 1.003, time + 0.9, 0.045);
      }
    }

    /* —— 渐强 riser：cycle 3 最后一小节，推向循环回 to 序章 —— */
    if (step === 112) this._riser(time, this.stepDur * 16);

    /* —— 圣咏垫：每个和弦变换处换和声 —— */
    if (inBlock === 0) {
      const vel = this.CHOIR_VEL[cycle];
      chord.choir.forEach((midi, i) => {
        const v = [1, 0.8, 0.65, 0.45][i] * vel * 0.04;
        this._choir(nf(midi + 12), time, this.stepDur * 31, v);
      });
    }

    /* —— 铜管涌潮（cycle 2 和弦变换处） —— */
    if (cycle === 2 && inBlock === 0) {
      chord.brass.forEach((midi, i) => this._brass(nf(midi), time, this.stepDur * 30, 0.022 + (i === 0 ? 0.008 : 0)));
    }

    /* —— 弦乐八分律动（cycle ≥ 1；cycle 2 加半音邻音拉扯） —— */
    if (cycle >= 1 && inBar % 2 === 0) {
      const slot = this.OST[inBar / 2];
      const midi = chord.ost + slot.o;
      this._ostinato(nf(midi), time + h(), this.stepDur * 1.7, (cycle === 1 ? 0.05 : 0.065) * slot.a * hv());
      if (cycle === 2 && inBar === 14) {
        // 小节末半音邻音：向下一拍的「命运拉扯」
        this._ostinato(nf(chord.ost - 2), time + this.stepDur, this.stepDur * 0.8, 0.028);
      }
    }

    /* —— 战鼓 —— */
    if (cycle === 1) {
      const beat = this.HEART[inBar];
      if (beat) this._drum(beat[0], time + h(), beat[1] * hv() * 0.55);
    } else if (cycle === 2) {
      const hit = this.DRUMS[inBlock];
      if (hit) this._drum(hit[0], time + h(), hit[1] * hv());
    }

    /* —— 竖琴（cycle 0 / 3 的静谧点缀） —— */
    if ((cycle === 0 || cycle === 3) && (inBar === 4 || inBar === 12)) {
      const idx = (bar * 2 + (inBar === 12 ? 1 : 0)) % chord.harp.length;
      this._harp(nf(chord.harp[idx] + 12), time + h(), cycle === 0 ? 0.05 : 0.04);
    }
  }

  /* —— 路由 —— */
  _route(g, wet) {
    g.connect(this.dry);
    if (wet > 0) {
      const w = this.ctx.createGain();
      w.gain.value = wet;
      g.connect(w);
      w.connect(this.wet);
    }
  }

  /* —— 乐器 —— */

  /** 持续低音 drone：锯齿 + 三角叠置，暗色低通，极慢起振。 */
  _drone(f, when, attack, vel) {
    const ctx = this.ctx;
    const dur = this.STEPS * this.stepDur;
    for (const [type, mult, g0] of [['sawtooth', 1, 0.6], ['triangle', 1, 1], ['sawtooth', 1.005, 0.5]]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f * mult;
      const flt = ctx.createBiquadFilter();
      flt.type = 'lowpass';
      flt.frequency.value = 240;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.linearRampToValueAtTime(vel * g0, when + attack);
      g.gain.setValueAtTime(vel * g0, when + dur - 2.4);
      g.gain.linearRampToValueAtTime(0.0001, when + dur);
      o.connect(flt).connect(g);
      this._route(g, 0.25);
      o.start(when);
      o.stop(when + dur + 0.1);
    }
  }

  /** 圣咏「aah」：双失谐锯齿 → 低通 → 共振峰增强（900Hz 附近），带颤音与慢呼吸。 */
  _choir(f, when, dur, vel) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(vel, when + 1.5);
    g.gain.setValueAtTime(vel, when + dur - 2.2);
    g.gain.linearRampToValueAtTime(0.0001, when + dur);
    // 呼吸颤音（音量层面）
    const trem = ctx.createOscillator();
    trem.frequency.value = 0.24;
    const tremG = ctx.createGain();
    tremG.gain.value = vel * 0.22;
    trem.connect(tremG).connect(g.gain);
    trem.start(when);
    trem.stop(when + dur + 0.1);
    // 共振峰：低通控刺 + 900Hz 谐振提升「aah」元音感
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1350;
    const formant = ctx.createBiquadFilter();
    formant.type = 'peaking';
    formant.frequency.value = 900;
    formant.Q.value = 1.1;
    formant.gain.value = 7;
    g.connect(lp).connect(formant);
    this._route(formant, 0.6);
    // 音高颤音
    const vib = ctx.createOscillator();
    vib.frequency.value = 4.8;
    const vibG = ctx.createGain();
    vibG.gain.value = 5;
    vib.connect(vibG);
    vib.start(when);
    vib.stop(when + dur + 0.1);
    for (const det of [-6, 6]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.detune.value = det;
      vibG.connect(o.detune);
      o.connect(g);
      o.start(when);
      o.stop(when + dur + 0.1);
    }
  }

  /** 弦乐律动：双失谐锯齿短促发音，低通扫落，行军推进感。 */
  _ostinato(f, when, dur, vel) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(vel, when + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    const flt = ctx.createBiquadFilter();
    flt.type = 'lowpass';
    flt.frequency.setValueAtTime(2600, when);
    flt.frequency.exponentialRampToValueAtTime(900, when + dur);
    g.connect(flt);
    this._route(flt, 0.3);
    for (const det of [-7, 7]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.detune.value = det;
      o.connect(g);
      o.start(when);
      o.stop(when + dur + 0.05);
    }
  }

  /** 战鼓：太鼓式 boom（正弦坠底 + 鼓皮噪声 + 敲击瞬态）/ tom（中音鼓）。 */
  _drum(kind, when, vel) {
    const ctx = this.ctx;
    if (kind === 'boom') {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(150, when);
      o.frequency.exponentialRampToValueAtTime(46, when + 0.22);
      const g = ctx.createGain();
      g.gain.setValueAtTime(vel * 0.5, when);
      g.gain.exponentialRampToValueAtTime(0.0001, when + 0.34);
      o.connect(g);
      this._route(g, 0.35);
      o.start(when);
      o.stop(when + 0.38);
      const src = ctx.createBufferSource();
      src.buffer = this._noise();
      const flt = ctx.createBiquadFilter();
      flt.type = 'lowpass';
      flt.frequency.value = 340;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(vel * 0.16, when);
      ng.gain.exponentialRampToValueAtTime(0.0001, when + 0.1);
      src.connect(flt).connect(ng);
      this._route(ng, 0.35);
      src.start(when, Math.random());
      src.stop(when + 0.12);
    } else {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(98, when);
      o.frequency.exponentialRampToValueAtTime(58, when + 0.12);
      const g = ctx.createGain();
      g.gain.setValueAtTime(vel * 0.3, when);
      g.gain.exponentialRampToValueAtTime(0.0001, when + 0.18);
      o.connect(g);
      this._route(g, 0.35);
      o.start(when);
      o.stop(when + 0.2);
      const src = ctx.createBufferSource();
      src.buffer = this._noise();
      const flt = ctx.createBiquadFilter();
      flt.type = 'bandpass';
      flt.frequency.value = 520;
      flt.Q.value = 1.2;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(vel * 0.12, when);
      ng.gain.exponentialRampToValueAtTime(0.0001, when + 0.06);
      src.connect(flt).connect(ng);
      this._route(ng, 0.35);
      src.start(when, Math.random());
      src.stop(when + 0.08);
    }
  }

  /** 铜管涌潮：双失谐锯齿 + 音头俯冲（号角起振感）+ 低通开合。 */
  _brass(f, when, dur, vel) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(vel, when + 1.1);
    g.gain.setValueAtTime(vel, when + dur - 1.8);
    g.gain.linearRampToValueAtTime(0.0001, when + dur);
    const flt = ctx.createBiquadFilter();
    flt.type = 'lowpass';
    flt.frequency.setValueAtTime(500, when);
    flt.frequency.exponentialRampToValueAtTime(2400, when + 1.4);
    flt.frequency.exponentialRampToValueAtTime(1300, when + dur);
    g.connect(flt);
    this._route(flt, 0.45);
    for (const det of [-9, 9]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(f * 0.94, when);
      o.frequency.exponentialRampToValueAtTime(f, when + 0.14);
      o.detune.value = det;
      o.connect(g);
      o.start(when);
      o.stop(when + dur + 0.1);
    }
  }

  /** 命运钟声：非谐分音大钟，长尾浸在大教堂混响里。 */
  _bell(f, when, vel) {
    const ctx = this.ctx;
    const ratios = [1, 2.4, 3.9, 5.4];
    const vg = [1, 0.5, 0.28, 0.16];
    const dg = [1, 0.72, 0.5, 0.34];
    ratios.forEach((r, i) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f * r;
      const g = ctx.createGain();
      const d = 5.5 * dg[i];
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(vel * vg[i], when + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, when + d);
      o.connect(g);
      this._route(g, 0.7);
      o.start(when);
      o.stop(when + d + 0.1);
    });
  }

  /** Braam：预告片式号角撞击——低音锯齿群俯冲 + 亚低频 + 噪声涌。 */
  _braam(when) {
    const ctx = this.ctx;
    [36.71, 73.42, 110].forEach((f) => {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(f * 0.94, when);
      o.frequency.exponentialRampToValueAtTime(f, when + 0.4);
      const flt = ctx.createBiquadFilter();
      flt.type = 'lowpass';
      flt.frequency.setValueAtTime(300, when);
      flt.frequency.exponentialRampToValueAtTime(1100, when + 0.5);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.linearRampToValueAtTime(0.05, when + 0.35);
      g.gain.setValueAtTime(0.05, when + 2.6);
      g.gain.linearRampToValueAtTime(0.0001, when + 3.4);
      o.connect(flt).connect(g);
      this._route(g, 0.5);
      o.start(when);
      o.stop(when + 3.5);
    });
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(33, when);
    sub.frequency.exponentialRampToValueAtTime(36.71, when + 0.4);
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.0001, when);
    sg.gain.linearRampToValueAtTime(0.14, when + 0.3);
    sg.gain.exponentialRampToValueAtTime(0.0001, when + 2.8);
    sub.connect(sg);
    this._route(sg, 0.35);
    sub.start(when);
    sub.stop(when + 2.9);
  }

  /** 大镲：亮噪声长衰减（cycle 2 开战仪式）。 */
  _crash(when) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this._noise();
    const flt = ctx.createBiquadFilter();
    flt.type = 'highpass';
    flt.frequency.value = 5200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.09, when);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 2.4);
    src.connect(flt).connect(g);
    this._route(g, 0.55);
    src.start(when, Math.random());
    src.stop(when + 2.5);
  }

  /** 渐强 riser：噪声 + 高频圣咏假声，推向下一 cycle。 */
  _riser(when, dur) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this._noise();
    const flt = ctx.createBiquadFilter();
    flt.type = 'bandpass';
    flt.Q.value = 1;
    flt.frequency.setValueAtTime(320, when);
    flt.frequency.exponentialRampToValueAtTime(3800, when + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(0.06, when + dur * 0.94);
    g.gain.linearRampToValueAtTime(0.0001, when + dur);
    src.connect(flt).connect(g);
    this._route(g, 0.5);
    src.start(when, Math.random());
    src.stop(when + dur + 0.05);
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(587.33, when);
    o.frequency.exponentialRampToValueAtTime(1174.66, when + dur);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, when);
    og.gain.linearRampToValueAtTime(0.02, when + dur * 0.9);
    og.gain.linearRampToValueAtTime(0.0001, when + dur);
    o.connect(og);
    this._route(og, 0.6);
    o.start(when);
    o.stop(when + dur + 0.05);
  }

  /** 竖琴：三角波拨弦 + 亮泽正弦泛音，落入混响。 */
  _harp(f, when, vel) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(vel, when + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 1.4);
    g.connect(this.dry);
    const w = ctx.createGain();
    w.gain.value = 0.6;
    g.connect(w).connect(this.wet);
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = f;
    const o2 = ctx.createOscillator();
    o2.type = 'sine';
    o2.frequency.value = f * 2;
    const g2 = ctx.createGain();
    g2.gain.value = 0.35;
    o.connect(g);
    o2.connect(g2).connect(g);
    o.start(when);
    o.stop(when + 1.45);
    o2.start(when);
    o2.stop(when + 1.45);
  }

  /** 每次击打取随机偏移的立体声噪声，避免采样感。 */
  _noise() {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * 1.5);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }
}
