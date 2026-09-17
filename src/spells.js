import * as THREE from 'three';

/**
 * spells.js — 三系法术与它们共用的粒子/冲击波设施。
 *
 *  - Q 霜新星：冰圈在落点炸开，一环冰棱破土而起，短暂矗立后沉回；
 *  - E 落炎陨石：陨石从空中呼啸坠落，撞地引发火环、火星雨与焦痕；
 *  - R 天雷殛灭：雷柱自天而降，主干与分支每几十毫秒重劈一次形状。
 *
 * 每个法术落地时回调一次 `onImpact(point, radius)`，由 Game 决定改写世界、
 * 判定元素之灵命中与镜头震动。
 */

/* ---------------------------------------------------------------------- */
/* 一次性粒子雨（CPU 积分，几百颗量级，直接更新属性数组）                    */
/* ---------------------------------------------------------------------- */

class BurstPool {
  constructor(scene, max = 1400) {
    this.max = max;
    this.particles = [];

    this._positions = new Float32Array(max * 3);
    this._colors = new Float32Array(max * 3);
    this._alphas = new Float32Array(max);
    this._sizes = new Float32Array(max);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this._positions, 3));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(this._colors, 3));
    geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this._alphas, 1));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(this._sizes, 1));
    geometry.boundingSphere = null;

    this._material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
      uniforms: { uPixelRatio: { value: 1 } },
      vertexShader: /* glsl */ `
        uniform float uPixelRatio;
        attribute vec3 aColor;
        attribute float aAlpha;
        attribute float aSize;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = aColor;
          vAlpha = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize * uPixelRatio / max(-mv.z, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          if (d > 0.5) discard;
          float a = smoothstep(0.5, 0.04, d) * vAlpha;
          if (a < 0.004) discard;
          gl_FragColor = vec4(vColor, a);
          #include <colorspace_fragment>
        }
      `
    });

    this._points = new THREE.Points(geometry, this._material);
    this._points.frustumCulled = false;
    this._points.renderOrder = 3;
    scene.add(this._points);
    this._geometry = geometry;

    this._cA = new THREE.Color();
    this._cB = new THREE.Color();
  }

  setPixelRatio(ratio) {
    this._material.uniforms.uPixelRatio.value = ratio;
  }

  /** 清空所有粒子（重新开始时用）。 */
  clear() {
    this.particles.length = 0;
    this._alphas.fill(0);
  }

  /**
   * 发射一蓬粒子。
   * @param {object} o { pos, count, speed:[min,max], up:[min,max], life:[min,max],
   *                     size:[min,max], colorA, colorB, gravity, drag, spread }
   */
  emit(o) {
    for (let n = 0; n < o.count; n++) {
      if (this.particles.length >= this.max) this.particles.shift();
      const angle = Math.random() * Math.PI * 2;
      const flat = Math.sqrt(Math.random()) * (o.spread ?? 1);
      const speed = lerp(o.speed[0], o.speed[1], Math.random());
      this.particles.push({
        x: o.pos.x + Math.cos(angle) * flat * 0.3,
        y: o.pos.y + Math.random() * 0.2,
        z: o.pos.z + Math.sin(angle) * flat * 0.3,
        vx: Math.cos(angle) * flat * speed,
        vy: lerp(o.up[0], o.up[1], Math.random()),
        vz: Math.sin(angle) * flat * speed,
        life: 0,
        maxLife: lerp(o.life[0], o.life[1], Math.random()),
        size: lerp(o.size[0], o.size[1], Math.random()),
        gravity: o.gravity ?? -9,
        drag: o.drag ?? 0.6,
        color: this._cA.set(o.colorA).clone().lerp(this._cB.set(o.colorB), Math.random())
      });
    }
  }

  update(dt) {
    const ps = this.particles;
    let write = 0;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      p.life += dt;
      if (p.life >= p.maxLife) continue;
      const damp = Math.max(0, 1 - p.drag * dt);
      p.vx *= damp;
      p.vz *= damp;
      p.vy = p.vy * damp + p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      if (p.y < 0.03 && p.vy < 0) {
        p.y = 0.03;
        p.vy *= -0.35;
      }
      ps[write++] = p;
    }
    ps.length = write;

    for (let i = 0; i < this.max; i++) {
      if (i < ps.length) {
        const p = ps[i];
        const fade = 1 - p.life / p.maxLife;
        this._positions[i * 3] = p.x;
        this._positions[i * 3 + 1] = p.y;
        this._positions[i * 3 + 2] = p.z;
        this._colors[i * 3] = p.color.r;
        this._colors[i * 3 + 1] = p.color.g;
        this._colors[i * 3 + 2] = p.color.b;
        this._alphas[i] = fade;
        this._sizes[i] = p.size;
      } else {
        this._alphas[i] = 0;
      }
    }
    this._geometry.attributes.position.needsUpdate = true;
    this._geometry.attributes.aColor.needsUpdate = true;
    this._geometry.attributes.aAlpha.needsUpdate = true;
    this._geometry.attributes.aSize.needsUpdate = true;
  }

  dispose() {
    this._geometry.dispose();
    this._material.dispose();
  }
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** 冲出地面的环形波（法术通用，也供世界改写复用的观感语言）。 */
class ImpactWave {
  constructor(scene) {
    this._material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
      uniforms: {
        uTime: { value: 99 },
        uColor: { value: new THREE.Color(1, 1, 1) },
        uRadius: { value: 6 }
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
        uniform float uRadius;
        varying vec2 vLocal;
        void main() {
          float t = clamp(uTime / 0.8, 0.0, 1.0);
          float radius = uRadius * (1.0 - pow(1.0 - t, 2.4));
          float d = length(vLocal) * uRadius * 2.0;
          float lip = exp(-pow((d - radius) / 0.28, 2.0));
          float crest = exp(-pow((d - radius) / 1.1, 2.0)) * 0.4;
          float a = (lip + crest) * (1.0 - t) * (1.0 - t);
          if (a < 0.004) discard;
          gl_FragColor = vec4(uColor, a);
          #include <colorspace_fragment>
        }
      `
    });
    this._mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._material);
    this._mesh.scale.setScalar(8); // 半径 8m 的两倍宽
    this._mesh.rotation.x = -Math.PI / 2;
    this._mesh.visible = false;
    this._mesh.renderOrder = 3;
    scene.add(this._mesh);
  }

  trigger(point, color, radius = 6) {
    this._mesh.position.set(point.x, 0.06, point.z);
    this._mesh.scale.setScalar(radius);
    this._material.uniforms.uColor.value.set(color);
    this._material.uniforms.uRadius.value = radius;
    this._material.uniforms.uTime.value = 0;
    this._mesh.visible = true;
  }

  update(dt) {
    if (!this._mesh.visible) return;
    this._material.uniforms.uTime.value += dt;
    if (this._material.uniforms.uTime.value > 0.85) this._mesh.visible = false;
  }

  hide() {
    this._mesh.visible = false;
  }

  dispose() {
    this._mesh.geometry.dispose();
    this._material.dispose();
  }
}

/* ---------------------------------------------------------------------- */
/* 三系法术                                                                */
/* ---------------------------------------------------------------------- */

const ICE_SPIKES = 16;

export class SpellManager {
  constructor(scene) {
    this.scene = scene;
    this.bursts = new BurstPool(scene);
    this.wave = new ImpactWave(scene);

    // 冰棱池
    const spikeMaterial = new THREE.MeshStandardMaterial({
      color: '#c8ecff',
      emissive: '#6fc8ff',
      emissiveIntensity: 0.7,
      roughness: 0.25,
      metalness: 0.0,
      transparent: true,
      opacity: 0.96,
      flatShading: true
    });
    this._spikes = [];
    const spikeGeometry = new THREE.ConeGeometry(0.34, 1, 6);
    spikeGeometry.translate(0, 0.5, 0); // 锥底对齐地面
    for (let i = 0; i < ICE_SPIKES; i++) {
      const spike = new THREE.Mesh(spikeGeometry, spikeMaterial);
      spike.visible = false;
      scene.add(spike);
      this._spikes.push({ mesh: spike, seed: Math.random() });
    }

    // 陨石
    this._meteor = new THREE.Mesh(
      new THREE.SphereGeometry(0.55, 12, 10),
      new THREE.MeshStandardMaterial({
        color: '#3a2418',
        emissive: '#ff6a12',
        emissiveIntensity: 2.2,
        roughness: 0.9,
        flatShading: true
      })
    );
    this._meteor.visible = false;
    scene.add(this._meteor);
    this._meteorLight = new THREE.PointLight('#ff8a3c', 0, 26, 2);
    scene.add(this._meteorLight);

    // 陨石焦痕池
    this._scorch = [];
    for (let i = 0; i < 5; i++) {
      const decal = new THREE.Mesh(
        new THREE.CircleGeometry(2.4, 26),
        new THREE.MeshBasicMaterial({ color: '#0d0705', transparent: true, opacity: 0, depthWrite: false })
      );
      decal.rotation.x = -Math.PI / 2;
      decal.visible = false;
      scene.add(decal);
      this._scorch.push({ mesh: decal, life: 0 });
    }
    this._scorchCursor = 0;

    // 雷电
    this._boltMaterial = new THREE.MeshBasicMaterial({
      color: '#f2ecff',
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    this._bolt = new THREE.Group();
    this._bolt.visible = false;
    scene.add(this._bolt);
    this._boltLight = new THREE.PointLight('#c9b8ff', 0, 30, 2);
    scene.add(this._boltLight);

    this._scratchDir = new THREE.Vector3();

    // 普通攻击：能量球池（白色核心 + 元素色光壳 + 光晕，尺寸加大保证醒目）
    this._balls = [];
    const ballGeometry = new THREE.SphereGeometry(0.16, 12, 10);
    const shellGeometry = new THREE.SphereGeometry(0.32, 14, 12);
    const haloCanvas = document.createElement('canvas');
    haloCanvas.width = haloCanvas.height = 64;
    const haloCtx = haloCanvas.getContext('2d');
    const haloGrad = haloCtx.createRadialGradient(32, 32, 2, 32, 32, 30);
    haloGrad.addColorStop(0, 'rgba(255,255,255,1)');
    haloGrad.addColorStop(0.4, 'rgba(255,255,255,0.32)');
    haloGrad.addColorStop(1, 'rgba(255,255,255,0)');
    haloCtx.fillStyle = haloGrad;
    haloCtx.fillRect(0, 0, 64, 64);
    this._ballHaloTexture = new THREE.CanvasTexture(haloCanvas);
    for (let i = 0; i < 8; i++) {
      const group = new THREE.Group();
      const core = new THREE.Mesh(
        ballGeometry,
        new THREE.MeshBasicMaterial({ color: '#ffffff' })
      );
      const shell = new THREE.Mesh(
        shellGeometry,
        new THREE.MeshBasicMaterial({
          color: '#9fd8ff', transparent: true, opacity: 0.55,
          blending: THREE.AdditiveBlending, depthWrite: false
        })
      );
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this._ballHaloTexture, color: '#9fd8ff', transparent: true, opacity: 0.9,
        blending: THREE.AdditiveBlending, depthWrite: false
      }));
      halo.scale.setScalar(1.9);
      group.add(core, shell, halo);
      group.visible = false;
      scene.add(group);
      this._balls.push({ group, core, shell, halo, busy: false });
    }

    this._active = [];
  }

  /** 施放。`onImpact(point, spiritRadius)` 在法术命中地面时回调一次。 */
  cast(element, from, to, onImpact) {
    if (element === 'ice') this._castIce(to, onImpact);
    else if (element === 'fire') this._castFire(from, to, onImpact);
    else if (element === 'storm') this._castStorm(to, onImpact);
  }

  /**
   * 普通攻击：从 `from`（杖头宝珠）向 `to` 发射一颗元素能量球。
   * `onMove(pos)` 每帧回调球体当前位置（用于路径命中判定）；
   * `onImpact(point)` 在球落地时回调一次。
   */
  castBasic(from, to, color, onMove, onImpact) {
    const slot = this._balls.find((ball) => !ball.busy) ?? this._balls[0];
    slot.busy = true;
    slot.group.visible = true;
    slot.shell.material.color.set(color);
    slot.halo.material.color.set(color);
    slot.group.position.copy(from);
    slot.group.scale.setScalar(1.3);
    this._active.push({
      type: 'basic',
      t: 0,
      duration: Math.max(0.12, from.distanceTo(to) / 26),
      start: from.clone(),
      point: to.clone(),
      color,
      fired: false,
      hitSet: new Set(), // 本次攻击已结算过的特殊之灵：飞行多帧 + 落点只算一次命中
      onMove,
      onImpact,
      slot
    });
  }

  _tickBasic(state, dt) {
    state.t += dt;
    const k = Math.min(1, state.t / state.duration);
    state.slot.group.position.lerpVectors(state.start, state.point, k);
    // 路径命中：飞行途中每帧回报位置，沿途的元素之灵都能被打到（同一之灵只结算一次）
    state.onMove?.(state.slot.group.position, state.hitSet);
    // 明亮拖尾：每帧必发 2 颗粒子
    this.bursts.emit({
      pos: state.slot.group.position, count: 2, speed: [0.2, 1.2], up: [0, 0.7],
      life: [0.18, 0.42], size: [9, 20], colorA: '#ffffff', colorB: state.color,
      gravity: 0, drag: 2, spread: 0.3
    });
    // 呼吸脉动，远看也醒目
    state.slot.group.scale.setScalar(1.15 + 0.2 * Math.sin(state.t * 34));
    if (k >= 1 && !state.fired) {
      state.fired = true;
      state.slot.group.visible = false;
      state.slot.busy = false;
      this.bursts.emit({
        pos: state.point, count: 44, speed: [1.5, 6], up: [1, 5], life: [0.2, 0.55],
        size: [8, 20], colorA: '#ffffff', colorB: state.color, gravity: -8, drag: 1.6
      });
      this.wave.trigger(state.point, state.color, 2.4);
      this._flash(state.point, state.color, 110);
      state.onImpact(state.point, 1.8, state.hitSet);
    }
    return state.fired && state.t > state.duration + 0.15;
  }

  /* -- Q 霜新星 -- */
  _castIce(point, onImpact) {
    const delay = 0.22;
    const spikes = [];
    for (let i = 0; i < ICE_SPIKES; i++) {
      const slot = this._spikes[i];
      const angle = (i / ICE_SPIKES) * Math.PI * 2 + Math.random() * 0.4;
      const radius = 1.3 + Math.random() * 2.1;
      const height = 1.1 + Math.random() * 1.7;
      spikes.push({
        mesh: slot.mesh,
        delay: delay + Math.random() * 0.24,
        x: point.x + Math.cos(angle) * radius,
        z: point.z + Math.sin(angle) * radius,
        height,
        yaw: Math.random() * Math.PI,
        tilt: (Math.random() - 0.5) * 0.5,
        hold: 1.5 + slot.seed * 0.8
      });
    }
    this._active.push({
      type: 'ice',
      t: 0,
      point: point.clone(),
      spikes,
      fired: false,
      onImpact
    });
  }

  _tickIce(state, dt) {
    state.t += dt;
    if (!state.fired && state.t >= 0.24) {
      state.fired = true;
      this.wave.trigger(state.point, '#7fd8ff', 5);
      this.bursts.emit({
        pos: state.point, count: 90, speed: [3, 9], up: [2, 7], life: [0.4, 1.0],
        size: [8, 22], colorA: '#ffffff', colorB: '#7fd8ff', gravity: -12, drag: 1.2
      });
      this._flash(state.point, '#8fd8ff', 160);
      state.lightT = 0.5;
      state.onImpact(state.point, 4.6);
    }
    const flash = Math.max(0, 1 - (state.t - 0.24) * 2.4);
    for (const spike of state.spikes) {
      const local = state.t - spike.delay;
      const mesh = spike.mesh;
      if (local <= 0) {
        mesh.visible = false;
        continue;
      }
      mesh.visible = true;
      mesh.position.set(spike.x, 0, spike.z);
      mesh.rotation.set(spike.tilt, spike.yaw, 0);
      let scale;
      if (local < 0.18) {
        // 破土弹出，带过冲
        const k = local / 0.18;
        scale = k * (1 + 0.35 * (1 - k));
      } else if (local < 0.18 + spike.hold) {
        scale = 1;
      } else {
        const sink = (local - 0.18 - spike.hold) / 0.5;
        scale = Math.max(0, 1 - sink);
      }
      mesh.scale.set(0.8 + spike.height * 0.18, Math.max(0.001, scale * spike.height), 0.8 + spike.height * 0.18);
      mesh.material.emissiveIntensity = 0.55 + flash * 1.6;
    }
    if (state.t > 3.2) {
      for (const spike of state.spikes) spike.mesh.visible = false;
      return true;
    }
    return false;
  }

  /* -- E 落炎陨石 -- */
  _castFire(from, to, onImpact) {
    const dir = this._scratchDir
      .set(to.x - from.x, 0, to.z - from.z)
      .normalize();
    const start = to.clone().addScaledVector(dir, -9).add(new THREE.Vector3(0, 17, 0));
    this._meteor.position.copy(start);
    this._meteor.visible = true;
    this._meteorLight.position.copy(start);
    this._meteorLight.intensity = 130;
    this._active.push({
      type: 'fire',
      t: 0,
      duration: 0.62,
      start,
      point: to.clone(),
      fired: false,
      onImpact
    });
  }

  _tickFire(state, dt) {
    state.t += dt;
    const k = Math.min(1, state.t / state.duration);
    // 二次缓入：越坠越快
    const e = k * k;
    this._meteor.position.lerpVectors(state.start, state.point, e);
    this._meteor.rotation.x += dt * 7;
    this._meteor.rotation.z += dt * 5;
    this._meteor.position.y += Math.sin(state.t * 30) * 0.02;
    this._meteorLight.position.copy(this._meteor.position);
    this._meteorLight.intensity = 130;

    // 火尾
    if (Math.random() < 0.9) {
      this.bursts.emit({
        pos: this._meteor.position, count: 3, speed: [0.5, 2], up: [0.5, 2], life: [0.25, 0.6],
        size: [10, 26], colorA: '#fff3d0', colorB: '#ff5410', gravity: 2, drag: 2.5, spread: 0.3
      });
    }

    if (k >= 1 && !state.fired) {
      state.fired = true;
      this._meteor.visible = false;
      this._meteorLight.intensity = 0;
      this.wave.trigger(state.point, '#ff8a3c', 6.5);
      this.bursts.emit({
        pos: state.point, count: 150, speed: [4, 13], up: [3, 12], life: [0.4, 1.2],
        size: [10, 26], colorA: '#fff3d0', colorB: '#ff4408', gravity: -11, drag: 1.1
      });
      this._flash(state.point, '#ffb066', 220);
      this._layScorch(state.point);
      state.onImpact(state.point, 5.4);
    }
    if (state.fired) {
      this._meteorLight.intensity *= Math.max(0, 1 - dt * 7);
      if (state.t > state.duration + 2.2) return true;
    }
    return false;
  }

  _layScorch(point) {
    const slot = this._scorch[this._scorchCursor];
    this._scorchCursor = (this._scorchCursor + 1) % this._scorch.length;
    slot.mesh.position.set(point.x, 0.04, point.z);
    slot.mesh.material.opacity = 0.5;
    slot.mesh.visible = true;
    slot.life = 7;
  }

  /* -- R 天雷殛灭 -- */
  _castStorm(point, onImpact) {
    this._active.push({
      type: 'storm',
      t: 0,
      point: point.clone(),
      fired: false,
      regen: 0,
      onImpact
    });
  }

  _buildBolt(point) {
    // 清掉旧的
    for (const child of this._bolt.children) child.geometry.dispose();
    this._bolt.clear();

    const segments = 9;
    const top = new THREE.Vector3(
      point.x + (Math.random() - 0.5) * 2.5,
      21,
      point.z + (Math.random() - 0.5) * 2.5
    );

    const makeTube = (points, radius) =>
      new THREE.Mesh(
        new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 28, radius, 5, false),
        this._boltMaterial
      );

    const main = [top.clone()];
    for (let i = 1; i < segments; i++) {
      const k = i / segments;
      main.push(new THREE.Vector3(
        lerp(top.x, point.x, k) + (Math.random() - 0.5) * 1.7 * (1 - k * 0.5),
        lerp(top.y, 0.1, k),
        lerp(top.z, point.z, k) + (Math.random() - 0.5) * 1.7 * (1 - k * 0.5)
      ));
    }
    main.push(new THREE.Vector3(point.x, 0.05, point.z));
    this._bolt.add(makeTube(main, 0.09));

    // 两道分支
    for (let b = 0; b < 2; b++) {
      const at = 0.3 + Math.random() * 0.4;
      const idx = Math.floor(at * (main.length - 2));
      const branchPoints = [main[idx].clone()];
      let cursor = main[idx].clone();
      const outAngle = Math.random() * Math.PI * 2;
      for (let s = 0; s < 3; s++) {
        cursor = cursor.clone().add(new THREE.Vector3(
          Math.cos(outAngle) * 1.2 + (Math.random() - 0.5) * 0.8,
          -(main[idx].y / 3.2),
          Math.sin(outAngle) * 1.2 + (Math.random() - 0.5) * 0.8
        ));
        if (cursor.y < 0.05) cursor.y = 0.05;
        branchPoints.push(cursor.clone());
      }
      this._bolt.add(makeTube(branchPoints, 0.04));
    }
  }

  _tickStorm(state, dt) {
    state.t += dt;
    // 0.15 秒预警微光 → 落雷
    if (!state.fired && state.t >= 0.15) {
      state.fired = true;
      this._boltLight.position.set(state.point.x, 6, state.point.z);
      this.wave.trigger(state.point, '#a98bff', 5.5);
      this.bursts.emit({
        pos: state.point, count: 120, speed: [5, 14], up: [4, 12], life: [0.3, 0.9],
        size: [8, 22], colorA: '#ffffff', colorB: '#8f6bff', gravity: -13, drag: 1.0
      });
      this._flash(state.point, '#c9b8ff', 260);
      state.onImpact(state.point, 5.0);
    }
    if (state.fired) {
      this._bolt.visible = true;
      state.regen -= dt;
      if (state.regen <= 0) {
        this._buildBolt(state.point);
        state.regen = 0.07;
      }
      // 抖闪
      this._boltMaterial.opacity = 0.65 + Math.random() * 0.35;
      this._boltLight.intensity = Math.max(0, 260 * (1 - (state.t - 0.15) / 0.5));
      this._boltLight.position.y = 4;
      if (state.t > 0.62) {
        this._bolt.visible = false;
        this._boltLight.intensity = 0;
        return true;
      }
    }
    return false;
  }

  /* -- 命中闪光 -- */
  _flash(point, color, intensity) {
    if (!this._light) {
      this._light = new THREE.PointLight(color, 0, 30, 2);
      this.scene.add(this._light);
    }
    this._light.color.set(color);
    this._light.position.set(point.x, 2.6, point.z);
    this._light.intensity = intensity;
    this._flashT = 0.22;
    this._flashIntensity = intensity;
  }

  /** 重新开始：清空所有进行中的法术与残留效果。 */
  reset() {
    this._active.length = 0;
    for (const spike of this._spikes) spike.mesh.visible = false;
    this._meteor.visible = false;
    this._meteorLight.intensity = 0;
    this._bolt.visible = false;
    for (const child of this._bolt.children) child.geometry?.dispose?.();
    this._bolt.clear();
    this._boltLight.intensity = 0;
    if (this._light) this._light.intensity = 0;
    this._flashT = 0;
    for (const scorch of this._scorch) scorch.mesh.visible = false;
    this.wave.hide();
    this.bursts.clear();
  }

  update(dt) {
    for (let i = this._active.length - 1; i >= 0; i--) {
      const state = this._active[i];
      const done =
        state.type === 'ice' ? this._tickIce(state, dt)
        : state.type === 'fire' ? this._tickFire(state, dt)
        : state.type === 'basic' ? this._tickBasic(state, dt)
        : this._tickStorm(state, dt);
      if (done) this._active.splice(i, 1);
    }

    // 命中闪光衰减
    if (this._flashT > 0) {
      this._flashT -= dt;
      this._light.intensity = Math.max(0, (this._flashT / 0.22) * this._flashIntensity);
    }

    // 焦痕淡出
    for (const scorch of this._scorch) {
      if (!scorch.mesh.visible) continue;
      scorch.life -= dt;
      scorch.mesh.material.opacity = Math.max(0, Math.min(0.5, scorch.life * 0.09));
      if (scorch.life <= 0) scorch.mesh.visible = false;
    }

    this.bursts.update(dt);
    this.wave.update(dt);
  }

  dispose() {
    this.bursts.dispose();
    this.wave.dispose();
    for (const spike of this._spikes) spike.mesh.geometry.dispose();
    this._meteor.geometry.dispose();
    for (const scorch of this._scorch) scorch.mesh.geometry.dispose();
    for (const child of this._bolt.children) child.geometry?.dispose?.();
    for (const ball of this._balls) {
      ball.group.traverse((o) => o.geometry?.dispose?.());
      ball.core.material.dispose();
      ball.shell.material.dispose();
      ball.halo.material.dispose();
    }
    this._ballHaloTexture.dispose();
  }
}
