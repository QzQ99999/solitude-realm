import * as THREE from 'three';

/**
 * trail.js — 按住 Shift 贴地飞行时的拖尾光带。
 *
 * 角色飞行时按最小间距记录轨迹点（环形上限），把轨迹连成一条三角带：
 * 头端宽而亮、尾端细而淡，中心白芯过渡到元素色边缘，叠加发光；
 * 松开 Shift 后不再采样，光带自然缩短消散。颜色跟随当前选择的元素。
 */
const MAX_POINTS = 56; // 轨迹点上限
const LIFE = 1.3; // 每个轨迹点的寿命（秒）
const MIN_STEP = 0.18; // 两个采样点之间的最小间距（米）
const WIDTH = 0.62; // 光带头部全宽（米）

export class FlightTrail {
  constructor(scene) {
    this.scene = scene;
    this.uniforms = {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color('#9fd8ff') }
    };

    this._geometry = new THREE.BufferGeometry();
    this._positions = new Float32Array(MAX_POINTS * 2 * 3);
    this._alphas = new Float32Array(MAX_POINTS * 2);
    this._across = new Float32Array(MAX_POINTS * 2);
    const indices = new Uint16Array((MAX_POINTS - 1) * 6);
    for (let i = 0; i < MAX_POINTS - 1; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      indices.set([a, b, c, b, d, c], i * 6);
    }
    this._geometry.setAttribute('position', new THREE.BufferAttribute(this._positions, 3));
    this._geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this._alphas, 1));
    this._geometry.setAttribute('aAcross', new THREE.BufferAttribute(this._across, 1));
    this._geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    this._geometry.setDrawRange(0, 0);

    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        attribute float aAlpha;
        attribute float aAcross;
        varying float vAlpha;
        varying float vAcross;
        void main() {
          vAlpha = aAlpha;
          vAcross = aAcross;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uTime;
        varying float vAlpha;
        varying float vAcross;

        void main() {
          float edge = sin(3.14159265 * vAcross);      // 横向柔边
          float core = smoothstep(0.55, 0.0, abs(vAcross - 0.5)); // 白芯
          float shimmer = 0.82 + 0.18 * sin(uTime * 18.0 + vAcross * 9.0);
          vec3 col = mix(vec3(1.0), uColor, 0.45 + 0.55 * (1.0 - core));
          float a = edge * vAlpha * (0.7 + 0.7 * core) * shimmer;
          if (a < 0.004) discard;
          gl_FragColor = vec4(col * (0.95 + 1.05 * core), a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `
    });

    this._mesh = new THREE.Mesh(this._geometry, material);
    this._mesh.frustumCulled = false;
    this._mesh.renderOrder = 3;
    scene.add(this._mesh);

    this._points = []; // { x, y, z, t }
    this._time = 0;
    this._scratch = new THREE.Color();
  }

  /**
   * @param {number} dt
   * @param {THREE.Vector3|null} pos 飞行中的角色位置（root，含悬浮高度）；null = 未飞行
   * @param {string} accent 当前元素强调色
   */
  update(dt, pos, accent) {
    this._time += dt;
    this.uniforms.uTime.value = this._time;
    this.uniforms.uColor.value.lerp(this._scratch.set(accent), Math.min(1, dt * 8));

    const points = this._points;
    // 丢弃过期点
    while (points.length && this._time - points[0].t > LIFE) points.shift();
    // 飞行中且移动足够远才采样：原地悬停时光带自然缩短
    if (pos) {
      const last = points[points.length - 1];
      if (!last || (pos.x - last.x) ** 2 + (pos.z - last.z) ** 2 > MIN_STEP * MIN_STEP) {
        points.push({ x: pos.x, y: pos.y, z: pos.z, t: this._time });
        if (points.length > MAX_POINTS) points.shift();
      }
    }

    this._rebuild();
  }

  /** 把轨迹点写成三角带顶点（左右各一，宽度随寿命收窄）。 */
  _rebuild() {
    const points = this._points;
    const n = points.length;
    const pos = this._positions;
    const alp = this._alphas;
    const acr = this._across;

    for (let i = 0; i < n; i++) {
      const p = points[i];
      const age = this._time - p.t;
      const fade = Math.pow(1 - age / LIFE, 1.35);
      // 方向取前后邻点的连线，静止段用上一点方向
      const prev = points[Math.max(0, i - 1)];
      const next = points[Math.min(n - 1, i + 1)];
      let dx = next.x - prev.x;
      let dz = next.z - prev.z;
      const len = Math.hypot(dx, dz) || 1;
      dx /= len; dz /= len;
      const half = (WIDTH * fade) / 2;
      const px = -dz * half;
      const pz = dx * half;

      const o = i * 6;
      pos[o] = p.x + px;     pos[o + 1] = p.y; pos[o + 2] = p.z + pz;
      pos[o + 3] = p.x - px; pos[o + 4] = p.y; pos[o + 5] = p.z - pz;
      const a = Math.pow(fade, 1.15);
      alp[i * 2] = a; alp[i * 2 + 1] = a;
      acr[i * 2] = 0; acr[i * 2 + 1] = 1;
    }

    this._geometry.attributes.position.needsUpdate = true;
    this._geometry.attributes.aAlpha.needsUpdate = true;
    this._geometry.attributes.aAcross.needsUpdate = true;
    this._geometry.setDrawRange(0, n > 1 ? (n - 1) * 6 : 0);
  }

  dispose() {
    this.scene.remove(this._mesh);
    this._geometry.dispose();
    this._mesh.material.dispose();
  }
}
