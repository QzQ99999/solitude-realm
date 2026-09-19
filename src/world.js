import * as THREE from 'three';
import { Sky } from './sky.js';
import { Ground } from './ground.js';
import { Weather } from './weather.js';
import { loadArena, makeAmbientCandle } from './arena.js';
import {
  THEMES,
  THEME_COLOR_FIELDS,
  THEME_FLOAT_FIELDS,
  SHIFT_TIME
} from './themes.js';

/**
 * world.js — 世界本体与"改写"引擎（黑剑场景版）。
 *
 * 场景本体是 Blender 建模的黑剑 BOSS 战竞技场（arena.glb）：环形斗技场
 * 悬于虚空，顶层圆盘即玩家活动场地（边缘已对齐 BOUNDARY_RADIUS=58，
 * 盘面即 y=0 地面）。程序化 Ground 不再是地表，而是沉到竞技场深处的
 * "元素深渊"底层 —— 雾色之下隐约透出发光纹路，充当纵深背景。
 * `shift(family, point)` 在法术落地点炸开转换冲击波，并把整套主题参数
 * （天空/雾/深渊/灯光/暗角/天气）在 SHIFT_TIME 秒内平滑过渡；灯光颜色
 * 变化会直接染在竞技场石材上。
 */

const WAVE_DURATION = 1.5;
const WAVE_RADIUS = 22;

/** 深渊底层相对竞技场盘面（y=0）的深度。 */
const ABYSS_DEPTH = -120;

function buildWaveMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
    uniforms: {
      uTime: { value: WAVE_DURATION },
      uColor: { value: new THREE.Color(1, 1, 1) }
    },
    vertexShader: /* glsl */ `
      varying vec2 vLocal;
      void main() {
        vLocal = uv * 2.0 - 1.0;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uColor;
      varying vec2 vLocal;

      void main() {
        float t = clamp(uTime / ${WAVE_DURATION.toFixed(1)}, 0.0, 1.0);
        float radius = ${WAVE_RADIUS.toFixed(1)} * (1.0 - pow(1.0 - t, 3.0));
        float d = length(vLocal) * ${(WAVE_RADIUS * 2).toFixed(1)};

        float lip = exp(-pow((d - radius) / 0.3, 2.0));
        float crest = exp(-pow((d - radius) / 1.4, 2.0)) * 0.5;
        float wash = smoothstep(radius, 0.0, d) * 0.1;

        float fade = (1.0 - t) * (1.0 - t);
        float a = (lip + crest + wash) * fade;
        if (a < 0.004) discard;
        gl_FragColor = vec4(uColor, a * 0.9);
        #include <colorspace_fragment>
      }
    `
  });
}

export class World {
  constructor() {
    this.scene = new THREE.Scene();

    this.fog = new THREE.Fog('#141c28', 55, 235);
    this.scene.fog = this.fog;

    this.sky = new Sky(this.scene);
    this.ground = new Ground(this.scene);
    // Ground 降格为深渊底层：沉到竞技场下方，放大到雾距之外
    this.ground.mesh.position.y = ABYSS_DEPTH;
    this.ground.mesh.scale.setScalar(2.6);

    this.key = new THREE.DirectionalLight('#bcd2ff', 3.4);
    this.key.position.set(18, 30, 10);
    // 反方向的冷色补光：抬起草地暗部，避免石材死黑
    this.fill = new THREE.DirectionalLight('#46536e', 1.3);
    this.fill.position.set(-22, 24, -16);
    this.hemi = new THREE.HemisphereLight('#334e78', '#10161f', 1.45);
    this.scene.add(this.key, this.fill, this.hemi);
    this.candle = makeAmbientCandle(this.scene);

    // 黑剑 BOSS 战竞技场（异步加载，加载完成前玩法照常可用）
    loadArena(
      this.scene,
      (ok) => {
        this.arenaReady = ok;
        this.onArenaReady?.(ok);
      },
      (pct, loadedMB) => this.onArenaProgress?.(pct, loadedMB)
    );

    this.weather = new Weather(this.scene);

    /** 当前领域 id。 */
    this.current = 'neutral';
    this.currentAccent = THEMES.neutral.accent;

    /** 世界改写完成时回调（HUD 徽章 / 提示）。 */
    this.onShift = null;

    this._waveMaterial = buildWaveMaterial();
    this._wave = new THREE.Mesh(
      new THREE.PlaneGeometry(WAVE_RADIUS * 2, WAVE_RADIUS * 2),
      this._waveMaterial
    );
    this._wave.rotation.x = -Math.PI / 2;
    this._wave.visible = false;
    this._wave.renderOrder = 4;
    this.scene.add(this._wave);
    this._waveTime = WAVE_DURATION;

    this._progress = 1;
    this._from = {};
    this._to = null;
    this._cA = new THREE.Color();
    this._cB = new THREE.Color();
  }

  get theme() {
    return THEMES[this.current];
  }

  /**
   * 把世界改写成 `family` 领域。`point` 是法术落地点（冲击波位置）。
   * 相同领域重复施放只补一圈冲击波，不做无意义的重过渡。
   */
  shift(family, point) {
    const theme = THEMES[family];
    if (!theme) return;

    if (family !== this.current) {
      // 从"此刻的真实状态"出发捕获起点 —— 包括正处在上一次过渡中途的情况。
      const live = this._readLive();
      for (const field of THEME_COLOR_FIELDS) this._from[field] = live[field];
      for (const field of THEME_FLOAT_FIELDS) this._from[field] = live[field];
      this._to = theme;
      this._progress = 0;

      this.weather.setMode(theme.weather);
      this.current = family;
    }

    this.currentAccent = theme.accent;

    this._wave.position.set(point.x, 0.05, point.z);
    this._waveMaterial.uniforms.uColor.value.set(theme.accent);
    this._waveTime = 0;
    this._wave.visible = true;

    this.onShift?.({ id: family, theme });
  }

