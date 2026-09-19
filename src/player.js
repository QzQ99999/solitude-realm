import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { AnimationUtils } from 'three';
import { noiseGLSL } from './vfx/NoiseGLSL.js';
import { commonGLSL } from './vfx/CommonGLSL.js';

/** 场地半径：玩家活动范围被限制在这个圆内（edge.js 的边界环与之共用）。 */
export const BOUNDARY_RADIUS = 58;

/* 角色资源路径（public/character，相对 base 路径） */
const MODEL_URL = 'character/glb/character.glb';
const BOW_MODEL_URL = 'character/bow/bow.obj';
const CLIP_URLS = {
  idle: 'character/glb/idle.glb',
  sprint: 'character/glb/sprint-forward.glb',
  aimIdle: 'character/glb/aim-idle.glb',
  aimBack: 'character/glb/aim-walk-back.glb',
  aimLeft: 'character/glb/aim-walk-left.glb',
  aimRight: 'character/glb/aim-walk-right.glb',
  recoil: 'character/glb/aim-recoil.glb'
};

/* 目标身高（米）：角色原始网格高约 2.13 单位，统一缩放到游戏尺度 */
const TARGET_HEIGHT = 1.8;
/* 弓（Meshy OBJ）：目标高度与轴向校正（模型弓面在 X-Y 平面，转 90° 让弓面朝 +Z） */
const BOW_HEIGHT = 1.05;
const BOW_MODEL_ROT_Y = Math.PI / 2;
/* 握弓位置：战斗时弓柄沿面向前推，正好握进虎口/指根的"口袋"里；
 * 携带（非战斗）时略微移出身体左侧并外倾（cant），避免与腿臂相交 */
const BOW_GRIP_FORWARD = 0.09;
const BOW_CARRY_SIDE = 0.11;
const BOW_CARRY_CANT = 0.38;

/**
 * 风系护盾着色器：一层旋绕的气流球壳。
 *
 * 菲涅尔边缘 + 绕球面流动的风纹（脊状噪声沿切向拉伸、随时间旋转），
 * 消散时按噪声阈值溶解成片剥落、边缘发亮，同时球体膨胀变淡。
 */
const SHIELD_VERTEX = /* glsl */ `
  varying vec3 vNormalW;
  varying vec3 vViewDir;
  varying vec3 vLocal;

  void main() {
    vLocal = position;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vViewDir = cameraPosition - world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const SHIELD_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uFade;      // 常规透明度（脉动 + 到期渐隐）
  uniform float uDissolve;  // 0=完好 1=完全消散
  uniform float uSwelling;
  uniform vec3  uColorA;    // 气流基色
  uniform vec3  uColorB;    // 高光色

  varying vec3 vNormalW;
  varying vec3 vViewDir;
  varying vec3 vLocal;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    vec3 N = normalize(vNormalW);
    vec3 V = normalize(vViewDir);
    float ndv = clamp(dot(N, V), 0.0, 1.0);
    float fres = pow(1.0 - ndv, 2.0);

    // 环球面流动的风纹：在切向系里采样脊状噪声，沿纬线方向拉长、随时间旋转
    vec3 sp = vLocal * 2.6 + vec3(0.0, uTime * 0.35, 0.0);
    float swirl = ridged(vec3(sp.x, sp.y * 0.6, sp.z) + vec3(uTime * 0.6, 0.0, 0.0), 4);
    float streak = smoothstep(0.62, 0.96, swirl);

    // 消散：噪声阈值溶解，剥落边缘发亮
    vec2 dis = dissolveMask(fbm3(vLocal * 3.6 + vec3(uTime * 0.4)) * 0.5 + 0.5, uDissolve * 1.35 - 0.12, 0.14);

    float alpha = (0.05 + fres * 0.55 + streak * 0.38) * uFade * dis.x;
    if (alpha < 0.004) discard;

    vec3 color = mix(uColorA, uColorB, clamp(streak + fres * 0.6, 0.0, 1.0));
    color += uColorB * dis.y * 2.2; // 消散边缘的亮边
    gl_FragColor = vec4(color * 1.4, alpha);
  }
`;

function windShieldMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
    uniforms: {
      uTime: { value: 0 },
      uFade: { value: 1 },
      uDissolve: { value: 0 },
      uSwelling: { value: 0 },
      uColorA: { value: new THREE.Color('#9fd8ff') },
      uColorB: { value: new THREE.Color('#ffffff') }
    },
    vertexShader: SHIELD_VERTEX,
    fragmentShader: SHIELD_FRAGMENT
  });
}

/**
 * 去根位移：Mixamo 这套动画是"带位移"导出，Hips 每循环沿行进方向漂移。
 * 把水平净位移按线性坡道扣除（保留竖直起伏与左右摆动），原地循环化。
 */
function stripRootMotion(clip) {
  const track = clip.tracks.find((t) => /Hips.*\.position$/.test(t.name));
  if (!track) return clip;
  const v = track.values;
  const n = v.length / 3;
  const netX = v[(n - 1) * 3] - v[0];
  const netZ = v[(n - 1) * 3 + 2] - v[2];
  if (Math.hypot(netX, netZ) < 0.05) return clip;
  for (let i = 0; i < n; i++) {
    const k = i / (n - 1);
    v[i * 3] -= netX * k;
    v[i * 3 + 2] -= netZ * k;
  }
  return clip;
}

/* —— 角色盔甲材质 —— */
/* 游戏风格化配色（呼应场景的冷蓝 + 藏青）：按绑定的主骨骼给顶点分区，
 * 替换掉写实贴图；金属度走自定义顶点属性，盔甲有金属反射、布袍保持粗糙。 */
const ARMOR_PALETTE = {
  steel: { color: new THREE.Color('#96a2b8'), metal: 1 },   // 肩臂 / 腿甲
  helm: { color: new THREE.Color('#a5b1c6'), metal: 1 },    // 头盔
  cloth: { color: new THREE.Color('#b8b8b8'), metal: 0, cloth: 1 }, // 战袍：中性底色，色调由元素色实时染色
  leather: { color: new THREE.Color('#463827'), metal: 0 }  // 手套 / 靴 / 腰带
};

function armorRegion(boneName) {
  if (/Head|Neck/.test(boneName)) return 'helm';
  if (/ForeArm|Shoulder/.test(boneName)) return 'steel';
  if (/Arm$/.test(boneName)) return 'steel';
  if (/UpLeg|Leg$/.test(boneName)) return 'steel';
  if (/Hand$/.test(boneName)) return 'leather';
  if (/Foot|Toe/.test(boneName)) return 'leather';
  if (/Hips/.test(boneName)) return 'leather';
  if (/Spine/.test(boneName)) return 'cloth';
  return 'cloth';
}

/** 用盔甲配色重绘角色：按每个顶点权重最高的骨骼确定区域并写入顶点色，
 *  外加轻微明度抖动避免纯色塑料感；旧贴图材质释放掉。
 *  战袍区域带 aCloth 遮罩，色调与发光由 uniform 实时控制（跟随当前元素）。
 *  返回 { setCloth(accent, glow) } 更新接口，模型未就绪时返回 null。 */
