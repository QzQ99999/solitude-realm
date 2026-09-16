import * as THREE from 'three';

/**
 * ground.js — 程序化元素大地。
 *
 * 一张大圆盘，着色器里用 4 层 value noise 做地形明暗，再用"脊线噪声"挖出
 * 贯穿地表的元素纹路（冰原上的幽蓝冰脉、火山的熔岩裂缝、雷暴地的电弧纹），
 * 纹路颜色与强度随主题过渡插值，并随时间脉动 —— 世界改写时大地真的会"亮起
 * 另一种纹路"。边缘按距离混入雾色，与场景雾自然衔接。
 */
export class Ground {
  constructor(scene) {
    this.uniforms = {
      uBase: { value: new THREE.Color('#252e3a') },
      uAccent: { value: new THREE.Color('#446080') },
      uVein: { value: 0.22 },
      uKey: { value: new THREE.Color('#bcd2ff') },
      uAmb: { value: new THREE.Color('#334e78') },
      uFog: { value: new THREE.Color('#141c28') },
      uFogNear: { value: 26 },
      uFogFar: { value: 100 },
      uTime: { value: 0 }
    };

    const material = new THREE.ShaderMaterial({
      fog: false,
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vWorld = world.xyz;
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uBase;
        uniform vec3 uAccent;
        uniform float uVein;
        uniform vec3 uKey;
        uniform vec3 uAmb;
        uniform vec3 uFog;
        uniform float uFogNear;
        uniform float uFogFar;
        uniform float uTime;
        varying vec3 vWorld;

        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }

        float valueNoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
            mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
            u.y
          );
        }

        float fbm(vec2 p) {
          // 深渊底层在雾色深处，2 层噪声足够，省下的填充率留给游玩画面
          float v = 0.0;
          float a = 0.5;
          for (int k = 0; k < 2; k++) {
            v += a * valueNoise(p);
            p = p * 2.03 + vec2(17.3, 9.1);
            a *= 0.5;
          }
          return v;
        }

        void main() {
          vec2 xz = vWorld.xz;

          // 地形明暗
          float macro = fbm(xz * 0.045);
          vec3 col = uBase * (0.72 + 0.55 * macro);

          // 细碎斑驳
          float detail = fbm(xz * 0.6);
          col *= 0.9 + 0.2 * detail;

          // 元素纹路：脊线噪声 —— 取 fbm 到中心线的距离，挤压成发亮的细脉
          float ridge = 1.0 - abs(2.0 * fbm(xz * 0.16 + macro * 1.7) - 1.0);
          float vein = pow(ridge, 7.0);
          float pulse = 0.6 + 0.4 * sin(uTime * 1.4 + macro * 9.0);
          col += uAccent * vein * uVein * (0.55 + 0.75 * pulse);

          // 简化光照：天光 + 来自上方的微弱主光
          col *= (uAmb * 1.15 + uKey * 0.16);

          // 距离雾：与世界雾色衔接
          float dist = distance(cameraPosition, vWorld);
          float f = smoothstep(uFogNear, uFogFar, dist);
          col = mix(col, uFog, f);

          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `
    });

    this.mesh = new THREE.Mesh(new THREE.CircleGeometry(150, 72), material);
    this.mesh.rotation.x = -Math.PI / 2;
    scene.add(this.mesh);
  }

  update(elapsed) {
    this.uniforms.uTime.value = elapsed;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
