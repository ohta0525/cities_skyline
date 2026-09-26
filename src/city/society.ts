/**
 * 街の不満と治安（デモ → 暴動 → 過激派の武装化）、防衛隊のクーデター。
 */

export interface SocietyState {
  /** 不満 0〜100 */
  unrest: number;
  /** クーデターの危険 0〜100 */
  coupRisk: number;
  /** 過激派が武装している */
  extremists: boolean;
  /** 暴動が起きている地区（0 は市全体） */
  riotDistrict: number | null;
  /** 最近のデモ・暴動の場所（描画用） */
  hotspot: { x: number; z: number } | null;
  cooldowns: Record<string, number>;
  /** 戒厳令 */
  martialLaw: boolean;
  riots: number;
  /** 夏祭りを開く年 */
  festivalYear: number;
  /** 大雪・猛暑の期限（日） */
  snowUntil: number;
  heatUntil: number;
}

export const newSociety = (): SocietyState => ({
  unrest: 10, coupRisk: 0, extremists: false, riotDistrict: null, hotspot: null, cooldowns: {}, martialLaw: false, riots: 0, festivalYear: 0, snowUntil: 0, heatUntil: 0,
});

export function unrestStage(u: number): number {
  return u >= 85 ? 4 : u >= 65 ? 3 : u >= 45 ? 2 : u >= 25 ? 1 : 0;
}
export const UNREST_NAMES = ['平穏', '不満', 'デモ', '暴動', '過激派の武装化'];
export const UNREST_COLORS = ['#3ea865', '#b8c24a', '#e8b83e', '#e8873e', '#d9573f'];

export interface UnrestInput {
  happiness: number;
  unemployment: number;
  approval: number;
  /** 家を失った人の割合 */
  displacedShare: number;
  /** 警察が届いていない割合 */
  crime: number;
  curfew: boolean;
  martialLaw: boolean;
  tribute: boolean;
  atWar: boolean;
  /** 祭りの最中 */
  festival: boolean;
}

/** 不満の目標値。満足度・失業・支持率・住まい・治安から決まる */
export function unrestTarget(m: UnrestInput): number {
  let t = Math.max(0, 60 - m.happiness) * 1.4
    + m.unemployment * 150
    + Math.max(0, 45 - m.approval) * 0.8
    + m.displacedShare * 60
    + m.crime * 12
    + (m.tribute ? 8 : 0)
    + (m.atWar ? 6 : 0);
  if (m.curfew) t -= 10;
  if (m.festival) t -= 8;
  return Math.max(0, Math.min(100, t));
}

/** 月ごとの不満の変化（目標に向かって少しずつ動く） */
export function unrestMonth(s: SocietyState, m: UnrestInput): void {
  const target = unrestTarget(m);
  s.unrest += (target - s.unrest) * 0.25;
  if (m.martialLaw) s.unrest = Math.max(0, s.unrest - 15);
  s.unrest = Math.max(0, Math.min(100, s.unrest));
  if (s.unrest >= 85) s.extremists = true;
  else if (s.unrest < 40) s.extremists = false;
}

export interface CoupInput {
  /** 部隊の数 */
  units: number;
  power: number;
  /** 防衛派閥の支持 0〜100 */
  defenseSupport: number;
  martialLaw: boolean;
  extremists: boolean;
  unrest: number;
}

/** 月ごとのクーデターの危険。軍が強く、防衛派が市長を見放すほど高まる */
export function coupMonth(s: SocietyState, m: CoupInput): number {
  if (m.units < 4 || m.power < 80) {
    s.coupRisk = Math.max(0, s.coupRisk - 5);
    return s.coupRisk;
  }
  let d = (35 - m.defenseSupport) * 0.15;
  if (m.defenseSupport > 50) d -= 3;
  if (m.martialLaw) d += 2;
  if (m.extremists) d += 1;
  if (m.unrest > 70) d += 1;
  d *= Math.min(2, m.power / 150);
  s.coupRisk = Math.max(0, Math.min(100, s.coupRisk + d));
  return s.coupRisk;
}

export type SocietyActionId = 'dialogue' | 'handout' | 'crackdown' | 'treatment' | 'reshuffle';

export const SOCIETY_ACTIONS: Record<SocietyActionId, { name: string; note: string; cooldown: number }> = {
  dialogue: { name: '対話集会', note: '市長が市民と直接話す（500万円）。不満 −12', cooldown: 90 },
  handout: { name: '生活支援金', note: '市民に一律の支援金（人口 1 人あたり 3,000円）。不満 −20。経済界と保守派はばらまきを嫌う', cooldown: 180 },
  crackdown: { name: '機動隊で鎮圧', note: '警察署か機動隊が必要。不満 −30、過激派を抑える。革新派と環境派の支持が大きく下がる', cooldown: 60 },
  treatment: { name: '防衛隊の待遇改善', note: '給与と装備を良くする（3,000万円）。クーデターの危険 −15、防衛派の支持 +10', cooldown: 180 },
  reshuffle: { name: '幹部の人事異動', note: '不満を持つ幹部を配置換えする。クーデターの危険 −25。部隊が 1 つ解散し、防衛派の支持 −5', cooldown: 180 },
};
