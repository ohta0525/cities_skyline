import {
  angleBetween, bbox, closestOnCurve, curveIntersections, curveLength, dist2, pointAt, polyline,
  subCurve, tangentAt, type Curve, type P2,
} from './geometry';
import { heightAt, insideMap, waterLevelAt, type Terrain } from '../world/terrain';

export type RoadType = 'alley' | 'local' | 'avenue';

export interface RoadTypeDef {
  name: string;
  /** 全幅（m） */
  width: number;
  sidewalk: number;
  median: number;
}

export const ROAD_TYPES: Record<RoadType, RoadTypeDef> = {
  alley: { name: '路地', width: 5, sidewalk: 0, median: 0 },
  local: { name: '生活道路', width: 10, sidewalk: 1.6, median: 0 },
  avenue: { name: '幹線道路', width: 18, sidewalk: 2.6, median: 1.6 },
};

export interface RoadNode {
  id: number;
  x: number;
  z: number;
  y: number;
}

export interface RoadSegment {
  id: number;
  a: number;
  b: number;
  c: P2;
  type: RoadType;
  /** 路面の高さ。t = k / (ys.length - 1) ごと */
  ys: number[];
  /** その位置が橋か */
  bridge: boolean[];
}

export type Snap =
  | { kind: 'free'; p: P2 }
  | { kind: 'node'; p: P2; id: number }
  | { kind: 'segment'; p: P2; id: number; t: number };

type Stop =
  | { kind: 'node'; id: number; p: P2; y: number; t: number }
  | { kind: 'split'; segId: number; p: P2; y: number; t: number }
  | { kind: 'new'; p: P2; y: number; t: number };

export interface PlannedPiece {
  curve: Curve;
  ys: number[];
  bridge: boolean[];
}

export interface RoadPlan {
  ok: boolean;
  reason?: string;
  type: RoadType;
  curve: Curve;
  length: number;
  stops: Stop[];
  pieces: PlannedPiece[];
  bridgeLength: number;
}

export const MAX_GRADE = 0.16;
const MAX_BRIDGE = 320;
const MAX_FILL = 12;
const MIN_PIECE = 6;
const PROFILE_STEP = 5;

export const halfWidth = (type: RoadType) => ROAD_TYPES[type].width / 2;

/** 高さの列を t で補間する */
export function sampleProfile(arr: number[], t: number): number {
  const n = arr.length - 1;
  const f = Math.min(n, Math.max(0, t * n));
  const i = Math.min(n - 1, Math.floor(f));
  return arr[i] + (arr[i + 1] - arr[i]) * (f - i);
}

export class RoadNetwork {
  nodes = new Map<number, RoadNode>();
  segments = new Map<number, RoadSegment>();
  private nextId = 1;

  constructor(private terrain: Terrain) {}

  setTerrain(t: Terrain): void {
    this.terrain = t;
  }

  curveOf(s: RoadSegment): Curve {
    const a = this.nodes.get(s.a)!, b = this.nodes.get(s.b)!;
    return { p0: { x: a.x, z: a.z }, c: s.c, p2: { x: b.x, z: b.z } };
  }

  segmentsAt(nodeId: number): RoadSegment[] {
    const out: RoadSegment[] = [];
    for (const s of this.segments.values()) if (s.a === nodeId || s.b === nodeId) out.push(s);
    return out;
  }

  /** カーソル位置を既存の交差点・道路に吸着させる */
  snap(p: P2, enabled = true): Snap {
    if (!enabled) return { kind: 'free', p };
    let best: Snap = { kind: 'free', p };
    let bestD = Infinity;
    for (const n of this.nodes.values()) {
      const d = dist2(n, p);
      const r = Math.max(10, ...this.segmentsAt(n.id).map((s) => halfWidth(s.type) + 3));
      if (d < r && d < bestD) { best = { kind: 'node', p: { x: n.x, z: n.z }, id: n.id }; bestD = d; }
    }
    if (best.kind === 'node') return best;
    for (const s of this.segments.values()) {
      const cv = this.curveOf(s);
      const bb = bbox(cv, 20);
      if (p.x < bb.minX || p.x > bb.maxX || p.z < bb.minZ || p.z > bb.maxZ) continue;
      const hit = closestOnCurve(cv, p);
      if (hit.d < halfWidth(s.type) + 3 && hit.d < bestD) {
        best = { kind: 'segment', p: hit.p, id: s.id, t: hit.t };
        bestD = hit.d;
      }
    }
    return best;
  }

