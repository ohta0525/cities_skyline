import { HALF } from '../world/terrain';
import type { Building } from './buildings';
import { FACILITIES, type Facility, type FacilityCategory } from './facilities';
import type { FactionId } from './politics';
import type { RegionState } from './region';
import type { RoadNetwork } from './roads';

export type Utility = 'power' | 'water' | 'sewage' | 'garbage';
export const UTILITY_NAMES: Record<Utility, string> = { power: '電気', water: '水道', sewage: '下水', garbage: 'ゴミ収集' };
export const UTILITY_UNITS: Record<Utility, string> = { power: 'kW', water: 't／日', sewage: 't／日', garbage: 't／月' };
/** 隣町から買える量と、その単価（万円） */
export const IMPORT: Record<Utility, { cap: number; price: number }> = {
  power: { cap: 3_000, price: 0.08 },
  water: { cap: 2_000, price: 0.1 },
  sewage: { cap: 2_000, price: 0.08 },
  garbage: { cap: 1_500, price: 0.15 },
};

export interface BuildingService {
  power: boolean;
  water: boolean;
  sewage: boolean;
  garbage: boolean;
  /** 0〜1。1 に近いほど施設が近い */
  fire: number;
  police: number;
  health: number;
  education: number;
  leisure: number;
  pollution: number;
  happiness: number;
}

export interface UtilityTotal {
  supply: number;
  demand: number;
  imported: number;
  /** 需要のうち、まかなえた割合 */
  served: number;
}

export interface ServiceReport {
  per: Map<number, BuildingService>;
  util: Record<Utility, UtilityTotal>;
  /** 住民のうち、そのサービスが届いている割合 */
  coverage: Record<'fire' | 'police' | 'health' | 'education', number>;
  crime: number;
  pollution: number;
  happiness: number;
  importCost: number;
  factionBonus: Partial<Record<FactionId, number>>;
}

/** 建物 1 棟が使う量 */
export function usage(b: Pick<Building, 'residents' | 'jobs'>, powerSaving = false): Record<Utility, number> {
  const power = (b.residents * 1.2 + b.jobs * 2) * (powerSaving ? 0.8 : 1);
  const water = b.residents * 1 + b.jobs * 0.5;
  return { power, water, sewage: water, garbage: b.residents * 1 + b.jobs * 0.6 };
}

const hash01 = (id: number) => ((Math.imul(id, 2654435761) >>> 0) % 1000) / 1000;
const segOf = (cellKey: string | undefined) => (cellKey ? Number(cellKey.split(':')[0]) : -1);

interface Input {
  net: RoadNetwork;
  buildings: Iterable<Building>;
  facilities: Iterable<Facility>;
  region: RegionState;
  day: number;
  powerSaving: boolean;
  curfew: boolean;
}

/**
 * インフラとサービスを計算する。
 * 電気・水道は道路に沿った電線・水道管でつながる（道路網のつながりごとに需給を合わせる）。
 * 地図の端で隣町とつながっていれば、足りない分を買える。
 */
