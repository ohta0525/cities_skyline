import { HALF } from '../world/terrain';
import type { Building } from './buildings';
import { CAPACITY, FREE_SPEED, buildGraph, dijkstra, pathTo, type Edge, type Graph } from './graph';
import type { RegionState } from './region';
import type { RoadNetwork } from './roads';
import { crossingDelay, type Crossing } from './transit';

export interface TrafficResult {
  /** 道路ごとの 1 時間の交通量（朝の混む時間、両方向の合計） */
  volume: Map<number, number>;
  /** 道路ごとの混み具合（交通量 ÷ 容量。大きい方の向き） */
  vc: Map<number, number>;
  /** 道路ごとの平均速度（km/h） */
  speed: Map<number, number>;
  /** 車で通勤する人の平均の片道時間（分） */
  avgCommute: number;
  /** 混んでいる道路を走る車の割合（0〜1） */
  congestion: number;
  carTrips: number;
  /** 開かずの踏切 */
  busyCrossings: number;
}

export const EMPTY_TRAFFIC: TrafficResult = {
  volume: new Map(), vc: new Map(), speed: new Map(), avgCommute: 0, congestion: 0, carTrips: 0, busyCrossings: 0,
};

const segOf = (key: string | undefined) => (key ? Number(key.split(':')[0]) : -1);

interface Input {
  net: RoadNetwork;
  buildings: Iterable<Building>;
  region: RegionState;
  commuteOut: number;
  commuteIn: number;
  workers: number;
  /** 公共交通で通勤する人の割合（住宅の建物ごと） */
  transitShare: Map<number, number>;
  crossings: Crossing[];
  /** 時差出勤：朝の集中が減る */
  staggered: boolean;
  /** ロードプライシングをかけている地区にある職場か */
  priced: (b: Building) => boolean;
}

/** 交差点で待つ時間（秒）の基本 */
function nodeBaseDelay(net: RoadNetwork, g: Graph, node: number): number {
  const n = net.nodes.get(node);
  const deg = new Set([...(g.out.get(node) ?? []).map((e) => e.seg)]).size;
  const segs = net.segmentsAt(node);
  if (!n || segs.length < 3) return 0;
  if (n.control === 'grade') return 2;
  if (n.control === 'turnlane') return 8;
  return segs.every((s) => s.type === 'alley') ? 6 : 14 + deg;
}

/**
 * 朝の通勤の車の流れを計算する。
 * 住む場所の近くの交差点から、働く場所の近くの交差点へ、所要時間が短い道を選ぶ。
 * 3 回に分けて流し、混んだ道路は遅くなるので、あとの車は別の道を選ぶ。
 */
