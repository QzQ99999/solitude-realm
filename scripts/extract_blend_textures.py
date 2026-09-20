# 从自动保存 blend 提取全部打包贴图 → 工作目录(以图片数据块名命名)
# FBX 里的贴图引用就是这些十六进制名,提取后 fbx2gltf 即可解析。
import bpy, os, sys

argv = sys.argv[sys.argv.index("--") + 1:]
blend_path, out_dir = argv[0], argv[1]

bpy.ops.wm.open_mainfile(filepath=blend_path)
os.makedirs(out_dir, exist_ok=True)

ok = fail = 0
for img in bpy.data.images:
    if not img.packed_file:
        continue
    data = img.packed_file.data
    out = os.path.join(out_dir, img.name)
    try:
        with open(out, "wb") as f:
            f.write(data)
        ok += 1
    except Exception as e:
        fail += 1
        print(f"FAIL|{img.name}|{e}")
print(f"提取完成: {ok} 成功, {fail} 失败 → {out_dir}")
