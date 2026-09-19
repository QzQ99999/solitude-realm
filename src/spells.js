import * as THREE from 'three';
import { frame } from './vfx/FrameUniforms.js';
import { Easing, saturate, lerp, randRange } from './vfx/math.js';
import { createCrystalGeometry } from './vfx/ProceduralGeometry.js';
import { createAsteroidGeometry } from './vfx/ProceduralGeometry.js';
import { createBoltRibbonGeometry } from './vfx/ProceduralGeometry.js';
import { createIceMaterial } from './vfx/IceMaterial.js';
import { createMeteorMaterial } from './vfx/MeteorMaterial.js';
import { createOrbMaterial } from './vfx/OrbMaterial.js';
import { createLightningMaterial, BoltPass, thunderConfig } from './vfx/LightningMaterial.js';
import { BurstMode, DecalType } from './vfx/VFXSystem.js';

/**
 * spells.js — 三系法术与普通攻击，全部特效移植自 elemental-sandbox
 * （MIT）：https://genex.games/elemental-sandbox · github.com/achrefelouafi/LinearAbiltyCastingThreeJS
 *
 *  - 普通攻击：噪声啃噬的蓄能球（沙盒 BEAM 蓄能球材质）+ 速度拉伸火花拖尾；
 *  - Q 霜新星：程序化冰晶破土喷发（沙盒晶体几何 + 冰材质，弹性过冲起落），
 *    冻结水汽壳爆裂 + 成片外扩的地面霜；
 *  - E 落炎陨石：fbm 团块 + 平面切割 + 陨石坑的程序化石球（沙盒陨石材质，
 *    熔岩缝随充能烧亮），落地翻卷火球 + 放射龟裂 + 烧焦地面 + 燃烧碎块；
 *  - R 天雷殛灭：整条闪电活在顶点着色器里的丝带束（沙盒闪电材质，
 *    分段线性折角 + 逐丝扇面），入地分叉电流灼痕。
 *
 * 每个法术落地时回调一次 `onImpact(point, radius)`，由 Game 决定改写世界、
 * 判定元素之灵命中与镜头震动。
 */

/* 元素 → 蓄能球/闪电配色（游戏元素强调色 × 沙盒四段渐变） */
const ORB_PALETTES = {
  ice: { core: '#ffffff', inner: '#d3f4ff', outer: '#56d8ff' },
  fire: { core: '#ffffff', inner: '#ffe8c0', outer: '#ff8a3c' },
  storm: { core: '#ffffff', inner: '#e7dcff', outer: '#a98bff' }
};

/* ---------------------------------------------------------------------- */
/* 一次性粒子雨（CPU 积分，飞行轨迹等少量环境粒子继续用它）                  */
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

/* ---------------------------------------------------------------------- */
/* 冰晶场（Q 霜新星）——沙盒式直线施放：晶棱沿弹道向前推进破土，            */
/* 抵达落点时冲击簇炸开。弹性破土、诞生闪光、沉回地面。                     */
/* ---------------------------------------------------------------------- */

const CRYSTAL_VARIANTS = 3;
const CRYSTALS_PER_VARIANT = 44; // 单次施放至多 132 根晶体
const CRYSTAL_RISE = 0.17; // 破土时间（沙盒 riseTime）
const CRYSTAL_OVERSHOOT = 0.26; // 冲出地面的过冲（沙盒 riseOvershoot）
const CRYSTAL_SETTLE = 0.55; // 过冲回稳（沙盒 settle）
const CRYSTAL_BIRTH_FADE = 0.45; // 诞生闪光衰减
const CRYSTAL_HOLD = 1.3; // 抵达落点后的矗立时长
const CRYSTAL_SINK = 0.9; // 沉回地面时长
const ICE_FRONT_SPEED = 24; // 断裂前沿的推进速度（米/秒，沙盒 speed=26）

