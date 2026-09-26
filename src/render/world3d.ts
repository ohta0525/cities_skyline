import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { HorizontalTiltShiftShader } from 'three/addons/shaders/HorizontalTiltShiftShader.js';
import { VerticalTiltShiftShader } from 'three/addons/shaders/VerticalTiltShiftShader.js';
import { VignetteShader } from 'three/addons/shaders/VignetteShader.js';
import type { Quality } from '../core/settings';
import { BASE_Y, SEA_LEVEL, heightAt, insideMap, type Terrain } from '../world/terrain';
import { CameraController } from './camera';
import { buildDiorama, buildNameplate } from './diorama';
import { buildTerrainMesh } from './terrainMesh';
import { buildTrees } from './trees';
import { buildRiver, buildSea, createWaterMaterial } from './water';

const BG = new THREE.Color('#c8d5d3');
const SUN_DIR = new THREE.Vector3(-0.55, 0.78, 0.35).normalize();

export interface GroundHit { point: THREE.Vector3; water: boolean }

const QUALITY: Record<Quality, { ratio: number; shadow: number; ao: boolean; samples: number; trees: number }> = {
  high: { ratio: 2, shadow: 4096, ao: true, samples: 4, trees: 1 },
  medium: { ratio: 1.5, shadow: 2048, ao: false, samples: 4, trees: 0.7 },
  low: { ratio: 1, shadow: 1024, ao: false, samples: 0, trees: 0.4 },
};

/** 3D 表示の全体。地形の差し替え、画質、ミニチュア効果、地面の判定を受け持つ */
export class World3D {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(35, 1, 2, 16000);
  readonly controls: CameraController;
  private terrain!: Terrain;
  private worldGroup = new THREE.Group();
  private sun = new THREE.DirectionalLight('#fff0d8', 3.1);
  private water = createWaterMaterial();
  private composer!: EffectComposer;
  private ao?: GTAOPass;
  private tiltH!: ShaderPass;
  private tiltV!: ShaderPass;
  private quality: Quality = 'high';
  private miniature = 0.6;
  private nameplate?: THREE.Mesh;
  private raycaster = new THREE.Raycaster();
  private shadowExtent = 0;
  private aoRadius = 0;
  private time = 0;

  constructor(private canvas: HTMLCanvasElement, quality: Quality, miniature: number) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.scene.background = BG;
    this.scene.fog = new THREE.Fog(BG, 5000, 14000);
    this.scene.add(new THREE.HemisphereLight('#e4f0ff', '#8c7a5c', 1.25));
    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    this.sun.shadow.camera.near = 10;
    this.sun.shadow.camera.far = 6000;
    // 反対側から弱い補助光を当てて、影側の断面もつぶれないようにする
    const fill = new THREE.DirectionalLight('#dce8ff', 0.7);
    fill.position.set(0.6, 0.5, -0.4);
    this.scene.add(this.sun, this.sun.target, fill, this.worldGroup);

