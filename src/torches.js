import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FlamePool, makeGlowTexture, spawnFlameParticle } from './flame.js';
import { NEUTRAL_FLAME_COLOR } from './themes.js';

/**
 * torches.js — 环绕场地活动范围边缘的 12 座悬浮火炬。
 *
 * - 模型：Meshy 冰晶火炬（FBX→GLB），单模型 12 份克隆共享几何体
 * - 悬浮于边界内侧，带缓慢升降呼吸与自转朝心
 * - 火炬顶端燃烧与圣杯完全一致的元素火焰（共享 flame.js 粒子池）
 * - 火焰颜色跟随当前元素领域
 */

export const TORCH_COUNT = 12;
export const TORCH_RING_RADIUS = 56;  // 活动范围边缘（58）内侧
export const TORCH_HEIGHT = 7.2;      // 与圣杯同高
const TORCH_FLOAT_Y = 2.6;            // 悬浮基准高度
const TORCH_BOB = 0.35;               // 悬浮呼吸幅度
const FLAME_POOL_MAX = 320;           // 12 座火炬共享的火焰粒子上限

export class TorchRing {
  constructor(scene) {
    this.scene = scene;
    this.ready = false;
    this.group = null;
    this.torches = [];           // { group, baseY, phase, top }
    this._flameColor = new THREE.Color(NEUTRAL_FLAME_COLOR);
    this._targetColor = new THREE.Color(NEUTRAL_FLAME_COLOR);
    this._spawnAcc = new Array(TORCH_COUNT).fill(0);
    this._pixelRatio = 1;

    this._load();
  }

  async _load() {
    try {
      const [gltf, baseTex, normalTex, roughTex, metalTex] = await Promise.all([
        new GLTFLoader().loadAsync('goblet/torch.glb'),
        new THREE.TextureLoader().loadAsync('goblet/torch_base.png'),
        new THREE.TextureLoader().loadAsync('goblet/torch_normal.png'),
        new THREE.TextureLoader().loadAsync('goblet/torch_roughness.png'),
        new THREE.TextureLoader().loadAsync('goblet/torch_metallic.png')
      ]);

      baseTex.colorSpace = THREE.SRGBColorSpace;
      baseTex.anisotropy = 4;
      for (const t of [baseTex, normalTex, roughTex, metalTex]) t.flipY = false;

      const material = new THREE.MeshStandardMaterial({
        map: baseTex,
        normalMap: normalTex,
        roughnessMap: roughTex,
        metalnessMap: metalTex,
        roughness: 1,
        metalness: 1
      });

      const proto = gltf.scene;
      proto.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(proto);
      const size = box.getSize(new THREE.Vector3());
      const scale = TORCH_HEIGHT / Math.max(size.y, 0.001);
      proto.traverse((o) => { if (o.isMesh) o.material = material; });

      const group = new THREE.Group();
      const glowTex = makeGlowTexture();
      this.flame = new FlamePool(group, FLAME_POOL_MAX, glowTex, true);
      this.flame.setPixelRatio(this._pixelRatio);

      for (let i = 0; i < TORCH_COUNT; i++) {
        const t = proto.clone(true);
        t.scale.setScalar(scale);
        // 居中：火炬轴心对齐原点、底部对齐本地 y=0
        t.position.x = -(box.min.x + size.x / 2) * scale;
        t.position.z = -(box.min.z + size.z / 2) * scale;
        t.position.y = -box.min.y * scale;

        const holder = new THREE.Group();
        holder.add(t);
        const angle = (i / TORCH_COUNT) * Math.PI * 2;
        const baseY = TORCH_FLOAT_Y + Math.sin(i * 1.7) * 0.3; // 各火炬高低错落
        holder.position.set(
          Math.sin(angle) * TORCH_RING_RADIUS,
          baseY,
          Math.cos(angle) * TORCH_RING_RADIUS
        );
        group.add(holder);
        this.torches.push({ holder, baseY, phase: i * 0.55 });
      }

      this.group = group;
      this.ready = true;
      this.scene.add(group);
    } catch (error) {
      console.error('[torches] 火炬装载失败', error);
    }
  }

  setPixelRatio(r) {
    this._pixelRatio = r;
    this.flame?.setPixelRatio(r);
  }

  /** 每帧：悬浮呼吸 + 顶端喷发与圣杯同款的元素火焰。 */
  update(dt, elapsed, targetAccent) {
    if (!this.ready) return;
    this._targetColor.set(targetAccent);
    this._flameColor.lerp(this._targetColor, Math.min(1, dt * 2.2));
    const col = this._flameColor;

    let idx = 0;
    for (const t of this.torches) {
      // 悬浮呼吸（各自错相）
      t.holder.position.y = t.baseY + Math.sin(elapsed * 1.1 + t.phase) * TORCH_BOB;
      // 顶端火苗：粒子率按火炬与圣杯的体积比缩小
      const top = t.holder.position;
      this._spawnAcc[idx] = (this._spawnAcc[idx] ?? 0) + dt * 34;
      while (this._spawnAcc[idx] >= 1) {
        this._spawnAcc[idx] -= 1;
        const a = Math.random() * Math.PI * 2;
        const r = Math.random() * 0.3;
        spawnFlameParticle(this.flame,
          top.x + Math.cos(a) * r,
          top.y + TORCH_HEIGHT * 0.82 + Math.random() * 0.2,
          top.z + Math.sin(a) * r,
          col,
          {
            vy: 1.6 + Math.random() * 1.2,
            life: 0.8 + Math.random() * 0.6,
            maxLife: 1.4,
            size0: 1.9, size1: 0.6,
            alpha: 1.0
          });
      }
      idx++;
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
    this.flame.geometry.dispose();
    this.group = null;
    this.ready = false;
  }
}
