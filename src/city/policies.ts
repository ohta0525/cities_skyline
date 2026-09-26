import type { FactionId } from './politics';

export type PolicyId = 'heightLimit' | 'fireproof' | 'seismicAid' | 'landscape' | 'noSmoking' | 'roadPricing';

export interface PolicyDef {
  name: string;
  effect: string;
  /** 月の費用（万円）。地区の建物 1 棟あたり */
  costPerBuilding?: number;
  costFlat?: number;
  faction?: Partial<Record<FactionId, number>>;
}

export const POLICIES: Record<PolicyId, PolicyDef> = {
  heightLimit: { name: '高さ制限', effect: '新しく建つ建物は 4 階まで。低い町並みを守る', faction: { tradition: 3, business: -2 } },
  fireproof: { name: '防火地域', effect: '新しく建つ木造の建物を燃えにくい造りにする。建つのは少し遅くなる', faction: { tradition: 1 } },
  seismicAid: { name: '耐震補助', effect: '旧耐震の建物の耐震改修を補助する（毎月 3％ずつ新耐震に）', costPerBuilding: 2, faction: { progress: 2 } },
  landscape: { name: '景観条例', effect: '看板や色を規制して町並みを整える。商業の需要が少し下がる', faction: { tradition: 4, business: -2 } },
  noSmoking: { name: '路上喫煙禁止', effect: '歩きたばこを禁止する。満足度が少し上がる', costFlat: 30, faction: { progress: 1 } },
  roadPricing: { name: 'ロードプライシング', effect: 'この地区に車で入ると料金がかかる。地区へ向かう車が 3 割減る', costFlat: 50, faction: { green: 3, business: -3 } },
};

export type DecreeId = 'festival' | 'powerSaving' | 'curfew' | 'emergency' | 'staggered';

export interface DecreeDef {
  name: string;
  effect: string;
  /** 1 回きり（期間つき）か、切り替え式か */
  kind: 'once' | 'toggle';
  cost?: number;
  duration?: number;
  cooldown?: number;
}

export const DECREES: Record<DecreeId, DecreeDef> = {
  festival: { name: '祭りの開催', effect: '満足度 +8、保守・伝統の支持 +8（3 か月）。費用 1,500万円', kind: 'once', cost: 1_500, duration: 90, cooldown: 360 },
  powerSaving: { name: '節電要請', effect: '電気の使用量を 2 割減らす。経済界の支持と満足度が下がる', kind: 'toggle' },
  curfew: { name: '夜間外出禁止令', effect: '犯罪が半分に。革新の支持が大きく下がる', kind: 'toggle' },
  staggered: { name: '時差出勤の呼びかけ', effect: '朝の通勤が分散し、渋滞が減る。経済界の支持が少し下がる', kind: 'toggle' },
  emergency: { name: '非常事態宣言', effect: '災害から 60 日以内に出せる。消火と復旧が速くなる（60 日間）', kind: 'once', duration: 60, cooldown: 60 },
};

export interface PolicyState {
  /** 地区の id（0 は市全体）ごとの政策 */
  districts: Record<number, PolicyId[]>;
  /** 布告の期限（once）または true（toggle） */
  decrees: Partial<Record<DecreeId, number | boolean>>;
  cooldowns: Partial<Record<DecreeId, number>>;
  lastDisasterDay: number;
}

export const newPolicies = (): PolicyState => ({ districts: {}, decrees: {}, cooldowns: {}, lastDisasterDay: -9999 });

export function hasPolicy(p: PolicyState, districtId: number, id: PolicyId): boolean {
  return (p.districts[0] ?? []).includes(id) || (districtId > 0 && (p.districts[districtId] ?? []).includes(id));
}

export function decreeActive(p: PolicyState, id: DecreeId, day: number): boolean {
  const v = p.decrees[id];
  return v === true || (typeof v === 'number' && v > day);
}
