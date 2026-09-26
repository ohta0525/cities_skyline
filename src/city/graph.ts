import { arcTable, curveLength, pointAt, tAtLength, type P2 } from './geometry';
import type { RoadNetwork, RoadSegment, RoadType } from './roads';

/** 道路網を向きつきのグラフにする（一方通行を守る） */
export interface Edge {
  to: number;
  seg: number;
  len: number;
  /** a→b なら 1、b→a なら -1 */
  dir: 1 | -1;
}

export const FREE_SPEED: Record<RoadType, number> = { alley: 20, local: 40, avenue: 60 };
/** 片側 1 時間あたりの交通容量（台） */
export const CAPACITY: Record<RoadType, number> = { alley: 250, local: 700, avenue: 1600 };

export interface Graph {
  out: Map<number, Edge[]>;
  length: Map<number, number>;
}

export function buildGraph(net: RoadNetwork, allow: (s: RoadSegment) => boolean = () => true): Graph {
  const out = new Map<number, Edge[]>();
  const length = new Map<number, number>();
  for (const id of net.nodes.keys()) out.set(id, []);
  for (const s of net.segments.values()) {
    const len = curveLength(net.curveOf(s));
    length.set(s.id, len);
    if (!allow(s)) continue;
    const ow = s.oneway ?? 0;
    if (ow >= 0) out.get(s.a)?.push({ to: s.b, seg: s.id, len, dir: 1 });
    if (ow <= 0) out.get(s.b)?.push({ to: s.a, seg: s.id, len, dir: -1 });
  }
  return { out, length };
}

/** 二分ヒープ */
class Heap {
  private k: number[] = [];
  private v: number[] = [];
  get size() { return this.k.length; }
  push(key: number, val: number): void {
    this.k.push(key); this.v.push(val);
    let i = this.k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= this.k[i]) break;
      [this.k[p], this.k[i]] = [this.k[i], this.k[p]];
      [this.v[p], this.v[i]] = [this.v[i], this.v[p]];
      i = p;
    }
  }
  pop(): [number, number] {
    const top: [number, number] = [this.k[0], this.v[0]];
    const lk = this.k.pop()!, lv = this.v.pop()!;
    if (this.k.length) {
      this.k[0] = lk; this.v[0] = lv;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < this.k.length && this.k[l] < this.k[m]) m = l;
        if (r < this.k.length && this.k[r] < this.k[m]) m = r;
        if (m === i) break;
        [this.k[m], this.k[i]] = [this.k[i], this.k[m]];
        [this.v[m], this.v[i]] = [this.v[i], this.v[m]];
        i = m;
      }
    }
    return top;
  }
}

export interface Tree {
  dist: Map<number, number>;
  prev: Map<number, Edge & { from: number }>;
}

/** 最短経路木。cost は辺ごとの所要時間など、delay は交差点を通るときの遅れ */
export function dijkstra(g: Graph, sources: Map<number, number>, cost: (e: Edge) => number, delay: (node: number) => number = () => 0): Tree {
  const dist = new Map<number, number>();
  const prev = new Map<number, Edge & { from: number }>();
  const h = new Heap();
  for (const [n, d] of sources) { dist.set(n, d); h.push(d, n); }
  while (h.size) {
    const [d, n] = h.pop();
    if (d > (dist.get(n) ?? Infinity)) continue;
    const through = sources.has(n) && d === sources.get(n) ? 0 : delay(n);
    for (const e of g.out.get(n) ?? []) {
      const nd = d + through + cost(e);
      if (nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd);
        prev.set(e.to, { ...e, from: n });
        h.push(nd, e.to);
      }
    }
  }
  return { dist, prev };
}

/** 最短経路木から、終点までの辺の列 */
export function pathTo(tree: Tree, target: number): (Edge & { from: number })[] | null {
  if (!tree.dist.has(target)) return null;
  const out: (Edge & { from: number })[] = [];
  let n = target;
  for (let guard = 0; guard < 100000; guard++) {
    const e = tree.prev.get(n);
    if (!e) break;
    out.push(e);
    n = e.from;
  }
  return out.reverse();
}

/** 道路の一部（t0 から t1 へ）を折れ線にする */
export function segmentPoints(net: RoadNetwork, s: RoadSegment, t0: number, t1: number, step = 6): P2[] {
  const cv = net.curveOf(s);
  const table = arcTable(cv, 48);
  const len = table[table.length - 1];
  const s0 = t0 * len, s1 = t1 * len;
  const n = Math.max(1, Math.ceil(Math.abs(s1 - s0) / step));
  const pts: P2[] = [];
  for (let k = 0; k <= n; k++) pts.push(pointAt(cv, tAtLength(table, s0 + ((s1 - s0) * k) / n)));
  return pts;
}

/** 折れ線の長さ */
export function polylineLength(pts: P2[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  return l;
}