    this.controls = new CameraController(
      this.camera,
      canvas,
      () => this.terrain,
      (x, y) => this.pick(x, y)?.point ?? null,
      (x, y, h) => this.pickPlane(x, y, h),
    );
    this.miniature = miniature;
    this.setQuality(quality);
  }

  setTerrain(t: Terrain): void {
    this.terrain = t;
    this.disposeGroup(this.worldGroup);
    this.worldGroup.clear();
    this.worldGroup.add(buildTerrainMesh(t));
    this.worldGroup.add(buildSea(t, this.water.material));
    const river = buildRiver(t, this.water.material);
    if (river) this.worldGroup.add(river);
    this.worldGroup.add(buildDiorama(t, this.water.material));
    this.worldGroup.add(buildTrees(t, QUALITY[this.quality].trees));
  }

  setCityName(text: string): void {
    if (this.nameplate) {
      this.scene.remove(this.nameplate);
      this.disposeGroup(this.nameplate);
    }
    // 銘板は地形を作り直しても残すので、scene に直接置く
    this.nameplate = buildNameplate(text);
    this.scene.add(this.nameplate);
  }

  setQuality(q: Quality): void {
    const changedTrees = this.terrain && QUALITY[q].trees !== QUALITY[this.quality].trees;
    this.quality = q;
    const cfg = QUALITY[q];
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, cfg.ratio));
    this.sun.shadow.mapSize.set(cfg.shadow, cfg.shadow);
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null;
    this.buildComposer();
    if (changedTrees) this.setTerrain(this.terrain);
  }

  setMiniature(v: number): void {
    this.miniature = v;
  }

  private buildComposer(): void {
    this.composer?.dispose();
    const cfg = QUALITY[this.quality];
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(Math.max(1, size.x), Math.max(1, size.y), {
      type: THREE.HalfFloatType,
      samples: cfg.samples,
    });
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.ao = undefined;
    this.aoRadius = 0;
    if (cfg.ao) {
      this.ao = new GTAOPass(this.scene, this.camera, size.x, size.y);
      this.ao.blendIntensity = 0.85;
      this.composer.addPass(this.ao);
    }
    this.tiltH = new ShaderPass(HorizontalTiltShiftShader);
    this.tiltV = new ShaderPass(VerticalTiltShiftShader);
    this.composer.addPass(this.tiltH);
    this.composer.addPass(this.tiltV);
    const vignette = new ShaderPass(VignetteShader);
    vignette.uniforms.offset.value = 0.95;
    vignette.uniforms.darkness.value = 0.9;
    this.composer.addPass(vignette);
    this.composer.addPass(new OutputPass());
    this.resize();
  }

  resize(): void {
    const w = this.canvas.clientWidth || 1, h = this.canvas.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.composer?.setSize(w, h);
    this.composer?.setPixelRatio(this.renderer.getPixelRatio());
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render(dt: number): void {
    this.time += dt;
    this.water.uniforms.time.value = this.time;
    this.controls.update(dt);
    const d = this.controls.distance;

    // 影はカメラの注視点のまわりだけに当てる
    const t = this.controls.target;
    const extent = Math.min(1800, Math.max(260, d * 2.2));
    this.sun.target.position.copy(t);
    this.sun.position.copy(t).addScaledVector(SUN_DIR, 3000);
    if (Math.abs(extent - this.shadowExtent) > extent * 0.05) {
      const cam = this.sun.shadow.camera;
      cam.left = -extent; cam.right = extent; cam.top = extent; cam.bottom = -extent;
      cam.updateProjectionMatrix();
      this.shadowExtent = extent;
    }

    // 近づくほどミニチュア感を強くする
    const w = this.canvas.clientWidth || 1, h = this.canvas.clientHeight || 1;
    const near = 1 - Math.min(1, d / 3000);
    const amount = this.miniature * (0.5 + 1.2 * near);
    this.tiltH.uniforms.h.value = (amount * 2.2) / w;
    this.tiltV.uniforms.v.value = (amount * 2.2) / h;
    this.tiltH.uniforms.r.value = 0.5;
    this.tiltV.uniforms.r.value = 0.5;
    this.tiltH.enabled = this.tiltV.enabled = amount > 0.01;

    if (this.ao) {
      const r = Math.min(24, Math.max(2, d * 0.012));
      if (Math.abs(r - this.aoRadius) > this.aoRadius * 0.1) {
        this.ao.updateGtaoMaterial({ radius: r, thickness: r, distanceFallOff: 1, scale: 1 });
        this.aoRadius = r;
      }
    }
    this.composer.render(dt);
  }

  /** 画面座標の真下にある地面（または水面） */
  pick(clientX: number, clientY: number): GroundHit | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const { origin: o, direction: dir } = this.raycaster.ray;
    const top = 320;
    let t = o.y > top && dir.y < 0 ? (o.y - top) / -dir.y : 0;
    const surface = (x: number, z: number) => Math.max(SEA_LEVEL, heightAt(this.terrain, x, z));
    const p = new THREE.Vector3();
    let prev = t;
    for (let i = 0; i < 3000; i++) {
      p.copy(o).addScaledVector(dir, t);
      if (p.y < BASE_Y) return null;
      if (insideMap(p.x, p.z) && p.y <= surface(p.x, p.z)) {
        // 二分探索で交点を詰める
        let a = prev, b = t;
        for (let k = 0; k < 12; k++) {
          const m = (a + b) / 2;
          p.copy(o).addScaledVector(dir, m);
          if (insideMap(p.x, p.z) && p.y <= surface(p.x, p.z)) b = m; else a = m;
        }
        p.copy(o).addScaledVector(dir, b);
        const water = heightAt(this.terrain, p.x, p.z) < SEA_LEVEL;
        if (water) p.y = SEA_LEVEL;
        return { point: p.clone(), water };
      }
      prev = t;
      t += Math.max(2, t * 0.002);
      if (t > 20000) break;
    }
    return null;
  }

  private pickPlane(clientX: number, clientY: number, y: number): THREE.Vector3 | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), hit);
  }

  /** 方位磁針用：カメラが北から何ラジアン回っているか */
  heading(): number {
    return this.controls.yaw;
  }

  private disposeGroup(obj: THREE.Object3D): void {
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (!mat) return;
      for (const mm of Array.isArray(mat) ? mat : [mat]) {
        if (mm === this.water.material) continue;
        const map = (mm as THREE.MeshStandardMaterial).map;
        map?.dispose();
        mm.dispose();
      }
    });
  }
}

