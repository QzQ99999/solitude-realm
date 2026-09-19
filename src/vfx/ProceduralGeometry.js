import {
  BufferGeometry,
  BufferAttribute,
  Float32BufferAttribute,
  IcosahedronGeometry,
  InstancedBufferGeometry,
  InstancedBufferAttribute,
  Sphere,
  Vector3
} from 'three';
import { clamp, hash11, smoothstep } from './math.js';

/**
 * ProceduralGeometry.js — CPU 侧程序化几何。
 *
 * 移植自 elemental-sandbox（MIT）。本项目除角色外没有任何网格资产，
 * 冰晶与陨石都在这里生成。一颗六面晶体只有 108 个三角形，便宜到可以直接
 * 重建——形状参数烘焙进几何体，而不是在顶点着色器里近似。
 * 一切在 `seed` 中确定：同一个种子永远得到同一颗晶体。
 */

const TAU = Math.PI * 2;

/** 晶体的高度/半径轮廓，在下面的环高采样。`t` 是到塔尖的比例；返回半径是底半径的比例。 */
const RING_HEIGHTS = [0, 0.22, 0.5, 0.75, 0.92];

function profileRadius(t, taper) {
  return taper + (1 - taper) * Math.pow(1 - t, 1.15);
}

/**
 * 一颗冰晶：带锥度、多面、微微弯曲的棱柱。
 *
 * 单位空间 —— 底环在 y = 0、外接半径 0.5，塔尖在 y = 1。实例因此可以独立
 * 缩放 footprint 与高度，`local.y` 直接读作"我在这颗晶体的高处"，
 * IceMaterial 里的霜带正是以此为键。
 */
