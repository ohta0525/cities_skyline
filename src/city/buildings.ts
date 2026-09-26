import type { ZoneId } from './zones';

export type BuildingKind =
  | 'house' | 'apartment' | 'mansion' | 'danchi'
  | 'shopHouse' | 'konbini' | 'zakkyo' | 'office' | 'depato'
  | 'machiKoba' | 'warehouse' | 'factory' | 'plant';

export interface KindDef {
  name: string;
  zone: Exclude<ZoneId, 0>;
  /** 使える敷地の大きさ（道路沿いのマス数 × 奥行きのマス数） */
  lots: [number, number][];
  weight: number;
  floors: [number, number];
  residents: (floors: number, w: number, d: number) => number;
  jobs: (floors: number, w: number, d: number) => number;
}

const none = () => 0;

export const KINDS: Record<BuildingKind, KindDef> = {
  house: { name: '戸建て', zone: 1, lots: [[1, 2]], weight: 6, floors: [2, 2], residents: () => 3, jobs: none },
  apartment: { name: '木造アパート', zone: 1, lots: [[2, 2]], weight: 2, floors: [2, 2], residents: () => 8, jobs: none },
  mansion: { name: 'マンション', zone: 2, lots: [[2, 3], [3, 3], [2, 4], [3, 4]], weight: 4, floors: [5, 12], residents: (f, w) => f * w * 3, jobs: none },
  danchi: { name: '団地', zone: 2, lots: [[3, 2]], weight: 2, floors: [4, 5], residents: (f) => f * 8, jobs: none },
  shopHouse: { name: '店舗兼住宅', zone: 3, lots: [[1, 2], [1, 1]], weight: 5, floors: [2, 3], residents: () => 2, jobs: () => 3 },
  konbini: { name: 'コンビニ', zone: 3, lots: [[2, 2]], weight: 2, floors: [1, 1], residents: none, jobs: () => 8 },
  zakkyo: { name: '雑居ビル', zone: 4, lots: [[1, 2], [1, 3]], weight: 4, floors: [4, 9], residents: none, jobs: (f) => f * 4 },
  office: { name: 'オフィスビル', zone: 4, lots: [[2, 3], [3, 3], [3, 4]], weight: 3, floors: [7, 16], residents: none, jobs: (f, w) => f * w * 5 },
  depato: { name: '百貨店', zone: 4, lots: [[3, 4]], weight: 1, floors: [6, 8], residents: none, jobs: () => 120 },
  machiKoba: { name: '町工場', zone: 5, lots: [[2, 2], [1, 2]], weight: 5, floors: [1, 1], residents: none, jobs: (_f, w) => 6 * w },
  warehouse: { name: '倉庫', zone: 5, lots: [[2, 3], [3, 3]], weight: 3, floors: [1, 1], residents: none, jobs: (_f, w) => 4 * w },
  factory: { name: '工場', zone: 6, lots: [[3, 3], [3, 4]], weight: 4, floors: [1, 1], residents: none, jobs: (_f, _w, d) => 12 * d },
  plant: { name: '化学プラント', zone: 6, lots: [[2, 3], [3, 3]], weight: 2, floors: [1, 1], residents: none, jobs: (_f, w) => 10 * w },
};

export interface Building {
  id: number;
  kind: BuildingKind;
  zone: Exclude<ZoneId, 0>;
  /** 敷地の正面（道路側の辺）の中央 */
  x: number;
  z: number;
  y: number;
  /** 道路に沿った向き（建物の x 軸） */
  ax: number;
  az: number;
  /** 道路から奥へ向かう向き（建物の z 軸） */
  nx: number;
  nz: number;
  w: number;
  d: number;
  floors: number;
  seed: number;
  /** 建った日 */
  day: number;
  cells: string[];
  /** マスの中心座標 [x0, z0, x1, z1, ...]。道路を分割してマスの key が変わっても位置で引き継ぐ */
  cellPos: number[];
  residents: number;
  jobs: number;
}

export function kindsForZone(zone: number): BuildingKind[] {
  return (Object.keys(KINDS) as BuildingKind[]).filter((k) => KINDS[k].zone === zone);
}

/** 重み付きでランダムに並べ替える */
export function weightedOrder<T>(items: T[], weight: (t: T) => number, rand: () => number): T[] {
  const pool = items.map((it) => ({ it, key: Math.pow(rand(), 1 / Math.max(1e-6, weight(it))) }));
  return pool.sort((a, b) => b.key - a.key).map((p) => p.it);
}
