# 最终对齐导出:圆心/地面归零 + 缩放(盘缘最小 47 → 58),导出 Draco GLB
import bpy, sys, mathutils
from mathutils import Vector, Matrix

argv = sys.argv[sys.argv.index("--") + 1:]
fbx_path, glb_path = argv[0], argv[1]

CX, CY, FZ = -5.0, 48.0, -28.18  # 盘心/盘面(实测)
SCALE = 58.0 / 47.0              # 盘缘最小半径对齐 BOUNDARY_RADIUS

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=fbx_path)
bpy.context.view_layer.update()

T = Matrix.Translation(Vector((-CX, -CY, -FZ)))
S = Matrix.Scale(SCALE, 4)
M = S @ T

roots = [o for o in bpy.data.objects if o.parent is None]
for o in roots:
    o.matrix_world = M @ o.matrix_world
bpy.context.view_layer.update()

# 应用变换,清理节点
bpy.ops.object.select_all(action="DESELECT")
for o in roots:
    o.select_set(True)
bpy.context.view_layer.objects.active = roots[0]
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

# 校验包围盒
mn = Vector((1e9,) * 3)
mx = Vector((-1e9,) * 3)
for o in bpy.data.objects:
    if o.type != "MESH":
        continue
    for c in o.bound_box:
        w = o.matrix_world @ Vector(c)
        mn = Vector(map(min, mn, w))
        mx = Vector(map(max, mx, w))
print(f"对齐后包围盒 min=({mn.x:.1f},{mn.y:.1f},{mn.z:.2f}) max=({mx.x:.1f},{mx.y:.1f},{mx.z:.2f})")

# 按材质槽签名合并网格:消除 Draco 前网格间的接缝顶点重复与逐网格流开销
# (运行时 arena.js 的 mergeArena 本就按材质合并,此合并无任何视觉差异)
meshes = [o for o in bpy.data.objects if o.type == "MESH"]
groups = {}
for o in meshes:
    sig = tuple(m.name if m else "" for m in o.data.materials)
    groups.setdefault(sig, []).append(o)
print(f"材质槽签名组: {len(groups)}")
bpy.ops.object.select_all(action="DESELECT")
for sig, objs in groups.items():
    if len(objs) == 1:
        continue
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    for o in bpy.context.selected_objects:
        o.select_set(False)
joined = [o for o in bpy.data.objects if o.type == "MESH"]
print(f"合并后网格数: {len(joined)}")

# 材质混合方式统计(透明材质会影响渲染排序)
from collections import Counter
blends = Counter(m.blend_method for m in bpy.data.materials if m.use_nodes)
print(f"材质混合方式: {dict(blends)}")

bpy.ops.export_scene.gltf(
    filepath=glb_path,
    export_format="GLB",
    export_draco_mesh_compression_enable=True,
    export_draco_mesh_compression_level=6,
    export_image_format="AUTO",
    export_yup=True,
)
import os
print(f"GLB 导出完成: {os.path.getsize(glb_path)/1e6:.1f}MB  scale={SCALE:.4f}")