  /** 吸着先での道路の向き（角度の吸着に使う） */
  directionAt(s: Snap): P2 | null {
    if (s.kind === 'segment') return tangentAt(this.curveOf(this.segments.get(s.id)!), s.t);
    if (s.kind === 'node') {
      const seg = this.segmentsAt(s.id)[0];
      if (!seg) return null;
      const cv = this.curveOf(seg);
      const tan = tangentAt(cv, seg.a === s.id ? 0 : 1);
      return seg.a === s.id ? { x: -tan.x, z: -tan.z } : tan;
    }
    return null;
  }

  private heightOfSnap(s: Snap): number | null {
    if (s.kind === 'node') return this.nodes.get(s.id)!.y;
    if (s.kind === 'segment') return sampleProfile(this.segments.get(s.id)!.ys, s.t);
    if (waterLevelAt(this.terrain, s.p.x, s.p.z) !== null) return null;
    return heightAt(this.terrain, s.p.x, s.p.z);
  }

  /** 道路を置けるか調べ、置く場合の分割と高さを計算する（まだ何も変えない） */
  plan(start: Snap, end: Snap, control: P2 | null, type: RoadType): RoadPlan {
    const curve: Curve = { p0: start.p, c: control ?? { x: (start.p.x + end.p.x) / 2, z: (start.p.z + end.p.z) / 2 }, p2: end.p };
    const length = curveLength(curve);
    const fail = (reason: string): RoadPlan => ({ ok: false, reason, type, curve, length, stops: [], pieces: [], bridgeLength: 0 });
    if (length < 8) return fail('短すぎます');
    if (start.kind !== 'free' && end.kind !== 'free' && sameTarget(start, end)) return fail('同じ場所どうしはつなげません');
    const pts = polyline(curve, 4);
    if (pts.some((q) => !insideMap(q.p.x, q.p.z))) return fail('地図の外には置けません');
    // 急カーブ
    for (let i = 1; i < pts.length - 1; i++) {
      const d1 = tangentAt(curve, pts[i - 1].t), d2 = tangentAt(curve, pts[i + 1].t);
      if (angleBetween(d1, d2) > 0.6) return fail('カーブが急すぎます');
    }

    const ya = this.heightOfSnap(start), yb = this.heightOfSnap(end);
    // （何もない場所の端の高さは、あとで縦断をならしたときに決まる）
    if (ya === null || yb === null) return fail('水の上で道路を始めたり終えたりはできません');

    const stops: Stop[] = [toStop(start, ya, 0)];
    const hw = halfWidth(type);
    for (const s of this.segments.values()) {
      const cv = this.curveOf(s);
      const b1 = bbox(cv, 30), b2 = bbox(curve, 30);
      if (b1.maxX < b2.minX || b2.maxX < b1.minX || b1.maxZ < b2.minZ || b2.maxZ < b1.minZ) continue;
      for (const hit of curveIntersections(curve, cv)) {
        if (dist2(hit.p, start.p) < 4 || dist2(hit.p, end.p) < 4) continue;
        const angle = angleBetween(tangentAt(curve, hit.ta), tangentAt(cv, hit.tb));
        if (angle < 0.4 || angle > Math.PI - 0.4) return fail('既存の道路との交差角が浅すぎます');
        const na = this.nodes.get(s.a)!, nb = this.nodes.get(s.b)!;
        const near = [na, nb].find((n) => dist2(n, hit.p) < 8);
        if (near) stops.push({ kind: 'node', id: near.id, p: { x: near.x, z: near.z }, y: near.y, t: hit.ta });
        else stops.push({ kind: 'split', segId: s.id, p: hit.p, y: sampleProfile(s.ys, hit.tb), t: hit.ta });
      }
    }
    stops.push(toStop(end, yb, 1));
    stops.sort((p, q) => p.t - q.t);
    for (let i = 1; i < stops.length; i++) {
      if (dist2(stops[i - 1].p, stops[i].p) < MIN_PIECE) return fail('交差点どうしが近すぎます');
    }

    // 既存の道路と平行に重なっていないか
    for (const q of pts) {
      if (stops.some((st) => dist2(st.p, q.p) < 14)) continue;
      for (const s of this.segments.values()) {
        const cv = this.curveOf(s);
        const bb = bbox(cv, 30);
        if (q.p.x < bb.minX || q.p.x > bb.maxX || q.p.z < bb.minZ || q.p.z > bb.maxZ) continue;
        if (closestOnCurve(cv, q.p).d < (hw + halfWidth(s.type)) * 0.9) {
          const ends = [this.nodes.get(s.a)!, this.nodes.get(s.b)!].filter((nd) => this.segmentsAt(nd.id).length === 1);
          if (ends.some((nd) => dist2(nd, q.p) < hw + halfWidth(s.type) + 6)) return fail('道路の行き止まりに近すぎます。端をクリックしてつなげてください');
          return fail('既存の道路と重なっています');
        }
      }
    }

    const pieces: PlannedPiece[] = [];
    let bridgeLength = 0;
    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i], b = stops[i + 1];
      const cv = subCurve(curve, a.t, b.t);
      // 端点は交点・吸着先の正確な位置にそろえる
      cv.p0 = a.p; cv.p2 = b.p;
      // 何もない場所の端は地形をならした高さに任せ、既存の道路につながる端だけ高さを固定する
      const prof = computeProfile(this.terrain, cv, a.kind === 'new' ? null : a.y, b.kind === 'new' ? null : b.y);
      if (a.kind === 'new') a.y = prof.ys[0];
      if (b.kind === 'new') b.y = prof.ys[prof.ys.length - 1];
      if (prof.maxGrade > MAX_GRADE) return fail(`勾配が急すぎます（${Math.round(prof.maxGrade * 100)}%、上限 ${MAX_GRADE * 100}%）`);
      if (prof.maxFill > MAX_FILL) return fail('地形の起伏が大きすぎます（盛り土・切り土が 12 m を超えます）');
      if (prof.longestBridge > MAX_BRIDGE) return fail(`橋が長すぎます（上限 ${MAX_BRIDGE} m）`);
      bridgeLength += prof.bridgeLength;
      pieces.push({ curve: cv, ys: prof.ys, bridge: prof.bridge });
    }
    return { ok: true, type, curve, length, stops, pieces, bridgeLength };
  }

  /** 計画どおりに道路を作る。作った区間の id を返す */
  build(plan: RoadPlan): number[] {
    if (!plan.ok) return [];
    const ids: number[] = [];
    for (const st of plan.stops) {
      if (st.kind === 'node') ids.push(st.id);
      else if (st.kind === 'new') ids.push(this.addNode(st.p, st.y));
      else ids.push(this.splitAtPoint(st.p));
    }
    const created: number[] = [];
    plan.pieces.forEach((pc, i) => {
      const id = this.nextId++;
      this.segments.set(id, { id, a: ids[i], b: ids[i + 1], c: { ...pc.curve.c }, type: plan.type, ys: pc.ys, bridge: pc.bridge });
      created.push(id);
    });
    return created;
  }

  private addNode(p: P2, y: number): number {
    const id = this.nextId++;
    this.nodes.set(id, { id, x: p.x, z: p.z, y });
    return id;
  }

  /** 点に一番近い道路をそこで分割し、できた交差点の id を返す */
  splitAtPoint(p: P2): number {
    let best: { s: RoadSegment; t: number; d: number } | null = null;
    for (const s of this.segments.values()) {
      const hit = closestOnCurve(this.curveOf(s), p);
      if (!best || hit.d < best.d) best = { s, t: hit.t, d: hit.d };
    }
    if (!best) throw new Error('分割する道路がありません');
    const { s, t } = best;
    for (const nid of [s.a, s.b]) {
      const n = this.nodes.get(nid)!;
      if (dist2(n, p) < 1) return nid;
    }
    return this.splitSegment(s.id, t);
  }

  splitSegment(id: number, t: number): number {
    const s = this.segments.get(id)!;
    const cv = this.curveOf(s);
    const mid = pointAt(cv, t);
    const m = this.addNode(mid, sampleProfile(s.ys, t));
    const left = subCurve(cv, 0, t), right = subCurve(cv, t, 1);
    const resample = (t0: number, t1: number, len: number) => {
      const n = Math.max(4, Math.ceil(len / PROFILE_STEP));
      const ys: number[] = [], br: boolean[] = [];
      for (let k = 0; k <= n; k++) {
        const tt = t0 + (t1 - t0) * (k / n);
        ys.push(sampleProfile(s.ys, tt));
        br.push(s.bridge[Math.round(tt * (s.bridge.length - 1))]);
      }
      return { ys, br };
    };
    const l = resample(0, t, curveLength(left)), r = resample(t, 1, curveLength(right));
    this.segments.delete(id);
    const idL = this.nextId++, idR = this.nextId++;
    this.segments.set(idL, { id: idL, a: s.a, b: m, c: left.c, type: s.type, ys: l.ys, bridge: l.br });
    this.segments.set(idR, { id: idR, a: m, b: s.b, c: right.c, type: s.type, ys: r.ys, bridge: r.br });
    return m;
  }

  removeSegment(id: number): void {
    const s = this.segments.get(id);
    if (!s) return;
    this.segments.delete(id);
    for (const nid of [s.a, s.b]) if (!this.segmentsAt(nid).length) this.nodes.delete(nid);
  }

  /** 点のすぐ下にある道路 */
  segmentAt(p: P2): { seg: RoadSegment; t: number; d: number } | null {
    let best: { seg: RoadSegment; t: number; d: number } | null = null;
    for (const s of this.segments.values()) {
      const cv = this.curveOf(s);
      const bb = bbox(cv, 20);
      if (p.x < bb.minX || p.x > bb.maxX || p.z < bb.minZ || p.z > bb.maxZ) continue;
      const hit = closestOnCurve(cv, p);
      if (hit.d <= halfWidth(s.type) + 1 && (!best || hit.d < best.d)) best = { seg: s, t: hit.t, d: hit.d };
    }
    return best;
  }

  toJSON() {
    return {
      nextId: this.nextId,
      nodes: [...this.nodes.values()],
      segments: [...this.segments.values()],
    };
  }

  load(data: { nextId: number; nodes: RoadNode[]; segments: RoadSegment[] }): void {
    this.nodes = new Map(data.nodes.map((n) => [n.id, { ...n }]));
    this.segments = new Map(data.segments.map((s) => [s.id, { ...s, c: { ...s.c }, ys: [...s.ys], bridge: [...s.bridge] }]));
    this.nextId = data.nextId;
  }
}