function stylizeArmor(model, accent) {
  const mesh = model.getObjectByProperty('isSkinnedMesh', true);
  if (!mesh) return null;
  const geometry = mesh.geometry;
  const count = geometry.attributes.position.count;
  const skinIndex = geometry.attributes.skinIndex;
  const skinWeight = geometry.attributes.skinWeight;
  const position = geometry.attributes.position;
  const bones = mesh.skeleton.bones;
  const colors = new Float32Array(count * 3);
  const metals = new Float32Array(count);
  const cloths = new Float32Array(count);
  const c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    let best = 0, bestW = -1;
    for (let k = 0; k < 4; k++) {
      const w = skinWeight.getComponent(i, k);
      if (w > bestW) { bestW = w; best = k; }
    }
    const bone = bones[skinIndex.getComponent(i, best)];
    const entry = ARMOR_PALETTE[armorRegion(bone?.name ?? '')] ?? ARMOR_PALETTE.cloth;
    // 顶点级明度抖动（哈希），让大面纯色有细微层次
    const h = Math.sin(position.getX(i) * 12.9898 + position.getY(i) * 78.233 + position.getZ(i) * 37.719) * 43758.5453;
    const jitter = 1 + ((h - Math.floor(h)) - 0.5) * 0.16;
    colors[i * 3] = Math.min(1, c.copy(entry.color).r * jitter);
    colors[i * 3 + 1] = Math.min(1, c.copy(entry.color).g * jitter);
    colors[i * 3 + 2] = Math.min(1, c.copy(entry.color).b * jitter);
    metals[i] = entry.metal;
    cloths[i] = entry.cloth ?? 0;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('aMetal', new THREE.BufferAttribute(metals, 1));
  geometry.setAttribute('aCloth', new THREE.BufferAttribute(cloths, 1));

  // 布料染色/发光 uniform（共享引用，运行时可实时改值）
  const clothColor = { value: new THREE.Color(accent).multiplyScalar(0.95) };
  const clothGlow = { value: 0.45 };

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.6,
    metalness: 0,
    flatShading: true // 低多边形切面感，贴合整体画风
  });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aMetal;\nattribute float aCloth;\nvarying float vMetal;\nvarying float vCloth;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMetal = aMetal;\nvCloth = aCloth;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vMetal;\nvarying float vCloth;\nuniform vec3 uClothColor;\nuniform float uClothGlow;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * uClothColor, vCloth);')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(0.68, 0.3, vMetal);')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix(0.04, 0.82, vMetal);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += uClothColor * vCloth * uClothGlow;');
    shader.uniforms.uClothColor = clothColor;
    shader.uniforms.uClothGlow = clothGlow;
  };
  const oldMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  mesh.material = material;
  for (const m of oldMaterials) {
    if (!m) continue;
    for (const key of Object.keys(m)) {
      const value = m[key];
      if (value && value.isTexture) value.dispose();
    }
    m.dispose();
  }
  return {
    setCloth(accentColor, glow) {
      clothColor.value.set(accentColor).multiplyScalar(0.95);
      clothGlow.value = glow;
    }
  };
}


/** 装载 Meshy 弓模型并归一化：居中（握把落在原点）、缩放到游戏尺度、
 *  绕 Y 转 90° 使弓面朝 +Z（箭头方向）。整弓材质统一，可随元素染色发光。 */
async function loadBowModel(accent) {
  const obj = await new OBJLoader().loadAsync(BOW_MODEL_URL);
  const material = new THREE.MeshStandardMaterial({
    color: '#9a917f',
    emissive: accent,
    emissiveIntensity: 0.85,
    metalness: 0.55,
    roughness: 0.42,
    toneMapped: false
  });
  obj.traverse((o) => { if (o.isMesh) o.material = material; });

  // 居中 + 高度归一 + 轴向校正
  const inner = new THREE.Group();
  inner.add(obj);
  const box = new THREE.Box3().setFromObject(inner);
  const size = box.getSize(new THREE.Vector3());
  inner.scale.setScalar(BOW_HEIGHT / Math.max(size.y, 0.001));
  const center = box.getCenter(new THREE.Vector3());
  inner.position.set(-center.x, -center.y, -center.z);
  inner.rotation.y = BOW_MODEL_ROT_Y;

  const bow = new THREE.Group();
  bow.add(inner);

  // 箭矢出发点（搭箭点前方）与元素光
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0, 0.16);
  bow.add(muzzle);
  const light = new THREE.PointLight(accent, 2.5, 7, 2);
  bow.add(light);

  bow.userData.material = material;
  bow.userData.light = light;
  bow.userData.muzzle = muzzle;
  return bow;
}

/**
 * player.js — 玩家角色：一名持弓的元素使（GLB 蒙皮模型 + Mixamo 动画组）。
 *
 * 模型与动作来自 public/character/（FBX 转出的 GLB）：待机/跑动/瞄准待机/
 * 瞄准横移与后撤/放箭。移动朝移动方向，瞄准或攻击时面向瞄准点并切换到
 * 瞄准动作组（横移步法）；射击时叠加放箭动作。武器为 Meshy 弓模型，放在
 * 场景根节点，位置跟随左手（携带时略移出体外并外倾），朝向锁定竖直；
 * 整弓颜色与发光跟随"当前选择的元素"，双眼同样发光。
 */
