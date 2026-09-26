import type { RoadNetwork } from './roads';

export type NeighborKind = 'tourism' | 'industrial' | 'bedtown' | 'village' | 'military';
export type Edge = 'west' | 'east' | 'north';

export interface NeighborKindDef {
  name: string;
  pop: number;
  jobRatio: number;
  workRatio: number;
  growth: number;
  /** 人口あたりの軍備の強さ（1 がふつう） */
  army: number;
  /** ふるさと納税の返礼品の魅力 */
  gifts: number;
}

export const NEIGHBOR_KINDS: Record<NeighborKind, NeighborKindDef> = {
  tourism: { name: '観光都市', pop: 9000, jobRatio: 0.52, workRatio: 0.48, growth: 0.01, army: 0.6, gifts: 0.6 },
  industrial: { name: '工業都市', pop: 16000, jobRatio: 0.62, workRatio: 0.46, growth: 0.015, army: 1.2, gifts: 0.3 },
  bedtown: { name: 'ベッドタウン', pop: 12000, jobRatio: 0.32, workRatio: 0.5, growth: 0.02, army: 0.8, gifts: 0.15 },
  village: { name: '過疎の村', pop: 900, jobRatio: 0.4, workRatio: 0.42, growth: -0.02, army: 0.4, gifts: 0.5 },
  military: { name: '軍事都市', pop: 14000, jobRatio: 0.5, workRatio: 0.47, growth: 0.008, army: 3, gifts: 0.1 },
};

export const EDGE_NAMES: Record<Edge, string> = { west: '西', east: '東', north: '北（山側）' };

export type TreatyId = 'trade' | 'aid' | 'wide' | 'nonaggression' | 'alliance';

export interface Neighbor {
  edge: Edge;
  name: string;
  kind: NeighborKind;
  population: number;
  /** -100〜100 */
  relation: number;
  /** 通勤と交易ができる（道路が境界まで届き、封鎖されていない） */
  connected: boolean;
  /** 道路が境界まで届いている */
  reach: boolean;
  /** 今月、こちらから働きに行った人・来た人 */
  outCommute: number;
  inCommute: number;
  /** 隣町の市長 */
  mayor: string;
  /** 緊張 0〜100。100 で紛争 */
  tension: number;
  /** 軍備の強さ */
  military: number;
  treaties: TreatyId[];
  /** こちらがかけている経済制裁 */
  sanction: boolean;
  /** ふるさと納税の返礼品の割合（0〜0.5） */
  furusatoRate: number;
  /** 合併した（地図の土地が市のものになった） */
  merged: boolean;
  /** 従属都市として上納金を納める期限（日） */
  vassalUntil: number;
  /** 戦争のあと、しばらく紛争にならない期限（日） */
  truceUntil: number;
  cooldowns: Record<string, number>;
}

export interface RegionState {
  neighbors: Neighbor[];
}

/** 市の境界。初めは地図の真ん中（東西 ±620 m、北は -620 m まで）が市の土地 */
export const BORDER = 620;
/** 境界からこの距離までの道路の端で、隣町とつながる */
export const LINK_MARGIN = 30;

const HEAD = ['大', '高', '上', '下', '東', '西', '北', '長', '石', '若', '三', '白', '豊', '清', '松', '桜', '吉', '湊'];
const MID = ['川', '山', '田', '野', '沢', '原', '森', '浜', '岡', '島', '谷', '橋'];
const FAMILY = ['佐伯', '久保田', '宮本', '小野寺', '田島', '桐生', '丹羽', '柳田', '北条', '本多', '真壁', '村瀬'];
const GIVEN = ['茂', '和子', '健一', '洋子', '誠司', '恵', '隆', '直美', '剛志', '千秋'];

export function armyBase(kind: NeighborKind, pop: number): number {
  return Math.round((pop / 1000) * NEIGHBOR_KINDS[kind].army * 12);
}

export function newRegion(rand: () => number): RegionState {
  const kinds: NeighborKind[] = ['tourism', 'industrial', 'bedtown', 'military'];
  // 山側は過疎の村になりやすい。軍事都市は東西のどちらかに出ることがある
  const pickKind = (edge: Edge): NeighborKind => {
    if (edge === 'north') return rand() < 0.7 ? 'village' : 'tourism';
    const k = kinds[Math.floor(rand() * 4)];
    return k === 'military' && rand() < 0.5 ? kinds[Math.floor(rand() * 3)] : k;
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
    const mayor = FAMILY[Math.floor(rand() * FAMILY.length)] + ' ' + GIVEN[Math.floor(rand() * GIVEN.length)];
    return normalizeNeighbor({ edge, name, kind, population: pop, relation: 0, connected: false, outCommute: 0, inCommute: 0, mayor });
  });
  return { neighbors };
}