export function createCrystalGeometry({
  seed = 1,
  sides = 6,
  taper = 0.13,
  roughness = 0.28,
  bend = 0.22
} = {}) {
  const facets = Math.max(3, Math.round(sides));
  const tipRadius = Math.min(0.9, Math.max(0.01, taper));

  // 每颗晶体一个固定的弯曲方向，整片晶体场才像在整体倾斜。
  const bendAngle = hash11(seed * 1.77) * TAU;
  const bendX = Math.cos(bendAngle);
  const bendZ = Math.sin(bendAngle);

  /** 晶体轴在高度 `t` 处的横向漂移。 */
  const axisOffset = (t) => bend * 0.5 * Math.pow(t, 1.6);

  // 角度只抖动一次并由所有环共享，棱面才能保持连续的边，而不是拧成螺丝。
  const angles = [];
  for (let i = 0; i < facets; i++) {
    const jitter = (hash11(seed * 3.13 + i * 7.7) - 0.5) * (TAU / facets) * 0.55 * roughness * 3;
    angles.push((i / facets) * TAU + jitter);
  }

  const rings = RING_HEIGHTS.map((t, ringIndex) => {
    const baseR = profileRadius(t, tipRadius) * 0.5;
    const drift = axisOffset(t);
    // 高度抖动让肩线不再叠成干净的环带。
    const y = t + (hash11(seed * 5.9 + ringIndex * 2.3) - 0.5) * 0.06 * roughness * (t > 0 ? 1 : 0);

    return angles.map((angle, i) => {
      // 不规则度向塔尖增长：晶体在破土处大致浑圆，在撕裂处越来越破。
      const wobble = 1 + (hash11(seed * 11.1 + ringIndex * 13.7 + i * 3.9) - 0.5) * roughness * 1.3 * (0.35 + 0.65 * t);
      const r = Math.max(0.002, baseR * wobble);
      return [Math.cos(angle) * r + bendX * drift, y, Math.sin(angle) * r + bendZ * drift];
    });
  });

  // 塔尖略微偏离轴线，尖端读作崩口而不是圆锥的顶点。
  const apexDrift = axisOffset(1);
  const apex = [
    bendX * apexDrift + (hash11(seed * 17.3) - 0.5) * 0.09 * roughness,
    1,
    bendZ * apexDrift + (hash11(seed * 19.7) - 0.5) * 0.09 * roughness
  ];
  const floorCentre = [0, 0, 0];

  // --- 三角形 ---
  const positions = [];
  const push = (p) => positions.push(p[0], p[1], p[2]);

  for (let ring = 0; ring < rings.length - 1; ring++) {
    const lower = rings[ring];
    const upper = rings[ring + 1];
    for (let i = 0; i < facets; i++) {
      const j = (i + 1) % facets;
      push(lower[i]); push(lower[j]); push(upper[i]);
      push(lower[j]); push(upper[j]); push(upper[i]);
    }
  }

  const top = rings[rings.length - 1];
  const base = rings[0];
  for (let i = 0; i < facets; i++) {
    const j = (i + 1) % facets;
    push(top[i]); push(top[j]); push(apex); // 尖
    push(floorCentre); push(base[j]); push(base[i]); // 底面
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  // 非索引 + 逐面法线：棱面才会锋利。
  geometry.computeVertexNormals();
  return geometry;
}

/** 一枚短宽的晶片——绕主塔四周补齐脚踝高度的碎砾。同一单位空间。 */
export function createShardGeometry(seed = 5, sides = 5) {
  return createCrystalGeometry({
    seed: seed * 2.7 + 41,
    sides,
    taper: 0.22,
    roughness: 0.55,
    bend: 0.35
  });
}

/* ---------------------------------------------------------------------- */
/* 陨石                                                                    */
/* ---------------------------------------------------------------------- */

/** 下面值噪声的一个晶格角。 */
function lattice(ix, iy, iz, seed) {
  return hash11(ix * 127.1 + iy * 311.7 + iz * 74.7 + seed * 19.19);
}

/**
 * 确定性 3D 值噪声，0..1。GLSL 库里有单纯形噪声，但陨石要在 CPU 位移
 * （顶点着色器动不了影子轮廓和法线），所以需要这份 JS 对应实现。
 */
function valueNoise3(x, y, z, seed) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;

  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);

  const c000 = lattice(ix, iy, iz, seed);
  const c100 = lattice(ix + 1, iy, iz, seed);
  const c010 = lattice(ix, iy + 1, iz, seed);
  const c110 = lattice(ix + 1, iy + 1, iz, seed);
  const c001 = lattice(ix, iy, iz + 1, seed);
  const c101 = lattice(ix + 1, iy, iz + 1, seed);
  const c011 = lattice(ix, iy + 1, iz + 1, seed);
  const c111 = lattice(ix + 1, iy + 1, iz + 1, seed);

  const x00 = c000 + (c100 - c000) * ux;
  const x10 = c010 + (c110 - c010) * ux;
  const x01 = c001 + (c101 - c001) * ux;
  const x11 = c011 + (c111 - c011) * ux;

  const y0 = x00 + (x10 - x00) * uy;
  const y1 = x01 + (x11 - x01) * uy;

  return y0 + (y1 - y0) * uz;
}

/** 基于 valueNoise3 的带符号 fbm，约 -1..1。 */
function fbmValue(x, y, z, seed, octaves) {
  let value = 0;
  let amplitude = 0.5;
  let frequency = 1;
  for (let i = 0; i < octaves; i++) {
    value += amplitude * (valueNoise3(x * frequency, y * frequency, z * frequency, seed + i * 7.7) * 2 - 1);
    frequency *= 2.03;
    amplitude *= 0.5;
  }
  return value;
}

/**
 * 一颗陨石：碎裂、坑洼的石球。
 *
 * 单位空间 —— 半径 1 的二十面球，顶点沿自身方向内外推挤，实例直接把缩放
 * 当米用，`local` 读作岩石上的方向。MeteorMaterial 正是在该空间采样熔岩缝：
 * 裂纹焊在岩石上随它翻滚，而不是在表面游动。
 *
 * 三层堆叠让它读作*石头*：fbm 团块（大形）、平面切割（真正的平断面 +
 * 硬边）、陨石坑（带喷射环的碗）。
 */