  /** 读出当前（可能是过渡中途的）主题参数。 */
  _readLive() {
    return {
      skyTop: this._cA.copy(this.sky.uniforms.uTop.value).clone(),
      skyBottom: this.sky.uniforms.uBottom.value.clone(),
      skyHorizon: this.sky.uniforms.uHorizon.value.clone(),
      fogColor: this.fog.color.clone(),
      groundBase: this.ground.uniforms.uBase.value.clone(),
      groundAccent: this.ground.uniforms.uAccent.value.clone(),
      keyColor: this.key.color.clone(),
      hemiSky: this.hemi.color.clone(),
      hemiGround: this.hemi.groundColor.clone(),
      stars: this.sky.uniforms.uStars.value,
      fogNear: this.fog.near,
      fogFar: this.fog.far,
      veinStrength: this.ground.uniforms.uVein.value,
      keyIntensity: this.key.intensity,
      hemiIntensity: this.hemi.intensity
    };
  }

  _apply(field, value) {
    switch (field) {
      case 'skyTop': this.sky.uniforms.uTop.value.copy(value); break;
      case 'skyBottom': this.sky.uniforms.uBottom.value.copy(value); break;
      case 'skyHorizon': this.sky.uniforms.uHorizon.value.copy(value); break;
      case 'fogColor': this.fog.color.copy(value); this.ground.uniforms.uFog.value.copy(value); break;
      case 'groundBase': this.ground.uniforms.uBase.value.copy(value); break;
      case 'groundAccent': this.ground.uniforms.uAccent.value.copy(value); break;
      case 'keyColor': this.key.color.copy(value); break;
      case 'hemiSky': this.hemi.color.copy(value); break;
      case 'hemiGround': this.hemi.groundColor.copy(value); break;
      case 'stars': this.sky.uniforms.uStars.value = value; break;
      case 'fogNear': this.fog.near = value; this.ground.uniforms.uFogNear.value = value; break;
      case 'fogFar': this.fog.far = value; this.ground.uniforms.uFogFar.value = value; break;
      case 'veinStrength': this.ground.uniforms.uVein.value = value; break;
      case 'keyIntensity': this.key.intensity = value; break;
      case 'hemiIntensity': this.hemi.intensity = value; break;
    }
  }

  /**
   * 领域颜色软化：向亮度轴去饱和并压暗。
   */
  static SOFTEN_DESAT = 0.42;
  static SOFTEN_DIM = 0.8;
  _soften(c) {
    const lum = c.r * 0.299 + c.g * 0.587 + c.b * 0.114;
    c.r += (lum - c.r) * World.SOFTEN_DESAT;
    c.g += (lum - c.g) * World.SOFTEN_DESAT;
    c.b += (lum - c.b) * World.SOFTEN_DESAT;
    c.multiplyScalar(World.SOFTEN_DIM);
    return c;
  }

  _tickShift(dt, vignette) {
    if (this._progress >= 1) return;

    this._progress = Math.min(1, this._progress + dt / SHIFT_TIME);
    // 平滑进出
    const k = this._progress * this._progress * (3 - 2 * this._progress);

    // 非荒原领域：主题颜色/灯光统一软化（用户反馈：施法后地形过艳过亮）
    const soften = this.current !== 'neutral';
    for (const field of THEME_COLOR_FIELDS) {
      this._cA.copy(this._from[field]);
      this._cB.set(this._to[field]);
      this._cA.lerp(this._cB, k);
      if (soften) this._soften(this._cA);
      this._apply(field, this._cA);
    }
    for (const field of THEME_FLOAT_FIELDS) {
      let value = this._from[field] + (this._to[field] - this._from[field]) * k;
      if (soften) {
        if (field === 'keyIntensity' || field === 'hemiIntensity') value *= 0.75;
        else if (field === 'veinStrength') value *= 0.5;
      }
      this._apply(field, value);
    }

    // 暗角颜色随主题走（DOM box-shadow，CSS transition 自带平滑）
    const v = this._to.vignette;
    const m = v.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
    if (m && this._progress > 0.5) {
      vignette.style.boxShadow = `inset 0 0 190px 30px rgba(${m[1]}, ${m[2]}, ${m[3]}, ${m[4] ?? 0.5})`;
    }
  }

  update(dt, elapsed, anchor, vignette) {
    // 先推进世界过渡，再更新天空/大地 —— 改写当帧即生效。
    this._tickShift(dt, vignette);

    this.sky.update(elapsed);
    this.ground.update(elapsed);
    this.weather.update(dt, elapsed, anchor);

    this._waveTime += dt;
    if (this._waveTime < WAVE_DURATION) {
      this._waveMaterial.uniforms.uTime.value = this._waveTime;
    } else {
      this._wave.visible = false;
    }
  }

  dispose() {
    this.sky.dispose();
    this.ground.dispose();
    this.weather.dispose();
    this.scene.remove(this.candle);
    this._wave.geometry.dispose();
    this._waveMaterial.dispose();
  }
}
