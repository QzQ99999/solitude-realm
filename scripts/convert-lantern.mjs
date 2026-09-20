/* 提灯专用转换 v3：网格强简化（保留 UV/贴图/法线）。
 * 雕花模型 UV 接缝多，不能先 weld（会把接缝焊死）；
 * 这里直接对索引跑 meshopt simplify——meshoptimizer 内部按位置哈希合并
 * 接缝两侧的同位顶点，塌缩时两侧同步收缩，不会撕裂 UV；
 * 之后再按保留顶点压缩 POSITION/NORMAL/TEXCOORD_0。
 * 用法：node scripts/convert-lantern.mjs */
import convert from 'fbx2gltf';
import fs from 'fs';
import { NodeIO } from '@gltf-transform/core';
import { KHRMaterialsUnlit, KHRTextureTransform } from '@gltf-transform/extensions';
import { dedup, prune, quantize, textureCompress } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const SRC = 'C:/Users/31202/Desktop/孤独领域角色/Meshy_AI_Arcane_Lantern_0919203250_texture_fbx';
const OUT = 'public/spirits/lantern.glb';
const KEEP = 0.13;  // 目标三角保留比例（19.8 万 → 约 2.6 万）
// 该模型 73% 的边是边界边（碎片化孤岛），普通 simplify 的边界锁定会卡死在 161K；
// Permissive 允许塌缩边界边，实测 13% 保留率下误差仅 0.06%，外形几乎无损。
const FLAGS = ['Permissive'];

(async () => {
  process.stdout.write('FBX → GLB…\n');
  await convert(SRC + '/Meshy_AI_Arcane_Lantern_0919203250_texture.fbx', 'public/spirits/_dbg.glb', ['--binary']);
  const io = new NodeIO().registerExtensions([KHRMaterialsUnlit, KHRTextureTransform]);
  const doc = await io.read('public/spirits/_dbg.glb');
  await doc.transform(dedup(), prune());

  const mesh = doc.getRoot().listMeshes()[0];
  const prim = mesh.listPrimitives()[0];
  const pos = prim.getAttribute('POSITION');
  const indices = prim.getIndices();
  const iCount = indices.getCount();
  const triCount = iCount / 3;

  process.stdout.write(`meshopt 简化（${triCount | 0} 三角 → 目标 ${(triCount * KEEP) | 0}）…\n`);
  await MeshoptSimplifier.ready;
  const [newIndices, err] = MeshoptSimplifier.simplify(
    new Uint32Array(indices.getArray()),
    new Float32Array(pos.getArray()),
    3,
    Math.floor(triCount * KEEP) * 3,
    1.0,
    FLAGS
  );

  // 按"被保留的顶点"压缩全部属性（POSITION/NORMAL/TEXCOORD_0）
  const remap = new Map();
  for (const old of newIndices) if (!remap.has(old)) remap.set(old, remap.size);
  const buffer = pos.getBuffer();
  const compactAttr = (attr, type) => {
    const src = attr.getArray();
    const comp = attr.getElementSize();
    const dst = new src.constructor(remap.size * comp);
    for (const [newId, oldId] of remap)
      for (let c = 0; c < comp; c++)
        dst[newId * comp + c] = src[oldId * comp + c];
    return doc.createAccessor().setArray(dst).setType(type).setBuffer(buffer);
  };
  prim.setAttribute('POSITION', compactAttr(pos, 'VEC3'));
  const normal = prim.getAttribute('NORMAL');
  if (normal) prim.setAttribute('NORMAL', compactAttr(normal, 'VEC3'));
  const uv = prim.getAttribute('TEXCOORD_0');
  if (uv) prim.setAttribute('TEXCOORD_0', compactAttr(uv, 'VEC2'));
  prim.setIndices(doc.createAccessor()
    .setArray(new Uint32Array(Array.from(newIndices, (v) => remap.get(v))))
    .setType('SCALAR')
    .setBuffer(buffer));

  await doc.transform(textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024] }));
  await doc.transform(quantize());
  await io.write(OUT, doc);
  fs.rmSync('public/spirits/_dbg.glb', { force: true });
  console.log(`lantern 定稿: ${remap.size} 顶点 ${newIndices.length / 3 | 0} 三角（误差 ${(err * 100).toFixed(2)}%）`,
    (fs.statSync(OUT).size / 1e6).toFixed(2) + 'MB');
})();