export function createAsteroidGeometry({
  seed = 1,
  detail = 3,
  lumpiness = 0.26,
  noiseScale = 1.5,
  roughness = 0.16,
  cuts = 7,
  cutDepth = 0.2,
  craters = 5,
  craterDepth = 0.18,
  craterSize = 0.5
} = {}) {
  const geometry = new IcosahedronGeometry(1, clamp(Math.round(detail), 0, 3)).toNonIndexed();
  const array = geometry.attributes.position.array;

  /** 单位球上一个确定性的点。 */
  const direction = (a, b) => {
    const phi = Math.acos(2 * hash11(a) - 1);
    const theta = hash11(b) * TAU;
    const sinPhi = Math.sin(phi);
    return { x: sinPhi * Math.cos(theta), y: Math.cos(phi), z: sinPhi * Math.sin(theta) };
  };

  // 切割面与坑按种子挑一次、所有顶点共享，下面的顶点循环保持纯查表。
  const planes = [];
  for (let i = 0; i < Math.max(0, Math.round(cuts)); i++) {
    const n = direction(seed * 2.3 + i * 9.1, seed * 5.7 + i * 4.3);
    // 平面沿自身法线的位置：1 是相切（不咬），更小则削掉一面。
    n.offset = 1 - cutDepth * (0.35 + 0.9 * hash11(seed * 13.1 + i * 6.7));
    planes.push(n);
  }

  const bowls = [];
  for (let i = 0; i < Math.max(0, Math.round(craters)); i++) {
    const c = direction(seed * 3.1 + i * 12.9, seed * 7.7 + i * 5.3);
    c.radius = Math.max(0.08, craterSize * (0.45 + 0.8 * hash11(seed * 11.3 + i * 3.7)));
    c.depth = craterDepth * (0.5 + hash11(seed * 17.9 + i * 2.1));
    bowls.push(c);
  }

  for (let i = 0; i < array.length; i += 3) {
    const x = array[i];
    const y = array[i + 1];
    const z = array[i + 2];

    /* --- 1. 团块主体 --- */
    let radius = 1;
    radius += fbmValue(x * noiseScale, y * noiseScale, z * noiseScale, seed, 3) * lumpiness;
    radius +=
      fbmValue(x * noiseScale * 4.3, y * noiseScale * 4.3, z * noiseScale * 4.3, seed + 31.7, 2) *
      roughness *
      0.5;

    /* --- 2. 陨石坑，先于切割，让切面能把坑劈成两半 --- */
    for (const bowl of bowls) {
      const angle = Math.acos(clamp(x * bowl.x + y * bowl.y + z * bowl.z, -1, 1));
      const q = angle / bowl.radius;
      if (q >= 1.4) continue;
      radius -= bowl.depth * Math.max(0, 1 - q * q);
      radius += bowl.depth * 0.5 * smoothstep(0.72, 1.0, q) * (1 - smoothstep(1.0, 1.4, q));
    }

    radius = Math.max(0.35, radius);
    let px = x * radius;
    let py = y * radius;
    let pz = z * radius;

    /* --- 3. 切出平断面 --- */
    for (const plane of planes) {
      const along = px * plane.x + py * plane.y + pz * plane.z;
      const over = along - plane.offset;
      if (over <= 0) continue;
      // 投影回平面。外面的顶点都落在面上，得到的是真正的平面，不是压扁的弧。
      px -= plane.x * over;
      py -= plane.y * over;
      pz -= plane.z * over;
    }

    array[i] = px;
    array[i + 1] = py;
    array[i + 2] = pz;
  }

  geometry.attributes.position.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/* ---------------------------------------------------------------------- */
/* 闪电                                                                    */
/* ---------------------------------------------------------------------- */

/**
 * 闪电丝所在的条带 —— 参数空间里的平面梯格。
 *
 * 每个顶点携带 `position = (t, side, 0)`：t 从施法者到命中点，side 是条带
 * 两侧 ±1。这里没有米；LightningMaterial 每帧把这一对变成世界坐标，
 * 一条带服务任意长度、形状、宽度的闪电。
 *
 * 一个实例是一根丝，`aStrand` 是它的序号。
 */
export function createBoltRibbonGeometry(nodes = 72, strands = 24) {
  const steps = Math.max(2, Math.round(nodes));
  const count = Math.max(1, Math.round(strands));

  const positions = new Float32Array(steps * 2 * 3);
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    const o = i * 6;
    positions[o + 0] = t;
    positions[o + 1] = -1;
    positions[o + 3] = t;
    positions[o + 4] = 1;
  }

  const indices = new Uint16Array((steps - 1) * 6);
  for (let i = 0; i < steps - 1; i++) {
    const a = i * 2;
    const o = i * 6;
    indices[o + 0] = a;
    indices[o + 1] = a + 1;
    indices[o + 2] = a + 2;
    indices[o + 3] = a + 1;
    indices[o + 4] = a + 3;
    indices[o + 5] = a + 2;
  }

  const strandIndex = new Float32Array(count);
  for (let i = 0; i < count; i++) strandIndex[i] = i;

  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('aStrand', new InstancedBufferAttribute(strandIndex, 1));
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.instanceCount = count;
  geometry.boundingSphere = new Sphere(new Vector3(), 1e4);
  return geometry;
}

