import type { Edge, Neighbor } from './region';

export type UnitKind = 'infantry' | 'mobile' | 'rescue' | 'naval' | 'air';

export interface UnitDef {
  name: string;
  /** 編成の費用（万円） */
  cost: number;
  /** 維持費（万円／月） */
  upkeep: number;
  /** 戦う力 */
  power: number;
  /** この施設がないと編成できない */
  needs?: 'coastwatch' | 'airbase';
  unlockYear?: number;
  note: string;
}

export const UNITS: Record<UnitKind, UnitDef> = {
  infantry: { name: '歩兵隊', cost: 5_000, upkeep: 120, power: 10, note: '基本の部隊。安いが力は小さい' },
  mobile: { name: '機動隊', cost: 15_000, upkeep: 350, power: 28, note: '装甲車の部隊。平地で強い' },
  rescue: { name: '救助隊', cost: 6_000, upkeep: 150, power: 2, note: '災害派遣の主力。逃げ遅れと家を失う人を減らす' },
  naval: { name: '艦艇', cost: 40_000, upkeep: 900, power: 45, needs: 'coastwatch', note: '湾を守る船。沿岸監視所が必要' },
  air: { name: '航空隊', cost: 90_000, upkeep: 2_000, power: 100, needs: 'airbase', unlockYear: 41, note: '発展期から。航空基地が必要' },
};

/** 駐屯地 1 か所で置ける部隊の数 */
export const UNITS_PER_GARRISON = 6;

export interface Unit {
  id: number;
  kind: UnitKind;
  since: number;
}

export type WarResult = 'won' | 'lost' | 'peace';

export interface War {
  edge: Edge;
  name: string;
  startDay: number;
  /** 戦況 -100（負け）〜100（勝ち） */
  front: number;
  aggressor: 'us' | 'them';
  /** 失った部隊 */
  ourLosses: number;
  /** 相手の軍の損害（力） */
  theirLosses: number;
  /** 被害を受けた建物 */
  damaged: number;
  /** 勝ったあと、結末を選ぶ前 */
  pendingVictory: boolean;
  /** 次に講和を申し入れられる日 */
  peaceTry: number;
}

export interface WarRecord {
  name: string;
  startDay: number;
  endDay: number;
  result: WarResult;
  outcome: string;
}

export interface DefenseState {
  units: Unit[];
  nextUnitId: number;
  war: War | null;
  records: WarRecord[];
  /** 負けたあと、相手に上納金を払う */
  tribute: { edge: Edge; name: string; until: number; share: number } | null;
}

export const newDefense = (): DefenseState => ({ units: [], nextUnitId: 1, war: null, records: [], tribute: null });

export function unitCount(d: DefenseState, kind?: UnitKind): number {
  return kind ? d.units.filter((u) => u.kind === kind).length : d.units.length;
}

export function upkeepOf(d: DefenseState): number {
  return d.units.reduce((s, u) => s + UNITS[u.kind].upkeep, 0);
}

export interface PowerInput {
  training: boolean;
  /** 支持率 0〜100 */
  approval: number;
  money: number;
}

/** 部隊の力の合計。訓練場があれば 1.25 倍、士気（支持率）と補給（資金）で上下する */
export function ourPower(d: DefenseState, m: PowerInput): number {
  const raw = d.units.reduce((s, u) => s + UNITS[u.kind].power, 0);
  const morale = 0.7 + Math.max(0, Math.min(100, m.approval)) / 200;
  const supply = m.money < 0 ? 0.6 : 1;
  return raw * (m.training ? 1.25 : 1) * morale * supply;
}

export interface WarStepInput {
  ours: number;
  /** 味方（軍事同盟）の力 */
  allies: number;
  /** 中央政府の基地が守りに加わる力（攻められたときだけ） */
  base: number;
  rand: () => number;
}

export interface WarStep {
  delta: number;
  lostUnit: boolean;
  /** 街が受ける被害（棟数） */
  hits: number;
}

/** 戦況を 5 日ぶん進める（自動解決）。戦力 × 補給 × 士気 × 地形で決まる */
export function warStep(w: War, n: Neighbor, m: WarStepInput): WarStep {
  const ours = m.ours + m.allies + (w.aggressor === 'them' ? m.base : 0);
  // 山側の町を攻めると、守る側が有利
  const terrain = w.aggressor === 'us' && n.edge === 'north' ? 1.3 : 1;
  const theirs = n.military * terrain;
  const ratio = ours / Math.max(1, ours + theirs);
  const delta = (ratio - 0.5) * 18 + (m.rand() - 0.5) * 8;
  w.front = Math.max(-100, Math.min(100, w.front + delta));
  const lostUnit = m.rand() < (1 - ratio) * 0.35;
  const dmg = Math.min(n.military, ours * 0.04 * ratio + 1);
  n.military = Math.max(0, n.military - dmg);
  w.theirLosses += dmg;
  const hits = w.front < -10 ? Math.ceil(-w.front / 30) : 0;
  return { delta, lostUnit, hits };
}

/** 講和の条件。戦況が良ければ賠償金を取れ、悪ければ払う */
export function peaceTerms(w: War, n: Neighbor): { kind: 'theyPay' | 'white' | 'wePay'; amount: number; chance: number } {
  if (w.front >= 40) return { kind: 'theyPay', amount: Math.round(w.front * n.population * 0.02), chance: 1 };
  if (w.front > -40) return { kind: 'white', amount: 0, chance: Math.max(0.2, Math.min(0.9, 0.5 + w.front / 100)) };
  return { kind: 'wePay', amount: Math.round(-w.front * n.population * 0.02 + 5_000), chance: 1 };
}

export type VictoryChoice = 'annex' | 'reparations' | 'vassal';

export const VICTORY: Record<VictoryChoice, { name: string; note: (n: Neighbor) => string }> = {
  annex: { name: '併合する', note: (n) => `${n.name}の土地が市のものになる（強制的な合併）。住民の反発で数年は支持率が下がる` },
  reparations: { name: '賠償金を取る', note: (n) => `${Math.round(n.population * 1.5 / 10) * 10}万円を受け取る` },
  vassal: { name: '従属都市にする', note: (n) => `10 年間、毎月 ${Math.round(n.population * 0.05)}万円の上納金を受け取る` },
};
