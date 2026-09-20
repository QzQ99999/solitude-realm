import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FlamePool, makeGlowTexture, spawnFlameParticle } from './flame.js';
import { NEUTRAL_FLAME_COLOR } from './themes.js';

/* 开始界面的骷髅教徒半身像舞台。
 *
 * 不透明独立场景：开始界面全屏渲染它，完全不透出后面的游戏画面；
 * 鼠标视差：教徒模型跟随鼠标平移/微微转身（立体感），背景幕布反向轻移
 *（DOM 文字保持静止）。
 * begin() 后触发退场：背景幕布原地渐隐透出游戏画面，教徒水平旋转着从
 * 右侧移出（保持不透明）。
 */

// 半身像在画面中的水平基准位（人物略偏右，不出最右侧屏幕）
const BASE_X = 0.42;
const MODEL_HEIGHT = 2.1;
// 手中金杯的焰心（root 空间，相机反投影校准：碗口液面处）
const FLAME_POS = new THREE.Vector3(0.486, 1.69, 0.345);

export class PortraitStage {
  constructor(renderer) {
    this.renderer = renderer;
    this.ready = false;
    this.active = true;   // 是否渲染半身像层
    this.leaving = false; // 退场动画中
    this._leaveT = 0;
    this.fade = 1;        // 退场渐隐系数（1=不透明）

    // 鼠标视差（-1~1），仅由指针移动驱动
    this._parTarget = { x: 0, y: 0 };
    this._par = { x: 0, y: 0 };

    // 不设场景背景色：靠背景幕布遮住游戏画面，退场时幕布原地渐隐即透出
    this.scene = new THREE.Scene();

    // 灯光：左上暖主光 + 右后冷轮辋光 + 低强度环境
    const key = new THREE.DirectionalLight('#ffe9c4', 2.6);
    key.position.set(-2.2, 3.4, 2.6);
    const rim = new THREE.DirectionalLight('#7fa8d8', 1.9);
    rim.position.set(2.6, 2.8, -2.2);
    const hemi = new THREE.HemisphereLight('#2c3850', '#0c0f16', 0.9);
    this.scene.add(key, rim, hemi);

    // 相机：半身像特写构图——头顶留边完整入画，垂下的右手裁出屏幕下缘，
    // 人物放大铺满右幅，文字允许压在人物身上
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 30);
    this.camera.position.set(0.2, 1.76, 1.97);
    this.camera.lookAt(0.3, 1.68, 0);
    this.scene.add(this.camera);

