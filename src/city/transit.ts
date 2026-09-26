import { smoothstep } from '../core/noise';
import { heightAt, insideMap, waterLevelAt, type Terrain } from '../world/terrain';
import type { Building } from './buildings';
import { closestOnCurve, curveIntersections, curveLength, dist2, pointAt, straight, type Curve, type P2 } from './geometry';
import { buildGraph, dijkstra, pathTo, polylineLength, segmentPoints } from './graph';
import type { RoadNetwork } from './roads';

export type TransitMode = 'bus' | 'tram' | 'rail' | 'subway';
export type TrackLevel = 'ground' | 'elevated' | 'under';

export interface ModeDef {
  name: string;
  stopName: string;
  /** 歩いて使う範囲（m） */
  radius: number;
  /** 1 両（1 編成）の定員 */
  capacity: number;
  /** 表定速度（km/h） */
  speed: number;
  /** 車両 1 台（1 編成）の月の費用（万円） */
  vehicleUpkeep: number;
  stopCost: number;
  stopUpkeep: number;
  /** 線路 1 m あたりの建設費（万円） */
  trackCost: number;
  elevatedCost?: number;
  /** 使う人の割合の上限の目安 */
  share: number;
  fare: number;
  vehicles: number;
  colors: string[];
}

export const MODES: Record<TransitMode, ModeDef> = {
  bus: { name: 'バス', stopName: '停留所', radius: 320, capacity: 60, speed: 20, vehicleUpkeep: 25, stopCost: 50, stopUpkeep: 1, trackCost: 0, share: 0.3, fare: 210, vehicles: 4, colors: ['#2f8f4e', '#2f6fc1', '#e08a1e', '#8c55b8'] },
  tram: { name: '路面電車', stopName: '電停', radius: 360, capacity: 120, speed: 16, vehicleUpkeep: 60, stopCost: 300, stopUpkeep: 3, trackCost: 6, share: 0.4, fare: 180, vehicles: 4, colors: ['#e2a23b', '#3fa7a0', '#c9533f'] },
  rail: { name: '鉄道', stopName: '駅', radius: 650, capacity: 900, speed: 55, vehicleUpkeep: 300, stopCost: 30_000, stopUpkeep: 60, trackCost: 15, elevatedCost: 45, share: 0.6, fare: 240, vehicles: 3, colors: ['#d23c3c', '#2d6fb7', '#e3a019', '#3e9a57', '#8a4fb0'] },
  subway: { name: '地下鉄', stopName: '駅', radius: 600, capacity: 800, speed: 40, vehicleUpkeep: 350, stopCost: 80_000, stopUpkeep: 120, trackCost: 80, share: 0.6, fare: 210, vehicles: 3, colors: ['#1f8fd6', '#c2479b', '#f08a24', '#6e9c2e'] },
};

export interface Stop {
  id: number;
  mode: TransitMode;
  x: number;
  z: number;
  y: number;
  name: string;
  /** バス・路面電車：止まる道路と位置 */
  seg?: number;
  t?: number;
  level?: TrackLevel;
}

export interface Track {
  id: number;
  a: number;
  b: number;
  mode: 'rail' | 'subway';
  level: TrackLevel;
  ys: number[];
  bridge: boolean[];
}

export interface Line {
  id: number;
  mode: TransitMode;
  name: string;
  /** 駅ナンバリングの記号（例：M） */
  code: string;
  color: string;
  stops: number[];
  vehicles: number;
  fare: number;
  operator: 'city' | 'private';
  /** 車両が走る道のり（行きと帰り） */
  path: P2[];
  pathLen: number;
  broken: boolean;
  riders: number;
  income: number;
  cost: number;
}

export interface TransitState {
  stops: Map<number, Stop>;
  tracks: Map<number, Track>;
  lines: Map<number, Line>;
  nextId: number;
}

export const newTransit = (): TransitState => ({ stops: new Map(), tracks: new Map(), lines: new Map(), nextId: 1 });

export function trackCurve(t: TransitState, tr: Track): Curve {
  const a = t.stops.get(tr.a)!, b = t.stops.get(tr.b)!;
  return straight({ x: a.x, z: a.z }, { x: b.x, z: b.z });
}

export function trackFor(t: TransitState, a: number, b: number): Track | undefined {
  for (const tr of t.tracks.values()) if ((tr.a === a && tr.b === b) || (tr.a === b && tr.b === a)) return tr;
  return undefined;
}