function sameTarget(a: Snap, b: Snap): boolean {
  if (a.kind === 'node' && b.kind === 'node') return a.id === b.id;
  return dist2(a.p, b.p) < 1;
}

function toStop(s: Snap, y: number, t: number): Stop {
  if (s.kind === 'node') return { kind: 'node', id: s.id, p: s.p, y, t };
  if (s.kind === 'segment') return { kind: 'split', segId: s.id, p: s.p, y, t };
  return { kind: 'new', p: s.p, y, t };
}

/**
 * 道路の縦断（高さの列）。地形をならしてなめらかにし、両端の高さに合わせる。
 * 水の上は橋にして、水面から一定の高さを保つ。
 */
export function computeProfile(t: Terrain, cv: Curve, ya: number | null, yb: number | null) {
  const len = curveLength(cv);
  const n = Math.max(4, Math.ceil(len / PROFILE_STEP));
  const raw: number[] = [], water: (number | null)[] = [];
  for (let k = 0; k <= n; k++) {
    const p = pointAt(cv, k / n);
    const w = waterLevelAt(t, p.x, p.z);
    water.push(w);
    raw.push(heightAt(t, p.x, p.z));
  }
  const bridge = water.map((w) => w !== null);
  // 橋の区間は両岸の高さで結ぶ
  const base = raw.slice();
  for (let k = 0; k <= n; k++) {
    if (!bridge[k]) continue;
    let i0 = k; while (i0 > 0 && bridge[i0]) i0--;
    let i1 = k; while (i1 < n && bridge[i1]) i1++;
    const f = (k - i0) / Math.max(1, i1 - i0);
    base[k] = base[i0] + (base[i1] - base[i0]) * f;
  }
  // なめらかにする
  let sm = base.slice();
  for (let pass = 0; pass < 6; pass++) {
    const next = sm.slice();
    for (let k = 0; k <= n; k++) {
      const a = sm[Math.max(0, k - 1)], b = sm[Math.min(n, k + 1)];
      next[k] = (a + sm[k] * 2 + b) / 4;
    }
    sm = next;
  }
  // 固定する端の高さに合わせる
  const y0 = ya ?? sm[0], y1 = yb ?? sm[n];
  const ys = sm.map((h, k) => h + (y0 - sm[0]) * (1 - k / n) + (y1 - sm[n]) * (k / n));
  ys[0] = y0; ys[n] = y1;
  // 橋は水面から 4 m 以上
  for (let k = 0; k <= n; k++) {
    const w = water[k];
    if (w !== null) ys[k] = Math.max(ys[k], w + 4);
  }
  const step = len / n;
  // 橋へ上がる取り付け部分を、勾配の上限より少し緩いスロープにする
  const lim = MAX_GRADE * 0.85 * step;
  for (let pass = 0; pass < 3; pass++) {
    for (let k = 1; k < n; k++) ys[k] = Math.max(ys[k], ys[k - 1] - lim);
    for (let k = n - 1; k > 0; k--) ys[k] = Math.max(ys[k], ys[k + 1] - lim);
  }
  let maxGrade = 0, longestBridge = 0, run = 0, bridgeLength = 0;
  let maxFill = 0;
  for (let k = 0; k < n; k++) maxGrade = Math.max(maxGrade, Math.abs(ys[k + 1] - ys[k]) / step);
  for (let k = 0; k <= n; k++) if (!bridge[k]) maxFill = Math.max(maxFill, Math.abs(ys[k] - raw[k]));
  for (let k = 0; k <= n; k++) {
    if (bridge[k]) { run += step; bridgeLength += step; longestBridge = Math.max(longestBridge, run); } else run = 0;
  }
  return { ys, bridge, maxGrade, maxFill, longestBridge, bridgeLength };
}
