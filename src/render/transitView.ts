import * as THREE from 'three';
import type { City } from '../city/city';
import { arcTable, curveLength, leftNormal, pointAt, tAtLength, tangentAt, type P2 } from '../city/geometry';
import { halfWidth, sampleProfile } from '../city/roads';
import { MODES, stationDirection, trackCurve, trackFor, type Line, type Stop } from '../city/transit';
import { heightAt } from '../world/terrain';

/** 頂点を積む入れ物（向きは out で決める） */
class G {
  pos: number[] = []; nrm: number[] = []; col: number[] = [];
  private c = new THREE.Color();
  quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, color: string, out: THREE.Vector3): void {
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    const pts = n.dot(out) < 0 ? [a, c, b, a, d, c] : [a, b, c, a, c, d];
    n.normalize();
    if (n.dot(out) < 0) n.negate();
    this.c.set(color);
    for (const p of pts) { this.pos.push(p.x, p.y, p.z); this.nrm.push(n.x, n.y, n.z); this.col.push(this.c.r, this.c.g, this.c.b); }
  }
  /** 向きのついた箱（中心 p、軸 u は長さ方向） */
  box(p: THREE.Vector3, u: THREE.Vector3, len: number, width: number, h0: number, h1: number, color: string, top?: string): void {
    const v = new THREE.Vector3(-u.z, 0, u.x);
    const c = (su: number, sv: number, y: number) => p.clone().addScaledVector(u, su * len / 2).addScaledVector(v, sv * width / 2).setY(p.y + y);
    const up = new THREE.Vector3(0, 1, 0);
    this.quad(c(-1, -1, h1), c(1, -1, h1), c(1, 1, h1), c(-1, 1, h1), top ?? color, up);
    this.quad(c(-1, -1, h0), c(1, -1, h0), c(1, -1, h1), c(-1, -1, h1), color, v.clone().negate());
    this.quad(c(-1, 1, h0), c(1, 1, h0), c(1, 1, h1), c(-1, 1, h1), color, v);
    this.quad(c(-1, -1, h0), c(-1, 1, h0), c(-1, 1, h1), c(-1, -1, h1), color, u.clone().negate());
    this.quad(c(1, -1, h0), c(1, 1, h0), c(1, 1, h1), c(1, -1, h1), color, u);
  }
  mesh(mat: THREE.Material): THREE.Mesh {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    const m = new THREE.Mesh(g, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  }
}

const up = new THREE.Vector3(0, 1, 0);