/** 線路の高さ（縦断）。地上は勾配 4％まで、高架は地面から 9 m、地下は 18 m 下 */
export function trackProfile(terrain: Terrain, cv: Curve, level: TrackLevel): { ok: boolean; reason?: string; ys: number[]; bridge: boolean[]; length: number } {
  const len = curveLength(cv);
  const n = Math.max(4, Math.ceil(len / 8));
  const raw: number[] = [], bridge: boolean[] = [];
  let sea = false;
  for (let k = 0; k <= n; k++) {
    const p = pointAt(cv, k / n);
    const w = waterLevelAt(terrain, p.x, p.z);
    const h = heightAt(terrain, p.x, p.z);
    if (h < -1 && level !== 'under') sea = true;
    bridge.push(w !== null);
    raw.push(w !== null ? w + (level === 'elevated' ? 9 : 5) : h);
  }
  if (sea) return { ok: false, reason: '海の上には線路を通せません', ys: [], bridge, length: len };
  let ys = raw.slice();
  for (let pass = 0; pass < 8; pass++) {
    const next = ys.slice();
    for (let k = 1; k < n; k++) next[k] = (ys[k - 1] + ys[k] * 2 + ys[k + 1]) / 4;
    ys = next;
  }
  const step = len / n;
  // 勾配を上限（地上 3.5％、高架 4％）に収める。足りない分は切り土・盛り土にする
  if (level !== 'under') {
    const lim = (level === 'elevated' ? 0.04 : 0.035) * step;
    for (let pass = 0; pass < 4; pass++) {
      for (let k = 1; k <= n; k++) ys[k] = Math.min(Math.max(ys[k], ys[k - 1] - lim), ys[k - 1] + lim);
      for (let k = n - 1; k >= 0; k--) ys[k] = Math.min(Math.max(ys[k], ys[k + 1] - lim), ys[k + 1] + lim);
    }
  }
  if (level === 'elevated') ys = ys.map((y) => y + 9);
  if (level === 'under') ys = ys.map((y, k) => Math.min(y, raw[k]) - 18);
  let maxGrade = 0, maxFill = 0;
  for (let k = 0; k < n; k++) maxGrade = Math.max(maxGrade, Math.abs(ys[k + 1] - ys[k]) / step);
  for (let k = 0; k <= n; k++) if (!bridge[k]) maxFill = Math.max(maxFill, Math.abs(ys[k] - raw[k]) - (level === 'elevated' ? 9 : level === 'under' ? 18 : 0));
  if (level === 'ground' && maxGrade > 0.036) return { ok: false, reason: `線路の勾配が急すぎます（${(maxGrade * 100).toFixed(1)}％、上限 4％）。高架にすると通せる場合があります`, ys, bridge, length: len };
  if (level === 'ground' && maxFill > 14) return { ok: false, reason: '起伏が大きすぎて線路を通せません（切り土・盛り土が 14 m を超えます）。高架か地下鉄にしてください', ys, bridge, length: len };
  if (level === 'elevated' && maxFill > 25) return { ok: false, reason: '起伏が大きすぎて高架を通せません。地下鉄にしてください', ys, bridge, length: len };
  return { ok: true, ys, bridge: bridge.map((b, k) => b || (level === 'ground' && ys[k] - raw[k] > 6)), length: len };
}

/** 線路の建設費 */
export function trackCost(mode: 'rail' | 'subway', level: TrackLevel, length: number): number {
  const def = MODES[mode];
  const per = level === 'elevated' ? def.elevatedCost ?? def.trackCost * 3 : def.trackCost;
  return Math.round(per * length);
}

/** バス・路面電車の道のり。道路網で停留所を順に結ぶ（行きと帰り） */
export function roadPath(net: RoadNetwork, stops: Stop[], tram: boolean): { path: P2[]; ok: boolean } {
  const g = buildGraph(net, (s) => !tram || s.type !== 'alley');
  const leg = (a: Stop, b: Stop): P2[] | null => {
    const sa = net.segments.get(a.seg!), sb = net.segments.get(b.seg!);
    if (!sa || !sb) return null;
    if (sa.id === sb.id) return segmentPoints(net, sa, a.t!, b.t!);
    const la = g.length.get(sa.id)!, lb = g.length.get(sb.id)!;
    const ow = (sa.oneway ?? 0);
    const sources = new Map<number, number>();
    if (ow >= 0) sources.set(sa.b, (1 - a.t!) * la);
    if (ow <= 0) sources.set(sa.a, a.t! * la);
    const tree = dijkstra(g, sources, (e) => e.len);
    let best: { node: number; cost: number; tEnter: number } | null = null;
    const owb = sb.oneway ?? 0;
    for (const [node, tEnter] of [[sb.a, 0], [sb.b, 1]] as const) {
      if ((tEnter === 0 && owb < 0) || (tEnter === 1 && owb > 0)) continue;
      const d = tree.dist.get(node);
      if (d === undefined) continue;
      const cost = d + Math.abs(b.t! - tEnter) * lb;
      if (!best || cost < best.cost) best = { node, cost, tEnter };
    }
    if (!best) return null;
    const edges = pathTo(tree, best.node)!;
    const startNode = edges.length ? edges[0].from : best.node;
    const pts: P2[] = [...segmentPoints(net, sa, a.t!, startNode === sa.a ? 0 : 1)];
    for (const e of edges) {
      const s = net.segments.get(e.seg)!;
      pts.push(...segmentPoints(net, s, e.dir === 1 ? 0 : 1, e.dir === 1 ? 1 : 0).slice(1));
    }
    pts.push(...segmentPoints(net, sb, best.tEnter, b.t!).slice(1));
    return pts;
  };
  const out: P2[] = [];
  const order = [...stops, ...stops.slice(0, -1).reverse()];
  for (let i = 0; i < order.length - 1; i++) {
    const pts = leg(order[i], order[i + 1]);
    if (!pts) return { path: out, ok: false };
    out.push(...(out.length ? pts.slice(1) : pts));
  }
  return { path: out, ok: true };
}

