import * as THREE from 'three';
import { mulberry32 } from '../core/rng';
import type { Building, BuildingKind } from '../city/buildings';

/**
 * 建物の手続き生成。建物ごとのローカル座標：
 * x は道路沿い（-W/2〜W/2）、z は道路から奥（0〜D）、y は上。
 * 窓は頂点属性 aWin の種類ごとにシェーダーで描く。
 */
export const WIN = { none: 0, house: 1, apartment: 2, office: 3, factory: 4, shop: 5 } as const;

type V = THREE.Vector3;
const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

class B {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  win: number[] = [];
  private tmpC = new THREE.Color();

  tri(a: V, b: V, c: V, color: string | THREE.Color, win = 0): void {
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
    const col = typeof color === 'string' ? this.tmpC.set(color) : color;
    for (const p of [a, b, c]) {
      this.pos.push(p.x, p.y, p.z);
      this.nrm.push(n.x, n.y, n.z);
      this.col.push(col.r, col.g, col.b);
      this.win.push(win);
    }
  }

  /** 4 点の面。out の向きが表になるよう自動で巻き順を決める */
  quad(a: V, b: V, c: V, d: V, color: string | THREE.Color, out: V, win = 0): void {
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    if (n.dot(out) < 0) { this.tri(a, c, b, color, win); this.tri(a, d, c, color, win); }
    else { this.tri(a, b, c, color, win); this.tri(a, c, d, color, win); }
  }

