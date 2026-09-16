import * as THREE from 'three';

const COUNT = 1400;
const AREA = 56;
const HEIGHT = 17;

/**
 * weather.js — 领域天气。
 *
 * 三套 GPU 粒子场（雪 / 余烬 / 电花），各自是一条 Points 绘制调用。当前领域
 * 对应的那套强度 damp 到 1，其余 damp 到 0，世界改写时旧天气退散、新天气
 * 卷入。运动全部在顶点着色器里完成，CPU 每帧只写几个 uniform。
 */

const MODES = {
  snow: {
    body: /* glsl */ `
      float fall = 0.5 + aSeed * 0.85;
      p.y = mod(p.y - uTime * fall, uH);
      p.x += sin(uTime * (0.5 + aSeed * 0.5) + aSeed * 6.283) * (0.5 + aSeed * 1.0);
      p.z += cos(uTime * (0.45 + aSeed * 0.4) + aSeed * 9.1) * (0.5 + aSeed * 1.0);
      vTw = 0.7 + 0.3 * sin(uTime * (1.0 + aSeed * 2.0) + aSeed * 30.0);
      vCol = mix(vec3(1.0), vec3(0.75, 0.9, 1.0), aSeed);
      vSz = 1.0 + aSeed * 0.8;
    `,
    alpha: 0.75
  },
  embers: {
    body: /* glsl */ `
      float rise = 0.6 + aSeed * 1.6;
      p.y = mod(p.y + uTime * rise, uH);
      p.x += sin(uTime * (0.7 + aSeed * 0.6) + aSeed * 5.1) * (0.4 + aSeed * 0.9);
      p.z += cos(uTime * (0.6 + aSeed * 0.5) + aSeed * 7.6) * (0.4 + aSeed * 0.9);
      vTw = 0.35 + 0.65 * sin(uTime * (2.4 + aSeed * 4.0) + aSeed * 50.0);
      vCol = mix(vec3(1.0, 0.83, 0.45), vec3(1.0, 0.33, 0.1), aSeed * aSeed);
      vSz = 0.7 + aSeed * 0.8;
    `,
    alpha: 0.8
  },
  sparks: {
    body: /* glsl */ `
      float rise = 0.3 + aSeed * 0.7;
      p.y = mod(p.y + uTime * rise, uH);
      p.x += sin(uTime * (5.0 + aSeed * 4.0) + aSeed * 97.0) * 0.6;
      p.z += cos(uTime * (4.6 + aSeed * 3.4) + aSeed * 61.0) * 0.6;
      // 硬闪烁：大部分时间暗淡，偶尔猛地炸亮 —— 读作"空气里在放电"。
      float blink = pow(0.5 + 0.5 * sin(uTime * (3.0 + aSeed * 6.0) + aSeed * 80.0), 6.0);
      vTw = 0.1 + 1.6 * blink;
      vCol = mix(vec3(0.8, 0.88, 1.0), vec3(0.58, 0.42, 1.0), aSeed);
      vSz = 0.6 + aSeed * 0.7;
    `,
    alpha: 0.85
  }
};

export class Weather {
  constructor(scene) {
    this.scene = scene;
    this._mode = 'none';
    this._systems = new Map();

    for (const [mode, def] of Object.entries(MODES)) {
      const geometry = new THREE.BufferGeometry();
      const positions = new Float32Array(COUNT * 3);
      const seeds = new Float32Array(COUNT);

      for (let i = 0; i < COUNT; i++) {
        positions[i * 3 + 0] = (Math.random() - 0.5) * AREA;
        positions[i * 3 + 1] = Math.random() * HEIGHT;
        positions[i * 3 + 2] = (Math.random() - 0.5) * AREA;
        seeds[i] = Math.random();
      }
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
      geometry.boundingSphere = null;

      const material = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
        uniforms: {
          uTime: { value: 0 },
          uIntensity: { value: 0 },
          uH: { value: HEIGHT },
          uPixelRatio: { value: 1 }
        },
        vertexShader: /* glsl */ `
          uniform float uTime;
          uniform float uH;
          uniform float uPixelRatio;
          attribute float aSeed;
          varying float vA;
          varying vec3 vCol;
          varying float vTw;
          varying float vSz;

          void main() {
            vec3 p = position;
            ${def.body}
            vec4 mv = modelViewMatrix * vec4(p, 1.0);
            float dist = -mv.z;
            vA = smoothstep(70.0, 12.0, dist) * smoothstep(0.4, 4.0, dist);
            gl_Position = projectionMatrix * mv;
            gl_PointSize = 20.0 * uPixelRatio * vSz / max(dist, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform float uIntensity;
          varying float vA;
          varying vec3 vCol;
          varying float vTw;

          void main() {
            float d = length(gl_PointCoord - 0.5);
            if (d > 0.5) discard;
            float a = smoothstep(0.5, 0.05, d) * vA * vTw * uIntensity * ${def.alpha.toFixed(2)};
            if (a < 0.004) discard;
            gl_FragColor = vec4(vCol, a);
            #include <colorspace_fragment>
          }
        `
      });

      const points = new THREE.Points(geometry, material);
      points.frustumCulled = false;
      points.visible = false;
      scene.add(points);
      this._systems.set(mode, { points, material, intensity: 0 });
    }
  }

  setMode(mode) {
    this._mode = mode;
  }

  setPixelRatio(ratio) {
    for (const system of this._systems.values()) {
      system.material.uniforms.uPixelRatio.value = ratio;
    }
  }

  update(dt, elapsed, anchor) {
    for (const [mode, system] of this._systems) {
      const target = mode === this._mode ? 1 : 0;
      const rate = target > system.intensity ? 0.55 : 0.8;
      system.intensity += (target - system.intensity) * Math.min(1, dt * rate);
      if (system.intensity < 0.004) {
        system.points.visible = false;
        continue;
      }
      system.points.visible = true;
      system.material.uniforms.uTime.value = elapsed;
      system.material.uniforms.uIntensity.value = system.intensity;
      if (anchor) system.points.position.set(anchor.x, 0, anchor.z);
    }
  }

  dispose() {
    for (const system of this._systems.values()) {
      this.scene.remove(system.points);
      system.points.geometry.dispose();
      system.material.dispose();
    }
    this._systems.clear();
  }
}
