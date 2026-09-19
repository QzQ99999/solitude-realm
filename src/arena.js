import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BOUNDARY_RADIUS } from './player.js';
import { patchMarble } from './arenaMarble.js';

/**
 * arena.js — 黑剑 BOSS 战场景（孤独领域）。
 *
 * 由 Blender 建模导出的 GLB（Draco 压缩）：中央是一座环形斗技场——顶层圆盘
 * 即玩家活动场地，导出时已把圆盘边缘对齐到半径 58（BOUNDARY_RADIUS）、盘面
 * 对齐到 y=0；四周环廊与浮空黑塔只作背景，玩家被边界拦在圆盘之内。
 * 盘面下方铺有一层深色石底衬（见 loadArena），挡住雕镂缝隙的透视。
 *
 * 性能：GLB 原始 657 个网格逐个渲染 draw call 开销巨大（实测占总帧时间约
 * 一半），加载后按材质把静态网格合并成几十个（mergeArena），场景是纯静态
 * 摆设，合并不损失任何表现。
 *
 * 模型异步加载，`onReady` 在场景可用（或失败降级）时回调一次。
 */

/** 多材质网格：按 geometry.groups 拆成"单材质子几何体"列表。 */
function splitMultiMaterial(node) {
  const out = [];
  const geo = node.geometry;
  for (const grp of geo.groups) {
    const mat = node.material[grp.materialIndex];
    if (!mat || grp.count === 0) continue;
    const sub = geo.clone();
    if (geo.index) {
      const idx = geo.index.array.slice(grp.start, grp.start + grp.count);
      sub.setIndex(new THREE.BufferAttribute(idx, 1));
    } else {
      for (const key of Object.keys(sub.attributes)) {
        const attr = sub.attributes[key];
        const arr = attr.array.slice(attr.itemSize * grp.start, attr.itemSize * (grp.start + grp.count));
        sub.setAttribute(key, new THREE.BufferAttribute(arr, attr.itemSize));
      }
    }
    sub.clearGroups();
    sub.morphAttributes = {};
    out.push({ geo: sub, material: mat });
  }
  return out;
}

/**
 * 按材质合并场景里的全部静态网格。
 * 返回合并后的 Mesh 列表（材质原样复用），并把原网格从场景移除、释放几何体。
 */
function mergeArena(root) {
  root.updateMatrixWorld(true);

  const groups = new Map(); // material.uuid -> { material, nodes, geos, indexed }
  const stale = []; // { node, usedIds, extraGeos } 需要移除+释放的原始节点
  root.traverse((node) => {
    if (!node.isMesh || !node.material) return;
    const bakeInto = (geo, material) => {
      const key = material.uuid;
      if (!groups.has(key)) groups.set(key, { material, nodes: [], geos: [], indexed: true });
      const grp = groups.get(key);
      for (const attr of Object.keys(geo.attributes)) {
        if (attr !== 'position' && attr !== 'normal' && attr !== 'uv') geo.deleteAttribute(attr);
      }
      geo.morphAttributes = {};
      if (!geo.attributes.uv) {
        const count = geo.attributes.position.count;
        geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
      }
      if (!geo.attributes.normal) geo.computeVertexNormals();
      if (!geo.index) grp.indexed = false;
      grp.geos.push(geo);
    };

    if (Array.isArray(node.material)) {
      // 多材质网格：按组拆开分别归并；记录几何体实际用到的材质
      const usedIds = new Set();
      const parts = splitMultiMaterial(node);
      for (const part of parts) {
        part.geo.applyMatrix4(node.matrixWorld);
        bakeInto(part.geo, part.material);
        usedIds.add(part.material.uuid);
      }
      stale.push({ node, usedIds, extraGeos: [] });
    } else {
      const geo = node.geometry.clone();
      geo.applyMatrix4(node.matrixWorld);
      bakeInto(geo, node.material);
      stale.push({ node, usedIds: new Set([node.material.uuid]), extraGeos: [geo] });
    }
  });

  const merged = [];
  let removed = 0;
  let failed = 0;
  for (const grp of groups.values()) {
    const mergedGeo = mergeGeometries(
      grp.indexed ? grp.geos : grp.geos.map((g) => (g.index ? g.toNonIndexed() : g)),
      false
    );
    if (!mergedGeo) {
      // 合并失败（属性不兼容等）：保留原网格，只释放烘焙的克隆
      failed++;
      for (const geo of grp.geos) geo.dispose();
      continue;
    }
    const mesh = new THREE.Mesh(mergedGeo, grp.material);
    mesh.matrixAutoUpdate = false;
    merged.push(mesh);
    for (const geo of grp.geos) geo.dispose();
    grp.geos = []; // 标记该材质组已成功合并
  }
  for (const { node, usedIds, extraGeos } of stale) {
    // 只移除"几何体实际用到的材质全部成功合并"的节点，避免与合并体重复绘制
    let allMerged = usedIds.size > 0;
    for (const uuid of usedIds) {
      const grp = groups.get(uuid);
      if (!grp || grp.geos.length > 0) { allMerged = false; break; }
    }
    if (allMerged) {
      node.parent?.remove(node);
      node.geometry.dispose();
      removed++;
    }
    for (const geo of extraGeos) geo.dispose();
  }
  console.info(`[arena] 合并网格：${removed} -> ${merged.length}（按材质，失败组 ${failed} 保留原样）`);
  mergeArena.stats = { removed, failed, merged: merged.length };
  return merged;
}