export function computeServices(inp: Input): ServiceReport {
  // 道路網のつながり（Union-Find）
  const parent = new Map<number, number>();
  const find = (a: number): number => {
    let r = a;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let x = a;
    while (parent.get(x) !== r) { const n = parent.get(x)!; parent.set(x, r); x = n; }
    return r;
  };
  for (const id of inp.net.nodes.keys()) parent.set(id, id);
  for (const s of inp.net.segments.values()) parent.set(find(s.a), find(s.b));
  const compOfSeg = (seg: number) => {
    const s = inp.net.segments.get(seg);
    return s ? find(s.a) : -1;
  };

  // 隣町とつながっているまとまり
  const importComps = new Set<number>();
  for (const n of inp.region.neighbors) {
    if (!n.connected) continue;
    for (const nd of inp.net.nodes.values()) {
      const near = (n.edge === 'west' && nd.x < -HALF + 40) || (n.edge === 'east' && nd.x > HALF - 40) || (n.edge === 'north' && nd.z < -HALF + 40);
      if (near) importComps.add(find(nd.id));
    }
  }

  const utils: Utility[] = ['power', 'water', 'sewage', 'garbage'];
  const supply = new Map<number, Record<Utility, number>>();
  const demand = new Map<number, Record<Utility, number>>();
  const zero = () => ({ power: 0, water: 0, sewage: 0, garbage: 0 });
  const facs = [...inp.facilities];
  for (const f of facs) {
    if (f.downUntil > inp.day) continue;
    const def = FACILITIES[f.kind];
    const c = compOfSeg(segOf(f.cells[0]));
    const s = supply.get(c) ?? zero();
    s.power += def.power ?? 0;
    s.water += def.water ?? 0;
    s.sewage += def.sewage ?? 0;
    s.garbage += def.garbage ?? 0;
    supply.set(c, s);
  }
  const blds = [...inp.buildings];
  const compOfB = new Map<number, number>();
  for (const b of blds) {
    const c = compOfSeg(segOf(b.cells[0]));
    compOfB.set(b.id, c);
    const d = demand.get(c) ?? zero();
    const u = usage(b, inp.powerSaving);
    for (const k of utils) d[k] += u[k];
    demand.set(c, d);
  }

  const ratio = new Map<number, Record<Utility, number>>();
  const util: Record<Utility, UtilityTotal> = {
    power: { supply: 0, demand: 0, imported: 0, served: 1 }, water: { supply: 0, demand: 0, imported: 0, served: 1 },
    sewage: { supply: 0, demand: 0, imported: 0, served: 1 }, garbage: { supply: 0, demand: 0, imported: 0, served: 1 },
  };
  let importCost = 0;
  for (const [c, d] of demand) {
    const s = supply.get(c) ?? zero();
    const r = zero();
    for (const k of utils) {
      const imp = importComps.has(c) ? Math.min(IMPORT[k].cap, Math.max(0, d[k] - s[k])) : 0;
      const avail = s[k] + imp;
      r[k] = d[k] > 0 ? Math.min(1, avail / d[k]) : 1;
      util[k].imported += imp;
      util[k].demand += d[k];
      importCost += imp * IMPORT[k].price;
    }
    ratio.set(c, r);
  }
  for (const s of supply.values()) for (const k of utils) util[k].supply += s[k];
  // まかなえた割合は、つながりごとの配分を合計して求める（離れた発電所の電気は届かない）
  const servedSum = zero();
  for (const [c, d] of demand) {
    const r = ratio.get(c)!;
    for (const k of utils) servedSum[k] += d[k] * r[k];
  }
  for (const k of utils) util[k].served = util[k].demand ? servedSum[k] / util[k].demand : 1;

  // サービスの届く範囲
  const byCat = new Map<FacilityCategory, Facility[]>();
  for (const f of facs) {
    const cat = FACILITIES[f.kind].cat;
    byCat.set(cat, [...(byCat.get(cat) ?? []), f]);
  }
  const center = (f: Facility) => ({ x: f.x + f.nx * f.d * 4, z: f.z + f.nz * f.d * 4 });
  const cover = (cat: FacilityCategory, x: number, z: number) => {
    let best = 0;
    for (const f of byCat.get(cat) ?? []) {
      const r = FACILITIES[f.kind].radius ?? 0;
      const c = center(f);
      const d = Math.hypot(c.x - x, c.z - z);
      if (d < r) best = Math.max(best, 1 - d / r);
    }
    return best;
  };
  const polluters: { x: number; z: number; r: number; w: number }[] = [];
  for (const f of facs) {
    const p = FACILITIES[f.kind].pollution;
    if (p) { const c = center(f); polluters.push({ ...c, r: p, w: 1 }); }
  }
  for (const b of blds) {
    if (b.zone === 6) polluters.push({ x: b.x, z: b.z, r: 60, w: 0.5 });
    else if (b.zone === 5) polluters.push({ x: b.x, z: b.z, r: 60, w: 0.2 });
  }
  // 公害源を 64 m の格子に分けて探す
  const PG = 64;
  const pgrid = new Map<string, typeof polluters>();
  for (const p of polluters) {
    const k = `${Math.floor(p.x / PG)},${Math.floor(p.z / PG)}`;
    const l = pgrid.get(k);
    if (l) l.push(p); else pgrid.set(k, [p]);
  }
  const pollutionAt = (x: number, z: number) => {
    let s = 0;
    const bx = Math.floor(x / PG), bz = Math.floor(z / PG);
    for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) {
      for (const p of pgrid.get(`${bx + dx},${bz + dz}`) ?? []) {
        const d = Math.hypot(p.x - x, p.z - z);
        if (d < p.r) s += p.w * (1 - d / p.r) * 1.5;
      }
    }
    return Math.min(1, s);
  };

  const noisy = facs.filter((f) => FACILITIES[f.kind].noise);
  const per = new Map<number, BuildingService>();
  let resTotal = 0, hapSum = 0, polSum = 0;
  const cov = { fire: 0, police: 0, health: 0, education: 0 };
  const bonus: Partial<Record<FactionId, number>> = {};
  for (const f of facs) {
    const fb = FACILITIES[f.kind].faction;
    if (fb) bonus[fb.id] = Math.max(-15, Math.min(15, (bonus[fb.id] ?? 0) + fb.amount));
  }
  for (const b of blds) {
    const r = ratio.get(compOfB.get(b.id)!) ?? zero();
    const h = hash01(b.id);
    const cx = b.x + b.nx * b.d * 4, cz = b.z + b.nz * b.d * 4;
    let leisure = 0;
    for (const f of byCat.get('leisure') ?? []) {
      const def = FACILITIES[f.kind];
      const c = center(f);
      const d = Math.hypot(c.x - cx, c.z - cz);
      if (d < (def.radius ?? 0)) leisure += (def.happiness ?? 0) * (1 - d / (def.radius ?? 1));
    }
    const s: BuildingService = {
      power: h < r.power, water: h < r.water, sewage: h < r.sewage, garbage: h < r.garbage,
      fire: cover('fire', cx, cz), police: cover('police', cx, cz), health: cover('health', cx, cz), education: cover('education', cx, cz),
      leisure: Math.min(12, leisure), pollution: b.residents ? pollutionAt(cx, cz) : 0, happiness: 0,
    };
    let noise = 0;
    for (const f of noisy) {
      const [amount, radius] = FACILITIES[f.kind].noise!;
      const c = center(f);
      const d = Math.hypot(c.x - cx, c.z - cz);
      if (d < radius) noise += amount * (1 - d / radius);
    }
    let hap = 60 - Math.min(12, noise) + (s.power ? 0 : -8) + (s.water ? 0 : -7) + (s.sewage ? 0 : -3) + (s.garbage ? 0 : -3)
      + (s.fire > 0 ? 3 : -2) + (s.police > 0 ? 4 : inp.curfew ? -1 : -3) + (s.health > 0 ? 4 : -3)
      + (b.residents ? (s.education > 0 ? 5 : -2) : 0) + s.leisure - s.pollution * 25;
    if (b.damagedUntil && b.damagedUntil > inp.day) hap -= 10;
    s.happiness = Math.max(0, Math.min(100, hap));
    per.set(b.id, s);
    if (b.residents) {
      resTotal += b.residents;
      hapSum += s.happiness * b.residents;
      polSum += s.pollution * b.residents;
      if (s.fire > 0) cov.fire += b.residents;
      if (s.police > 0) cov.police += b.residents;
      if (s.health > 0) cov.health += b.residents;
      if (s.education > 0) cov.education += b.residents;
    }
  }
  const share = (v: number) => (resTotal ? v / resTotal : 0);
  return {
    per, util, importCost,
    coverage: { fire: share(cov.fire), police: share(cov.police), health: share(cov.health), education: share(cov.education) },
    crime: resTotal ? (1 - share(cov.police)) * (inp.curfew ? 0.5 : 1) : 0,
    pollution: share(polSum),
    happiness: resTotal ? hapSum / resTotal : 58,
    factionBonus: bonus,
  };
}
