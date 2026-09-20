/* 场地 GLB 优化管线(临时工具脚本):
 * Blender 导出的对齐+按材质合并 GLB(scripts/align_export_arena.py 产出)
 * → 去重/剪枝 → 网格简化 → 纹理压缩(WebP,大图 1024/其余 512)
 * → Draco 压缩(不与 quantize 连用:量化过的整型属性会令 Draco 压缩失效)。
 * 用法:node scripts/convert-arena.mjs [输入GLB] [输出GLB] [简化误差] */
import fs from 'fs';
import { NodeIO } from '@gltf-transform/core';
import { KHRMaterialsUnlit, KHRTextureTransform, KHRDracoMeshCompression } from '@gltf-transform/extensions';
import { dedup, prune, simplify, textureCompress, draco } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const SRC = process.argv[2] ?? 'work/arena_aligned.glb';
const OUT = process.argv[3] ?? 'public/arena.glb';
const ERR = Number(process.argv[4] ?? 0.002);

const draco3d = await import('draco3dgltf');
const io = new NodeIO().registerExtensions([KHRMaterialsUnlit, KHRTextureTransform, KHRDracoMeshCompression]);
io.registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
});

process.stdout.write('读取 GLB…\n');
const doc = await io.read(SRC);

let tris = 0;
for (const mesh of doc.getRoot().listMeshes())
  for (const prim of mesh.listPrimitives())
    tris += prim.getIndices() ? prim.getIndices().getCount() / 3 : prim.getAttribute('POSITION').getCount() / 3;
console.log(`网格 ${doc.getRoot().listMeshes().length} 材质 ${doc.getRoot().listMaterials().length} 贴图 ${doc.getRoot().listTextures().length} 三角 ${tris | 0}`);

process.stdout.write('dedup/prune…\n');
await doc.transform(dedup(), prune());

process.stdout.write(`meshopt 简化(误差 ${ERR})…\n`);
await MeshoptSimplifier.ready;
await doc.transform(simplify({ simplifier: MeshoptSimplifier, error: ERR }));

process.stdout.write('WebP 压缩贴图(大面积 1024 / 其余 512)…\n');
{
  const textures = doc.getRoot().listTextures();
  await Promise.all(textures.map(async (tex, idx) => {
    const img = tex.getImage();
    if (!img) return;
    const size = img.byteLength;
    const target = size > 200 * 1024 ? 1024 : 512; // 大贴图(盘面等)保精度,其余减半
    const out = await sharp(img).resize(target, target).webp({ quality: 80 }).toBuffer();
    tex.setImage(out);
    tex.setMimeType('image/webp');
    const name = tex.getURI() ?? `tex${idx}.webp`;
    if (!name.endsWith('.webp')) tex.setURI(name.replace(/\.\w+$/, '.webp'));
  }));
}

process.stdout.write('Draco 压缩…\n');
await doc.transform(draco({ method: 'edgesbreaker', encodeSpeed: 2, decodeSpeed: 4, quantizePosition: 11, quantizeNormal: 8, quantizeTexcoord: 10 }));

let verts2 = 0, tris2 = 0;
for (const mesh of doc.getRoot().listMeshes())
  for (const prim of mesh.listPrimitives()) {
    verts2 += prim.getAttribute('POSITION').getCount();
    tris2 += prim.getIndices().getCount() / 3;
  }
await io.write(OUT, doc);
console.log(`OK ${OUT}  ${verts2 | 0} 顶点  ${tris2 | 0} 三角  ${(fs.statSync(OUT).size / 1e6).toFixed(2)}MB`);