/** 鉄道・地下鉄の道のり（駅を結ぶ線路の上。行きと帰り） */
export function trackPath(t: TransitState, stops: Stop[]): { path: P2[]; ok: boolean } {
  const out: P2[] = [];
  const order = [...stops, ...stops.slice(0, -1).reverse()];
  for (let i = 0; i < order.length - 1; i++) {
    if (!trackFor(t, order[i].id, order[i + 1].id)) return { path: out, ok: false };
    const a = order[i], b = order[i + 1];
    const n = Math.max(2, Math.ceil(dist2(a, b) / 10));
    for (let k = out.length ? 1 : 0; k <= n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n });
  }
  return { path: out, ok: true };
}

/** 路線の 1 周（往復）にかかる時間（分） */
export const roundTripMinutes = (l: Pick<Line, 'mode' | 'pathLen' | 'stops'>, slow = 1) =>
  (l.pathLen / 1000 / MODES[l.mode].speed) * 60 * slow + l.stops.length * 2 * 0.5;

export interface Ridership {
  /** 路線ごとの 1 日の利用者（片道） */
  riders: Map<number, number>;
  /** 住宅の建物ごとの、公共交通で通勤する人の割合 */
  shareByBuilding: Map<number, number>;
  total: number;
}

/**
 * 利用者の数。駅や停留所の近くに住む人が、同じ路線の別の駅の近くで働いていれば使う。
 * 本数（待ち時間）、運賃、道路の渋滞（バス・路面電車）で割合が変わる。
 */
export function ridership(t: TransitState, buildings: Iterable<Building>, congestion: (lineId: number) => number, radiusBoost: (stop: Stop) => number = () => 1): Ridership {
  const blds = [...buildings];
  let totalJobs = 0;
  for (const b of blds) totalJobs += b.jobs;
  const riders = new Map<number, number>();
  const share = new Map<number, number>();
  let total = 0;
  for (const l of t.lines.values()) {
    if (l.broken || l.stops.length < 2) { riders.set(l.id, 0); continue; }
    const def = MODES[l.mode];
    const stops = l.stops.map((id) => t.stops.get(id)!).filter(Boolean);
    const R = new Array(stops.length).fill(0), J = new Array(stops.length).fill(0);
    const home = new Map<number, number>();
    for (const b of blds) {
      let best = -1, bestD = Infinity;
      stops.forEach((s, i) => {
        const d = Math.hypot(s.x - b.x, s.z - b.z);
        if (d < def.radius * radiusBoost(s) && d < bestD) { bestD = d; best = i; }
      });
      if (best < 0) continue;
      const walk = 1 - smoothstep(def.radius * 0.4, def.radius * radiusBoost(stops[best]), bestD) * 0.6;
      if (b.residents) { R[best] += b.residents * 0.55 * walk; home.set(b.id, best); }
      J[best] += b.jobs * walk;
    }
    const jobsOnLine = J.reduce((a, v) => a + v, 0);
    const trip = roundTripMinutes(l, l.mode === 'bus' || l.mode === 'tram' ? 1 + congestion(l.id) * 1.5 : 1);
    const headway = trip / Math.max(1, l.vehicles);
    const freq = 1 / (1 + headway / 12);
    const fareF = Math.max(0.2, Math.min(1.6, Math.exp(-((l.fare - def.fare) / def.fare) * 1.5)));
    const slow = l.mode === 'bus' || l.mode === 'tram' ? 1 / (1 + congestion(l.id) * 1.5) : 1;
    const s = def.share * freq * fareF * slow;
    let potential = 0;
    R.forEach((r, i) => { potential += (r * (jobsOnLine - J[i])) / (totalJobs + 1); });
    const capacity = (l.vehicles * def.capacity * ((18 * 60) / Math.max(5, trip))) / 2;
    const n = Math.min(potential * s, capacity);
    riders.set(l.id, Math.round(n));
    total += n;
    const capF = potential * s > 0 ? Math.min(1, capacity / (potential * s)) : 0;
    for (const [bid, i] of home) {
      const v = Math.min(0.7, ((jobsOnLine - J[i]) / (totalJobs + 1)) * s * capF);
      share.set(bid, Math.min(0.7, (share.get(bid) ?? 0) + v));
    }
  }
  return { riders, shareByBuilding: share, total: Math.round(total) };
}