/**
 * 加载竞技场场景。
 * @param {THREE.Scene} scene
 * @param {(ok: boolean) => void} [onReady] 装载完成/失败回调
 * @param {(pct: number|null, loadedMB: number) => void} [onProgress] 下载进度回调
 *   （pct 为 0~99 的百分比；总大小未知时为 null，loadedMB 为已下载 MB 数）
 */
export function loadArena(scene, onReady, onProgress) {
  // 圆盘底衬：竞技场地面雕刻有镂空纹样，缝隙会透视到场景下方的虚空。
  // 在盘面下方贴一层深色石底盘（边缘藏进环墙基部），从缝隙里看到的就是
  // 石材底色而不是深渊；受主题灯光影响，改写世界时同样会被染色。
  const floorPatch = new THREE.Mesh(
    new THREE.CircleGeometry(BOUNDARY_RADIUS + 1, 96),
    new THREE.MeshStandardMaterial({ color: '#10141c', roughness: 0.95, metalness: 0.05 })
  );
  floorPatch.rotation.x = -Math.PI / 2;
  floorPatch.position.y = -0.35;
  scene.add(floorPatch);

  const draco = new DRACOLoader();
  draco.setDecoderPath('draco/'); // public/draco 下的解码器
  const loader = new GLTFLoader();
  loader.setDRACOLoader(draco);

  loader.load(
    'arena.glb',
    (gltf) => {
      const model = gltf.scene;
      model.traverse((object) => {
        if (object.isMesh) {
          // 烘焙贴图直接受灯光；投影开销太大，暂不开启
          object.castShadow = false;
          object.receiveShadow = false;
        }
      });
      // 性能优化：静态网格按材质合并，draw call 从数百降到几十
      const merged = mergeArena(model);
      window.__arenaMerge = mergeArena.stats; // 供控制台检查合并结果
      for (const mesh of merged) {
        patchMarble(mesh.material); // 白底材质注入大理石/岩石质感
        model.add(mesh);
      }
      scene.add(model);
      onReady?.(true);
    },
    (event) => {
      if (!onProgress) return;
      if (event.total > 0) {
        onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)), event.loaded / 1048576);
      } else {
        onProgress(null, event.loaded / 1048576);
      }
    },
    (error) => {
      console.error('[arena] 场景加载失败', error);
      onReady?.(false);
    }
  );
}

/** 供调试/扩展：在圆盘中心上方放一盏幽暗烛光（黑剑场景的氛围点光）。 */
export function makeAmbientCandle(scene) {
  const light = new THREE.PointLight('#8fb4de', 70, 150, 1.8);
  light.position.set(0, 20, 0);
  scene.add(light);
  return light;
}
