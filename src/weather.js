import * as THREE from 'three';

const COUNT = 2400;      // 点状天气（雪/余烬/电花）粒子数
const RAIN_COUNT = 1100; // 雨线条数
const AREA = 56;
const HEIGHT = 17;

/**
 * weather.js — 领域天气（主天气 + 副天气）。
 *
 * 冰封 = 大雪（主）；烈焰 = 浓雾（主，地面雾板 + 雾距收紧）+ 飘升余烬（副）；
 * 雷暴 = 雨幕（主，拉丝雨线）+ 空气放电（副）。运动全部在顶点着色器里完成，
 * CPU 每帧只写几个 uniform；每种天气都是一次绘制调用，强度平滑 damp 进出。
 */

const MODES = {
  snow: {
    body: /* glsl */ `
      float fall = 0.32 + aSeed * 0.62;   // 大雪片慢慢飘
      p.y = mod(p.y - uTime * fall, uH);
      p.x += sin(uTime * (0.4 + aSeed * 0.45) + aSeed * 6.283) * (0.9 + aSeed * 1.6);
      p.z += cos(uTime * (0.35 + aSeed * 0.4) + aSeed * 9.1) * (0.9 + aSeed * 1.5);
      p.x += sin(uTime * (1.7 + aSeed) + aSeed * 40.0) * 0.25; // 小幅扑翼
      vTw = 0.8 + 0.2 * sin(uTime * (0.8 + aSeed * 1.6) + aSeed * 30.0);
      vCol = mix(vec3(1.0), vec3(0.78, 0.9, 1.0), aSeed);
      vSz = 1.9 + aSeed * 1.9;             // 又大又软
    `,
    alpha: 0.95
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
    this._primary = 'none';
    this._secondary = 'none';
    this._systems = new Map();

    /* —— 点状天气（雪 / 余烬 / 电花） —— */
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
      this._systems.set(mode, { obj: points, material, intensity: 0, isLine: false });
    }

    /* —— 雨幕：LineSegments，每滴两顶点拉成斜丝，快速坠落 —— */
    {
      const geometry = new THREE.BufferGeometry();
      const positions = new Float32Array(RAIN_COUNT * 2 * 3);
      const seeds = new Float32Array(RAIN_COUNT * 2);
      const tips = new Float32Array(RAIN_COUNT * 2);
      for (let i = 0; i < RAIN_COUNT; i++) {
        const x = (Math.random() - 0.5) * AREA;
        const y = Math.random() * HEIGHT;
        const z = (Math.random() - 0.5) * AREA;
        const seed = Math.random();
        for (let v = 0; v < 2; v++) {
          const j = (i * 2 + v) * 3;
          positions[j] = x; positions[j + 1] = y; positions[j + 2] = z;
          seeds[i * 2 + v] = seed;
          tips[i * 2 + v] = v; // 0=滴头 1=滴尾
        }
      }
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
      geometry.setAttribute('aTip', new THREE.BufferAttribute(tips, 1));
      geometry.boundingSphere = null;

      const material = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
        uniforms: {
          uTime: { value: 0 },
          uIntensity: { value: 0 },
          uH: { value: HEIGHT }
        },
        vertexShader: /* glsl */ `
          uniform float uTime;
          uniform float uH;
          attribute float aSeed;
          attribute float aTip;
          varying float vA;

          void main() {
            vec3 p = position;
            float fall = 13.0 + aSeed * 9.0;
            p.y = mod(p.y - uTime * fall, uH);
            // 微风斜落的雨丝：滴尾沿运动反方向拉长
            float slantX = 0.55 + aSeed * 0.25;
            p.x += aTip * 0.12 * slantX;
            p.y += aTip * (0.5 + aSeed * 0.25);
            vec4 mv = modelViewMatrix * vec4(p, 1.0);
            float dist = -mv.z;
            vA = smoothstep(65.0, 10.0, dist) * smoothstep(0.4, 3.0, dist);
            gl_Position = projectionMatrix * mv;
          }
        `,
        fragmentShader: /* glsl */ `
          uniform float uIntensity;
          varying float vA;

          void main() {
            float a = 0.34 * vA * uIntensity;
            if (a < 0.004) discard;
            gl_FragColor = vec4(vec3(0.72, 0.82, 1.0), a);
            #include <colorspace_fragment>
          }
        `
      });

      const lines = new THREE.LineSegments(geometry, material);
      lines.frustumCulled = false;
      lines.visible = false;
      scene.add(lines);
      this._systems.set('rain', { obj: lines, material, intensity: 0, isLine: true });
    }

    /* —— 浓雾层（烈焰领域）：四块大幅雾板自低到高堆叠，噪声 alpha 缓滚 —— */
    {
      const FOG_LAYER_Y = [0.35, 0.8, 1.45, 2.3];
      const FOG_LAYER_ALPHA = [0.36, 0.34, 0.3, 0.26];
      const FOG_LAYER_R = [54, 50, 46, 40];
      this._fogMaterials = [];
      for (let k = 0; k < FOG_LAYER_Y.length; k++) {
        const material = new THREE.ShaderMaterial({
          transparent: true,
          depthWrite: false,
          blending: THREE.NormalBlending,
          fog: false,
          side: THREE.DoubleSide,
          uniforms: {
            uTime: { value: 0 },
            uIntensity: { value: 0 },
            uPhase: { value: k * 37.0 }
          },
          vertexShader: /* glsl */ `
            varying vec2 vUv;
            varying float vDist;
            void main() {
              vUv = uv;
              vec4 world = modelMatrix * vec4(position, 1.0);
              vec4 mv = viewMatrix * world;
              vDist = -mv.z;
              gl_Position = projectionMatrix * mv;
            }
          `,
          fragmentShader: /* glsl */ `
            uniform float uTime;
            uniform float uIntensity;
            uniform float uPhase;
            varying vec2 vUv;
            varying float vDist;

            float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
            float valueNoise(vec2 p) {
              vec2 i = floor(p); vec2 f = fract(p);
              vec2 u = f * f * (3.0 - 2.0 * f);
              return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
                         mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
            }
            float fbm(vec2 p) {
              float v = 0.0; float a = 0.5;
              for (int k = 0; k < 3; k++) { v += a * valueNoise(p); p = p * 2.13 + vec2(11.3, 7.1); a *= 0.5; }
              return v;
            }

            void main() {
              // 两层噪声朝不同方向缓慢翻滚 —— 雾的"流动感"
              vec2 drift = vec2(uTime * 0.014, uTime * 0.008);
              float n1 = fbm(vUv * 7.0 + drift + uPhase);
              float n2 = fbm(vUv * 13.0 - drift * 1.7 + uPhase * 2.0);
              float density = smoothstep(0.14, 0.72, n1 * 0.72 + n2 * 0.42);
              // 边缘淡出，遮住雾板圆形边界
              float edge = smoothstep(0.5, 0.3, length(vUv - 0.5));
              float dist = smoothstep(75.0, 14.0, vDist) * smoothstep(0.6, 3.0, vDist);
              float a = density * edge * dist * uIntensity * ${FOG_LAYER_ALPHA[k].toFixed(2)};
              if (a < 0.004) discard;
              // 暖灰雾色，微随噪声起伏
              vec3 col = mix(vec3(0.3, 0.16, 0.09), vec3(0.46, 0.27, 0.15), n1);
              gl_FragColor = vec4(col, a);
              #include <colorspace_fragment>
            }
          `
        });
        const mesh = new THREE.Mesh(new THREE.CircleGeometry(FOG_LAYER_R[k], 48), material);
        mesh.rotation.x = -Math.PI / 2;
        mesh.position.y = FOG_LAYER_Y[k];
        mesh.renderOrder = 5;
        mesh.frustumCulled = false;
        mesh.visible = false;
        scene.add(mesh);
        this._fogMaterials.push({ mesh, material, intensity: 0 });
      }
    }

    /* —— 丁达尔光束（烈焰领域）：同一光源方向、互相平行的暖光柱，
     *    圆柱体积（假体积光：法线朝向镜头处最亮，轮廓处自然衰减），
     *    固定在场地坐标里（不跟随玩家），缓慢呼吸 —— */
    {
      const RAY_COUNT = 9;
      const RAY_TILT = 0.16; // 统一倾角：所有光束平行，像来自同一光源
      this._rayGroup = new THREE.Group();
      this._rayMaterials = [];
      for (let k = 0; k < RAY_COUNT; k++) {
        const rt = 1.3 + Math.random() * 1.1;  // 顶部半径
        const rb = rt * (1.12 + Math.random() * 0.3); // 底部微张（光落进雾里摊开）
        const material = new THREE.ShaderMaterial({
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
          fog: false,
          uniforms: {
            uTime: { value: 0 },
            uIntensity: { value: 0 },
            uSeed: { value: Math.random() * 100 }
          },
          vertexShader: /* glsl */ `
            varying vec2 vUv;
            varying vec3 vN;
            varying vec3 vW;
            varying float vDist;
            void main() {
              vUv = uv;
              vN = normalize(mat3(modelMatrix) * normal);
              vec4 wp = modelMatrix * vec4(position, 1.0);
              vW = wp.xyz;
              vec4 mv = viewMatrix * wp;
              vDist = -mv.z;
              gl_Position = projectionMatrix * mv;
            }
          `,
          fragmentShader: /* glsl */ `
            uniform float uTime;
            uniform float uIntensity;
            uniform float uSeed;
            varying vec2 vUv;
            varying vec3 vN;
            varying vec3 vW;
            varying float vDist;

            float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
            float noise(vec2 p) {
              vec2 i = floor(p); vec2 f = fract(p);
              vec2 u = f * f * (3.0 - 2.0 * f);
              return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
                         mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
            }

            void main() {
              // 体积感核心：柱面正对镜头的水平方向最亮（视线穿过介质最厚），
              // 轮廓处衰减为 0。只用水平分量——俯视/仰视都有圆柱体积感
              vec3 V = normalize(cameraPosition - vW);
              vec3 Vh = V - vec3(0.0, 1.0, 0.0) * dot(V, vec3(0.0, 1.0, 0.0));
              float hl = length(Vh);
              float facing = hl > 0.001 ? abs(dot(normalize(vN), Vh / hl)) : 1.0;
              float body = pow(facing, 1.7);
              // 上亮下不灭：高俯视相机主要看到光柱下半段，底部保留 35% 亮度
              float grad = 0.35 + 0.65 * pow(vUv.y, 1.1);
              // 环向缓慢流动的云隙闪烁（光柱里的尘埃在动）
              float n = noise(vec2(vUv.x * 6.0 + uSeed, vUv.y * 1.6 - uTime * 0.05));
              n = 0.45 + 0.55 * n;
              float a = body * grad * n * uIntensity * 0.3;
              a *= smoothstep(75.0, 18.0, vDist) * smoothstep(1.5, 6.0, vDist);
              if (a < 0.004) discard;
              vec3 col = mix(vec3(1.0, 0.58, 0.26), vec3(1.0, 0.84, 0.58), n);
              gl_FragColor = vec4(col, a);
              #include <colorspace_fragment>
            }
          `
        });
        const mesh = new THREE.Mesh(
          new THREE.CylinderGeometry(rt, rb, 19, 28, 1, true),
          material
        );
        const ang = (k / RAY_COUNT) * Math.PI * 2 + Math.random() * 0.6;
        const rad = 10 + Math.random() * 40; // 铺满整个场地（固定于场地坐标）
        mesh.position.set(Math.sin(ang) * rad, 8.5, Math.cos(ang) * rad);
        // ZYX 欧拉序：统一倾斜 —— 倾斜在世界空间里同向，光束平行
        mesh.rotation.order = 'ZYX';
        mesh.rotation.z = RAY_TILT;
        mesh.renderOrder = 6;
        mesh.frustumCulled = false;
        mesh.visible = false;
        this._rayGroup.add(mesh);
        this._rayMaterials.push({ mesh, material, intensity: 0 });
      }
      scene.add(this._rayGroup);
    }
  }

  /** 主天气 + 副天气（副天气强度 damp 到 0.55）。'fog' 作用于地面雾板。 */
  setMode(primary, secondary = 'none') {
    this._primary = primary || 'none';
    this._secondary = secondary || 'none';
  }

  setPixelRatio(ratio) {
    for (const system of this._systems.values()) {
      system.material.uniforms.uPixelRatio && (system.material.uniforms.uPixelRatio.value = ratio);
    }
  }

  update(dt, elapsed, anchor) {
    /* 粒子/雨线系统 */
    for (const [mode, system] of this._systems) {
      let target = 0;
      if (mode === this._primary) target = 1;
      else if (mode === this._secondary) target = 0.55;
      const rate = target > system.intensity ? 0.55 : 0.8;
      system.intensity += (target - system.intensity) * Math.min(1, dt * rate);
      if (system.intensity < 0.004) {
        system.obj.visible = false;
        continue;
      }
      system.obj.visible = true;
      system.material.uniforms.uTime.value = elapsed;
      system.material.uniforms.uIntensity.value = system.intensity;
      if (anchor) system.obj.position.set(anchor.x, 0, anchor.z);
    }

    /* 地面浓雾板：固定于场地中心，不跟随玩家 */
    const fogTarget = this._primary === 'fog' ? 1 : 0;
    for (const layer of this._fogMaterials) {
      layer.intensity += (fogTarget - layer.intensity) * Math.min(1, dt * (fogTarget > layer.intensity ? 0.4 : 0.6));
      if (layer.intensity < 0.004) {
        layer.mesh.visible = false;
        continue;
      }
      layer.mesh.visible = true;
      layer.material.uniforms.uTime.value = elapsed;
      layer.material.uniforms.uIntensity.value = layer.intensity;
    }

    /* 丁达尔光束：随浓雾淡入，亮度缓慢呼吸；固定于场地坐标，不跟随玩家 */
    this._rayPhase = (this._rayPhase ?? 0) + (fogTarget - (this._rayPhase ?? 0)) * Math.min(1, dt * 0.35);
    for (const [k, layer] of this._rayMaterials.entries()) {
      if (this._rayPhase < 0.004) {
        layer.mesh.visible = false;
        continue;
      }
      layer.mesh.visible = true;
      layer.material.uniforms.uTime.value = elapsed;
      layer.material.uniforms.uIntensity.value = this._rayPhase * (0.8 + 0.2 * Math.sin(elapsed * 0.35 + k * 2.1));
    }
  }

  dispose() {
    for (const system of this._systems.values()) {
      this.scene.remove(system.obj);
      system.obj.geometry.dispose();
      system.material.dispose();
    }
    this._systems.clear();
    for (const layer of this._fogMaterials) {
      this.scene.remove(layer.mesh);
      layer.mesh.geometry.dispose();
      layer.material.dispose();
    }
    this._fogMaterials.length = 0;
    for (const layer of this._rayMaterials) {
      layer.mesh.geometry.dispose();
      layer.material.dispose();
    }
    this.scene.remove(this._rayGroup);
    this._rayMaterials.length = 0;
  }
}