/** 線路・駅・停留所・踏切 */
export function buildTransitStatic(city: City, mat: THREE.Material): THREE.Group {
  const group = new THREE.Group();
  const g = new G();
  const t = city.transit;
  // 線路
  for (const tr of t.tracks.values()) {
    if (tr.level === 'under') continue;
    const cv = trackCurve(t, tr);
    const len = curveLength(cv);
    const n = Math.max(2, Math.ceil(len / 3));
    const elevated = tr.level === 'elevated';
    let lastPillar = -99;
    for (let k = 0; k < n; k++) {
      const t0 = k / n, t1 = (k + 1) / n;
      const p0 = pointAt(cv, t0), p1 = pointAt(cv, t1);
      const y0 = sampleProfile(tr.ys, t0), y1 = sampleProfile(tr.ys, t1);
      const u = new THREE.Vector3(p1.x - p0.x, 0, p1.z - p0.z).normalize();
      const mid = new THREE.Vector3((p0.x + p1.x) / 2, (y0 + y1) / 2, (p0.z + p1.z) / 2);
      const seg = Math.hypot(p1.x - p0.x, p1.z - p0.z) + 0.05;
      const bridged = elevated || tr.bridge[Math.round(t0 * (tr.bridge.length - 1))];
      if (bridged) {
        g.box(mid, u, seg, 10, -1.6, 0.1, '#b9b4aa', '#9a948a');
        g.box(mid.clone().addScaledVector(new THREE.Vector3(-u.z, 0, u.x), 4.8), u, seg, 0.3, 0.1, 1.3, '#cfcac0');
        g.box(mid.clone().addScaledVector(new THREE.Vector3(-u.z, 0, u.x), -4.8), u, seg, 0.3, 0.1, 1.3, '#cfcac0');
        const s = k * (len / n);
        if (s - lastPillar > 22) {
          lastPillar = s;
          const ground = Math.min(heightAt(city.terrain, mid.x, mid.z), mid.y - 2);
          g.box(new THREE.Vector3(mid.x, ground, mid.z), u, 1.6, 6.5, 0, mid.y - 1.6 - ground, '#a9a499');
        }
      } else {
        g.box(mid, u, seg, 9, -0.6, 0.2, '#8b8174', '#8b8174');
      }
      // 複線のレール
      for (const off of [-2.1, 2.1]) {
        for (const r of [-0.72, 0.72]) {
          const c = mid.clone().addScaledVector(new THREE.Vector3(-u.z, 0, u.x), off + r);
          g.box(c, u, seg, 0.14, 0.2, 0.38, '#8e949a', '#c9ced3');
        }
        g.box(mid.clone().addScaledVector(new THREE.Vector3(-u.z, 0, u.x), off), u, 0.5, 2.4, 0.15, 0.24, '#6b5a48');
      }
    }
  }
  // 駅
  for (const st of t.stops.values()) {
    if (st.mode === 'rail') stationGeometry(g, city, st);
    else if (st.mode === 'subway') subwayEntrance(g, city, st);
    else busStop(g, city, st);
  }
  // 踏切
  for (const c of city.crossings) {
    const tr = t.tracks.get(c.track);
    const seg = city.net.segments.get(c.seg);
    if (!tr || !seg) continue;
    const cv = trackCurve(t, tr);
    const tan = tangentAt(cv, 0.5);
    const u = new THREE.Vector3(tan.x, 0, tan.z);
    const hw = halfWidth(seg.type);
    const y = heightAt(city.terrain, c.x, c.z);
    for (const side of [-1, 1]) {
      for (const lat of [-1, 1]) {
        const base = new THREE.Vector3(c.x, y, c.z).addScaledVector(u, side * 6.5).addScaledVector(new THREE.Vector3(-u.z, 0, u.x), lat * (hw + 0.6));
        for (let k = 0; k < 5; k++) g.box(base.clone().setY(y + k * 0.7), u, 0.25, 0.25, 0, 0.7, k % 2 ? '#1b1b1b' : '#f2c230');
        g.box(base.clone().setY(y + 3.3), new THREE.Vector3(-u.z, 0, u.x), 0.9, 0.2, 0, 0.3, '#d8322a');
        g.box(base.clone().setY(y + 2.6), new THREE.Vector3(-u.z, 0, u.x).multiplyScalar(-lat), 0.25, 0.9, 0, 0.5, '#f5f5f0');
      }
    }
  }
  // 路面電車のレール（道路の中央）
  for (const l of t.lines.values()) {
    if (l.mode !== 'tram' || l.broken) continue;
    const half = Math.floor(l.path.length / 2) + 1;
    for (let i = 0; i < Math.min(half, l.path.length - 1); i++) {
      const a = l.path[i], b = l.path[i + 1];
      const u = new THREE.Vector3(b.x - a.x, 0, b.z - a.z);
      const segLen = u.length();
      if (segLen < 0.1) continue;
      u.normalize();
      const y = pathY(city, { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 });
      const mid = new THREE.Vector3((a.x + b.x) / 2, y, (a.z + b.z) / 2);
      for (const r of [-0.72, 0.72]) g.box(mid.clone().addScaledVector(new THREE.Vector3(-u.z, 0, u.x), r), u, segLen + 0.05, 0.12, 0.12, 0.2, '#9aa0a6', '#c9ced3');
    }
  }
  group.add(g.mesh(mat));
  return group;
}