/** 古い保存データの隣町に、あとから増えた項目を足す */
export function normalizeNeighbor(n: Partial<Neighbor> & Pick<Neighbor, 'edge' | 'name' | 'kind' | 'population'>): Neighbor {
  return {
    relation: 0, connected: false, reach: false, outCommute: 0, inCommute: 0,
    mayor: '', tension: n.kind === 'military' ? 12 : 0, military: armyBase(n.kind, n.population), treaties: [], sanction: false,
    furusatoRate: n.kind === 'tourism' ? 0.35 : 0.3, merged: false, vassalUntil: 0, truceUntil: 0, cooldowns: {},
    ...n,
  } as Neighbor;
}

export function normalizeRegion(r: RegionState): RegionState {
  return { neighbors: r.neighbors.map((n) => normalizeNeighbor(n)) };
}

/** その場所を持っている隣町（市の土地なら null） */
export function ownerAt(r: RegionState, x: number, z: number): Neighbor | null {
  const edge: Edge | null = x < -BORDER ? 'west' : x > BORDER ? 'east' : z < -BORDER ? 'north' : null;
  if (!edge) return null;
  const n = r.neighbors.find((m) => m.edge === edge);
  return n && !n.merged ? n : null;
}

export const active = (r: RegionState) => r.neighbors.filter((n) => !n.merged);

/** 緊張の段階（0：平穏〜5：紛争） */
export function stageOf(tension: number): number {
  return tension >= 100 ? 5 : tension >= 80 ? 4 : tension >= 60 ? 3 : tension >= 40 ? 2 : tension >= 20 ? 1 : 0;
}
export const STAGE_NAMES = ['平穏', '外交摩擦', '経済制裁', '境界の封鎖', '小競り合い', '紛争'];
export const STAGE_COLORS = ['#3ea865', '#b8c24a', '#e8b83e', '#e8873e', '#d9573f', '#a3263a'];

/** 道路が市の境界まで届いているか。封鎖されていると通勤も交易も止まる */
export function updateConnections(r: RegionState, net: RoadNetwork): void {
  const m = LINK_MARGIN;
  for (const n of r.neighbors) {
    if (n.merged) { n.reach = false; n.connected = false; continue; }
    n.reach = [...net.nodes.values()].some((nd) =>
      (n.edge === 'west' && nd.x < -BORDER + m) ||
      (n.edge === 'east' && nd.x > BORDER - m) ||
      (n.edge === 'north' && nd.z < -BORDER + m && nd.x > -BORDER - m && nd.x < BORDER + m));
    n.connected = n.reach && stageOf(n.tension) < 3;
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
  for (const n of active(r)) {
    const g = NEIGHBOR_KINDS[n.kind].growth;
    n.population = Math.max(100, Math.round(n.population * (1 + g / 12 + (rand() - 0.5) * 0.004)));
    const traffic = n.outCommute + n.inCommute;
    // つながっていれば行き来で仲良くなる。そうでなければ少しずつ「ふつう」に戻る
    let drift = n.connected ? Math.min(1.2, 0.2 + traffic / 400) : 0;
    drift -= n.relation * 0.01;
    if (n.treaties.includes('trade')) drift += 0.4;
    if (n.treaties.includes('alliance')) drift += 0.5;
    drift -= (n.tension / 100) * 0.4;
    if (n.sanction) drift -= 1;
    n.relation = Math.max(-100, Math.min(100, n.relation + drift));
  }
}

/** 交易できる隣町か（経済制裁の段階より下で、こちらも制裁していない） */
export const canTrade = (n: Neighbor) => n.connected && !n.sanction && stageOf(n.tension) < 2;

/** 交易の収入（万円／月）。工業の製品を隣町に売る */
export function tradeIncome(r: RegionState, indJobs: number, comJobs: number): number {
  const reach = r.neighbors.filter((n) => n.connected);
  if (!reach.length) return 0;
  const base = indJobs * 0.12 + comJobs * 0.03;
  let sum = 0;
  for (const n of reach) {
    if (!canTrade(n)) continue;
    sum += (1 + n.relation / 200) * (n.treaties.includes('trade') ? 1.4 : 1);
  }
  return (base * sum) / reach.length;
}