export function computeTraffic(inp: Input): TrafficResult {
  const net = inp.net;
  if (!net.segments.size) return EMPTY_TRAFFIC;
  const g = buildGraph(net);
  const blds = [...inp.buildings];
  const segType = new Map([...net.segments.values()].map((s) => [s.id, s.type]));

  // 交差点を 160 m の格子でまとめて、計算を軽くする
  const cluster = new Map<string, number>();
  const rep = (node: number) => {
    const n = net.nodes.get(node)!;
    const k = `${Math.floor(n.x / 160)},${Math.floor(n.z / 160)}`;
    if (!cluster.has(k)) cluster.set(k, node);
    return cluster.get(k)!;
  };
  const nodeOf = (b: Building) => {
    const s = net.segments.get(segOf(b.cells[0]));
    return s ? rep(s.a) : -1;
  };
  const peak = inp.staggered ? 0.25 : 0.33;
  const origins = new Map<number, number>();
  const dests = new Map<number, number>();
  const outShare = inp.workers > 0 ? inp.commuteOut / inp.workers : 0;
  let carTrips = 0;
  for (const b of blds) {
    const n = nodeOf(b);
    if (n < 0) continue;
    if (b.residents) {
      const cars = b.residents * 0.55 * (1 - outShare) * 0.62 * (1 - (inp.transitShare.get(b.id) ?? 0)) * peak;
      origins.set(n, (origins.get(n) ?? 0) + cars);
      carTrips += cars;
    }
    if (b.jobs) dests.set(n, (dests.get(n) ?? 0) + b.jobs * (inp.priced(b) ? 0.7 : 1));
  }
  // 隣町への通勤：地図の端の交差点へ／から
  const edgeNodes: number[] = [];
  for (const nb of inp.region.neighbors) {
    if (!nb.connected) continue;
    for (const nd of net.nodes.values()) {
      const near = (nb.edge === 'west' && nd.x < -HALF + 40) || (nb.edge === 'east' && nd.x > HALF - 40) || (nb.edge === 'north' && nd.z < -HALF + 40);
      if (near) { edgeNodes.push(nd.id); break; }
    }
  }
  const extra: { from: number; to: number; cars: number }[] = [];
  if (edgeNodes.length) {
    const outCars = inp.commuteOut * 0.62 * peak;
    const inCars = inp.commuteIn * 0.7 * peak;
    const totalRes = [...origins.values()].reduce((a, v) => a + v, 0) || 1;
    for (const [o, v] of origins) for (const e of edgeNodes) extra.push({ from: o, to: e, cars: (outCars * v) / totalRes / edgeNodes.length });
    const totalJobs = [...dests.values()].reduce((a, v) => a + v, 0) || 1;
    for (const [d, v] of dests) for (const e of edgeNodes) extra.push({ from: e, to: d, cars: (inCars * v) / totalJobs / edgeNodes.length });
    carTrips += outCars + inCars;
  }
  if (!carTrips) return { ...EMPTY_TRAFFIC };

  // 通勤の行き先の割り振り（近い職場ほど選ばれやすい）
  const pos = (n: number) => net.nodes.get(n)!;
  const od: { from: number; to: number; cars: number }[] = [...extra];
  for (const [o, cars] of origins) {
    const po = pos(o);
    let wsum = 0;
    const ws: [number, number][] = [];
    for (const [d, jobs] of dests) {
      const pd = pos(d);
      const w = jobs * Math.exp(-Math.hypot(po.x - pd.x, po.z - pd.z) / 2500);
      ws.push([d, w]);
      wsum += w;
    }
    if (!wsum) continue;
    for (const [d, w] of ws) if (d !== o) od.push({ from: o, to: d, cars: (cars * w) / wsum });
  }

  // 踏切の遅れ
  const crossDelay = new Map<number, number>();
  let busyCrossings = 0;
  for (const c of inp.crossings) {
    crossDelay.set(c.seg, (crossDelay.get(c.seg) ?? 0) + crossingDelay(c.trains));
    if (c.trains > 16) busyCrossings++;
  }

  const vol = new Map<number, [number, number]>();
  const nodeLoad = new Map<number, number>();
  const baseDelay = new Map<number, number>();
  for (const id of net.nodes.keys()) baseDelay.set(id, nodeBaseDelay(net, g, id));
  // 一方通行は車線をすべて同じ向きに使えるので、片側の容量が増える
  const capOf = (seg: number) => CAPACITY[segType.get(seg)!] * ((net.segments.get(seg)!.oneway ?? 0) !== 0 ? 1.6 : 1);
  const edgeTime = (e: Edge) => {
    const type = segType.get(e.seg)!;
    const v = vol.get(e.seg)?.[e.dir === 1 ? 0 : 1] ?? 0;
    const x = v / capOf(e.seg);
    return (e.len / (FREE_SPEED[type] / 3.6)) * (1 + 0.15 * x ** 4) + (crossDelay.get(e.seg) ?? 0);
  };
  const nodeDelay = (n: number) => {
    const b = baseDelay.get(n) ?? 0;
    if (!b) return 0;
    const deg = Math.max(3, (g.out.get(n) ?? []).length);
    const load = (nodeLoad.get(n) ?? 0) / (deg * 700);
    return b * (1 + load * load);
  };

  const byOrigin = new Map<number, { to: number; cars: number }[]>();
  for (const x of od) {
    const l = byOrigin.get(x.from);
    if (l) l.push(x); else byOrigin.set(x.from, [x]);
  }
  let timeSum = 0;
  const STEPS = 3;
  for (let step = 0; step < STEPS; step++) {
    for (const [o, list] of byOrigin) {
      const tree = dijkstra(g, new Map([[o, 0]]), edgeTime, nodeDelay);
      for (const { to, cars } of list) {
        const c = cars / STEPS;
        const path = pathTo(tree, to);
        if (!path) continue;
        timeSum += (tree.dist.get(to) ?? 0) * c;
        for (const e of path) {
          const v = vol.get(e.seg) ?? [0, 0];
          v[e.dir === 1 ? 0 : 1] += c;
          vol.set(e.seg, v);
          nodeLoad.set(e.to, (nodeLoad.get(e.to) ?? 0) + c);
        }
      }
    }
  }

  const volume = new Map<number, number>(), vcMap = new Map<number, number>(), speed = new Map<number, number>();
  let vkm = 0, jammed = 0;
  for (const s of net.segments.values()) {
    const v = vol.get(s.id) ?? [0, 0];
    const x = Math.max(v[0], v[1]) / capOf(s.id);
    volume.set(s.id, v[0] + v[1]);
    vcMap.set(s.id, x);
    speed.set(s.id, FREE_SPEED[s.type] / (1 + 0.15 * x ** 4));
    const len = g.length.get(s.id) ?? 0;
    vkm += (v[0] + v[1]) * len;
    if (x > 0.85) jammed += (v[0] + v[1]) * len;
  }
  const routed = od.reduce((a, x) => a + x.cars, 0) || 1;
  return {
    volume, vc: vcMap, speed,
    avgCommute: timeSum / routed / 60 + 6,
    congestion: vkm ? jammed / vkm : 0,
    carTrips: Math.round(carTrips / peak),
    busyCrossings,
  };
}