class CrystalField {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);

    this.material = createIceMaterial({
      colorDeep: '#3e737a',
      colorIce: '#8adaff',
      colorRim: '#f2feff',
      colorCore: '#638797'
    });

    this.meshes = [];
    this.seedAttrs = [];
    this.birthAttrs = [];
    for (let v = 0; v < CRYSTAL_VARIANTS; v++) {
      const geometry = createCrystalGeometry({
        seed: 7.3 + v * 21.7,
        sides: 6,
        taper: 0.16,
        roughness: 0.24,
        bend: 0.3
      });
      const seeds = new THREE.InstancedBufferAttribute(
        new Float32Array(CRYSTALS_PER_VARIANT), 1
      );
      const births = new THREE.InstancedBufferAttribute(
        new Float32Array(CRYSTALS_PER_VARIANT), 1
      ).setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute('aSeed', seeds);
      geometry.setAttribute('aBirth', births);

      const mesh = new THREE.InstancedMesh(geometry, this.material, CRYSTALS_PER_VARIANT);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.visible = false;
      this.group.add(mesh);
      this.meshes.push(mesh);
      this.seedAttrs.push(seeds);
      this.birthAttrs.push(births);
    }

    this._dummy = new THREE.Object3D();
    this._up = new THREE.Vector3(0, 1, 0);
    this._lean = new THREE.Vector3();
    this._axis = new THREE.Vector3();
    this._tilt = new THREE.Quaternion();
    this._spin = new THREE.Quaternion();
  }

  /** 弹道带在 `along`（0..1）处的半宽：越接近落点越宽（沙盒 widthNear→width）。 */
  _halfWidth(along) {
    return lerp(0.55, 2.6, Math.pow(saturate(along), 0.75));
  }

  /**
   * 布置一次直线冰晶喷发：晶棱沿 `start → point` 的弹道带分布，
   * 最后 22% 留给落点的冲击簇（前沿抵达才炸开）。
   * @returns {Array} 晶体记录
   */
  layout(start, point, dir, side) {
    const len = start.distanceTo(point);
    const records = [];
    const total = CRYSTAL_VARIANTS * CRYSTALS_PER_VARIANT;
    const impactCount = Math.round(total * 0.22);
    const bandCount = total - impactCount;

    /* —— 弹道带：沙盒式 along + lateral 分布，前端聚拢（frontBias） —— */
    for (let i = 0; i < bandCount; i++) {
      const along = Math.pow((i + Math.random()) / bandCount, 0.85);
      const lateral = randRange(-1, 1);
      const clumped = Math.sign(lateral) * Math.pow(Math.abs(lateral), 1.35);
      const offset = (clumped + randRange(-1, 1) * 0.3) * this._halfWidth(along);
      const px = start.x + dir.x * len * along + side.x * offset;
      const pz = start.z + dir.z * len * along + side.z * offset;

      let height = lerp(0.55, 3.0, Math.pow(along, 1.4));
      // 落点前的隆起（沙盒 peak/peakWidth）
      height *= 1 + 0.45 * saturate((along - 0.72) / 0.28);
      // 穹顶剪影：带缘的晶体矮下去（crown）
      height *= 1 - 0.55 * Math.pow(saturate(Math.abs(clumped)), 1.4);
      height *= 1 + randRange(-0.3, 0.3);
      const rubble = Math.random() < 0.35;
      if (rubble) height *= 0.32;

      // 向前倾倒（沿弹道方向 + 带缘外扩），沙盒 lean 的直线版
      const outward = clumped;
      const leanX = dir.x * 0.75 + side.x * outward * 0.85;
      const leanZ = dir.z * 0.75 + side.z * outward * 0.85;
      const lean = 0.42 * (0.35 + 0.65 * along) * (1 + randRange(-0.5, 0.5));

      records.push({
        x: px, z: pz,
        along,
        yaw: Math.random() * Math.PI * 2,
        height,
        radius: 0.3 + Math.random() * 0.28,
        leanX, leanZ, lean,
        stagger: Math.random() * 0.09,
        eruptTime: -1,
        variant: i % CRYSTAL_VARIANTS,
        slot: (i / CRYSTAL_VARIANTS) | 0,
        seed: Math.random()
      });
    }

    /* —— 冲击簇：留在落点周围，前沿抵达才喷发 —— */
    for (let i = 0; i < impactCount; i++) {
      const angle = Math.random() * Math.PI * 2;
      const radial = Math.sqrt(Math.random());
      const reach = this._halfWidth(1) * 1.3 * radial;
      records.push({
        x: point.x + Math.cos(angle) * reach,
        z: point.z + Math.sin(angle) * reach,
        along: 1,
        yaw: Math.random() * Math.PI * 2,
        height: 2.1 + Math.random() * 1.2,
        radius: 0.34 + Math.random() * 0.3,
        leanX: Math.cos(angle), leanZ: Math.sin(angle),
        lean: 0.3 + Math.random() * 0.25,
        stagger: Math.random() * 0.12,
        eruptTime: -1,
        variant: (bandCount + i) % CRYSTAL_VARIANTS,
        slot: ((bandCount + i) / CRYSTAL_VARIANTS) | 0,
        seed: Math.random()
      });
    }

    // 逐变体写入种子
    for (const r of records) this.seedAttrs[r.variant].array[r.slot] = r.seed;
    for (let v = 0; v < CRYSTAL_VARIANTS; v++) {
      this.seedAttrs[v].needsUpdate = true;
      this.meshes[v].count = CRYSTALS_PER_VARIANT;
      this.meshes[v].visible = true;
    }
    return records;
  }

  /**
   * 断裂前沿推进到 `limit`（0..1，弹道比例）：触发所有被越过的晶体。
   * includeImpact = 前沿已抵达落点，连冲击簇一起引爆。
   */
  triggerUpTo(records, age, limit, includeImpact) {
    for (const r of records) {
      if (r.eruptTime >= 0) continue;
      if (r.along > limit) continue;
      if (r.along >= 1 && !includeImpact) continue;
      r.eruptTime = age + r.stagger;
    }
  }

  /** 一根晶体此刻伸出地面多少：-1 = 还埋着；0..1 = 升起；>1 = 过冲回弹。 */
  _emergence(record, age) {
    if (record.eruptTime < 0) return -1;
    const elapsed = age - record.eruptTime;
    if (elapsed < 0) return -1;
    const rise = Easing.outQuint(saturate(elapsed / CRYSTAL_RISE));
    if (elapsed <= CRYSTAL_RISE) return rise;
    // 冲过高点再回弹落定。
    const after = elapsed - CRYSTAL_RISE;
    const spring = Math.sin(after * 14) * Math.exp(-after / CRYSTAL_SETTLE);
    return 1 + CRYSTAL_OVERSHOOT * spring;
  }

  /** 每帧推进冰晶场的所有晶体。retract > 0 时整场沉回地面。 */
  update(records, age, retract) {
    const used = [0, 0, 0];
    for (const r of records) {
      const emerge = this._emergence(r, age);
      const mesh = this.meshes[r.variant];
      const slot = r.slot;
      used[r.variant] = Math.max(used[r.variant], slot + 1);

      if (emerge < 0) {
        // 还埋着：停到视野外，避免原点处画退化矩阵。
        this._dummy.position.set(0, -999, 0);
        this._dummy.scale.setScalar(0.0001);
        this._dummy.rotation.set(0, 0, 0);
        this._dummy.updateMatrix();
        mesh.setMatrixAt(slot, this._dummy.matrix);
        this.birthAttrs[r.variant].array[slot] = 0;
        continue;
      }

      // 朝 lean 方向倾倒（绕 up×lean 的轴把 +Y 推向 lean）。
      this._lean.set(r.leanX, 0, r.leanZ).normalize();
      this._axis.crossVectors(this._up, this._lean).normalize();
      this._tilt.setFromAxisAngle(this._axis, r.lean);
      this._spin.setFromAxisAngle(this._up, r.yaw);
      this._tilt.multiply(this._spin);

      this._dummy.position.set(r.x, (Math.min(emerge, 1.3) - 1) * r.height * 0.85, r.z);
      this._dummy.quaternion.copy(this._tilt);
      const settled = Math.min(1, emerge);
      this._dummy.scale.set(r.radius, Math.max(0.02, settled * r.height), r.radius);
      this._dummy.updateMatrix();
      mesh.setMatrixAt(slot, this._dummy.matrix);

      // 诞生闪光：破土的一瞬自内而外点亮，再按 birthFade 衰减。
      const sinceBirth = age - r.eruptTime;
      this.birthAttrs[r.variant].array[slot] = saturate(1 - sinceBirth / CRYSTAL_BIRTH_FADE);
    }

    for (let v = 0; v < CRYSTAL_VARIANTS; v++) {
      this.meshes[v].count = used[v];
      this.meshes[v].instanceMatrix.needsUpdate = true;
      this.birthAttrs[v].needsUpdate = true;
    }

    if (retract > 0) {
      const sink = Easing.inCubic(retract);
      this.group.position.y = -sink * 4.2; // 整场沉回地面之下
    } else {
      this.group.position.y = 0;
    }
  }

  hide() {
    for (let v = 0; v < CRYSTAL_VARIANTS; v++) {
      this.meshes[v].count = 0;
      this.meshes[v].visible = false;
    }
    this.group.position.y = 0;
  }

  dispose() {
    for (const mesh of this.meshes) mesh.geometry.dispose();
    this.material.dispose();
    this.group.parent?.remove(this.group);
  }
}