    // 背景幕布（挂在相机上铺满全屏，边缘渐隐；退场时原地变透明透出游戏画面）
    this.glow = new THREE.Mesh(
      new THREE.PlaneGeometry(5, 3.4),
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        uniforms: {
          uColor: { value: new THREE.Color('#182338') },
          uFade: { value: 1 }
        },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 uColor;
          uniform float uFade;
          varying vec2 vUv;
          void main() {
            float r = length((vUv - vec2(0.62, 0.45)) * vec2(1.0, 0.8)) * 2.0;
            float a = (1.0 - smoothstep(0.15, 1.0, r)) * 0.85 * uFade;
            if (a < 0.004) discard;
            gl_FragColor = vec4(uColor, a);
          }
        `
      })
    );
    this.glow.position.set(0.35, 0.05, -2.4);
    this.camera.add(this.glow);

    // 模型挂载点（视差移动整体）；BASE_X 把半身像推到画面右侧
    this.root = new THREE.Group();
    this.scene.add(this.root);

    // 手中金杯的白青火焰：与局内圣杯同款的粒子火焰（尺寸按杯身缩小）
    this.flame = new FlamePool(this.root, 120, makeGlowTexture(), true);
    this.flameColor = new THREE.Color(NEUTRAL_FLAME_COLOR);
    this.cupLight = new THREE.PointLight(this.flameColor, 0, 1.6, 2);
    this.cupLight.position.copy(FLAME_POS).add(new THREE.Vector3(0, 0.08, 0));
    this.root.add(this.cupLight);
    this._flameAcc = 0;

    this._load();
  }

  async _load() {
    try {
      const gltf = await new GLTFLoader().loadAsync('spirits/cultist.glb');
      const model = gltf.scene;
      model.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const scale = MODEL_HEIGHT / Math.max(size.y, 0.001);
      model.scale.setScalar(scale);
      model.position.x = -(box.min.x + size.x / 2) * scale;
      model.position.z = -(box.min.z + size.z / 2) * scale;
      model.position.y = -box.min.y * scale;
      model.rotation.y = 0.26; // 微侧身面向左侧标题
      this.root.add(model);

      // 收集教徒材质（视差清晰度：各向异性过滤）
      const maxAniso = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      this._mats = [];
      model.traverse((o) => {
        if (o.isMesh && o.material) {
          this._mats.push(o.material);
          for (const tkey of ['map', 'normalMap', 'roughnessMap', 'metallicMap']) {
            const t = o.material[tkey];
            if (t) t.anisotropy = maxAniso;
          }
        }
      });
      this.ready = true;
    } catch (error) {
      console.error('[startscreen] 教徒模型装载失败', error);
    }
  }

  /** 视口尺寸变化：重设相机纵横比（全屏）。 */
  resize(w, h) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** 鼠标视差输入（-1~1），仅指针驱动。 */
  setParallax(nx, ny) {
    this._parTarget.x = nx;
    this._parTarget.y = ny;
  }

  /** 点击开始：整层原地渐隐（无位移），透明过渡到游戏画面。 */
  leave() {
    if (this.leaving) return;
    this.leaving = true;
    this._leaveT = 0;
  }

  /** 返回初始界面：恢复半身像层。 */
  show() {
    this.leaving = false;
    this.active = true;
    this._leaveT = 0;
    this.fade = 1;
    this.glow.material.uniforms.uFade.value = 1;
    if (this._mats) for (const m of this._mats) { m.transparent = false; m.opacity = 1; }
    this.root.position.set(0, 0, 0);
    this.root.rotation.y = 0;
  }

  update(dt, elapsed) {
    if (!this.active) return;
    // 视差缓动
    const k = Math.min(1, dt * 5);
    this._par.x += (this._parTarget.x - this._par.x) * k;
    this._par.y += (this._parTarget.y - this._par.y) * k;

    // 视差：教徒模型跟随鼠标平移并微微转身（立体感），背景幕布反向轻移
    const parX = BASE_X + this._par.x * 0.14;
    const parY = this._par.y * 0.07;
    const parYaw = this._par.x * -0.34;
    this.glow.position.x = 0.35 - this._par.x * 0.24;
    this.glow.position.y = 0.05 + this._par.y * -0.14;

    // 退场：背景幕布原地渐隐（无位移）透出游戏画面；
    // 模型保持不透明，水平旋转着从右侧移出
    let leaveX = 0, spin = 0;
    if (this.leaving) {
      this._leaveT = Math.min(1, this._leaveT + dt / 1.05);
      const p = this._leaveT;
      const ease = p * p;
      leaveX = ease * 3.2;
      spin = ease * 6.5;
      const fade = 1 - p * p * (3 - 2 * p); // 幕布 smoothstep 渐隐
      this.fade = fade;
      if (this.glow.material.uniforms) this.glow.material.uniforms.uFade.value = fade;
      if (p >= 1) this.active = false;
    }

    this.root.position.set(parX + leaveX, parY, 0);
    this.root.rotation.y = parYaw + spin;

    // 手中金杯的白青火焰：局内圣杯同款粒子火焰（随退场一起渐隐）
    if (this.ready) {
      this.cupLight.intensity = (1.7 + Math.sin(elapsed * 11.3) * 0.45 + Math.sin(elapsed * 27.7) * 0.28) * this.fade;
      this._flameAcc += dt * 46 * this.fade;
      while (this._flameAcc >= 1) {
        this._flameAcc -= 1;
        const a = Math.random() * Math.PI * 2;
        const r = Math.random() * 0.05;
        spawnFlameParticle(this.flame,
          FLAME_POS.x + Math.cos(a) * r,
          FLAME_POS.y + Math.random() * 0.04,
          FLAME_POS.z + Math.sin(a) * r,
          this.flameColor,
          { vy: 0.95 + Math.random() * 0.55, life: 0.6 + Math.random() * 0.35, maxLife: 0.95,
            size0: 0.5 + Math.random() * 0.16, size1: 0.12, alpha: 1.0, sway: true });
      }
    }
    this.flame.update(dt, elapsed);
  }

  /** 开始界面整层渲染（不透明）：退场时整层原地变透明，透出下面的游戏画面。 */
  render(renderer) {
    if (!this.active) return;
    const size = new THREE.Vector2();
    renderer.getSize(size);
    const w = size.x, h = size.y;
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, w, h);
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(this.scene, this.camera); // 幕布不透明时盖住游戏画面，渐隐后透出
    renderer.autoClear = true;
  }
}
