# 孤独领域 · Solitude Realm

一款运行在浏览器里的竞技场生存小游戏：你是元素使，施放法术改写整个世界，
同时躲避并清除不断袭来的元素之灵。

游戏场景「黑剑 BOSS 战竞技场」由 Blender 建模（`黑剑BOSS战场景.blend`），
导出为 Draco 压缩的 glTF 加载。

![tech](https://img.shields.io/badge/Vite-8-purple) ![tech](https://img.shields.io/badge/Three.js-0.185-blue)

## 玩法

- **WASD** 移动，**Shift** 贴地飞行（消耗体力，拖尾光带）
- **Q / E / R** 选择冰 / 火 / 雷技能，**按住右键瞄准、松开释放**（冷却 5 秒）
- **按住左键** 普通攻击（能量球）
- 元素之灵会永久追击：普通之灵撞击 -25% 生命，特殊之灵 -50%
- 特殊之灵（堕圣遗物）需要**对应元素技能**清除，或在**同色领域**内普攻 3 次
- 技能命中会**改写世界**：全场染色浪潮、地裂、天空/雾/灯光整体过渡到该元素领域；
  6 秒不施法，世界退回元素荒原
- 连续击杀 9 个普通之灵回复 20% 生命；每 100 分提升难度档位（最高 LV.10）

## 运行

```bash
npm install
npm run dev        # http://127.0.0.1:5180
```

或双击 `启动游戏.bat`（Windows）。

## 技术要点

- Vite 8 + Three.js 0.185，无框架、无游戏引擎
- 竞技场场景：Blender → glTF（Draco），加载后按材质合并静态网格
  （draw call ~660 → ~80）
- 程序化着色器：天空穹顶、地面深渊、施法染色浪潮/地裂特效、能量边界环
- 领域天气：GPU 粒子（大雪/雨幕/余烬/电花）+ 烈焰领域地面浓雾板，
  随世界改写平滑进出；雷暴领域带真实雨声环境循环
- 音频：程序化合成引擎（Web Audio API）+ 真实法术音效采样
  （`public/sfx/`，来自 [Mixkit](https://mixkit.co)，Mixkit 免费许可：
  可商用、无需署名；采样加载失败自动回退纯合成）
- 动态分辨率控制器：帧率不足自动下调渲染像素比，稳住高帧率
- 玩家角色：蒙皮 GLB 模型 + Mixamo 动作组（待机/跑动/瞄准步法/放箭），
  武器为程序化长弓（绑定左手骨骼，宝石随元素换色）；
  之灵 / 特效仍由基础几何体 + 着色器程序化生成

## 目录结构

```
public/arena.glb    竞技场场景（Blender 导出，42MB，Draco 压缩）
public/character/   玩家角色模型与动作（FBX 原件不入库，glb/ 为运行时资源）
public/draco/       Draco 解码器
src/arena.js        场景加载与网格合并
src/game.js         游戏主循环 / 输入 / 相机
src/world.js        世界本体与"改写"引擎
src/themes.js       四套领域主题（荒原/冰封/烈焰/雷暴）
src/groundfx.js     施法全场地特效（染色浪潮/地裂）
src/trail.js        飞行拖尾光带
src/player.js       玩家角色（元素使）
src/spirits.js      元素之灵（缚灵 / 堕圣遗物）
src/spells.js       三系法术与粒子系统
src/edge.js         场地边缘能量环与碰撞反馈
src/hud.js          DOM 界面
```