function stationGeometry(g: G, city: City, st: Stop): void {
  const dir = stationDirection(city.transit, st);
  const u = new THREE.Vector3(dir.x, 0, dir.z);
  const v = new THREE.Vector3(-u.z, 0, u.x);
  const elevated = st.level === 'elevated';
  const y = elevated ? st.y : Math.max(0, heightAt(city.terrain, st.x, st.z));
  const c = new THREE.Vector3(st.x, y, st.z);
  if (elevated) {
    g.box(c, u, 76, 20, -1.8, 0.1, '#b9b4aa');
    for (let k = -3; k <= 3; k++) {
      const p = c.clone().addScaledVector(u, k * 11);
      const ground = heightAt(city.terrain, p.x, p.z);
      g.box(new THREE.Vector3(p.x, ground, p.z), u, 1.8, 12, 0, y - 1.8 - ground, '#a9a499');
    }
  }
  for (const side of [-1, 1]) {
    const pc = c.clone().addScaledVector(v, side * 6.2);
    g.box(pc, u, 70, 3.2, 0, 1.1, '#cfc9bd', '#e6e0d3');
    g.box(pc.clone().addScaledVector(v, side * -1.3), u, 70, 0.3, 1.1, 1.12, '#f2c230');
    for (let k = -3; k <= 3; k++) g.box(pc.clone().addScaledVector(u, k * 9), u, 0.25, 0.25, 1.1, 4.2, '#8e969c');
    g.box(pc, u, 64, 3.8, 4.2, 4.5, '#6f7b85', '#7c8993');
  }
  // 駅舎
  const bc = c.clone().addScaledVector(v, 13).setY(Math.max(0, heightAt(city.terrain, st.x + v.x * 13, st.z + v.z * 13)));
  g.box(bc, u, 16, 8, 0, 6, '#e8e2d4', '#8a8f93');
  g.box(bc.clone().addScaledVector(v, 4.1), u, 10, 0.2, 4.2, 5.4, '#2d6fb7');
}

function subwayEntrance(g: G, city: City, st: Stop): void {
  const dir = stationDirection(city.transit, st);
  const u = new THREE.Vector3(dir.x, 0, dir.z);
  const v = new THREE.Vector3(-u.z, 0, u.x);
  for (const side of [-1, 1]) {
    const p = new THREE.Vector3(st.x, 0, st.z).addScaledVector(v, side * 9).addScaledVector(u, side * 12);
    p.y = Math.max(0, heightAt(city.terrain, p.x, p.z));
    g.box(p, u, 5, 2.8, 0, 2.6, '#9fb3c1', '#6b7a86');
    g.box(p.clone().addScaledVector(u, 2.7), u, 0.2, 1.2, 1.8, 2.8, '#1f8fd6');
  }
}

function busStop(g: G, city: City, st: Stop): void {
  const seg = st.seg !== undefined ? city.net.segments.get(st.seg) : undefined;
  if (!seg) return;
  const cv = city.net.curveOf(seg);
  const tan = tangentAt(cv, st.t ?? 0.5), n = leftNormal(tan);
  const u = new THREE.Vector3(tan.x, 0, tan.z);
  const off = halfWidth(seg.type) - 0.6;
  const y = sampleProfile(seg.ys, st.t ?? 0.5) + 0.27;
  for (const side of [1, -1]) {
    const p = new THREE.Vector3(st.x + n.x * off * side, y, st.z + n.z * off * side);
    if (st.mode === 'bus') {
      g.box(p, u, 0.12, 0.12, 0, 2.4, '#8e969c');
      g.box(p.clone().setY(y + 2.1), u, 0.1, 0.7, 0, 0.6, MODES.bus.colors[0], '#f5f5f0');
      g.box(p.clone().addScaledVector(u, 2), u, 2.4, 1.2, 0, 2.3, '#bcd3e0', '#6f7b85');
    } else {
      g.box(p.clone().addScaledVector(new THREE.Vector3(n.x, 0, n.z), -side * 0.9), u, 14, 1.6, 0, 0.3, '#d6d0c2');
      g.box(p, u, 0.14, 0.14, 0, 2.6, '#8e969c');
      g.box(p.clone().setY(y + 2.3), u, 0.1, 0.9, 0, 0.5, MODES.tram.colors[0]);
    }
  }
}