/* ---------------------------------------------------------------------- */
/* 陨石（E 落炎陨石）——程序化石球 + 熔岩缝 + 燃烧碎块                      */
/* ---------------------------------------------------------------------- */

const METEOR_CHUNKS = 14;

class MeteorRig {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);

    this.material = createMeteorMaterial();

    // 主岩：实例化容量 1，实例化属性 aSeed/aHeat 驱动熔岩缝的种子与温度。
    const rockGeometry = createAsteroidGeometry({
      seed: 11.7, detail: 3, lumpiness: 0.26, noiseScale: 1.5, roughness: 0.16,
      cuts: 9, cutDepth: 0.28, craters: 5, craterDepth: 0.18, craterSize: 0.5
    });
    const rockSeed = new THREE.InstancedBufferAttribute(new Float32Array([3.7]), 1);
    this._rockHeat = new THREE.InstancedBufferAttribute(new Float32Array([0]), 1)
      .setUsage(THREE.DynamicDrawUsage);
    rockGeometry.setAttribute('aSeed', rockSeed);
    rockGeometry.setAttribute('aHeat', this._rockHeat);
    this.rock = new THREE.InstancedMesh(rockGeometry, this.material, 1);
    this.rock.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.rock.frustumCulled = false;
    this.rock.visible = false;
    this.group.add(this.rock);

    // 碎块：落地时从撞击点炸出的燃烧岩屑。
    const chunkGeometry = createAsteroidGeometry({
      seed: 47.3, detail: 1, lumpiness: 0.4, noiseScale: 1.8, roughness: 0.3,
      cuts: 5, cutDepth: 0.32, craters: 2, craterDepth: 0.2, craterSize: 0.5
    });
    const chunkSeeds = new THREE.InstancedBufferAttribute(
      new Float32Array(METEOR_CHUNKS), 1
    );
    for (let i = 0; i < METEOR_CHUNKS; i++) chunkSeeds.array[i] = Math.random() * 40;
    this._chunkHeat = new THREE.InstancedBufferAttribute(
      new Float32Array(METEOR_CHUNKS), 1
    ).setUsage(THREE.DynamicDrawUsage);
    chunkGeometry.setAttribute('aSeed', chunkSeeds);
    chunkGeometry.setAttribute('aHeat', this._chunkHeat);
    this.chunks = new THREE.InstancedMesh(chunkGeometry, this.material, METEOR_CHUNKS);
    this.chunks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.chunks.frustumCulled = false;
    this.chunks.visible = false;
    this.group.add(this.chunks);

    this._dummy = new THREE.Object3D();
    this._quat = new THREE.Quaternion();
    this._chunkList = [];
    this._rockScale = 1.35;
  }

  /** 布置主岩的下坠起点。 */
  launch(start) {
    this._dummy.position.copy(start);
    this._dummy.quaternion.identity();
    this._dummy.scale.setScalar(this._rockScale);
    this._dummy.updateMatrix();
    this.rock.setMatrixAt(0, this._dummy.matrix);
    this.rock.instanceMatrix.needsUpdate = true;
    this.rock.visible = true;
    this._rockHeat.array[0] = 1;
    this._rockHeat.needsUpdate = true;
    this.rock.material.userData.sync(0, null);
  }

  /** 主岩每帧：位置 + 翻滚 + 充能。 */
  tickRock(pos, spinX, spinZ, charge, heading) {
    this._dummy.position.copy(pos);
    this._dummy.rotation.set(spinX, 0, spinZ);
    this._dummy.scale.setScalar(this._rockScale);
    this._dummy.updateMatrix();
    this.rock.setMatrixAt(0, this._dummy.matrix);
    this.rock.instanceMatrix.needsUpdate = true;
    this._rockHeat.array[0] = 1;
    this._rockHeat.needsUpdate = true;
    this.rock.material.userData.sync(charge, heading);
  }

  hideRock() {
    this.rock.visible = false;
  }

  /** 撞击：炸出燃烧碎块，落地反弹、逐块冷却。 */
  burstChunks(point, rng = Math.random) {
    this._chunkList.length = 0;
    for (let i = 0; i < METEOR_CHUNKS; i++) {
      const angle = rng() * Math.PI * 2;
      this._chunkList.push({
        x: point.x, y: 0.5, z: point.z,
        vx: Math.cos(angle) * (2 + rng() * 5),
        vy: 4 + rng() * 7,
        vz: Math.sin(angle) * (2 + rng() * 5),
        rx: rng() * Math.PI * 2, rz: rng() * Math.PI * 2,
        wx: (rng() - 0.5) * 12, wz: (rng() - 0.5) * 12,
        scale: 0.16 + rng() * 0.22,
        heat: 1
      });
      this._chunkHeat.array[i] = 1;
    }
    this.chunks.visible = true;
  }

  tickChunks(dt) {
    if (!this.chunks.visible) return;
    let alive = false;
    for (let i = 0; i < this._chunkList.length; i++) {
      const c = this._chunkList[i];
      c.heat = Math.max(0, c.heat - dt * 0.75);
      this._chunkHeat.array[i] = c.heat;
      if (c.heat <= 0) {
        this._dummy.position.set(0, -999, 0);
        this._dummy.scale.setScalar(0.0001);
        this._dummy.rotation.set(0, 0, 0);
        this._dummy.updateMatrix();
        this.chunks.setMatrixAt(i, this._dummy.matrix);
        continue;
      }
      alive = true;
      c.vy -= 17 * dt;
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      c.z += c.vz * dt;
      if (c.y < 0.12 && c.vy < 0) {
        c.y = 0.12;
        c.vy *= -0.38;
        c.vx *= 0.72;
        c.vz *= 0.72;
      }
      c.rx += c.wx * dt;
      c.rz += c.wz * dt;
      this._dummy.position.set(c.x, c.y, c.z);
      this._dummy.rotation.set(c.rx, 0, c.rz);
      this._dummy.scale.setScalar(c.scale);
      this._dummy.updateMatrix();
      this.chunks.setMatrixAt(i, this._dummy.matrix);
    }
    this.chunks.instanceMatrix.needsUpdate = true;
    this._chunkHeat.needsUpdate = true;
    if (!alive) this.chunks.visible = false;
  }

  reset() {
    this.rock.visible = false;
    this.chunks.visible = false;
    this._chunkList.length = 0;
    this._rockHeat.array[0] = 0;
  }

  dispose() {
    this.rock.geometry.dispose();
    this.chunks.geometry.dispose();
    this.material.dispose();
    this.group.parent?.remove(this.group);
  }
}