/** 地上の線路と道路の交わる場所（踏切） */
export interface Crossing {
  track: number;
  seg: number;
  x: number;
  z: number;
  /** 1 時間に通る列車の本数 */
  trains: number;
}

export function findCrossings(t: TransitState, net: RoadNetwork): Crossing[] {
  const out: Crossing[] = [];
  const perTrack = trainsPerHour(t);
  for (const tr of t.tracks.values()) {
    if (tr.level !== 'ground') continue;
    const cv = trackCurve(t, tr);
    for (const s of net.segments.values()) {
      const rc = net.curveOf(s);
      for (const hit of curveIntersections(cv, rc)) {
        if (s.bridge[Math.round(hit.tb * (s.bridge.length - 1))]) continue;
        if (tr.bridge[Math.round(hit.ta * (tr.bridge.length - 1))]) continue;
        out.push({ track: tr.id, seg: s.id, x: hit.p.x, z: hit.p.z, trains: perTrack.get(tr.id) ?? 0 });
      }
    }
  }
  return out;
}

/** 線路ごとに 1 時間に通る列車の本数（両方向） */
export function trainsPerHour(t: TransitState): Map<number, number> {
  const m = new Map<number, number>();
  for (const l of t.lines.values()) {
    if (l.mode !== 'rail' || l.broken) continue;
    const trip = roundTripMinutes(l);
    const perHour = (l.vehicles * 60) / Math.max(5, trip) * 2;
    for (let i = 0; i < l.stops.length - 1; i++) {
      const tr = trackFor(t, l.stops[i], l.stops[i + 1]);
      if (tr) m.set(tr.id, (m.get(tr.id) ?? 0) + perHour);
    }
  }
  return m;
}

/** 踏切での遅れ（秒）。列車が多いほど開かない */
export const crossingDelay = (trains: number) => 25 + trains * 6 + (trains > 16 ? (trains - 16) * 15 : 0);

/** 線路や駅を、区画のマスや建物にとっての障害物として扱うための線分 */
export function transitObstacles(t: TransitState): { a: P2; b: P2; half: number }[] {
  const out: { a: P2; b: P2; half: number }[] = [];
  for (const tr of t.tracks.values()) {
    if (tr.level === 'under') continue;
    const a = t.stops.get(tr.a)!, b = t.stops.get(tr.b)!;
    out.push({ a, b, half: tr.level === 'elevated' ? 4 : 5 });
  }
  for (const s of t.stops.values()) {
    if (s.mode !== 'rail' && s.mode !== 'subway') continue;
    const dir = stationDirection(t, s);
    const half = s.mode === 'subway' ? 8 : 36;
    out.push({ a: { x: s.x - dir.x * half, z: s.z - dir.z * half }, b: { x: s.x + dir.x * half, z: s.z + dir.z * half }, half: s.mode === 'subway' ? 7 : 9 });
  }
  return out;
}

/** 駅のホームの向き（つながる線路の平均） */
export function stationDirection(t: TransitState, s: Stop): P2 {
  let x = 0, z = 0;
  for (const tr of t.tracks.values()) {
    if (tr.a !== s.id && tr.b !== s.id) continue;
    const o = t.stops.get(tr.a === s.id ? tr.b : tr.a)!;
    let dx = o.x - s.x, dz = o.z - s.z;
    const l = Math.hypot(dx, dz) || 1;
    dx /= l; dz /= l;
    if (x * dx + z * dz < 0) { dx = -dx; dz = -dz; }
    x += dx; z += dz;
  }
  const l = Math.hypot(x, z);
  return l ? { x: x / l, z: z / l } : { x: 1, z: 0 };
}

/** 停留所に近い道路 */
export function snapStopToRoad(net: RoadNetwork, p: P2, tram: boolean): { seg: number; t: number; p: P2 } | null {
  let best: { seg: number; t: number; p: P2; d: number } | null = null;
  for (const s of net.segments.values()) {
    if (tram && s.type === 'alley') continue;
    const hit = closestOnCurve(net.curveOf(s), p);
    if (hit.d < 14 && (!best || hit.d < best.d)) best = { seg: s.id, t: hit.t, p: hit.p, d: hit.d };
  }
  return best;
}

export { insideMap, polylineLength };