/** 道路の上の点の高さ */
export function pathY(city: City, p: P2): number {
  const s = city.net.segmentAt(p);
  if (s) return sampleProfile(s.seg.ys, s.t) + 0.15;
  return Math.max(0, heightAt(city.terrain, p.x, p.z));
}

// ---------- 走る乗り物 ----------

interface LaneSamples { pts: Float32Array; len: number; step: number }

/** 道路を走る車（左側通行）と、路線を走るバス・電車 */
export class Vehicles {
  readonly group = new THREE.Group();
  private cars: THREE.InstancedMesh;
  private carData: { lane: LaneSamples; s: number; speed: number }[] = [];
  private transit = new THREE.Group();
  private transitData: { mesh: THREE.Mesh; path: LaneSamples; s: number; speed: number; cars: number; carLen: number }[] = [];
  private tmp = new THREE.Object3D();
  static readonly MAX_CARS = 3000;

  constructor(private mat: THREE.Material) {
    const body = new THREE.BoxGeometry(1.8, 1.1, 4.2).translate(0, 0.75, 0);
    const cabin = new THREE.BoxGeometry(1.6, 0.7, 2.2).translate(0, 1.6, -0.3);
    const geo = mergeBoxes([body, cabin], ['#ffffff', '#cfd8e0']);
    this.cars = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.2 }), Vehicles.MAX_CARS);
    this.cars.count = 0;
    this.cars.castShadow = true;
    this.cars.frustumCulled = false;
    this.group.add(this.cars, this.transit);
  }

  /** 交通量に合わせて車を配り直す */
  syncCars(city: City): void {
    this.carData = [];
    const colors = ['#f1f1ee', '#2a2d31', '#b8322c', '#c7ccd1', '#2f5fa8', '#e7dfc9', '#4f6b4a'];
    const c = new THREE.Color();
    let count = 0;
    for (const s of city.net.segments.values()) {
      const vol = city.traffic.volume.get(s.id) ?? 0;
      if (vol < 1) continue;
      const cv = city.net.curveOf(s);
      const len = curveLength(cv);
      const speed = ((city.traffic.speed.get(s.id) ?? 30) / 3.6) * 0.9;
      const hw = halfWidth(s.type);
      const lanes = s.type === 'avenue' ? [2.2, 5.2] : s.type === 'local' ? [1.8] : [0.9];
      const ow = s.oneway ?? 0;
      const dirs = ow === 0 ? [1, -1] : [ow];
      // 1 時間の交通量から、道路の上にいる車の台数の目安
      const density = Math.min(1 / 7, (vol / dirs.length / lanes.length) / (speed * 3600) * 1.2 + 0.004);
      for (const d of dirs) {
        for (const off of lanes) {
          const laneOff = ow !== 0 ? off - hw / 2 : off;
          const lane = sampleLane(city, s, cv, len, d as 1 | -1, laneOff);
          const n = Math.floor(len * density);
          for (let k = 0; k < n && count < Vehicles.MAX_CARS; k++) {
            this.carData.push({ lane, s: (len * (k + Math.random() * 0.5)) / Math.max(1, n), speed: speed * (0.85 + Math.random() * 0.3) });
            this.cars.setColorAt(count, c.set(colors[Math.floor(Math.random() * colors.length)]));
            count++;
          }
        }
      }
    }
    this.cars.count = count;
    if (this.cars.instanceColor) this.cars.instanceColor.needsUpdate = true;
  }

  /** 路線ごとの車両 */
  syncTransit(city: City): void {
    for (const m of [...this.transit.children] as THREE.Mesh[]) { this.transit.remove(m); m.geometry.dispose(); }
    this.transitData = [];
    for (const l of city.transit.lines.values()) {
      if (l.broken || l.mode === 'subway' || l.path.length < 2) continue;
      const path = linePath(city, l);
      const def = MODES[l.mode];
      const cars = l.mode === 'rail' ? 4 : 1;
      const carLen = l.mode === 'rail' ? 20 : l.mode === 'tram' ? 14 : 10;
      for (let k = 0; k < l.vehicles; k++) {
        const g = l.mode === 'rail' ? trainGeometry(l.color, cars) : l.mode === 'tram' ? tramGeometry(l.color) : busGeometry(l.color);
        const m = new THREE.Mesh(g, this.mat);
        m.castShadow = true;
        this.transit.add(m);
        this.transitData.push({ mesh: m, path, s: (path.len * k) / l.vehicles, speed: (def.speed / 3.6) * 1.1, cars, carLen });
      }
    }
  }

  update(dt: number): void {
    const t = this.tmp;
    for (let i = 0; i < this.carData.length; i++) {
      const d = this.carData[i];
      d.s = (d.s + d.speed * dt) % d.lane.len;
      placeOn(d.lane, d.s, t);
      t.updateMatrix();
      this.cars.setMatrixAt(i, t.matrix);
    }
    if (this.carData.length) this.cars.instanceMatrix.needsUpdate = true;
    for (const v of this.transitData) {
      v.s = (v.s + v.speed * dt) % v.path.len;
      placeOn(v.path, v.s, v.mesh);
    }
  }
}