/* ---------------------------------------------------------------------- */
/* 法术管理器                                                              */
/* ---------------------------------------------------------------------- */

export class SpellManager {
  constructor(scene, vfx) {
    this.scene = scene;
    this.vfx = vfx;
    this.bursts = new BurstPool(scene);

    /* -- Q：冰晶场 -- */
    this._crystals = new CrystalField(scene);
    this._crystalState = null; // 同一时间只有一场霜新星

    /* -- E：陨石 -- */
    this._meteor = new MeteorRig(scene);
    this._meteorLight = new THREE.PointLight('#ff8a3c', 0, 26, 2);
    scene.add(this._meteorLight);

    /* -- R：丝带闪电（沙盒闪电材质，双 pass：宽晕 + 灼芯）——紫暴放大版 -- */
    this._boltConfig = thunderConfig({
      sag: 0, // 垂直落雷不压弯
      strands: 14,
      spread: 1.15,
      spreadNear: 0.03,
      spreadCurve: 1.5,
      jitter: 0.58,
      jitterScale: 0.72,
      width: 0.042,
      widthTip: 0.5,
      coreWidth: 1.55,
      coreSharp: 4.4,
      glowWidth: 8.5,
      glowOpacity: 0.6,
      glowFalloff: 2.2,
      restrike: 18,
      flicker: 0.35,
      strandFlash: 0.55,
      glow: 2.8,
      // 雷暴紫：与游戏 storm 强调色同族（#a98bff）
      colorCore: '#ffffff',
      colorInner: '#e9dfff',
      colorOuter: '#a98bff',
      colorHalo: '#5a2bd6'
    });
    this._boltGeometry = createBoltRibbonGeometry(72, 14);
    this._boltGroup = new THREE.Group();
    this._boltGroup.visible = false;
    scene.add(this._boltGroup);
    this._boltMaterials = [];
    for (const pass of [BoltPass.GLOW, BoltPass.CORE]) {
      const material = createLightningMaterial(pass, this._boltConfig);
      const mesh = new THREE.Mesh(this._boltGeometry, material);
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      // 宽晕先画，灼芯叠在其上。
      mesh.renderOrder = 11 + pass * 2;
      this._boltGroup.add(mesh);
      this._boltMaterials.push(material);
    }
    this._boltState = {
      origin: new THREE.Vector3(),
      target: new THREE.Vector3(),
      side: new THREE.Vector3(1, 0, 0),
      progress: 0,
      fade: 1,
      seed: 0,
      strands: 14
    };
    this._boltLight = new THREE.PointLight('#c9b8ff', 0, 30, 2);
    scene.add(this._boltLight);

    /* -- 普通攻击：沙盒蓄能球（噪声啃噬的能量弹）池 -- */
    this._balls = [];
    const orbGeometry = new THREE.IcosahedronGeometry(1, 3);
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
      const orb = new THREE.Mesh(orbGeometry, createOrbMaterial({
        core: '#ffffff', inner: '#d3f4ff', outer: '#56d8ff', glow: 2.8
      }));
      orb.scale.setScalar(0.2);
      orb.renderOrder = 20; // 地面贴花之上，避免霜面/焦痕盖住能量球
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this._ballHaloTexture, color: '#9fd8ff', transparent: true, opacity: 0.75,
        blending: THREE.AdditiveBlending, depthWrite: false
      }));
      halo.scale.setScalar(1.6);
      halo.renderOrder = 20;
      group.add(orb, halo);
      group.visible = false;
      scene.add(group);
      this._balls.push({ group, orb, halo, busy: false });
    }

    this._active = [];
    this._scratchDir = new THREE.Vector3();
    this._scratchUp = new THREE.Vector3(0, 1, 0);
  }

  /** 施放。`onImpact(point, spiritRadius)` 在法术命中地面时回调一次。 */
  cast(element, from, to, onImpact) {
    if (element === 'ice') this._castIce(from, to, onImpact);
    else if (element === 'fire') this._castFire(from, to, onImpact);
    else if (element === 'storm') this._castStorm(to, onImpact);
  }

  /**
   * 普通攻击：从 `from`（杖头宝珠）向 `to` 发射一颗元素蓄能球。
   * `onMove(pos)` 每帧回调球体当前位置（用于路径命中判定）；
   * `onImpact(point)` 在球落地时回调一次。
   */
  castBasic(from, to, color, onMove, onImpact) {
    const slot = this._balls.find((ball) => !ball.busy) ?? this._balls[0];
    slot.busy = true;
    slot.group.visible = true;
    slot.group.position.copy(from);
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

    // 沙盒式拖尾：速度拉伸的火花 + 柔光尘
    const el = this._elementFromColor(state.color);
    const palette = ORB_PALETTES[el] ?? ORB_PALETTES.ice;
    const vfx = this.vfx;
    vfx.sparks.setGradient('#ffffff', palette.inner, palette.outer, palette.outer);
    vfx.sparks.uniforms.uGravity.value.set(0, -1.5, 0);
    vfx.sparks.uniforms.uSizeScale.value = 0.55;
    vfx.sparks.uniforms.uLifeScale.value = 0.32;
    vfx.sparks.uniforms.uGlow.value = 1.5;
    const e = vfx._emit;
    e.position = state.slot.group.position;
    e.radius = 0.1;
    e.direction = null;
    e.speed = 1.2;
    e.speedVariance = 0.8;
    e.spread = 1.0;
    e.size = 0.14;
    e.sizeVariance = 0.7;
    e.life = 0.3;
    e.lifeVariance = 0.5;
    e.spin = 0;
    e.tint = null;
    e.time = frame.uTime.value;
    vfx.sparks.emit(3, e);

    // 呼吸脉动，远看也醒目
    state.slot.orb.scale.setScalar(0.2 * (1.1 + 0.18 * Math.sin(state.t * 34)));
    state.slot.orb.material.uniforms.uCharge.value = 1;
    state.slot.halo.material.color.set(state.color);
    if (k >= 1 && !state.fired) {
      state.fired = true;
      state.slot.group.visible = false;
      state.slot.busy = false;
      // 命中：薄压力壳 + 冲击波环 + 火花
      this.vfx.bursts.spawn(BurstMode.AIR, state.point, {
        radius: 0.12, endRadius: 1.9, life: 0.38,
        intensity: 1.0, opacity: 0.9, fresnel: 2.0, displace: 0.3,
        colorA: state.color, colorB: '#ffffff', colorC: '#d3f4ff'
      });
      this.vfx.decals.spawn(DecalType.SHOCKWAVE, state.point, {
        radius: 2.1, life: 0.42, width: 0.06, intensity: 0.9,
        colorA: state.color, colorB: '#ffffff'
      });
      this.vfx.sparkBurst(state.point, el, { count: 26, speed: 5.5, life: 0.6, size: 0.9, up: 1.2 });
      this._flash(state.point, state.color, 110);
      state.onImpact(state.point, 1.8, state.hitSet);
    }
    return state.fired && state.t > state.duration + 0.15;
  }

  /** 由强调色猜元素（供火花配色）。 */
  _elementFromColor(hex) {
    if (hex.startsWith('#56d8')) return 'ice';
    if (hex.startsWith('#ff8a')) return 'fire';
    if (hex.startsWith('#a98b')) return 'storm';
    return 'basic';
  }

  /* -- Q 霜新星：沙盒式直线冰晶喷发（前沿推进 → 落点炸开） -- */
  _castIce(from, point, onImpact) {
    // 上一场还没收完就提前复用：直接收掉旧场。
    if (this._crystalState) {
      this._crystals.hide();
      this._crystalState = null;
    }
    const dir = this._scratchDir.set(point.x - from.x, 0, point.z - from.z);
    const len = Math.max(3, dir.length());
    dir.divideScalar(Math.max(1e-4, dir.length()));
    const side = new THREE.Vector3(-dir.z, 0, dir.x); // 弹道带的横向
    const records = this._crystals.layout(from, point, dir, side);
    this._crystalState = {
      age: 0,
      started: false,
      fired: false,
      retract: 0,
      front: 0,
      len,
      dir: dir.clone(),
      side: side.clone(),
      start: from.clone(),
      point: point.clone(),
      records,
      frostDist: 1.2, // 下一次撒霜面的弹道距离
      frostAccum: 0,
      onImpact
    };
    this._active.push({ type: 'ice' });
  }

  _tickIce(state, dt) {
    const s = this._crystalState;
    s.age += dt;
    const travelTime = s.len / ICE_FRONT_SPEED;

    // 起手：断裂从施放者脚下撕开，先炸起一小蓬霜
    if (!s.started) {
      s.started = true;
      this.vfx.bursts.spawn(BurstMode.FROST, s.start.clone().setY(0.5), {
        radius: 0.18, endRadius: 2.2, life: 0.45,
        intensity: 0.85, opacity: 0.9, fresnel: 1.4, displace: 0.4,
        colorA: '#a9e4ff', colorB: '#cdefff', colorC: '#f2feff'
      });
      this.vfx.decals.spawn(DecalType.FROST, s.start, {
        radius: 2.2, life: 5.5, intensity: 0.6, width: 1.5,
        colorA: '#f0f9ff', colorB: '#79b6dd', height: 0.045
      });
      this.vfx.sparkBurst(s.start, 'ice', { count: 30, speed: 5, life: 0.6, size: 0.9, up: 1.2 });
      this._flash(s.start, '#8fd8ff', 90);
    }

    // 断裂前沿沿弹道推进，越过之处冰晶破土
    if (!s.fired) s.front += ICE_FRONT_SPEED * dt;
    const limit = saturate(s.front / s.len);
    this._crystals.triggerUpTo(s.records, s.age, limit, s.fired);

    // 前沿经过之处地面结霜（沙盒 frostSpread：霜面沿弹道一路铺向落点）
    s.frostAccum += ICE_FRONT_SPEED * dt;
    while (!s.fired && s.frostAccum >= 2.4 && s.frostDist < s.len - 0.5) {
      s.frostAccum -= 2.4;
      const fx = s.start.x + s.dir.x * s.frostDist + s.side.x * randRange(-1, 1);
      const fz = s.start.z + s.dir.z * s.frostDist + s.side.z * randRange(-1, 1);
      this.vfx.decals.spawn(DecalType.FROST, { x: fx, z: fz }, {
        radius: 2.0, life: 5.0, intensity: 0.55, width: 1.5,
        colorA: '#f0f9ff', colorB: '#79b6dd', height: 0.045
      });
      s.frostDist += 2.4;
    }

    // 前沿抵达落点：冲击簇连同霜壳一起炸开
    if (!s.fired && limit >= 1) {
      s.fired = true;
      this.vfx.bursts.spawn(BurstMode.FROST, s.point.clone().setY(0.6), {
        radius: 0.3, endRadius: 4.4, life: 0.6,
        intensity: 0.95, opacity: 0.95, fresnel: 1.3, displace: 0.45,
        colorA: '#a9e4ff', colorB: '#cdefff', colorC: '#f2feff'
      });
      this.vfx.decals.spawn(DecalType.SHOCKWAVE, s.point, {
        radius: 5.4, life: 0.55, width: 0.05, intensity: 0.95,
        colorA: '#5fd0ff', colorB: '#f2feff'
      });
      this.vfx.decals.spawn(DecalType.FROST, s.point, {
        radius: 5.0, life: 7.0, intensity: 0.85, width: 1.5,
        colorA: '#f0f9ff', colorB: '#79b6dd', height: 0.05
      });
      this.vfx.sparkBurst(s.point, 'ice', { count: 90, speed: 8, life: 0.9, size: 1.1, up: 1.4 });
      this._flash(s.point, '#8fd8ff', 160);
      s.onImpact(s.point, 4.6);
    }

    // 冰晶场推进 + 沉回收场
    if (s.age > travelTime + CRYSTAL_HOLD + 0.3) {
      s.retract = Math.min(1, s.retract + dt / CRYSTAL_SINK);
    }
    this._crystals.update(s.records, s.age, s.retract);

    // 前沿附近上升的微光（沙盒 signature 闪光羽）
    if (!s.retract) {
      this.vfx.motes.setGradient('#f2feff', '#a9e4ff', '#57c9ff', '#0a3552');
      this.vfx.motes.uniforms.uGravity.value.set(0, 1.6, 0);
      this.vfx.motes.uniforms.uSizeScale.value = 0.7;
      this.vfx.motes.uniforms.uLifeScale.value = 1.4;
      this.vfx.motes.uniforms.uTurbulence.value = 0.5;
      this.vfx.motes.uniforms.uGlow.value = 1.2;
      const e = this.vfx._emit;
      const at = Math.min(s.front, s.len) * (0.75 + Math.random() * 0.25);
      e.position = this._scratchUp.set(
        s.start.x + s.dir.x * at + s.side.x * randRange(-1.5, 1.5),
        0.2,
        s.start.z + s.dir.z * at + s.side.z * randRange(-1.5, 1.5)
      );
      e.radius = 1.0;
      e.direction = null;
      e.speed = 2.4;
      e.speedVariance = 0.8;
      e.spread = 0.7;
      e.size = 0.1;
      e.sizeVariance = 0.6;
      e.life = 1.6;
      e.lifeVariance = 0.5;
      e.spin = 0;
      e.tint = null;
      e.time = frame.uTime.value;
      this.vfx.motes.emit(2, e);
    }

    if (s.retract >= 1) {
      this._crystals.hide();
      this._crystalState = null;
      return true;
    }
    return false;
  }

  /* -- E 落炎陨石：程序化燃烧石球 -- */
  _castFire(from, to, onImpact) {
    const dir = this._scratchDir
      .set(to.x - from.x, 0, to.z - from.z)
      .normalize();
    const start = to.clone().addScaledVector(dir, -9).add(new THREE.Vector3(0, 17, 0));
    this._meteor.launch(start);
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
    const e2 = k * k;
    const pos = state.start.clone().lerp(state.point, e2);
    // 充能 0→1：熔岩缝在坠落途中越烧越亮
    const charge = saturate(state.t / state.duration);
    const heading = state.point.clone().sub(state.start).normalize();
    this._meteor.tickRock(pos, state.t * 7, state.t * 5, charge, heading);
    this._meteorLight.position.copy(pos);
    this._meteorLight.intensity = 130;

    // 火尾：上升的余烬 + 拉伸火花 + 烟
    this.vfx.motes.setGradient('#fff3d0', '#ff9a2e', '#ff3b0d', '#2b0d05');
    this.vfx.motes.uniforms.uGravity.value.set(0, 1.5, 0);
    this.vfx.motes.uniforms.uSizeScale.value = 1.0;
    this.vfx.motes.uniforms.uLifeScale.value = 0.8;
    this.vfx.motes.uniforms.uTurbulence.value = 0.5;
    this.vfx.motes.uniforms.uGlow.value = 1.4;
    const e = this.vfx._emit;
    e.position = pos;
    e.radius = 0.7;
    e.direction = null;
    e.speed = 2.4;
    e.speedVariance = 0.8;
    e.spread = 0.9;
    e.size = 0.28;
    e.sizeVariance = 0.6;
    e.life = 0.7;
    e.lifeVariance = 0.5;
    e.spin = 0;
    e.tint = null;
    e.time = frame.uTime.value;
    this.vfx.motes.emit(5, e);
    this.vfx.sparkBurst(pos, 'fire', { count: 2, speed: 3, life: 0.4, size: 0.8, up: 0.4, radius: 0.5 });

    if (k >= 1 && !state.fired) {
      state.fired = true;
      this._meteor.hideRock();
      this._meteor.burstChunks(state.point);
      this._meteorLight.intensity = 260;
      // 翻卷火球 + 冲击波 + 龟裂 + 焦痕
      this.vfx.bursts.spawn(BurstMode.FIRE, state.point.clone().setY(0.8), {
        radius: 0.5, endRadius: 5.6, life: 0.7,
        intensity: 1.2, opacity: 0.95, fresnel: 1.0, displace: 0.55, turbulence: 1.4,
        colorA: '#ffd27a', colorB: '#ff6a12', colorC: '#fff3d0'
      });
      this.vfx.decals.spawn(DecalType.SHOCKWAVE, state.point, {
        radius: 6.0, life: 0.6, width: 0.05, intensity: 1.0,
        colorA: '#ff9a2e', colorB: '#fff3d0'
      });
      this.vfx.decals.spawn(DecalType.CRACK, state.point, {
        radius: 5.2, life: 5.5, width: 0.14, intensity: 1.2,
        colorA: '#1a0d05', colorB: '#ff6a12', height: 0.045
      });
      this.vfx.decals.spawn(DecalType.SCORCH, state.point, {
        radius: 2.8, life: 8.0, intensity: 0.95,
        colorA: '#0d0907', colorB: '#ff9a2e', height: 0.04
      });
      this.vfx.decals.spawn(DecalType.DUSTRING, state.point, {
        radius: 4.4, life: 1.1, intensity: 0.7,
        colorA: '#3a322c', colorB: '#ffb066', height: 0.05
      });
      this.vfx.sparkBurst(state.point, 'fire', { count: 150, speed: 11, life: 1.1, size: 1.2, up: 1.2 });
      this._flash(state.point, '#ffb066', 220);
      state.onImpact(state.point, 5.4);
    }
    if (state.fired) {
      this._meteor.tickChunks(dt);
      this._meteorLight.intensity *= Math.max(0, 1 - dt * 5);
      if (state.t > state.duration + 2.4) {
        this._meteorLight.intensity = 0;
        return true;
      }
    }
    return false;
  }

  /* -- R 天雷殛灭：沙盒丝带闪电 -- */
  _castStorm(point, onImpact) {
    this._active.push({
      type: 'storm',
      t: 0,
      point: point.clone(),
      fired: false,
      seed: Math.random() * 100,
      onImpact
    });
  }

  _tickStorm(state, dt) {
    state.t += dt;
    // 0.15 秒预警微光 → 落雷
    if (!state.fired && state.t >= 0.15) {
      state.fired = true;
      // 丝带闪电从天而降：顶端带随机偏移
      this._boltState.origin.set(
        state.point.x + (Math.random() - 0.5) * 2.5,
        22,
        state.point.z + (Math.random() - 0.5) * 2.5
      );
      this._boltState.target.set(state.point.x, 0.05, state.point.z);
      this._boltState.seed = state.seed;
      this._boltGroup.visible = true;
      this._boltLight.position.set(state.point.x, 6, state.point.z);
      // 电离空气壳 + 冲击波 + 分叉电流灼痕 + 焦痕
      this.vfx.bursts.spawn(BurstMode.STORM, state.point.clone().setY(0.7), {
        radius: 0.25, endRadius: 3.4, life: 0.6,
        intensity: 1.2, opacity: 0.95, fresnel: 1.6, displace: 0.5,
        colorA: '#a98bff', colorB: '#d3f4ff', colorC: '#ffffff'
      });
      this.vfx.decals.spawn(DecalType.SHOCKWAVE, state.point, {
        radius: 5.6, life: 0.55, width: 0.05, intensity: 1.0,
        colorA: '#c9ecff', colorB: '#ffffff'
      });
      this.vfx.decals.spawn(DecalType.ARC, state.point, {
        radius: 3.6, life: 0.95, width: 0.6, intensity: 1.1,
        colorA: '#12060a', colorB: '#c9a6ff', height: 0.045
      });
      // 落点四周再撒几片小的电弧灼痕（沙盒 arcRate 沿雷击散布的观感）
      for (let i = 0; i < 4; i++) {
        const ang = Math.random() * Math.PI * 2;
        const rad = 1.6 + Math.random() * 2.6;
        this.vfx.decals.spawn(DecalType.ARC, {
          x: state.point.x + Math.cos(ang) * rad,
          z: state.point.z + Math.sin(ang) * rad
        }, {
          radius: 1.3 + Math.random() * 1.1, life: 0.8, width: 0.55,
          intensity: 0.9, colorA: '#12060a', colorB: '#9fdcff', height: 0.04
        });
      }
      this.vfx.decals.spawn(DecalType.SCORCH, state.point, {
        radius: 1.6, life: 6.0, intensity: 0.5,
        colorA: '#080b11', colorB: '#8f6bff', height: 0.04
      });
      this.vfx.sparkBurst(state.point, 'storm', { count: 120, speed: 10, life: 0.8, size: 1.1, up: 1.0 });
      this._flash(state.point, '#c9b8ff', 260);
      state.onImpact(state.point, 5.0);
    }
    if (state.fired) {
      const since = state.t - 0.15;
      // 打击前沿 0.08 秒内冲到地面，随后保持 0.3 秒，最后 0.15 秒熄灭
      this._boltState.progress = Math.min(1, since / 0.08);
      this._boltState.fade = since < 0.45 ? 1 : Math.max(0, 1 - (since - 0.45) / 0.17);
      for (const material of this._boltMaterials) material.userData.sync(this._boltState);
      this._boltLight.intensity = Math.max(0, 260 * (1 - since / 0.5));
      this._boltLight.position.y = 4;
      if (since > 0.62) {
        this._boltGroup.visible = false;
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
    this._crystals.hide();
    this._crystalState = null;
    this._meteor.reset();
    this._meteorLight.intensity = 0;
    this._boltGroup.visible = false;
    this._boltLight.intensity = 0;
    if (this._light) this._light.intensity = 0;
    this._flashT = 0;
    for (const ball of this._balls) {
      ball.group.visible = false;
      ball.busy = false;
    }
    this.bursts.clear();
    this.vfx?.clear();
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

    this.bursts.update(dt);
  }

  dispose() {
    this.bursts.dispose();
    this._crystals.dispose();
    this._meteor.dispose();
    for (const material of this._boltMaterials) material.dispose();
    this._boltGeometry.dispose();
    for (const ball of this._balls) {
      ball.group.traverse((o) => o.geometry?.dispose?.());
      ball.orb.material.dispose();
      ball.halo.material.dispose();
    }
    this._ballHaloTexture.dispose();
  }
}
