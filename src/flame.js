import * as THREE from 'three';

/**
 * flame.js — 共享的元素火焰粒子池（圣杯 + 环边火炬共用）。
 *
 * 真实火焰的温度渐变：粒子生成瞬间白热 → 元素色主体 → 暗色枯竭尖端，
 * 随生命进度插值；亮度快进慢出；火舌带随机摆动。
 */

export function makeGlowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export class FlamePool {
  constructor(scene, max, texture, additive) {
    this.max = max;
    this.list = []; // 粒子对象（见 spawnFlameParticle）
    this._pos = new Float32Array(max * 3);
    this._col = new Float32Array(max * 3);
    this._alpha = new Float32Array(max);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this._pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this._col, 3));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this._alpha, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: { uMap: { value: texture }, uProjScale: { value: 800 } },
      vertexShader: /* glsl */ `
        uniform float uProjScale;
        attribute float aSize;
        attribute vec3 aColor;
        attribute float aAlpha;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = aColor;
          vAlpha = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize * uProjScale / max(-mv.z, 0.1);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vec4 tex = texture2D(uMap, gl_PointCoord);
          float a = tex.a * vAlpha;
          if (a < 0.004) discard;
          gl_FragColor = vec4(vColor * tex.rgb, a);
          #include <colorspace_fragment>
        }
      `
    });
    this._size = new Float32Array(max);
    geo.setAttribute('aSize', new THREE.BufferAttribute(this._size, 1));
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 12;
    scene.add(this.points);
    this.geometry = geo;
  }

  setPixelRatio(r) {
    this.points.material.uniforms.uProjScale.value = window.innerHeight * r * 1.123; // h / (2·tan(fov/2))
  }

  push(p) {
    if (this.list.length >= this.max) this.list.shift();
    this.list.push(p);
  }

  update(dt, elapsed) {
    // 积分 + 写属性，死亡粒子用末位交换移除
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      p.life -= dt;
      if (p.life <= 0) { this.list.splice(i, 1); continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      if (p.sway) p.x += Math.sin(elapsed * 9 + p.phase) * 0.35 * dt; // 火舌随机摆动
    }
    for (let i = 0; i < this.max; i++) {
      if (i < this.list.length) {
        const p = this.list[i];
        const t = 1 - p.life / p.maxLife; // 0→1 生命进度
        this._pos[i * 3] = p.x;
        this._pos[i * 3 + 1] = p.y;
        this._pos[i * 3 + 2] = p.z;
        // 温度渐变：白热 → 元素色 → 暗端，随生命进度插值
        let cr, cg, cb;
        if (t < 0.35) {
          const k = t / 0.35;
          cr = p.r0 + (p.r1 - p.r0) * k;
          cg = p.g0 + (p.g1 - p.g0) * k;
          cb = p.b0 + (p.b1 - p.b0) * k;
        } else {
          const k = (t - 0.35) / 0.65;
          cr = p.r1 + (p.r2 - p.r1) * k;
          cg = p.g1 + (p.g2 - p.g1) * k;
          cb = p.b1 + (p.b2 - p.b1) * k;
        }
        this._col[i * 3] = cr;
        this._col[i * 3 + 1] = cg;
        this._col[i * 3 + 2] = cb;
        this._size[i] = p.size0 + (p.size1 - p.size0) * t;
        // 快速淡入、缓慢枯竭淡出
        this._alpha[i] = p.alpha * Math.min(1, t * 6) * Math.pow(1 - t, 1.1);
      } else {
        this._alpha[i] = 0;
        this._size[i] = 0;
      }
    }
    // 只画活跃粒子：死亡槽位（alpha=0）不送入顶点着色器
    this.geometry.setDrawRange(0, this.list.length);
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aColor.needsUpdate = true;
    this.geometry.attributes.aAlpha.needsUpdate = true;
    this.geometry.attributes.aSize.needsUpdate = true;
  }
}

/** 生成一颗火粒子（三段温度渐变：白热 → 元素色 → 暗端）。
 *  opts 可覆盖速度 / 生命 / 尺寸 / 亮度（小火把传缩小参数）。 */
export function spawnFlameParticle(pool, x, y, z, col, opts = {}) {
  if (pool.list.length >= pool.max) pool.list.shift();
  const white = 0.55;
  pool.list.push({
    x, y, z,
    vx: (Math.random() - 0.5) * 0.9,
    vy: 1.3 + Math.random() * 1.1,
    vz: (Math.random() - 0.5) * 0.9,
    life: 0.7 + Math.random() * 0.6,
    maxLife: 1.3,
    size0: 1.9, size1: 0.55,
    alpha: 0.8,
    phase: Math.random() * Math.PI * 2,
    sway: true,
    r0: col.r + (1 - col.r) * white,
    g0: col.g + (1 - col.g) * white,
    b0: col.b + (1 - col.b) * white,
    r1: col.r, g1: col.g, b1: col.b,
    r2: col.r * 0.32, g2: col.g * 0.3, b2: col.b * 0.38,
    ...opts
  });
}