/* ---------------------------------------------------------------------- */
/* 光束                                                                    */
/* ---------------------------------------------------------------------- */

/**
 * 光束的柱体 —— 参数空间里的管。
 *
 * 顶点携带 `position = (t, a, 0)`：t 从炮口到命中点，a 绕炮管一圈。
 * BeamMaterial 每帧把这一对变成世界坐标，一根管服务任意长度与轮廓。
 *
 * 用真管而不是面向相机的条带，是因为这么粗的光束必须*有*横截面：
 * 环绕时轮廓要正确地鼓起，远壁要透过近壁叠加，冲击环才能贴着它。
 *
 * 接缝列复制一份，让 a 能到达完整的 1.0 而不是折回 0——否则角向噪声会
 * 在光束上留下一道硬接缝。
 */
export function createBeamTubeGeometry(nodes = 96, sides = 26) {
  const steps = Math.max(2, Math.round(nodes));
  const facets = Math.max(3, Math.round(sides));
  const columns = facets + 1;

  const positions = new Float32Array(steps * columns * 3);
  let v = 0;
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    for (let j = 0; j < columns; j++) {
      positions[v++] = t;
      positions[v++] = j / facets;
      positions[v++] = 0;
    }
  }

  const indices = new Uint16Array((steps - 1) * facets * 6);
  let k = 0;
  for (let i = 0; i < steps - 1; i++) {
    for (let j = 0; j < facets; j++) {
      const a = i * columns + j;
      const b = a + columns;
      indices[k++] = a;
      indices[k++] = b;
      indices[k++] = a + 1;
      indices[k++] = b;
      indices[k++] = b + 1;
      indices[k++] = a + 1;
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.boundingSphere = new Sphere(new Vector3(), 1e4);
  return geometry;
}

/**
 * 沿光束竞速的冲击环 —— 实例化圆环，同样在参数空间：position = (band, a, 0)。
 * 一个实例是一片环，`aRing` 只是序号——着色器按它沿柱均匀布环并推向远方，
 * 整列环是时钟的纯函数，CPU 上没有队列。
 */
export function createBeamRingGeometry(rings = 10, segments = 44) {
  const count = Math.max(1, Math.round(rings));
  const facets = Math.max(6, Math.round(segments));
  const columns = facets + 1;

  const positions = new Float32Array(2 * columns * 3);
  let v = 0;
  for (let band = 0; band < 2; band++) {
    for (let j = 0; j < columns; j++) {
      positions[v++] = band;
      positions[v++] = j / facets;
      positions[v++] = 0;
    }
  }

  const indices = new Uint16Array(facets * 6);
  let k = 0;
  for (let j = 0; j < facets; j++) {
    const a = j;
    const b = columns + j;
    indices[k++] = a;
    indices[k++] = b;
    indices[k++] = a + 1;
    indices[k++] = b;
    indices[k++] = b + 1;
    indices[k++] = a + 1;
  }

  const ringIndex = new Float32Array(count);
  for (let i = 0; i < count; i++) ringIndex[i] = i;

  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('aRing', new InstancedBufferAttribute(ringIndex, 1));
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.instanceCount = count;
  geometry.boundingSphere = new Sphere(new Vector3(), 1e4);
  return geometry;
}