export class Player {
  constructor(scene) {
    this.root = new THREE.Group(); // 位置 + 朝向
    this.body = new THREE.Group(); // 蒙皮模型挂载点
    this.root.add(this.body);
    this.scene = scene;
    scene.add(this.root);

    // 脚下假阴影（留在世界地面高度，角色升空时缩小变淡）
    this.blob = new THREE.Mesh(
      new THREE.CircleGeometry(0.62, 24),
      new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.34, depthWrite: false })
    );
    this.blob.rotation.x = -Math.PI / 2;
    this.blob.position.y = 0.02;
    scene.add(this.blob);

    // 受击无敌帧的风系护盾：规则球形气流护罩，到期时溶解消散
    this.shield = new THREE.Mesh(new THREE.SphereGeometry(1.35, 40, 26), windShieldMaterial());
    this.shield.visible = false;
    this.shield.renderOrder = 20; // 地面贴花之上
    scene.add(this.shield);
    this._shieldShown = false;   // 上一帧护盾是否可见
    this._dissolveT = 1;         // 消散动画进度（1 = 结束）
    this._dissolveFrom = new THREE.Vector3();

    /** 运行状态 */
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.respawn(); // 站到出生点
    this.obstacles = [];   // 柱基碰撞体 [{x,z,r}]（game 侧注入圣杯等）
    this._moveAmount = 0;
    this._bobT = 0;
    this._hover = 0; // 平滑归零的旧悬浮高度（保留供缓动）
    this._tilt = 0; // 平滑归零的旧前倾角（保留供缓动）

    // 场地边缘状态（供 edge.js / game.js 读取的碰撞提示输入）
    this.edgePush = 0; // 正在顶边界的强度 0~1（平滑），>0.3 视为碰撞中
    this.edgeProximity = 0; // 距边缘的接近程度 0~1（9 米内渐亮）
    this.edgeAngle = 0; // 接触方位角
    this.edgePoint = new THREE.Vector3(); // 边界环上的接触点（粒子发射用）

    /** 模型 / 动画（异步装载完成前保持空） */
    this.model = null;
    this.mixer = null;
    this._actions = {};      // 名字 → AnimationAction
    this._loco = null;       // 当前移动态动作
    this._locoName = '';
    this._recoilA = null;    // 放箭动作 ×2（乒乓交替，快速连射不跳变）
    this._recoilB = null;
    this._recoilFlip = false;
    this._recoilActive = false; // 是否有放箭叠加动画正在生效
    this._accent = '#9fd8ff';
    this._handBone = null;   // 弓跟随的左手骨骼
    this._armor = null;      // 盔甲材质接口（布料染色/发光）   // 弓跟随的左手骨骼
    this._bowFlash = 0;      // 切换元素时弓的发光脉冲（1 → 0 衰减）
    this._combatBlend = 0;   // 0 = 携带姿态 ←→ 1 = 战斗姿态

    this._scratch = new THREE.Vector3();
    this._e1 = new THREE.Euler(); // 弓朝向锁定用
    this._loadAssets();
  }

  /* —— 资源装载 —— */

  async _loadAssets() {
    const loader = new GLTFLoader();
    try {
      const [modelGltf, ...animGltfs] = await Promise.all([
        loader.loadAsync(MODEL_URL),
        ...Object.values(CLIP_URLS).map((url) => loader.loadAsync(url))
      ]);

      const model = modelGltf.scene;
      // 归一化到游戏尺度：脚底对齐 y=0
      model.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(model);
      const height = Math.max(box.max.y - box.min.y, 0.001);
      const scale = TARGET_HEIGHT / height;
      model.scale.setScalar(scale);
      model.position.y = -box.min.y * scale;

      // 换上游戏风格的盔甲材质（同时释放写实贴图）
      this._armor = stylizeArmor(model, this._accent);

      const names = Object.keys(CLIP_URLS);
      const clips = {};
      names.forEach((name, i) => { clips[name] = animGltfs[i].animations[0]; });

      this.mixer = new THREE.AnimationMixer(model);

      // 待机 / 瞄准待机：循环
      this._actions.idle = this.mixer.clipAction(stripRootMotion(clips.idle));
      this._actions.aimIdle = this.mixer.clipAction(stripRootMotion(clips.aimIdle));
      // 跑动（普攻/疾跑共用，速率在 update 里按状态调）
      this._actions.sprint = this.mixer.clipAction(stripRootMotion(clips.sprint));
      // 瞄准步法：后撤 / 左移 / 右移；前移复用后撤片段倒放
      this._actions.aimBack = this.mixer.clipAction(stripRootMotion(clips.aimBack));
      this._actions.aimLeft = this.mixer.clipAction(stripRootMotion(clips.aimLeft));
      this._actions.aimRight = this.mixer.clipAction(stripRootMotion(clips.aimRight));
      this._actions.aimFwd = this.mixer.clipAction(stripRootMotion(clips.aimBack));
      this._actions.aimFwd.setEffectiveTimeScale(-1);

      for (const action of Object.values(this._actions)) action.play();
      // 先停在待机态；其余动作压到 0 权重（fadeOut(0) 不动权重乘数，
      // 之后 fadeIn 才能正常生效——setEffectiveWeight(0) 会把乘数永久清零）
      this._loco = this._actions.idle;
      this._locoName = 'idle';
      for (const [name, action] of Object.entries(this._actions)) {
        if (name !== 'idle') action.fadeOut(0);
      }

      // 放箭：一次性叠加动作（相对自身第 0 帧的增量，骑在瞄准待机上播放）
      const recoilClip = AnimationUtils.makeClipAdditive(clips.recoil.clone(), 0);
      this._recoilA = this.mixer.clipAction(recoilClip);
      this._recoilB = this.mixer.clipAction(recoilClip);
      for (const action of [this._recoilA, this._recoilB]) {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = false;
        action.blendMode = THREE.AdditiveAnimationBlendMode;
        action.fadeOut(0);
        action.play();
      }

      // 发光双眼：绑定眼骨，颜色跟随当前元素（沿眼骨 +Z 前推，从面甲缝里露出）
      const eyeMaterial = new THREE.MeshBasicMaterial({ color: this._accent, toneMapped: false });
      eyeMaterial.color.multiplyScalar(2.2); // HDR 提亮
      const eyeGeometry = new THREE.SphereGeometry(0.05, 10, 8);
      for (const eyeBoneName of ['mixamorigReye', 'mixamorigLeye']) {
        const eyeBone = model.getObjectByName(eyeBoneName);
        if (!eyeBone) continue;
        const eye = new THREE.Mesh(eyeGeometry, eyeMaterial);
        eye.position.set(0, 0, 0.045);
        eye.renderOrder = 20;
        eyeBone.add(eye);
      }
      this._eyeMaterial = eyeMaterial;

      // 长弓（Meshy 模型）：不作为手骨子节点（部分骨骼世界矩阵带镜像/负缩放），
      // 放在场景根节点，每帧由 _updateBowOrientation 锁定位置与朝向。
      const hand = model.getObjectByName('mixamorigLeftHand');
      if (hand) {
        this.bow = await loadBowModel(this._accent);
        this.scene.add(this.bow);
        this._handBone = hand;
      }

      this.model = model;
      this.body.add(model);
    } catch (error) {
      console.error('[player] 角色模型装载失败', error);
    }
  }

  /** 回到出生点（开局 / 重新开始时调用）：南侧空地，面向场地中央。 */
  respawn() {
    this.position.set(0, 0, 12);
    this.facing = Math.PI;
  }

  /* —— 公共接口 —— */

  /**
   * 无敌帧风系护盾：invulnT > 0 时罩住玩家的旋绕气流球。
   *
   * 罩上瞬间从 0.6 倍弹开，生效期间风纹旋转 + 轻微脉动；
   * 到期（invulnT 归零）后不再直接隐藏，而是播放 0.45 秒消散：
   * 球体膨胀、按噪声阈值溶解成片剥落、剥落边缘发亮，最后散尽。
   *
   * @param {number} elapsed 全局时间
   * @param {number} invulnT 剩余无敌帧
   * @param {number} [dt] 帧间隔（消散动画需要）
   */
  updateShield(elapsed, invulnT, dt = 1 / 60) {
    const u = this.shield.material.uniforms;
    u.uTime.value = elapsed;

    /* —— 到期检测：上一帧还可见、这一帧无敌帧结束 → 开始消散 —— */
    if (this._shieldShown && invulnT <= 0) {
      this._shieldShown = false;
      this._dissolveT = 0;
      this._dissolveFrom.copy(this.shield.position);
    }

    /* —— 消散动画 —— */
    if (this._dissolveT < 1) {
      this._dissolveT = Math.min(1, this._dissolveT + dt / 0.45);
      const k = this._dissolveT;
      this.shield.visible = true;
      this.shield.position.copy(this._dissolveFrom);
      this.shield.scale.setScalar(1 + k * 0.65);
      u.uDissolve.value = k;
      u.uFade.value = (1 - k) * 0.9;
      u.uSwelling.value = k;
      if (k >= 1) this.shield.visible = false;
      return;
    }

    if (invulnT <= 0) {
      this.shield.visible = false;
      this._shieldShown = false;
      return;
    }

    /* —— 生效中：罩上弹开 + 风纹旋转 + 临到期渐隐 —— */
    if (!this._shieldShown) {
      this._shieldShown = true;
      this.shield.scale.setScalar(0.6); // 罩上瞬间从 0.6 弹开
    }
    const scale = this.shield.scale.x + (1 - this.shield.scale.x) * Math.min(1, dt * 10);
    this.shield.visible = true;
    this.shield.position.set(this.position.x, 1.05, this.position.z);
    const fadeOut = Math.min(1, invulnT / 0.35); // 临到期渐隐
    const flicker = 0.78 + 0.22 * Math.sin(elapsed * 16);
    u.uFade.value = 0.9 * fadeOut * flicker;
    u.uDissolve.value = 0;
    u.uSwelling.value = 0;
    this.shield.scale.setScalar(scale * (1 + 0.03 * Math.sin(elapsed * 11)));
  }

  /** 箭矢出发点（弓上的世界坐标；模型未就绪时退回角色胸口位置）。 */
  getOrbWorldPosition(out) {
    if (this.bow) return this.bow.userData.muzzle.getWorldPosition(out);
    return out.set(this.position.x, 1.2, this.position.z);
  }

  /** 当前元素变了：整弓染色发光（带一次闪光脉冲）、双眼、元素光、疾跑光晕换色。 */
  setElement(accent) {
    this._accent = accent;
    this._bowFlash = 1;
    this._eyeMaterial?.color.set(accent).multiplyScalar(2.2); // HDR 提亮
    this._armor?.setCloth(accent, 0.45 + this._bowFlash * 0.9); // 战袍随元素变色发光
    const su = this.shield.material.uniforms;
    su.uColorA.value.set(accent);            // 护罩基色随元素
    su.uColorB.value.set(accent).lerp(new THREE.Color('#ffffff'), 0.55);
    if (this.bow) {
      this.bow.userData.material.color.set(accent).lerp(new THREE.Color('#ffffff'), 0.3);
      this.bow.userData.material.emissive.set(accent);
      this.bow.userData.light.color.set(accent);
    }
  }

  /** 放箭：叠加播放一次放箭动作（乒乓交替两个动作实例，连射不跳变）。 */
  playCast() {
    if (!this._recoilA) return;
    const outgoing = this._recoilFlip ? this._recoilA : this._recoilB;
    const incoming = this._recoilFlip ? this._recoilB : this._recoilA;
    this._recoilFlip = !this._recoilFlip;
    outgoing.fadeOut(0.06);
    incoming.reset().fadeIn(0.06).play();
    this._recoilActive = true;
  }

  /** 切换移动态：淡入目标动作、淡出当前动作。 */
  _setLoco(name, fade = 0.18) {
    if (name === this._locoName) return;
    const next = this._actions[name];
    if (!next) return;
    this._loco?.fadeOut(fade);
    next.reset().fadeIn(fade).play();
    this._loco = next;
    this._locoName = name;
  }

  /**
   * @param {number} dt
   * @param {THREE.Vector3|null} moveDir 单位移动方向（世界系），null = 静止
   * @param {THREE.Vector3|null} aimPoint 瞄准点（静止时缓慢转向它）
   * @param {number} elapsed
   * @param {boolean} flying 按住 Shift：地面疾跑（高速移动）
   * @param {boolean} combat 按住右键瞄准或按住左键攻击：面向瞄准点的瞄准姿态
   */
  update(dt, moveDir, aimPoint, elapsed, flying = false, combat = false) {
    const speed = flying ? 17 : 6.2;
    if (moveDir) {
      this.position.addScaledVector(moveDir, speed * dt);
      const r = Math.hypot(this.position.x, this.position.z);
      let clamped = false;
      if (r > BOUNDARY_RADIUS) {
        this.position.x *= BOUNDARY_RADIUS / r;
        this.position.z *= BOUNDARY_RADIUS / r;
        clamped = true;
      }
      // 边缘碰撞检测：被拦在边界上且仍在朝外推时，记为"顶边"状态
      const invR = r > 0.0001 ? 1 / r : 0;
      const outward = (moveDir.x * this.position.x + moveDir.z * this.position.z) * invR;
      const pushing = clamped && outward > 0.12;
      const pushTarget = pushing ? Math.min(1, 0.5 + outward * 0.6) : 0;
      this.edgePush += (pushTarget - this.edgePush) * Math.min(1, dt * (pushing ? 14 : 6));
      // 战斗姿态（瞄准/攻击）面向瞄准点，其余面向移动方向
      if (combat && aimPoint) {
        const dx = aimPoint.x - this.position.x;
        const dz = aimPoint.z - this.position.z;
        if (dx * dx + dz * dz > 0.5) this._faceToward(Math.atan2(dx, dz), dt, 14);
      } else {
        this._faceToward(Math.atan2(moveDir.x, moveDir.z), dt, flying ? 9 : 14);
      }
      this._moveAmount = Math.min(1, this._moveAmount + dt * 6);
    } else {
      this._moveAmount = Math.max(0, this._moveAmount - dt * 6);
      this.edgePush += (0 - this.edgePush) * Math.min(1, dt * 6);
      if (aimPoint) {
        const dx = aimPoint.x - this.position.x;
        const dz = aimPoint.z - this.position.z;
        if (dx * dx + dz * dz > 1) this._faceToward(Math.atan2(dx, dz), dt, combat ? 14 : 4);
      }
    }

    // 柱基碰撞：陷入圣杯等障碍物时沿径向推出
    for (const ob of this.obstacles) {
      const dx = this.position.x - ob.x;
      const dz = this.position.z - ob.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < ob.r * ob.r && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        this.position.x = ob.x + (dx / d) * ob.r;
        this.position.z = ob.z + (dz / d) * ob.r;
      }
    }

    // 边缘接近度：9 米内线性渐亮；接触方位与接触点同步更新
    const distToEdge = BOUNDARY_RADIUS - Math.hypot(this.position.x, this.position.z);
    this.edgeProximity = Math.max(0, Math.min(1, 1 - distToEdge / 9));
    this.edgeAngle = Math.atan2(this.position.x, this.position.z);
    this.edgePoint.set(
      Math.sin(this.edgeAngle) * BOUNDARY_RADIUS,
      0.08,
      Math.cos(this.edgeAngle) * BOUNDARY_RADIUS
    );

    // 贴地疾跑（原"贴地飞行"的悬浮/俯身已按需求移除，跑在地上）
    const hoverTarget = 0;
    this._hover += (hoverTarget - this._hover) * Math.min(1, dt * 4.5);
    const tiltTarget = 0;
    this._tilt += (tiltTarget - this._tilt) * Math.min(1, dt * 6);
    this.body.rotation.x = this._tilt;

    // 移动起伏（角色动画自带步伐起伏，这里只保留轻微整体律动）
    this._bobT += dt * (5 + this._moveAmount * 6);
    const bob = Math.abs(Math.sin(this._bobT)) * 0.045 * this._moveAmount;

    this.root.position.set(this.position.x, this._hover + bob, this.position.z);
    this.root.rotation.y = this.facing;

    this._updateAnimation(dt, moveDir, flying, combat);

    // 假阴影留在地面：升空越高越小越淡
    this.blob.position.set(this.position.x, 0.02, this.position.z);
    const air = Math.min(1, this._hover / 1.25);
    this.blob.material.opacity = 0.34 * (1 - air * 0.7);
    this.blob.scale.setScalar(1 - air * 0.35);

    if (this.mixer) this.mixer.update(dt);

    // 弓的元素发光脉冲衰减
    if (this._bowFlash > 0) {
      this._bowFlash = Math.max(0, this._bowFlash - dt * 1.6);
      if (this.bow) {
        this.bow.userData.material.emissiveIntensity = 0.85 + this._bowFlash * 1.4;
        this.bow.userData.light.intensity = 3.2 + this._bowFlash * 5;
      }
      this._armor?.setCloth(this._accent, 0.45 + this._bowFlash * 0.9);
    }

    this._updateBowOrientation(dt, combat);
  }


  _updateBowOrientation(dt, combat) {
    if (!this.bow || !this._handBone || !this.model) return;
    this.model.updateMatrixWorld(true);

    this._combatBlend += ((combat ? 1 : 0) - this._combatBlend) * Math.min(1, dt * 8);
    const w = this._combatBlend;
    const f = this.facing;
    const fx = Math.sin(f), fz = Math.cos(f);   // 面向
    const lx = Math.cos(f), lz = -Math.sin(f);  // 角色左侧

    // 战斗：弓柄沿面向前推，正好握进虎口/指根的"口袋"（不压腕关节）；
    // 携带：弓留在手上但略微移出身体左侧、上弓梢向外倾（cant），不扫腿不穿臂
    this._handBone.getWorldPosition(this._scratch);
    const gripF = BOW_GRIP_FORWARD * w + 0.04 * (1 - w);
    const sideL = BOW_CARRY_SIDE * (1 - w);
    this.bow.position.set(
      this._scratch.x + fx * gripF + lx * sideL,
      this._scratch.y + 0.03 * (1 - w),
      this._scratch.z + fz * gripF + lz * sideL
    );

    // 朝向锁定：弓身竖直（+Y 朝上）、弓面正对面朝方向（+Z）；携带时外倾
    this._e1.set(0, f, BOW_CARRY_CANT * (1 - w), 'YZX');
    this.bow.quaternion.setFromEuler(this._e1);
  }

  /** 动画状态机：按"飞行/战斗姿态/移动方向"挑选动作并交叉淡入。 */
  _updateAnimation(dt, moveDir, flying, combat) {
    if (!this.mixer) return;

    // 战斗姿态结束（含切跑步/走路）时，立刻淡出残留的放箭叠加：
    // 它是相对瞄准姿势设计的增量，叠在跑步摆臂上会让手臂动作失真
    if (!combat && this._recoilActive) {
      this._recoilA.fadeOut(0.12);
      this._recoilB.fadeOut(0.12);
      this._recoilActive = false;
    }

    // 移动态选择
    let target;
    if (flying) {
      target = 'sprint';
      this._actions.sprint.setEffectiveTimeScale(2.3);
    } else if (moveDir) {
      if (combat) {
        // 朝向已锁定瞄准点，把移动方向换算到角色本地前后左右
        const sin = Math.sin(this.facing);
        const cos = Math.cos(this.facing);
        const localZ = moveDir.x * sin + moveDir.z * cos;              // 前为 +
        const localX = moveDir.x * cos - moveDir.z * sin;              // 右为 +
        if (Math.abs(localZ) >= Math.abs(localX)) {
          target = localZ >= 0 ? 'aimFwd' : 'aimBack';
        } else {
          target = localX >= 0 ? 'aimRight' : 'aimLeft';
        }
      } else {
        target = 'sprint';
        this._actions.sprint.setEffectiveTimeScale(1.55);
      }
    } else {
      target = combat ? 'aimIdle' : 'idle';
    }
    this._setLoco(target);

    // 横移步法贴上速度感：步频 ×2 左右，贴近 6.2m/s 的实际移速
    for (const name of ['aimFwd', 'aimBack', 'aimLeft', 'aimRight']) {
      const action = this._actions[name];
      const sign = name === 'aimFwd' ? -1 : 1;
      action.setEffectiveTimeScale(sign * 1.9);
    }
  }

  _faceToward(targetYaw, dt, rate) {
    let delta = targetYaw - this.facing;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    this.facing += delta * Math.min(1, dt * rate);
  }

  dispose() {
    this.scene.remove(this.root, this.blob, this.shield);
    this.root.traverse((object) => {
      if (object.geometry) object.geometry.dispose();
      if (object.material) {
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
          for (const key of Object.keys(material)) {
            const value = material[key];
            if (value && value.isTexture) value.dispose();
          }
          material.dispose();
        }
      }
    });
    // 弓挂在场景根节点（不在 root 子树里），单独移除并释放
    if (this.bow) {
      this.scene.remove(this.bow);
      this.bow.traverse((object) => {
        if (object.geometry) object.geometry.dispose();
        if (object.material) object.material.dispose();
      });
    }
    this.blob.geometry.dispose();
    this.blob.material.dispose();
    this.shield.geometry.dispose();
    this.shield.material.dispose();
  }
}
