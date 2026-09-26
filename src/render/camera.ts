import * as THREE from 'three';
import type { CameraState } from '../save/save';
import { HALF, SEA_LEVEL, heightAt, insideMap, type Terrain } from '../world/terrain';

export const DEFAULT_CAMERA: CameraState = { x: 0, z: 60, yaw: 0.35, pitch: 0.6, distance: 2700 };

const MIN_DIST = 35, MAX_DIST = 3000;
const MIN_PITCH = 0.18, MAX_PITCH = 1.45;

/**
 * Cities: Skylines 風のカメラ操作。
 * WASD / 矢印：移動、Q E：回転、R F：傾き、ホイール：ズーム、
 * 右ドラッグ：回転と傾き、中ドラッグ：地面をつかんで移動、Home：初期位置。
 */
export class CameraController {
  readonly target = new THREE.Vector3();
  yaw = DEFAULT_CAMERA.yaw;
  pitch = DEFAULT_CAMERA.pitch;
  distance = DEFAULT_CAMERA.distance;
  private goal: CameraState = { ...DEFAULT_CAMERA };
  private keys = new Set<string>();
  private drag: { mode: 'rotate' | 'pan'; x: number; y: number; grab?: THREE.Vector3 } | null = null;
  private groundY = 0;

  constructor(
    private camera: THREE.PerspectiveCamera,
    dom: HTMLElement,
    private terrain: () => Terrain,
    /** 画面座標の真下の地面。なければ null */
    private pickGround: (clientX: number, clientY: number) => THREE.Vector3 | null,
    /** 画面座標から出る光線と、高さ y の水平面の交点 */
    private pickPlane: (clientX: number, clientY: number, y: number) => THREE.Vector3 | null,
  ) {
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    dom.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    dom.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  setState(s: CameraState, immediate = true): void {
    this.goal = { ...s };
    this.clampGoal();
    if (immediate) {
      this.target.set(this.goal.x, 0, this.goal.z);
      this.yaw = this.goal.yaw; this.pitch = this.goal.pitch; this.distance = this.goal.distance;
      this.groundY = this.groundAt(this.goal.x, this.goal.z);
    }
  }

  getState(): CameraState {
    return { ...this.goal };
  }

  private groundAt(x: number, z: number): number {
    return Math.max(SEA_LEVEL, heightAt(this.terrain(), x, z));
  }

  private clampGoal(): void {
    const g = this.goal;
    const lim = HALF * 0.98;
    g.x = Math.min(lim, Math.max(-lim, g.x));
    g.z = Math.min(lim, Math.max(-lim, g.z));
    g.distance = Math.min(MAX_DIST, Math.max(MIN_DIST, g.distance));
    g.pitch = Math.min(MAX_PITCH, Math.max(MIN_PITCH, g.pitch));
  }

  private onDown = (e: PointerEvent) => {
    if (e.button === 2) {
      this.drag = { mode: 'rotate', x: e.clientX, y: e.clientY };
    } else if (e.button === 1) {
      e.preventDefault();
      const grab = this.pickGround(e.clientX, e.clientY);
      if (grab) this.drag = { mode: 'pan', x: e.clientX, y: e.clientY, grab };
    }
  };

  private onMove = (e: PointerEvent) => {
    const d = this.drag;
    if (!d) return;
    if (d.mode === 'rotate') {
      this.goal.yaw -= (e.clientX - d.x) * 0.005;
      this.goal.pitch += (e.clientY - d.y) * 0.004;
      d.x = e.clientX; d.y = e.clientY;
      this.clampGoal();
    } else if (d.grab) {
      const p = this.pickPlane(e.clientX, e.clientY, d.grab.y);
      if (!p) return;
      // つかんだ点がカーソルの下に来るよう、すぐに動かす
      this.goal.x += d.grab.x - p.x;
      this.goal.z += d.grab.z - p.z;
      this.clampGoal();
      this.target.x = this.goal.x; this.target.z = this.goal.z;
      this.place();
    }
  };

  private onUp = (e: PointerEvent) => {
    if (this.drag && (e.button === 2 || e.button === 1)) this.drag = null;
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const factor = Math.exp(Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 120) * 0.0022);
    const old = this.goal.distance;
    this.goal.distance = old * factor;
    this.clampGoal();
    if (this.goal.distance < old) {
      // 拡大するときはカーソルの方へ寄る
      const p = this.pickGround(e.clientX, e.clientY);
      if (p) {
        const k = 1 - this.goal.distance / old;
        this.goal.x += (p.x - this.goal.x) * k;
        this.goal.z += (p.z - this.goal.z) * k;
        this.clampGoal();
      }
    }
  };

  private onKey = (e: KeyboardEvent) => {
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
    if (e.code === 'Home') { this.setState({ ...DEFAULT_CAMERA }, false); return; }
    this.keys.add(e.code);
  };

  update(dt: number): void {
    const k = this.keys;
    const g = this.goal;
    const fast = k.has('ShiftLeft') || k.has('ShiftRight') ? 2.5 : 1;
    const move = g.distance * 0.9 * dt * fast;
    let fx = 0, fz = 0;
    if (k.has('KeyW') || k.has('ArrowUp')) fz += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) fz -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) fx += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) fx -= 1;
    if (fx || fz) {
      const sy = Math.sin(g.yaw), cy = Math.cos(g.yaw);
      // 前方 = (-sin, -cos)、右 = (cos, -sin)
      g.x += (-sy * fz + cy * fx) * move;
      g.z += (-cy * fz - sy * fx) * move;
    }
    if (k.has('KeyQ')) g.yaw += 1.4 * dt;
    if (k.has('KeyE')) g.yaw -= 1.4 * dt;
    if (k.has('KeyR')) g.pitch += 0.9 * dt;
    if (k.has('KeyF')) g.pitch -= 0.9 * dt;
    this.clampGoal();

    const a = 1 - Math.exp(-dt * 9);
    this.target.x += (g.x - this.target.x) * a;
    this.target.z += (g.z - this.target.z) * a;
    this.yaw += (g.yaw - this.yaw) * a;
    this.pitch += (g.pitch - this.pitch) * a;
    this.distance += (g.distance - this.distance) * a;
    this.groundY += (this.groundAt(this.target.x, this.target.z) - this.groundY) * (1 - Math.exp(-dt * 4));
    this.place();
  }

  private place(): void {
    this.target.y = this.groundY;
    const cp = Math.cos(this.pitch);
    const cam = this.camera;
    cam.position.set(
      this.target.x + Math.sin(this.yaw) * cp * this.distance,
      this.target.y + Math.sin(this.pitch) * this.distance,
      this.target.z + Math.cos(this.yaw) * cp * this.distance,
    );
    // 山に埋まらないようにする
    if (insideMap(cam.position.x, cam.position.z)) {
      const floor = this.groundAt(cam.position.x, cam.position.z) + 8;
      if (cam.position.y < floor) cam.position.y = floor;
    }
    cam.lookAt(this.target);
  }
}