  box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, color: string, win = 0, top: string | null = null, bottom = false): void {
    const c = top ?? color;
    this.quad(v(x0, y1, z0), v(x1, y1, z0), v(x1, y1, z1), v(x0, y1, z1), c, v(0, 1, 0));
    if (bottom) this.quad(v(x0, y0, z0), v(x1, y0, z0), v(x1, y0, z1), v(x0, y0, z1), color, v(0, -1, 0));
    this.quad(v(x0, y0, z0), v(x1, y0, z0), v(x1, y1, z0), v(x0, y1, z0), color, v(0, 0, -1), win);
    this.quad(v(x0, y0, z1), v(x1, y0, z1), v(x1, y1, z1), v(x0, y1, z1), color, v(0, 0, 1), win);
    this.quad(v(x0, y0, z0), v(x0, y0, z1), v(x0, y1, z1), v(x0, y1, z0), color, v(-1, 0, 0), win);
    this.quad(v(x1, y0, z0), v(x1, y0, z1), v(x1, y1, z1), v(x1, y1, z0), color, v(1, 0, 0), win);
  }

  /** 切妻屋根。棟は along の向き */
  gable(x0: number, x1: number, z0: number, z1: number, y0: number, rise: number, roof: string, wall: string, along: 'x' | 'z', oh = 0.45): void {
    if (along === 'x') {
      const zm = (z0 + z1) / 2, yr = y0 + rise;
      const a = v(x0 - oh, y0 - 0.2, z0 - oh), b = v(x1 + oh, y0 - 0.2, z0 - oh), r0 = v(x0 - oh, yr, zm), r1 = v(x1 + oh, yr, zm);
      const c = v(x0 - oh, y0 - 0.2, z1 + oh), d = v(x1 + oh, y0 - 0.2, z1 + oh);
      this.quad(a, b, r1, r0, roof, v(0, 1, -1));
      this.quad(c, d, r1, r0, roof, v(0, 1, 1));
      this.tri(v(x0, y0, z0), v(x0, y0, z1), v(x0, yr, zm), wall); this.fixLast(v(-1, 0, 0));
      this.tri(v(x1, y0, z0), v(x1, y0, z1), v(x1, yr, zm), wall); this.fixLast(v(1, 0, 0));
    } else {
      const xm = (x0 + x1) / 2, yr = y0 + rise;
      const a = v(x0 - oh, y0 - 0.2, z0 - oh), b = v(x0 - oh, y0 - 0.2, z1 + oh), r0 = v(xm, yr, z0 - oh), r1 = v(xm, yr, z1 + oh);
      const c = v(x1 + oh, y0 - 0.2, z0 - oh), d = v(x1 + oh, y0 - 0.2, z1 + oh);
      this.quad(a, b, r1, r0, roof, v(-1, 1, 0));
      this.quad(c, d, r1, r0, roof, v(1, 1, 0));
      this.tri(v(x0, y0, z0), v(x1, y0, z0), v(xm, yr, z0), wall); this.fixLast(v(0, 0, -1));
      this.tri(v(x0, y0, z1), v(x1, y0, z1), v(xm, yr, z1), wall); this.fixLast(v(0, 0, 1));
    }
  }

  /** 寄棟屋根 */
  hip(x0: number, x1: number, z0: number, z1: number, y0: number, rise: number, roof: string, oh = 0.45): void {
    const X0 = x0 - oh, X1 = x1 + oh, Z0 = z0 - oh, Z1 = z1 + oh, y = y0 - 0.2, yr = y0 + rise;
    const w = X1 - X0, d = Z1 - Z0;
    let r0: V, r1: V;
    if (w >= d) { const m = (Z0 + Z1) / 2; r0 = v(X0 + d / 2, yr, m); r1 = v(X1 - d / 2, yr, m); }
    else { const m = (X0 + X1) / 2; r0 = v(m, yr, Z0 + w / 2); r1 = v(m, yr, Z1 - w / 2); }
    const A = v(X0, y, Z0), Bq = v(X1, y, Z0), Cq = v(X1, y, Z1), D = v(X0, y, Z1);
    if (w >= d) {
      this.quad(A, Bq, r1, r0, roof, v(0, 1, -1));
      this.quad(D, Cq, r1, r0, roof, v(0, 1, 1));
      this.tri(A, D, r0, roof); this.fixLast(v(-1, 1, 0));
      this.tri(Bq, Cq, r1, roof); this.fixLast(v(1, 1, 0));
    } else {
      this.quad(A, D, r1, r0, roof, v(-1, 1, 0));
      this.quad(Bq, Cq, r1, r0, roof, v(1, 1, 0));
      this.tri(A, Bq, r0, roof); this.fixLast(v(0, 1, -1));
      this.tri(D, Cq, r1, roof); this.fixLast(v(0, 1, 1));
    }
  }

  /** 直前の三角形の表裏を out に合わせる */
  private fixLast(out: V): void {
    const k = this.pos.length - 9;
    const a = v(this.pos[k], this.pos[k + 1], this.pos[k + 2]);
    const b = v(this.pos[k + 3], this.pos[k + 4], this.pos[k + 5]);
    const c = v(this.pos[k + 6], this.pos[k + 7], this.pos[k + 8]);
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    if (n.dot(out) >= 0) return;
    // b と c を入れ替え、法線も反転する
    for (let i = 0; i < 3; i++) {
      const t = this.pos[k + 3 + i]; this.pos[k + 3 + i] = this.pos[k + 6 + i]; this.pos[k + 6 + i] = t;
    }
    for (let i = k; i < k + 9; i++) this.nrm[i] = -this.nrm[i];
  }

  cylinder(cx: number, cz: number, r: number, y0: number, y1: number, color: string, seg = 12, top: string | null = null): void {
    for (let k = 0; k < seg; k++) {
      const a0 = (k / seg) * Math.PI * 2, a1 = ((k + 1) / seg) * Math.PI * 2;
      const p0 = v(cx + Math.cos(a0) * r, 0, cz + Math.sin(a0) * r), p1 = v(cx + Math.cos(a1) * r, 0, cz + Math.sin(a1) * r);
      const out = v(Math.cos((a0 + a1) / 2), 0, Math.sin((a0 + a1) / 2));
      this.quad(p0.clone().setY(y0), p1.clone().setY(y0), p1.clone().setY(y1), p0.clone().setY(y1), color, out);
      this.tri(v(cx, y1, cz), p0.clone().setY(y1), p1.clone().setY(y1), top ?? color); this.fixLast(v(0, 1, 0));
    }
  }

  /** のこぎり屋根（北側の縦面がガラス） */
  sawtooth(x0: number, x1: number, z0: number, z1: number, y0: number, teeth: number, h: number, roof: string, glass: string, wall: string): void {
    const step = (z1 - z0) / teeth;
    for (let k = 0; k < teeth; k++) {
      const za = z0 + k * step, zb = za + step;
      this.quad(v(x0, y0, za), v(x1, y0, za), v(x1, y0 + h, zb), v(x0, y0 + h, zb), roof, v(0, 1, -1));
      this.quad(v(x0, y0, zb), v(x1, y0, zb), v(x1, y0 + h, zb), v(x0, y0 + h, zb), glass, v(0, 0, 1));
      this.tri(v(x0, y0, za), v(x0, y0, zb), v(x0, y0 + h, zb), wall); this.fixLast(v(-1, 0, 0));
      this.tri(v(x1, y0, za), v(x1, y0, zb), v(x1, y0 + h, zb), wall); this.fixLast(v(1, 0, 0));
    }
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aWin', new THREE.Float32BufferAttribute(this.win, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

const pick = <T>(r: () => number, arr: T[]): T => arr[Math.floor(r() * arr.length)];
const range = (r: () => number, a: number, b: number) => a + (b - a) * r();

const WALLS = ['#f3f0e6', '#e8dfcc', '#dcd6ca', '#cdbba0', '#bfc8cc', '#e6d6bd', '#d9cfc0'];
const ROOFS = ['#4a4f58', '#34465e', '#6d4a37', '#56655a', '#7e4538', '#3f4a52'];
const SIGNS = ['#d8443a', '#2f7fc1', '#f0b429', '#3c9a5f', '#e46f2a', '#8c55b8', '#e84a8a'];
const BLOCK = '#b4afa5';
const CONCRETE = '#bab6ad';

/** 敷地の地面（造成した面）と基礎 */
function lotPad(g: B, W: number, D: number, color: string): void {
  g.box(-W / 2 + 0.2, W / 2 - 0.2, -3, 0.06, 0.2, D - 0.2, CONCRETE, 0, color);
}

function house(g: B, r: () => number, W: number, D: number): void {
  lotPad(g, W, D, '#9dbd6c');
  const wall = pick(r, WALLS), roof = pick(r, ROOFS);
  const bw = Math.min(W - 1.6, range(r, 6, 7)), bd = range(r, 7, 8.5);
  const x0 = -bw / 2 + range(r, -0.4, 0.4), z0 = range(r, 2.8, 3.6);
  const h = 5.6;
  g.box(x0, x0 + bw, 0, h, z0, z0 + bd, wall, WIN.house);
  if (r() < 0.55) g.gable(x0, x0 + bw, z0, z0 + bd, h, range(r, 1.8, 2.6), roof, wall, r() < 0.5 ? 'x' : 'z');
  else g.hip(x0, x0 + bw, z0, z0 + bd, h, range(r, 1.6, 2.2), roof);
  // 下屋（1 階だけの張り出し）
  if (r() < 0.4) {
    const ax0 = x0 + 0.5, ax1 = x0 + bw - 0.5, az1 = z0 + bd + 2.2;
    g.box(ax0, ax1, 0, 2.8, z0 + bd - 0.1, az1, wall, WIN.house);
    g.box(ax0 - 0.3, ax1 + 0.3, 2.8, 3.1, z0 + bd - 0.1, az1 + 0.3, roof);
  }
  // ブロック塀と門、駐車スペース
  const gate = range(r, -1.5, 1.5);
  g.box(-W / 2 + 0.3, gate - 1.4, 0, 1.2, 0.3, 0.5, BLOCK);
  g.box(gate + 1.4, W / 2 - 0.3, 0, 1.2, 0.3, 0.5, BLOCK);
  g.box(-W / 2 + 0.3, -W / 2 + 0.5, 0, 1.2, 0.5, D - 0.4, BLOCK);
  g.box(W / 2 - 0.5, W / 2 - 0.3, 0, 1.2, 0.5, D - 0.4, BLOCK);
  g.box(-W / 2 + 0.3, W / 2 - 0.3, 0, 1.2, D - 0.6, D - 0.4, BLOCK);
  g.box(gate - 1.3, gate + 1.3, 0.06, 0.1, 0.5, z0 - 0.2, CONCRETE);
  // 庭木
  if (r() < 0.7) {
    const tx = r() < 0.5 ? -W / 2 + 1.4 : W / 2 - 1.4, tz = range(r, z0 + bd + 1.5, D - 1.5);
    if (tz < D - 1) {
      g.cylinder(tx, tz, 0.15, 0.06, 1.2, '#6b4a31', 5);
      g.cylinder(tx, tz, 0.9, 1.2, 3, '#4f8f3f', 7, '#5c9c47');
    }
  }
}

function apartment(g: B, r: () => number, W: number, D: number): void {
  lotPad(g, W, D, '#b9b5a9');
  const wall = pick(r, ['#e8dcc3', '#d7ccb8', '#e9e3d6', '#c9b89c']), roof = pick(r, ROOFS);
  const bw = W - 3, x0 = -bw / 2, z0 = 4.6, z1 = z0 + 8, h = 5.8;
  g.box(x0, x0 + bw, 0, h, z0, z1, wall, WIN.apartment);
  g.gable(x0, x0 + bw, z0, z1, h, 1.1, roof, wall, 'x', 0.3);
  // 外廊下と手すり、鉄骨階段
  g.box(x0, x0 + bw, 2.8, 3.0, z0 - 1.3, z0, '#d8d3c6');
  g.box(x0, x0 + bw, 3.0, 4.0, z0 - 1.35, z0 - 1.2, '#cfd4d6');
  g.box(x0 + bw, x0 + bw + 1.3, 0, 3.0, z0 - 1.3, z0 + 2.2, '#8e969c');
  // 駐輪場の屋根
  g.box(-W / 2 + 0.8, -W / 2 + 4, 2.2, 2.35, 0.8, 3, '#8c9aa3');
}

function mansion(g: B, r: () => number, W: number, D: number, floors: number): void {
  lotPad(g, W, D, '#b9b5a9');
  const wall = pick(r, ['#ece8df', '#d8d2c6', '#c7b9a6', '#b8bfc4', '#e3d4bf']);
  const x0 = -W / 2 + 1.8, x1 = W / 2 - 1.8, z0 = 5, z1 = D - 2;
  const h = floors * 3;
  g.box(x0, x1, 0, h, z0, z1, wall, WIN.apartment);
  // バルコニー（道路側）
  for (let f = 1; f < floors; f++) {
    const y = f * 3;
    g.box(x0 + 0.3, x1 - 0.3, y - 0.1, y + 0.1, z0 - 1.3, z0, '#e9e6de');
    g.box(x0 + 0.3, x1 - 0.3, y + 0.1, y + 1.05, z0 - 1.35, z0 - 1.2, r() < 0.5 ? '#f2efe8' : '#a9c0cc');
  }
  // 屋上：パラペット、塔屋、高架水槽
  g.box(x0, x1, h, h + 0.8, z0, z0 + 0.3, wall);
  g.box(x0 + 1, x0 + 4, h, h + 3, z1 - 4, z1 - 1, wall);
  g.cylinder(x1 - 2.5, z1 - 3, 1.2, h + 0.5, h + 2.6, '#d9dcdc', 10);
  g.box(x1 - 3.6, x1 - 1.4, h, h + 0.5, z1 - 4.1, z1 - 1.9, '#9aa0a3');
  // エントランスのひさし
  g.box(-2, 2, 2.8, 3.1, z0 - 2.5, z0, '#9fa7ab');
}

function danchi(g: B, r: () => number, W: number, D: number, floors: number): void {
  lotPad(g, W, D, '#a8c07a');
  const wall = pick(r, ['#efe9dc', '#e7e2d7', '#e3dcc9']);
  const x0 = -W / 2 + 1.2, x1 = W / 2 - 1.2, z0 = 3.5, z1 = z0 + 9;
  const h = floors * 2.8;
  g.box(x0, x1, 0, h, z0, z1, wall, WIN.apartment);
  // 階段室
  for (let k = 0; k < 3; k++) {
    const cx = x0 + ((k + 0.5) * (x1 - x0)) / 3;
    g.box(cx - 1.3, cx + 1.3, 0, h + 1.2, z0 - 1.2, z0 + 0.1, '#dcd5c5');
  }
  g.box(x0, x1, h, h + 0.5, z0, z1, '#cfc8b7');
  // 棟番号のような青い帯
  g.box(x1 - 0.1, x1 + 0.05, h - 3, h - 1, z0 + 2, z0 + 5, '#3d6ea8');
}

function shopHouse(g: B, r: () => number, W: number, D: number, floors: number): void {
  lotPad(g, W, D, CONCRETE);
  const wall = pick(r, WALLS), sign = pick(r, SIGNS);
  const bw = W - 0.6, x0 = -bw / 2, z0 = 0.6, z1 = Math.min(D - 1, z0 + range(r, 7, 10));
  const h = floors * 3;
  g.box(x0, x0 + bw, 0, h, z0, z1, wall, WIN.shop);
  // 日よけと看板
  g.box(x0 + 0.2, x0 + bw - 0.2, 2.5, 2.7, z0 - 1.2, z0, sign);
  g.box(x0 + 0.4, x0 + bw - 0.4, 3.1, 3.9, z0 - 0.25, z0, r() < 0.5 ? '#f5f1e6' : sign);
  if (r() < 0.5) g.gable(x0, x0 + bw, z0, z1, h, 1.6, pick(r, ROOFS), wall, 'z', 0.3);
  else g.box(x0, x0 + bw, h, h + 0.7, z0, z0 + 0.25, wall);
}

function konbini(g: B, r: () => number, W: number, D: number): void {
  lotPad(g, W, D, '#5a5d61');
  const band = pick(r, [['#2e9b54', '#f08a24', '#2f6fc1'], ['#e23b3b', '#f5f1e6', '#e23b3b'], ['#2f6fc1', '#f5f1e6', '#2f6fc1']]);
  const x0 = -W / 2 + 1.2, x1 = W / 2 - 1.2, z0 = 7, z1 = D - 1, h = 4.2;
  g.box(x0, x1, 0, h, z0, z1, '#f4f3ee', WIN.shop);
  g.box(x0 - 0.05, x1 + 0.05, 3.0, 3.3, z0 - 0.08, z1 + 0.05, band[0]);
  g.box(x0 - 0.05, x1 + 0.05, 3.3, 3.6, z0 - 0.08, z1 + 0.05, band[1]);
  g.box(x0 - 0.05, x1 + 0.05, 3.6, 3.9, z0 - 0.08, z1 + 0.05, band[2]);
  // 駐車場の白線
  for (let k = 0; k < 5; k++) {
    const x = x0 + 1 + k * 2.6;
    g.box(x, x + 0.12, 0.06, 0.09, 1.2, 5.6, '#f1efe7');
  }
  // 看板の柱
  g.cylinder(x1 - 0.5, 1, 0.15, 0, 5.5, '#c8cccf', 6);
  g.box(x1 - 1.3, x1 + 0.3, 5.5, 7, 0.7, 1.3, band[0], 0, band[1]);
}

function zakkyo(g: B, r: () => number, W: number, D: number, floors: number): void {
  lotPad(g, W, D, CONCRETE);
  const wall = pick(r, ['#c9b9a1', '#b0674e', '#9ea3a6', '#d8d0c2', '#a7998a', '#c2a58a']);
  const bw = W - 0.4, x0 = -bw / 2, z0 = 0.4, z1 = D - 0.6;
  const h = floors * 3.1;
  g.box(x0, x0 + bw, 0, h, z0, z1, wall, r() < 0.5 ? WIN.shop : WIN.apartment);
  // 縦長の袖看板
  const sx = r() < 0.5 ? x0 + 0.3 : x0 + bw - 0.8;
  for (let f = 1; f < floors; f++) g.box(sx, sx + 0.5, f * 3.1, f * 3.1 + 2.9, z0 - 1.1, z0 - 0.1, pick(r, SIGNS));
  // 屋上の塔屋と室外機
  g.box(x0 + 0.5, x0 + 3, h, h + 2.6, z1 - 3.5, z1 - 0.5, wall);
  for (let k = 0; k < 3; k++) g.box(x0 + 3.5 + k * 1.1, x0 + 4.3 + k * 1.1, h, h + 0.8, z1 - 2, z1 - 1.2, '#d8dadb');
}

function office(g: B, r: () => number, W: number, D: number, floors: number): void {
  lotPad(g, W, D, '#c4c0b6');
  const skin = pick(r, ['#8fa9b8', '#9fb0bc', '#c9c6bf', '#7d95a6', '#b7bdc0']);
  const x0 = -W / 2 + 2, x1 = W / 2 - 2, z0 = 4, z1 = D - 2;
  const lower = Math.ceil(floors * range(r, 0.7, 1));
  const h1 = lower * 3.6;
  g.box(x0, x1, 0, 4.2, z0 + 0.6, z1 - 0.6, '#40474d', 0, skin);
  g.box(x0, x1, 4.2, h1, z0, z1, skin, WIN.office);
  if (lower < floors) {
    const ix = (x1 - x0) * 0.15, iz = (z1 - z0) * 0.15;
    g.box(x0 + ix, x1 - ix, h1, floors * 3.6, z0 + iz, z1 - iz, skin, WIN.office);
  }
  const top = floors * 3.6;
  g.box((x0 + x1) / 2 - 3, (x0 + x1) / 2 + 3, top, top + 3, (z0 + z1) / 2 - 2.5, (z0 + z1) / 2 + 2.5, '#9ca3a7');
  // 植栽
  g.box(x0 - 1.5, x0 - 0.3, 0.06, 0.6, 0.8, z0 - 0.5, '#5f9346');
}

function depato(g: B, r: () => number, W: number, D: number, floors: number): void {
  lotPad(g, W, D, '#c4c0b6');
  const wall = pick(r, ['#d8cbb4', '#e2d7c3', '#cbbba0']);
  const x0 = -W / 2 + 1, x1 = W / 2 - 1, z0 = 2, z1 = D - 1;
  const h = floors * 4.2;
  g.box(x0, x1, 0, h, z0, z1, wall, WIN.shop);
  g.box(x0 + 1, x1 - 1, h, h + 0.8, z0, z0 + 0.4, wall);
  const sign = pick(r, SIGNS);
  g.box(-5, 5, h + 0.8, h + 4, z0, z0 + 0.6, sign, 0, '#f5f1e6');
  // 正面のひさし
  g.box(x0 + 2, x1 - 2, 4, 4.3, z0 - 2, z0, '#7b7f82');
}

function machiKoba(g: B, r: () => number, W: number, D: number): void {
  lotPad(g, W, D, CONCRETE);
  const wall = pick(r, ['#8fa3b0', '#a9b3a6', '#b3aa98', '#9aa9a2']);
  const x0 = -W / 2 + 0.8, x1 = W / 2 - 0.8, z0 = 3, z1 = D - 1, h = 4.8;
  g.box(x0, x1, 0, h, z0, z1, wall, WIN.factory);
  g.sawtooth(x0, x1, z0, z1, h, Math.max(2, Math.round((z1 - z0) / 3.5)), 2, '#6d7680', '#9fc3d4', wall);
  g.box(x0 + 0.8, Math.min(x1 - 0.8, x0 + 4.5), 0, 3.6, z0 - 0.1, z0 + 0.05, '#5b6166');
  // 事務所
  if (W > 10) g.box(x1 - 4.5, x1, 0, 3, 0.8, z0, '#ecebe5', WIN.house);
}

function warehouse(g: B, r: () => number, W: number, D: number): void {
  lotPad(g, W, D, '#b3afa5');
  const wall = pick(r, ['#c7ccce', '#d9d2c0', '#b9c3c9']);
  const x0 = -W / 2 + 1, x1 = W / 2 - 1, z0 = 3.5, z1 = D - 1, h = range(r, 7.5, 10);
  g.box(x0, x1, 0, h, z0, z1, wall, WIN.factory);
  g.gable(x0, x1, z0, z1, h, 1.4, '#5c6770', wall, 'z', 0.3);
  const n = Math.max(1, Math.floor((x1 - x0) / 5.5));
  for (let k = 0; k < n; k++) {
    const cx = x0 + ((k + 0.5) * (x1 - x0)) / n;
    g.box(cx - 1.8, cx + 1.8, 0, 4.2, z0 - 0.1, z0 + 0.05, '#6b7277');
  }
  g.box(x0, x1, 1.1, 1.3, z0 - 2, z0, '#9aa1a5');
}

function factory(g: B, r: () => number, W: number, D: number): void {
  lotPad(g, W, D, '#a9a59b');
  const wall = pick(r, ['#b8c2c8', '#c9c4b5', '#aeb9b0']);
  const x0 = -W / 2 + 1.5, x1 = x0 + (W - 3) * 0.72, z0 = 5, z1 = D - 2, h = 10;
  g.box(x0, x1, 0, h, z0, z1, wall, WIN.factory);
  g.gable(x0, x1, z0, z1, h, 2, '#65707a', wall, 'z', 0.4);
  // 紅白の煙突
  const cx = W / 2 - 3, cz = D - 4, ch = range(r, 26, 36);
  const bands = 7;
  for (let k = 0; k < bands; k++) {
    g.cylinder(cx, cz, 1.2 - k * 0.05, (ch * k) / bands, (ch * (k + 1)) / bands, k % 2 ? '#f2f0ea' : '#d2433a', 12);
  }
  // タンク
  g.cylinder(W / 2 - 3.5, 7, 2.6, 0, 6.5, '#e8e8e4', 14, '#d0d2d2');
  if (D > 26) g.cylinder(W / 2 - 3.5, 14, 2.2, 0, 5.5, '#e8e8e4', 14, '#d0d2d2');
  g.box(x0, x0 + 6, 0, 3.2, 1, z0 - 0.5, '#ecebe5', WIN.house);
}

function plant(g: B, r: () => number, W: number, D: number): void {
  lotPad(g, W, D, '#a9a59b');
  const silver = '#d5d8da';
  g.cylinder(-W / 2 + 4, D / 2, 3.4, 0, 8, silver, 16, '#c3c7c9');
  g.cylinder(-W / 2 + 4, D / 2 + 8, 2.6, 0, 7, silver, 16, '#c3c7c9');
  g.cylinder(W / 2 - 4, D / 2 - 4, 1.2, 0, range(r, 20, 28), '#c9cdd0', 10);
  g.cylinder(W / 2 - 7, D / 2 + 4, 0.9, 0, 15, '#c9cdd0', 10);
  // 配管のラック
  g.box(-W / 2 + 2, W / 2 - 2, 4, 4.6, D / 2 - 0.6, D / 2 + 0.6, '#b57b3a');
  for (let x = -W / 2 + 3; x < W / 2 - 2; x += 4) g.box(x, x + 0.3, 0, 4, D / 2 - 0.5, D / 2 + 0.5, '#8a8f93');
  g.box(-W / 2 + 1.5, -W / 2 + 7, 0, 3, 1, 4.5, '#ecebe5', WIN.house);
}

export function buildBuildingGeometry(b: Pick<Building, 'kind' | 'w' | 'd' | 'floors' | 'seed'>): THREE.BufferGeometry {
  const g = new B();
  const r = mulberry32(b.seed);
  const W = b.w * 8, D = b.d * 8;
  const makers: Record<BuildingKind, () => void> = {
    house: () => house(g, r, W, D),
    apartment: () => apartment(g, r, W, D),
    mansion: () => mansion(g, r, W, D, b.floors),
    danchi: () => danchi(g, r, W, D, b.floors),
    shopHouse: () => shopHouse(g, r, W, D, b.floors),
    konbini: () => konbini(g, r, W, D),
    zakkyo: () => zakkyo(g, r, W, D, b.floors),
    office: () => office(g, r, W, D, b.floors),
    depato: () => depato(g, r, W, D, b.floors),
    machiKoba: () => machiKoba(g, r, W, D),
    warehouse: () => warehouse(g, r, W, D),
    factory: () => factory(g, r, W, D),
    plant: () => plant(g, r, W, D),
  };
  makers[b.kind]();
  return g.build();
}

/** 窓をシェーダーで描く建物用マテリアル */
export function buildingMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0 });
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aWin;\nvarying float vWin;\nvarying vec3 vObjPos;\nvarying vec3 vObjN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWin = aWin;\nvObjPos = position;\nvObjN = normal;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vWin;\nvarying vec3 vObjPos;\nvarying vec3 vObjN;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        if (vWin > 0.5 && abs(vObjN.y) < 0.5) {
          float hc = abs(vObjN.x) > 0.5 ? vObjPos.z : vObjPos.x;
          float y = vObjPos.y;
          float fx, fy, win = 0.0;
          int st = int(vWin + 0.5);
          if (st == 1) {
            fy = fract(y / 2.8); fx = fract(hc / 2.6 + 0.25);
            win = step(0.9, y) * step(0.3, fy) * step(fy, 0.72) * step(0.3, fx) * step(fx, 0.7);
          } else if (st == 2) {
            fy = fract(y / 3.0); fx = fract(hc / 2.4);
            win = step(1.0, y) * step(0.3, fy) * step(fy, 0.78) * step(0.15, fx) * step(fx, 0.85);
          } else if (st == 3) {
            fy = fract(y / 3.6); fx = fract(hc / 1.5);
            win = step(0.12, fy) * step(fy, 0.88) * step(0.08, fx) * step(fx, 0.92);
          } else if (st == 4) {
            fy = fract(y / 6.0); fx = fract(hc / 3.0);
            win = step(0.55, fy) * step(fy, 0.8) * step(0.1, fx) * step(fx, 0.9);
          } else if (st == 5) {
            if (y < 2.8) { fx = fract(hc / 3.5); win = step(0.3, y) * step(y, 2.5) * step(0.06, fx) * step(fx, 0.94); }
            else { fy = fract(y / 3.0); fx = fract(hc / 2.4); win = step(0.3, fy) * step(fy, 0.75) * step(0.2, fx) * step(fx, 0.8); }
          }
          vec3 glass = st == 3 ? vec3(0.34, 0.45, 0.56) : vec3(0.24, 0.3, 0.38);
          glass += 0.1 * fract(y / 17.0 + hc / 29.0);
          diffuseColor.rgb = mix(diffuseColor.rgb, pow(glass, vec3(2.2)), win);
        }`,
      );
  };
  return mat;
}
