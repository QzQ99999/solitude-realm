import * as THREE from 'three';

/**
 * sky.js — 程序化天空穹顶。
 *
 * 一颗反转法线的大球：着色器里按视线高度混合天顶/地平线两层颜色，加一条
 * 地平线辉光带，再用 cell hash 撒程序化星星（带闪烁）。所有颜色和星星亮度
 * 都是 uniform，世界主题过渡时直接插值 —— 天空因此可以整体"换色"。
 */
export class Sky {
  constructor(scene) {
    this.uniforms = {
      uTop: { value: new THREE.Color('#0b1120') },
      uBottom: { value: new THREE.Color('#1b2534') },
      uHorizon: { value: new THREE.Color('#33475e') },
      uStars: { value: 1.0 },
      uTime: { value: 0 }
    };

    const material = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uTop;
        uniform vec3 uBottom;
        uniform vec3 uHorizon;
        uniform float uStars;
        uniform float uTime;
        varying vec3 vDir;

        float hash(vec3 p) {
          return fract(sin(dot(p, vec3(12.9898, 78.233, 45.164))) * 43758.5453);
        }

        void main() {
          vec3 dir = normalize(vDir);
          float h = dir.y;

          vec3 col = mix(uBottom, uTop, smoothstep(-0.08, 0.6, h));

          // 地平线辉光带：越贴地平线越亮。
          col += uHorizon * pow(1.0 - clamp(abs(h), 0.0, 1.0), 9.0) * 0.75;

          // 程序化星星：把方向空间切成 cell，每颗星星是离 cell 中心的小亮点。
          if (uStars > 0.01 && h > 0.02) {
            vec3 sd = dir * 160.0;
            vec3 cell = floor(sd);
            float rnd = hash(cell);
            if (rnd > 0.972) {
              float d = length(fract(sd) - 0.5);
              float star = smoothstep(0.28, 0.02, d);
              float twinkle = 0.55 + 0.45 * sin(uTime * (1.5 + rnd * 4.0) + rnd * 40.0);
              col += vec3(0.9, 0.95, 1.0) * star * twinkle * uStars * smoothstep(0.02, 0.25, h);
            }
          }

          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `
    });

    // 穹顶罩住整座黑剑竞技场（缩放后场景半径约 250+）
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(700, 32, 20), material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10;
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
