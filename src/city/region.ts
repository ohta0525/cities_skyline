import { HALF } from '../world/terrain';
import type { RoadNetwork } from './roads';

export type NeighborKind = 'tourism' | 'industrial' | 'bedtown' | 'village';
export type Edge = 'west' | 'east' | 'north';

export const NEIGHBOR_KINDS: Record<NeighborKind, { name: string; pop: number; jobRatio: number; workRatio: number; growth: number }> = {
  tourism: { name: '観光都市', pop: 9000, jobRatio: 0.52, workRatio: 0.48, growth: 0.01 },
  industrial: { name: '工業都市', pop: 16000, jobRatio: 0.62, workRatio: 0.46, growth: 0.015 },
  bedtown: { name: 'ベッドタウン', pop: 12000, jobRatio: 0.32, workRatio: 0.5, growth: 0.02 },
  village: { name: '過疎の村', pop: 900, jobRatio: 0.4, workRatio: 0.42, growth: -0.02 },
};

export const EDGE_NAMES: Record<Edge, string> = { west: '西', east: '東', north: '北（山側）' };

export interface Neighbor {
  edge: Edge;
  name: string;
  kind: NeighborKind;
  population: number;
  /** -100〜100 */
  relation: number;
  connected: boolean;
  /** 今月、こちらから働きに行った人・来た人 */
  outCommute: number;
  inCommute: number;
}

export interface RegionState {
  neighbors: Neighbor[];
}

const HEAD = ['大', '高', '上', '下', '東', '西', '北', '長', '石', '若', '三', '白', '豊', '清', '松', '桜', '吉', '湊'];
const MID = ['川', '山', '田', '野', '沢', '原', '森', '浜', '岡', '島', '谷', '橋'];

export function newRegion(rand: () => number): RegionState {
  const kinds: NeighborKind[] = ['tourism', 'industrial', 'bedtown', 'village'];
  // 山側は過疎の村になりやすい
  const pickKind = (edge: Edge): NeighborKind => {
    if (edge === 'north') return rand() < 0.7 ? 'village' : 'tourism';
    return kinds[Math.floor(rand() * 3)];
  };
  const used = new Set<string>();
  const neighbors = (['west', 'east', 'north'] as Edge[]).map((edge) => {
    const kind = pickKind(edge);
    let name = '';
    do {
      name = HEAD[Math.floor(rand() * HEAD.length)] + MID[Math.floor(rand() * MID.length)] + (kind === 'village' ? '村' : kind === 'bedtown' ? '町' : '市');
    } while (used.has(name));
    used.add(name);
    const pop = Math.round(NEIGHBOR_KINDS[kind].pop * (0.8 + rand() * 0.4));
    return { edge, name, kind, population: pop, relation: 0, connected: false, outCommute: 0, inCommute: 0 };
  });
  return { neighbors };
}

/** 地図の端まで道路がつながっているか */
export function updateConnections(r: RegionState, net: RoadNetwork): void {
  const margin = 40;
  for (const n of r.neighbors) {
    n.connected = [...net.nodes.values()].some((nd) =>
      (n.edge === 'west' && nd.x < -HALF + margin) ||
      (n.edge === 'east' && nd.x > HALF - margin) ||
      (n.edge === 'north' && nd.z < -HALF + margin));
  }
}

export const neighborJobs = (n: Neighbor) => n.population * NEIGHBOR_KINDS[n.kind].jobRatio;
export const neighborWorkers = (n: Neighbor) => n.population * NEIGHBOR_KINDS[n.kind].workRatio;

/**
 * 通勤の流れを決める。市内の働き手が余れば隣町へ働きに行き、仕事が余れば隣町から人が来る。
 * 戻り値は市全体の通勤者数。
 */
export function commute(r: RegionState, workers: number, jobs: number): { out: number; inn: number } {
  const links = r.neighbors.filter((n) => n.connected);
  for (const n of r.neighbors) { n.outCommute = 0; n.inCommute = 0; }
  if (!links.length) return { out: 0, inn: 0 };
  let out = 0, inn = 0;
  const surplusWorkers = Math.max(0, workers - jobs);
  const surplusJobs = Math.max(0, jobs - workers);
  const openings = links.map((n) => Math.max(0, neighborJobs(n) - neighborWorkers(n)) + neighborJobs(n) * 0.04);
  const spare = links.map((n) => Math.max(0, neighborWorkers(n) - neighborJobs(n)) + neighborWorkers(n) * 0.04);
  const totalOpen = openings.reduce((a, b) => a + b, 0);
  const totalSpare = spare.reduce((a, b) => a + b, 0);
  links.forEach((n, i) => {
    if (totalOpen > 0) n.outCommute = Math.round(Math.min(surplusWorkers, totalOpen) * (openings[i] / totalOpen));
    if (totalSpare > 0) n.inCommute = Math.round(Math.min(surplusJobs, totalSpare) * (spare[i] / totalSpare));
    out += n.outCommute;
    inn += n.inCommute;
  });
  return { out, inn };
}

/** 月ごとの変化：隣町の人口と、関係の良し悪し */
export function monthlyRegion(r: RegionState, rand: () => number): void {
  for (const n of r.neighbors) {
    const g = NEIGHBOR_KINDS[n.kind].growth;
    n.population = Math.max(100, Math.round(n.population * (1 + g / 12 + (rand() - 0.5) * 0.004)));
    const traffic = n.outCommute + n.inCommute;
    const drift = n.connected ? Math.min(1.2, 0.2 + traffic / 400) : -0.05;
    n.relation = Math.max(-100, Math.min(100, n.relation + drift));
  }
}

/** 交易の収入（万円／月）。工業の製品を隣町に売る */
export function tradeIncome(r: RegionState, indJobs: number, comJobs: number): number {
  const links = r.neighbors.filter((n) => n.connected);
  if (!links.length) return 0;
  const rel = links.reduce((s, n) => s + n.relation, 0) / links.length;
  return (indJobs * 0.12 + comJobs * 0.03) * (1 + rel / 200);
}
