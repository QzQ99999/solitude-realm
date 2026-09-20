/* 敌人模型转换管线（临时工具脚本）：
 * FBX → GLB → 去重/剪枝 → 网格简化 → 纹理压缩(WebP 1024) → 顶点量化。
 * 用法：node scripts/convert-spirits.mjs */
import convert from 'fbx2gltf';
import fs from 'fs';
import path from 'path';
import { NodeIO } from '@gltf-transform/core';
import { KHRMaterialsUnlit, KHRTextureTransform } from '@gltf-transform/extensions';
import { dedup, prune, quantize, simplify, textureCompress, weld } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const SRC = 'C:/Users/31202/Desktop/孤独领域角色';
const OUT = 'public/spirits';
fs.mkdirSync(OUT, { recursive: true });

const MODELS = [
  { fbx: 'Meshy_AI_Arcane_Lantern_0919203250_texture_fbx/Meshy_AI_Arcane_Lantern_0919203250_texture.fbx', out: 'lantern.glb', err: 0.012 },
  { fbx: 'Meshy_AI_Icebound_Lich_0919205910_texture_fbx/Meshy_AI_Icebound_Lich_0919205910_texture.fbx', out: 'lich.glb', err: 0.002 },
  { fbx: 'Meshy_AI_Infernal_Gourd_Hall_0920035725_texture_fbx/Meshy_AI_Infernal_Gourd_Hall_0920035725_texture.fbx', out: 'fire.glb', err: 0.002 },
  { fbx: 'Meshy_AI_The_Binding_of_Ipos_0919210214_texture_fbx/Meshy_AI_The_Binding_of_Ipos_0919210214_texture.fbx', out: 'ipos.glb', err: 0.004 },
  { fbx: 'Meshy_AI_Meshy_AI_Skull_Clan_C_0920090019_texture_fbx/Meshy_AI_Meshy_AI_Skull_Clan_C_0920090019_texture.fbx', out: 'cultist.glb', err: 0.0002, tex: 4096 }
];
// 命令行过滤：node scripts/convert-spirits.mjs fire 只转 fire.glb
const only = process.argv[2];

const io = new NodeIO().registerExtensions([KHRMaterialsUnlit, KHRTextureTransform]);

for (const m of only ? MODELS.filter((x) => x.out.startsWith(only)) : MODELS) {
  if (!m) continue;
  const fbxPath = path.join(SRC, m.fbx);
  const tmp = path.join(OUT, '_raw_' + m.out);
  process.stdout.write(m.out + ' 转换中…\n');
  await convert(fbxPath, tmp, ['--binary']);

  const doc = await io.read(tmp);
  await doc.transform(dedup(), weld(), prune());
  await MeshoptSimplifier.ready;
  await doc.transform(simplify({ simplifier: MeshoptSimplifier, error: m.err }));
  // 半身像等特写模型可用 tex: 2048 保住贴图精度
  const tex = m.tex ?? 1024;
  await doc.transform(textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [tex, tex] }));
  await doc.transform(quantize());
  await io.write(path.join(OUT, m.out), doc);
  fs.rmSync(tmp, { force: true });

  let verts = 0;
  for (const mesh of doc.getRoot().listMeshes())
    for (const prim of mesh.listPrimitives())
      verts += prim.getAttribute('POSITION').getCount();
  const sz = (fs.statSync(path.join(OUT, m.out)).size / 1e6).toFixed(2);
  console.log(`OK ${m.out}  ${verts} 顶点  ${sz}MB`);
}
console.log('全部完成');