function sampleLane(city: City, s: import('../city/roads').RoadSegment, cv: import('../city/geometry').Curve, len: number, dir: 1 | -1, off: number): LaneSamples {
  const step = 2;
  const n = Math.max(2, Math.ceil(len / step));
  const pts = new Float32Array((n + 1) * 3);
  const table = arcTable(cv, 48);
  for (let k = 0; k <= n; k++) {
    const sa = dir === 1 ? (k / n) * len : len - (k / n) * len;
    const t = tAtLength(table, sa);
    const p = pointAt(cv, t), tan = tangentAt(cv, t), nr = leftNormal(tan);
    // 左側通行：進む向きの左に寄る
    const sx = dir === 1 ? 1 : -1;
    pts[k * 3] = p.x + nr.x * off * sx;
    pts[k * 3 + 1] = sampleProfile(s.ys, t) + 0.14;
    pts[k * 3 + 2] = p.z + nr.z * off * sx;
  }
  void city;
  return { pts, len, step: len / n };
}

/** 路線の道のりを、高さつきの点列にする */
function linePath(city: City, l: Line): LaneSamples {
  const P: number[] = [];
  const stops = l.stops.map((id) => city.transit.stops.get(id)!);
  if (l.mode === 'rail') {
    const order = [...stops, ...stops.slice(0, -1).reverse()];
    for (let i = 0; i < order.length - 1; i++) {
      const a = order[i], b = order[i + 1];
      const tr = trackFor(city.transit, a.id, b.id);
      const cv = tr ? trackCurve(city.transit, tr) : null;
      const n = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 4));
      for (let k = i ? 1 : 0; k <= n; k++) {
        const f = k / n;
        const tt = tr && tr.a === a.id ? f : 1 - f;
        const y = tr ? sampleProfile(tr.ys, tt) + 0.4 : 0;
        const x = a.x + (b.x - a.x) * f, z = a.z + (b.z - a.z) * f;
        // 行きと帰りで線路を分ける（左側）
        const u = { x: b.x - a.x, z: b.z - a.z };
        const ul = Math.hypot(u.x, u.z) || 1;
        P.push(x + (u.z / ul) * 2.1, y, z - (u.x / ul) * 2.1);
        void cv;
      }
    }
  } else {
    for (const p of l.path) P.push(p.x, pathY(city, p), p.z);
  }
  const pts = new Float32Array(P);
  // 点の間隔をそろえる
  const out: number[] = [];
  let len = 0;
  const cum: number[] = [0];
  for (let i = 1; i < pts.length / 3; i++) {
    len += Math.hypot(pts[i * 3] - pts[i * 3 - 3], pts[i * 3 + 2] - pts[i * 3 - 1]);
    cum.push(len);
  }
  const step = 2;
  const n = Math.max(2, Math.ceil(len / step));
  let j = 0;
  for (let k = 0; k <= n; k++) {
    const s = (k / n) * len;
    while (j < cum.length - 2 && cum[j + 1] < s) j++;
    const f = (s - cum[j]) / Math.max(1e-6, cum[j + 1] - cum[j]);
    for (let c = 0; c < 3; c++) out.push(pts[j * 3 + c] + (pts[(j + 1) * 3 + c] - pts[j * 3 + c]) * f);
  }
  return { pts: new Float32Array(out), len: Math.max(1, len), step: len / n };
}

