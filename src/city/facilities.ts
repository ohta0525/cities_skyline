import type { FactionId } from './politics';

export type FacilityCategory = 'power' | 'water' | 'garbage' | 'fire' | 'police' | 'health' | 'education' | 'leisure' | 'transport';

export const CATEGORY_NAMES: Record<FacilityCategory, string> = {
  power: '電気', water: '上下水道', garbage: 'ゴミ', fire: '消防', police: '警察', health: '医療', education: '教育', leisure: '公園・文化', transport: '交通',
};

export type FacilityKind =
  | 'thermal' | 'solar' | 'nuclear'
  | 'waterworks' | 'sewage'
  | 'incinerator'
  | 'fireStation' | 'fireBrigade'
  | 'koban' | 'policeStation'
  | 'clinic' | 'hospital'
  | 'elementary' | 'highschool'
  | 'park' | 'shrine'
  | 'parkRide';

export interface FacilityDef {
  name: string;
  cat: FacilityCategory;
  /** 敷地（道路沿いのマス数 × 奥行き） */
  w: number;
  d: number;
  /** 建設費（万円） */
  cost: number;
  /** 維持費（万円／月） */
  upkeep: number;
  /** 発電量（kW） */
  power?: number;
  /** 浄水・下水の処理能力 */
  water?: number;
  sewage?: number;
  /** ゴミの処理能力（月） */
  garbage?: number;
  /** サービスが届く半径（m） */
  radius?: number;
  /** 同時に対応できる数（消防車など） */
  capacity?: number;
  /** 川か海の近く（80 m 以内）でないと建てられない */
  needsWater?: boolean;
  unlockYear?: number;
  /** 周りの暮らしの満足度への効果 */
  happiness?: number;
  /** 周りへの公害の半径 */
  pollution?: number;
  faction?: { id: FactionId; amount: number };
  note: string;
}

export const FACILITIES: Record<FacilityKind, FacilityDef> = {
  thermal: { name: '火力発電所', cat: 'power', w: 3, d: 4, cost: 40_000, upkeep: 800, power: 30_000, pollution: 140, note: '発電量が多いが、周りに公害を出す' },
  solar: { name: '太陽光発電所', cat: 'power', w: 2, d: 3, cost: 15_000, upkeep: 150, power: 4_000, faction: { id: 'green', amount: 2 }, note: 'きれいだが発電量は少ない' },
  nuclear: { name: '原子力発電所', cat: 'power', w: 4, d: 4, cost: 200_000, upkeep: 3_000, power: 150_000, needsWater: true, unlockYear: 21, faction: { id: 'green', amount: -8 }, note: '成長期から。大量の電気。環境派が反発する' },
  waterworks: { name: '浄水場', cat: 'water', w: 2, d: 3, cost: 20_000, upkeep: 400, water: 6_000, needsWater: true, note: '川か海の近くに建てる' },
  sewage: { name: '下水処理場', cat: 'water', w: 2, d: 3, cost: 20_000, upkeep: 400, sewage: 6_000, needsWater: true, pollution: 60, note: '川か海の近くに建てる' },
  incinerator: { name: 'ごみ焼却場', cat: 'garbage', w: 2, d: 3, cost: 18_000, upkeep: 350, garbage: 5_000, pollution: 90, note: '建てる場所で反対運動が起きやすい' },
  fireStation: { name: '消防署', cat: 'fire', w: 2, d: 2, cost: 8_000, upkeep: 250, radius: 600, capacity: 3, note: '消防車 3 台' },
  fireBrigade: { name: '消防団詰所', cat: 'fire', w: 1, d: 1, cost: 800, upkeep: 20, radius: 260, capacity: 1, faction: { id: 'tradition', amount: 1 }, note: '地域の住民による消防団。安いが力は小さい' },
  koban: { name: '交番', cat: 'police', w: 1, d: 1, cost: 600, upkeep: 30, radius: 300, note: 'おまわりさんが地域を見守る' },
  policeStation: { name: '警察署', cat: 'police', w: 2, d: 2, cost: 7_000, upkeep: 250, radius: 750, note: '広い範囲の治安を守る' },
  clinic: { name: '診療所', cat: 'health', w: 1, d: 2, cost: 2_500, upkeep: 80, radius: 400, note: '町のお医者さん' },
  hospital: { name: '総合病院', cat: 'health', w: 3, d: 3, cost: 30_000, upkeep: 900, radius: 1_100, note: '救急にも対応する' },
  elementary: { name: '小学校', cat: 'education', w: 2, d: 3, cost: 9_000, upkeep: 250, radius: 600, faction: { id: 'progress', amount: 1 }, note: '校庭つき。災害時は避難所になる' },
  highschool: { name: '高校', cat: 'education', w: 3, d: 3, cost: 18_000, upkeep: 450, radius: 1_000, faction: { id: 'progress', amount: 2 }, note: '広い範囲の子どもが通う' },
  park: { name: '公園', cat: 'leisure', w: 1, d: 1, cost: 300, upkeep: 10, radius: 160, happiness: 6, note: '周りの満足度が上がる' },
  parkRide: { name: '駐車場（パークアンドライド）', cat: 'transport', w: 2, d: 2, cost: 1_200, upkeep: 30, radius: 250, note: '近く（250 m）の駅まで車で来て電車に乗り換えられる。駅を使える範囲が 1.6 倍に' },
  shrine: { name: '神社', cat: 'leisure', w: 1, d: 2, cost: 1_500, upkeep: 20, radius: 260, happiness: 4, faction: { id: 'tradition', amount: 3 }, note: '鎮守の森。保守・伝統派が喜ぶ' },
};

export interface Facility {
  id: number;
  kind: FacilityKind;
  x: number;
  z: number;
  y: number;
  ax: number;
  az: number;
  nx: number;
  nz: number;
  w: number;
  d: number;
  cells: string[];
  cellPos: number[];
  built: number;
  day: number;
  seed: number;
  /** 地震などで止まっている期限（日） */
  downUntil: number;
}

export function facilitiesIn(cat: FacilityCategory): FacilityKind[] {
  return (Object.keys(FACILITIES) as FacilityKind[]).filter((k) => FACILITIES[k].cat === cat);
}
