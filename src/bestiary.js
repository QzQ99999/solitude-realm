import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ELEMENT_INFO } from './themes.js';
import { SPECIAL_ACCENTS } from './spirits.js';
import { FlamePool, makeGlowTexture, spawnFlameParticle } from './flame.js';

/* 图鉴单元：缚灵为程序化建模（与局内同款魂火 + 双道铁枷锁），
 * 三尊堕圣遗物直接复用局内的 Meshy 模型与配色。 */
const CELLS = [
  { id: 'wraith', kind: 'wraith', accent: '#9cc3e8', height: 1.2 },
  { id: 'ice', kind: 'glb', url: 'spirits/lich.glb', accent: SPECIAL_ACCENTS.ice, height: 1.75, flame: 'ice' },
  { id: 'fire', kind: 'glb', url: 'spirits/fire.glb', accent: ELEMENT_INFO.fire.accent, height: 1.55, flame: 'fire' },
  { id: 'storm', kind: 'glb', url: 'spirits/ipos.glb', accent: ELEMENT_INFO.storm.accent, height: 1.7, flame: 'storm' }
];

const CELL_SPACING = 10; // 同一场景内各单元的水平间距
const FOV = 32;          // 图鉴镜头视场角
const RING_BASE_RADIUS = 0.82; // 符文环几何原始半径
const RING_TILT = 1.35;        // 符文环倾角（近水平）

/* 特殊之灵的元素火焰参数（与 spirits.js 局内同款节奏） */
const FLAME_PARAMS = {
  ice: { vy: [1.3, 0.7], life: [0.6, 0.4], maxLife: 1.0, size0: [0.75, 0.35], size1: 0.18, alpha: 0.85, rate: 44 },
  fire: { vy: [1.6, 0.9], life: [0.55, 0.4], maxLife: 0.95, size0: [0.9, 0.4], size1: 0.22, alpha: 1.0, rate: 44 },
  storm: { vy: [1.5, 0.8], life: [0.4, 0.3], maxLife: 0.7, size0: [0.75, 0.35], size1: 0.15, alpha: 1.0, rate: 44 }
};

/**
 * bestiary.js — 暂停界面「敌方图鉴」3D 展示台。
 *
 * 一块透明画布叠在图鉴面板上，一屏同展四位敌人：缚灵 + 三尊堕圣遗物
 * （冰魔/南瓜灯/圣物匣），各带元素符文环、倒悬尖刺、光晕与周身元素火焰。
 * 每格可用鼠标拖动旋转（横向转体、纵向俯仰），闲置 2.2 秒后缓慢自转。
 * 渲染按 DOM 格子的实际矩形做 scissor 分块，面板布局怎么排都能对齐；
 * 所有透明件用 Normal 混合——叠加混合在透明画布上不会写入 alpha，会被合成掉。
 */
export class SpiritShowcase {
  /** @param {HTMLCanvasElement} canvas #bestiaryCanvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.visible = false;
    this._raf = 0;
    this._lastT = 0;
    this._elapsed = 0;
    this._loaded = false;
    this._loading = false;
    this._drag = null;

    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.3;
    this.renderer.setClearColor(0x000000, 0);

    this.scene = new THREE.Scene();
    // 灯光与开始界面半身像同一套：左上暖主光 + 右后冷轮辋光 + 低强度环境
    const key = new THREE.DirectionalLight('#ffe9c4', 2.3);
    key.position.set(-2.4, 3.6, 2.8);
    const rim = new THREE.DirectionalLight('#7fa8d8', 1.8);
    rim.position.set(2.8, 2.6, -2.4);
    const hemi = new THREE.HemisphereLight('#33415e', '#0b0d13', 1.0);
    this.scene.add(key, rim, hemi);

    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 60);
    this._glow = makeGlowTexture();
    this._bandMaterial = new THREE.MeshStandardMaterial({
      color: '#232833',
      roughness: 0.55,
      metalness: 0.75
    });

    this.cells = CELLS.map((def, i) => this._buildCell(def, i));
    // 图鉴格子视口与单元一一对应（DOM 顺序即 CELLS 顺序）
    const viewports = document.querySelectorAll('.bestiary-cell__viewport');
    this.cells.forEach((cell, i) => { cell.vpEl = viewports[i] ?? null; });

    for (const cell of this.cells) {
      if (cell.def.kind === 'wraith') this._attachWraith(cell);
    }
    this._bindPointer();
  }

  /* —— 场景搭建 —— */