function placeOn(l: LaneSamples, s: number, o: THREE.Object3D): void {
  const f = s / l.step;
  const n = l.pts.length / 3 - 1;
  const i = Math.min(n - 1, Math.max(0, Math.floor(f)));
  const r = Math.min(1, Math.max(0, f - i));
  const x = l.pts[i * 3] + (l.pts[i * 3 + 3] - l.pts[i * 3]) * r;
  const y = l.pts[i * 3 + 1] + (l.pts[i * 3 + 4] - l.pts[i * 3 + 1]) * r;
  const z = l.pts[i * 3 + 2] + (l.pts[i * 3 + 5] - l.pts[i * 3 + 2]) * r;
  o.position.set(x, y, z);
  const dx = l.pts[i * 3 + 3] - l.pts[i * 3], dz = l.pts[i * 3 + 5] - l.pts[i * 3 + 2];
  if (dx || dz) o.rotation.set(0, Math.atan2(dx, dz), 0);
}

function mergeBoxes(geos: THREE.BufferGeometry[], colors: string[]): THREE.BufferGeometry {
  const pos: number[] = [], nrm: number[] = [], col: number[] = [];
  const c = new THREE.Color();
  geos.forEach((g0, i) => {
    const g = g0.toNonIndexed();
    const p = g.getAttribute('position'), n = g.getAttribute('normal');
    c.set(colors[i]);
    for (let k = 0; k < p.count; k++) {
      pos.push(p.getX(k), p.getY(k), p.getZ(k));
      nrm.push(n.getX(k), n.getY(k), n.getZ(k));
      col.push(c.r, c.g, c.b);
    }
  });
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return out;
}

function busGeometry(color: string): THREE.BufferGeometry {
  return mergeBoxes([
    new THREE.BoxGeometry(2.4, 2.4, 10).translate(0, 1.6, 0),
    new THREE.BoxGeometry(2.45, 0.9, 9.4).translate(0, 2.1, 0),
    new THREE.BoxGeometry(2.46, 0.35, 10.02).translate(0, 0.9, 0),
  ], ['#f3f1ea', '#3a4a58', color]);
}

function tramGeometry(color: string): THREE.BufferGeometry {
  return mergeBoxes([
    new THREE.BoxGeometry(2.4, 2.6, 14).translate(0, 1.7, 0),
    new THREE.BoxGeometry(2.45, 0.9, 13.2).translate(0, 2.2, 0),
    new THREE.BoxGeometry(2.46, 1, 14.02).translate(0, 0.9, 0),
    new THREE.BoxGeometry(0.2, 1, 0.2).translate(0, 3.4, 0),
  ], ['#efe9d8', '#3a4a58', color, '#2a2a2a']);
}

function trainGeometry(color: string, cars: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [], cols: string[] = [];
  for (let k = 0; k < cars; k++) {
    const z = -k * 20.5;
    parts.push(new THREE.BoxGeometry(2.9, 3.2, 19.5).translate(0, 2.0, z)); cols.push('#dfe3e6');
    parts.push(new THREE.BoxGeometry(2.95, 0.5, 19.52).translate(0, 1.9, z)); cols.push(color);
    parts.push(new THREE.BoxGeometry(2.96, 0.8, 18).translate(0, 2.8, z)); cols.push('#3a4a58');
  }
  return mergeBoxes(parts, cols);
}

export { up };
