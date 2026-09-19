import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FlamePool, makeGlowTexture, spawnFlameParticle } from './flame.js';

/**
 * goblet.js — 场地中央的巨型圣杯。
 *
 * - 模型：Meshy 圣杯（FBX→GLB），贴图紫色区域（宝石/符文）处理成发光遮罩，
 *   发光颜色跟随当前元素领域；元素荒原（默认）燃烧青色火焰
 * - 杯口火焰：加色发光粒子（flame.js 共享粒子池），随领域色变化
 * - 提供柱基碰撞半径（game 侧据此把玩家推出，防止穿模）
 */

export const GOBLET_POSITION = { x: 0, z: 0 };
export const GOBLET_COLLIDER_RADIUS = 2.4;

const GOBLET_HEIGHT = 7.2;      // 圣杯总高（米）
const FLAME_COLOR_NEUTRAL = '#40e0d0'; // 元素荒原：青色火焰
const FLAME_Y = 6.55;           // 火焰燃烧高度（杯口沿，让火舌探出杯外）
const FLAME_RADIUS = 1.25;      // 火焰分布半径（杯口内，按巨杯比例）

/** 处理圣杯贴图：紫色区域（宝石/符文）→ 发光遮罩白、底图压暗。
 *  返回 { base, mask } 两张 CanvasTexture（flipY=false 对齐 glTF UV）。 */
function processBaseTexture(baseTexture) {
  const img = baseTexture.image;
  const w = img.width, h = img.height;
  const baseCanvas = document.createElement('canvas');
  baseCanvas.width = w; baseCanvas.height = h;
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = w; maskCanvas.height = h;
  const bctx = baseCanvas.getContext('2d');
  const mctx = maskCanvas.getContext('2d');
  bctx.drawImage(img, 0, 0);
  const id = bctx.getImageData(0, 0, w, h);
  const md = mctx.createImageData(w, h);
  const d = id.data, m = md.data;
  let glowPixels = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    // 紫色系：蓝占优、红次之、绿明显偏低
    const isPurple = b > 70 && b > g * 1.32 && r + b > 140;
    if (isPurple) {
      m[i] = 255; m[i + 1] = 255; m[i + 2] = 255;
      d[i] = r * 0.16; d[i + 1] = g * 0.16; d[i + 2] = b * 0.2;
      glowPixels++;
    }
    m[i + 3] = 255;
  }
  bctx.putImageData(id, 0, 0);
  mctx.putImageData(md, 0, 0);
  const base = new THREE.CanvasTexture(baseCanvas);
  base.colorSpace = THREE.SRGBColorSpace;
  base.flipY = false;
  base.anisotropy = 4;
  const mask = new THREE.CanvasTexture(maskCanvas);
  mask.flipY = false;
  console.log(`[goblet] 发光区域像素占比 ${(100 * glowPixels / (w * h)).toFixed(1)}%`);
  return { base, mask };
}

export class Goblet {
  constructor(scene) {
    this.scene = scene;
    this.ready = false;
    this.group = null;
    this._flameColor = new THREE.Color(FLAME_COLOR_NEUTRAL);
    this._targetColor = new THREE.Color(FLAME_COLOR_NEUTRAL);
    this._spawnAcc = 0;
    this._pixelRatio = 1;

    this._load();
  }

  async _load() {
    try {
      const [gltf, baseTex, normalTex, roughTex, metalTex] = await Promise.all([
        new GLTFLoader().loadAsync('goblet/goblet.glb'),
        new THREE.TextureLoader().loadAsync('goblet/base.png'),
        new THREE.TextureLoader().loadAsync('goblet/normal.png'),
        new THREE.TextureLoader().loadAsync('goblet/roughness.png'),
        new THREE.TextureLoader().loadAsync('goblet/metallic.png')
      ]);

      const { base, mask } = processBaseTexture(baseTex);
      normalTex.flipY = false;
      roughTex.flipY = false;
      metalTex.flipY = false;

      const material = new THREE.MeshStandardMaterial({
        map: base,
        normalMap: normalTex,
        roughnessMap: roughTex,
        metalnessMap: metalTex,
        roughness: 1,
        metalness: 1,
        emissive: this._flameColor.clone(),
        emissiveMap: mask,
        emissiveIntensity: 2.3
      });
      const model = gltf.scene;
      model.traverse((o) => { if (o.isMesh) o.material = material; });

      // 归一化：脚底落地、缩放到巨杯高度
      model.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const scale = GOBLET_HEIGHT / Math.max(size.y, 0.001);
      model.scale.setScalar(scale);
      model.position.x = -(box.min.x + size.x / 2) * scale;
      model.position.z = -(box.min.z + size.z / 2) * scale;
      model.position.y = -box.min.y * scale;

      const group = new THREE.Group();
      group.add(model);
      group.position.set(GOBLET_POSITION.x, 0, GOBLET_POSITION.z);
      this._material = material;

      // 杯口火焰光源（颜色随元素，带火光闪烁）
      this.light = new THREE.PointLight(this._flameColor.clone(), 12, 40, 2);
      this.light.position.set(0, FLAME_Y + 0.8, 0);
      group.add(this.light);

      // 粒子池：杯口元素火焰（加色发光）
      const glowTex = makeGlowTexture();
      this.flame = new FlamePool(group, 130, glowTex, true);
      this.flame.setPixelRatio(this._pixelRatio);

      this.group = group;
      this.ready = true;
      this.scene.add(group);
    } catch (error) {
      console.error('[goblet] 圣杯装载失败', error);
    }
  }

  /** 渲染像素比同步（game 侧动态分辨率会调整）。 */
  setPixelRatio(r) {
    this._pixelRatio = r;
    this.flame?.setPixelRatio(r);
  }

  /** 每帧：targetAccent = 当前领域强调色（荒原传青色）。 */
  update(dt, elapsed, targetAccent) {
    if (!this.ready) return;
    this._targetColor.set(targetAccent);
    // 领域切换时颜色平滑过渡
    this._flameColor.lerp(this._targetColor, Math.min(1, dt * 2.2));
    if (this._material) {
      this._material.emissive.lerp(this._targetColor, Math.min(1, dt * 2.2));
      this._material.emissiveIntensity = 2.3; // 领域色饱和度不同（橙色偏暗），恒定高亮度补偿
    }

    // 火光闪烁
    this.light.color.copy(this._flameColor);
    this.light.intensity = 12 + Math.sin(elapsed * 12.7) * 2.6 + Math.sin(elapsed * 29.3) * 1.4;

    // 火焰粒子：杯口持续生成
    const col = this._flameColor;
    this._spawnAcc += dt * 95;
    while (this._spawnAcc >= 1) {
      this._spawnAcc -= 1;
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * FLAME_RADIUS;
      spawnFlameParticle(this.flame,
        Math.cos(a) * r,
        FLAME_Y + Math.random() * 0.35,
        Math.sin(a) * r,
        col);
    }
    this.flame.update(dt, elapsed);
  }

  dispose() {
    if (!this.group) return;
    this.scene.remove(this.group);
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          for (const key of Object.keys(m)) {
            const v = m[key];
            if (v && v.isTexture) v.dispose();
          }
          m.dispose();
        }
      }
    });
    this.group = null;
    this.ready = false;
  }
}