  _buildCell(def, index) {
    const group = new THREE.Group();
    group.position.x = index * CELL_SPACING;
    this.scene.add(group);
    // holder 只装模型本体：拖动的转体/俯仰作用在它上面，基座与火焰不跟着歪
    const holder = new THREE.Group();
    holder.rotation.order = 'YXZ';
    group.add(holder);

    const accent = new THREE.Color(def.accent);

    // 基座：暗色圆盘 + 元素色描边环
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(1.05, 40),
      new THREE.MeshBasicMaterial({ color: '#05070c', transparent: true, opacity: 0.62, depthWrite: false })
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.006;
    disc.renderOrder = 1;
    const rimRing = new THREE.Mesh(
      new THREE.RingGeometry(1.05, 1.16, 48),
      new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.42, depthWrite: false })
    );
    rimRing.rotation.x = -Math.PI / 2;
    rimRing.position.y = 0.008;
    rimRing.renderOrder = 1;
    group.add(disc, rimRing);

    // 光晕（Normal 混合，透明画布上叠加混合会被合成掉）
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this._glow,
      color: accent,
      transparent: true,
      opacity: 0.62,
      depthWrite: false
    }));
    holder.add(halo);

    // 元素补光：给模型本体染上一层领域色
    const lamp = new THREE.PointLight(accent, 9, 6, 2);
    lamp.position.set(group.position.x, def.height * 0.75, 1.8);
    this.scene.add(lamp);

    return {
      def, index, group, holder, halo, accent,
      vpEl: null, rect: null, rectGL: null, dist: 4,
      yaw: index * 0.9, pitch: 0, lastTouch: 0,
      height: def.height, midY: def.height / 2, radius: 0.55, ringRadius: 1.05,
      model: null, ring: null, wraith: null,
      flame: null, flameAcc: 0,
      phase: Math.random() * Math.PI * 2
    };
  }

  /** 缚灵：发光八面体魂火 + X 型交叉的双道锈蚀铁枷锁（与局内同款，
   *  图鉴里额外加白热内核与内嵌点光，让"魂火"在小视口里也读得出光感）。 */
  _attachWraith(cell) {
    const core = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.3, 0),
      new THREE.MeshStandardMaterial({
        color: '#dceaff',
        emissive: '#8fc6ef',
        emissiveIntensity: 3.4,
        roughness: 0.35,
        flatShading: true,
        transparent: true,
        opacity: 0.88,
        depthWrite: false
      })
    );
    core.scale.set(0.82, 1.7, 0.82);
    // 棱线描边：八面体自转到任何角度都能读出立体轮廓，不会糊成一张平面
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(core.geometry),
      new THREE.LineBasicMaterial({ color: '#eaf6ff', transparent: true, opacity: 0.85 })
    );
    core.add(edges);
    // 白热内核：比外壳更小更亮，转体时透出层叠的火苗感
    const inner = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.19, 0),
      new THREE.MeshBasicMaterial({ color: '#f2fbff' })
    );
    inner.scale.set(0.82, 1.7, 0.82);
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.46, 0.045, 6, 24), this._bandMaterial);
    band.rotation.set(0.9, 0, 0.4);
    const band2 = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.04, 6, 20), this._bandMaterial);
    band2.rotation.set(-0.9, 0.5, 1.2);
    // 魂火更小、悬浮得更高；相机与三尊堕圣遗物拉到等距（height 2.2 →
    // dist≈5.45），四格的基座圆环视感一致，模型本身明显小一圈
    const scaler = new THREE.Group();
    scaler.add(core, inner, band, band2);
    scaler.position.y = 0.55;
    cell.holder.add(scaler);
    cell.wraith = { core, inner, band, band2 };
    cell.height = 2.2;
    cell.midY = 0.8;
    cell.radius = 0.48;
    cell.ringRadius = 0.52;
    cell.halo.position.y = 1.0;
    cell.halo.material.opacity = 0.75;
    cell.halo.scale.setScalar(2.1);
    // 魂火内嵌点光：把附近的双道铁枷锁染上幽蓝
    const glow = new THREE.PointLight('#8fc6ef', 7, 3.5, 2);
    glow.position.set(0, 1.0, 0);
    cell.group.add(glow);
  }

  /* —— 堕圣遗物模型装载 —— */

  /** 居中到轴心、脚底落 y=0、缩放到目标高度（与 spirits.js 同款处理）。 */
  _prepModel(scene, height) {
    scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(scene);
    const size = box.getSize(new THREE.Vector3());
    const scale = height / Math.max(size.y, 0.001);
    scene.scale.setScalar(scale);
    const g = new THREE.Group();
    g.add(scene);
    scene.position.x = -(box.min.x + size.x / 2) * scale;
    scene.position.z = -(box.min.z + size.z / 2) * scale;
    scene.position.y = -box.min.y * scale;
    return g;
  }

  _ensureLoaded() {
    if (this._loaded || this._loading) return;
    this._loading = true;
    const loader = new GLTFLoader();
    const glbCells = this.cells.filter((c) => c.def.kind === 'glb');
    Promise.all(glbCells.map((cell) =>
      loader.loadAsync(cell.def.url).then((gltf) => ({ cell, gltf }))
    ))
      .then((results) => {
        for (const { cell, gltf } of results) this._attachModel(cell, gltf.scene);
        this._loaded = true;
      })
      .catch((error) => console.error('[bestiary] 敌人模型装载失败', error));
  }

  _attachModel(cell, scene) {
    const model = this._prepModel(scene, cell.def.height);
    cell.model = model;
    cell.holder.add(model);

    // 包围盒 → 符文环/光晕/火焰的适配尺寸
    model.updateMatrixWorld(true);
    const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
    cell.midY = size.y / 2;
    cell.radius = Math.max(size.x, size.z) / 2;
    cell.ringRadius = Math.min(Math.max(cell.radius * 1.5, 1.05), 1.8);
    cell.halo.position.y = cell.midY;

    // 符文铁环 + 三根倒悬尖刺（与局内特殊之灵同款）
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(RING_BASE_RADIUS, 0.05, 8, 42),
      new THREE.MeshBasicMaterial({ color: cell.accent, transparent: true, opacity: 0.85 })
    );
    ring.rotation.x = RING_TILT;
    const spikeGeometry = new THREE.ConeGeometry(0.1, 0.34, 5);
    for (let s = 0; s < 3; s++) {
      const spike = new THREE.Mesh(spikeGeometry, this._bandMaterial);
      const angle = (s / 3) * Math.PI * 2;
      spike.position.set(Math.cos(angle) * RING_BASE_RADIUS, 0, Math.sin(angle) * RING_BASE_RADIUS);
      spike.rotation.z = Math.PI; // 尖朝下，倒悬
      spike.rotation.y = -angle;
      ring.add(spike);
    }
    ring.scale.setScalar(cell.ringRadius / RING_BASE_RADIUS);
    ring.position.y = cell.midY;
    cell.holder.add(ring);
    cell.ring = ring;

    // 周身元素火焰（局内同款粒子池，Normal 混合适配透明画布）
    if (cell.def.flame) {
      cell.flame = new FlamePool(cell.group, 90, this._glow, false);
    }

    // 贴图各向异性：小视口下更清晰
    const maxAniso = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    model.traverse((o) => {
      if (o.isMesh && o.material) {
        for (const tkey of ['map', 'normalMap', 'roughnessMap', 'metallicMap']) {
          const t = o.material[tkey];
          if (t) t.anisotropy = maxAniso;
        }
      }
    });
  }

  /* —— 布局与渲染 —— */

  /** 按 DOM 格子矩形计算各单元的 scissor 视口与取景距离。 */
  _layout() {
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    if (!cw || !ch) return;
    this.renderer.setSize(cw, ch, false);
    const base = this.canvas.getBoundingClientRect();
    const t = Math.tan((FOV * Math.PI) / 360);
    for (const cell of this.cells) {
      if (!cell.vpEl) { cell.rect = null; continue; }
      const r = cell.vpEl.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) { cell.rect = null; continue; }
      cell.rect = { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height };
      // WebGL 视口原点在左下，翻 Y
      cell.rectGL = { x: cell.rect.x, y: ch - (r.bottom - base.top), w: r.width, h: r.height };
      const aspect = r.width / Math.max(r.height, 1);
      // 竖向框住模型本体，横向框住符文环全宽
      const vFit = (cell.height * 1.42) / (2 * t);
      const hFit = (cell.ringRadius * 2 * 1.24) / (2 * t * aspect);
      cell.dist = Math.max(vFit, hFit);
    }
  }

  resize() {
    this._layout();
  }

  show() {
    this._ensureLoaded();
    this._layout();
    if (this.visible) return;
    this.visible = true;
    this._lastT = performance.now();
    this._raf = requestAnimationFrame(this._tick);
  }

  hide() {
    this.visible = false;
    cancelAnimationFrame(this._raf);
  }

  _tick = (now) => {
    if (!this.visible) return;
    this._raf = requestAnimationFrame(this._tick);
    const dt = Math.min(0.05, (now - this._lastT) / 1000);
    this._lastT = now;
    this.update(dt);
    this.render();
  };

  update(dt) {
    this._elapsed += dt;
    const el = this._elapsed;
    const now = performance.now();
    for (const cell of this.cells) {
      cell.phase += dt;
      // 闲置自转：拖动后 2.2 秒恢复
      if (now - cell.lastTouch > 2200) cell.yaw += dt * 0.38;
      cell.holder.rotation.set(cell.pitch, cell.yaw, 0);

      if (cell.wraith) {
        const w = cell.wraith;
        w.core.rotation.y += dt * 1.4;
        w.core.rotation.x += dt * 0.6;
        w.inner.rotation.y -= dt * 2.2;
        w.band.rotation.y -= dt * 0.8;
        w.band.rotation.x = 0.9 + Math.sin(el * 1.3 + cell.phase) * 0.35;
        w.band2.rotation.y += dt * 0.6;
        w.band2.rotation.x = -0.9 - Math.sin(el * 1.3 + cell.phase) * 0.35;
        cell.halo.scale.setScalar(2.0 + Math.sin(el * 3.1 + cell.phase) * 0.22);
      }
      if (cell.ring) {
        cell.ring.rotation.z += dt * 1.5;
        cell.ring.rotation.x = RING_TILT + Math.sin(el * 0.9 + cell.phase) * 0.14;
        cell.halo.scale.setScalar(3.0 + Math.sin(el * 2.6 + cell.phase) * 0.2);
      }
      if (cell.flame) {
        const params = FLAME_PARAMS[cell.def.flame];
        const bodyH = cell.midY * 2;
        const bodyR = Math.min(cell.radius * 0.95, 1.05);
        cell.flameAcc += dt * params.rate;
        while (cell.flameAcc >= 1) {
          cell.flameAcc -= 1;
          const a = Math.random() * Math.PI * 2;
          const rr = bodyR * (0.3 + Math.random() * 0.6);
          spawnFlameParticle(
            cell.flame,
            Math.cos(a) * rr,
            0.06 + Math.random() * bodyH * 0.6,
            Math.sin(a) * rr,
            cell.accent,
            {
              vy: params.vy[0] + Math.random() * params.vy[1],
              life: params.life[0] + Math.random() * params.life[1],
              maxLife: params.maxLife,
              size0: params.size0[0] + Math.random() * params.size0[1],
              size1: params.size1,
              alpha: params.alpha,
              sway: true
            }
          );
        }
        cell.flame.update(dt, el);
      }
    }
  }

  render() {
    // 点精灵尺寸换算：viewport 高度（设备像素）/ (2·tan(fov/2))
    const pr = this.renderer.getPixelRatio();
    const uScale = 1 / (2 * Math.tan((FOV * Math.PI) / 360));
    this.renderer.setScissorTest(true);
    for (const cell of this.cells) {
      const r = cell.rectGL;
      if (!r) continue;
      this.renderer.setViewport(r.x, r.y, r.w, r.h);
      this.renderer.setScissor(r.x, r.y, r.w, r.h);
      if (cell.flame) {
        cell.flame.points.material.uniforms.uProjScale.value = r.h * pr * uScale;
      }
      this.camera.aspect = r.w / Math.max(r.h, 1);
      this.camera.updateProjectionMatrix();
      // 镜头精确对准模型几何中心：四个格子的模型永远落在同一水平线上
      this.camera.position.set(cell.group.position.x, cell.midY + cell.height * 0.12, cell.dist);
      this.camera.lookAt(cell.group.position.x, cell.midY, 0);
      this.renderer.render(this.scene, this.camera);
    }
  }

  /* —— 鼠标拖动旋转 —— */

  _cellAt(clientX, clientY) {
    const base = this.canvas.getBoundingClientRect();
    const px = clientX - base.left;
    const py = clientY - base.top;
    return this.cells.find((c) =>
      c.rect &&
      px >= c.rect.x && px <= c.rect.x + c.rect.w &&
      py >= c.rect.y && py <= c.rect.y + c.rect.h
    ) ?? null;
  }

  _bindPointer() {
    const c = this.canvas;
    // 图鉴区域的事件不外溢：不触发"点击任意处继续"与游戏侧视角/缩放
    const stop = (event) => event.stopPropagation();
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'click', 'dblclick', 'wheel']) {
      c.addEventListener(type, stop);
    }
    c.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });

    c.addEventListener('pointerdown', (event) => {
      if (this._drag) return;
      const cell = this._cellAt(event.clientX, event.clientY);
      if (!cell) return;
      this._drag = { cell, id: event.pointerId, x: event.clientX, y: event.clientY };
      cell.lastTouch = performance.now();
      c.style.cursor = 'grabbing';
      try { c.setPointerCapture(event.pointerId); } catch { /* 忽略 */ }
      event.preventDefault();
    });

    c.addEventListener('pointermove', (event) => {
      const d = this._drag;
      if (!d || event.pointerId !== d.id) {
        c.style.cursor = this._cellAt(event.clientX, event.clientY) ? 'grab' : 'default';
        return;
      }
      const cell = d.cell;
      cell.yaw += (event.clientX - d.x) * 0.0088;
      cell.pitch = Math.max(-0.55, Math.min(0.7, cell.pitch + (event.clientY - d.y) * 0.005));
      d.x = event.clientX;
      d.y = event.clientY;
      cell.lastTouch = performance.now();
    });

    const release = (event) => {
      if (!this._drag || event.pointerId !== this._drag.id) return;
      this._drag = null;
      c.style.cursor = 'grab';
    };
    c.addEventListener('pointerup', release);
    c.addEventListener('pointercancel', release);
  }

  dispose() {
    this.hide();
    this.scene.traverse((object) => {
      if (object.geometry) object.geometry.dispose();
      if (object.material) object.material.dispose?.();
    });
    for (const cell of this.cells) cell.flame?.geometry.dispose();
    this._glow.dispose();
    this._bandMaterial.dispose();
    this.renderer.dispose();
  }
}
