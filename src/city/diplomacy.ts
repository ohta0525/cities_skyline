import { NEIGHBOR_KINDS, active, armyBase, stageOf, type Edge, type Neighbor, type RegionState, type TreatyId } from './region';

// ---------- 協定 ----------
export interface TreatyDef {
  name: string;
  /** 結ぶのに必要な関係 */
  need: number;
  effect: string;
}

export const TREATIES: Record<TreatyId, TreatyDef> = {
  trade: { name: '交易協定', need: 20, effect: 'この町との交易の収入が 1.4 倍。関係が毎月少しずつ良くなる' },
  aid: { name: '災害時応援協定', need: 10, effect: '災害のとき、関係に関わらず応援と義援金が届く（2 倍）。相手が被災したら応援を頼まれる' },
  wide: { name: '広域連携（共同ゴミ処理）', need: 30, effect: 'ゴミと下水の処理を共同で行い、隣町から買う費用が半分になる' },
  nonaggression: { name: '不可侵条約', need: 0, effect: '緊張が「経済制裁」より上がらない（封鎖・小競り合い・紛争にならない）' },
  alliance: { name: '軍事同盟', need: 60, effect: '紛争のとき、この町の軍の半分が味方として戦う。関係が毎月良くなる' },
};

/** 協定を結べない理由（結べるなら null） */
export function treatyBlock(n: Neighbor, id: TreatyId): string | null {
  const def = TREATIES[id];
  if (n.merged) return '合併済みです';
  if (n.treaties.includes(id)) return null;
  if (n.relation < def.need) return `関係が ${def.need} 以上必要です`;
  if (id !== 'nonaggression' && stageOf(n.tension) >= 2) return '緊張が高く、相手が応じません';
  if (id === 'nonaggression' && n.tension >= 80) return '緊張が高すぎて、相手が応じません';
  return null;
}

// ---------- 外交の手段 ----------
export type DiploActionId = 'goodwill' | 'aid' | 'protest' | 'negotiate' | 'concede' | 'mediate';

export interface DiploActionDef {
  name: string;
  cost: number;
  cooldown: number;
  /** 使える緊張の下限 */
  minTension?: number;
  note: string;
}

export const DIPLO_ACTIONS: Record<DiploActionId, DiploActionDef> = {
  goodwill: { name: '親善訪問', cost: 300, cooldown: 90, note: '市長が訪ねて話す（300万円）。関係 +6、緊張 −3' },
  aid: { name: '経済支援', cost: 3_000, cooldown: 180, note: '相手の事業にお金を出す（3,000万円）。関係 +15、緊張 −8' },
  protest: { name: '抗議', cost: 0, cooldown: 60, note: '相手に抗議する。関係 −10、緊張 +8。防衛派が喜ぶ' },
  negotiate: { name: '交渉', cost: 0, cooldown: 60, minTension: 20, note: '緊張を下げる話し合い。関係が良く、軍備で勝るほど成功しやすい（成功で緊張 −20）' },
  concede: { name: '譲歩', cost: 5_000, cooldown: 120, minTension: 20, note: '相手の言い分を飲む（5,000万円）。緊張 −30、関係 +5。防衛派と保守派が怒る' },
  mediate: { name: '県に仲裁を頼む', cost: 0, cooldown: 360, minTension: 40, note: '県知事との関係 40 以上で使える。緊張 −35（知事との関係 −10）' },
};

// ---------- 隣町からの要求 ----------
export type DemandKind = 'water' | 'border' | 'dump' | 'evacuees';

export interface DiploDemand {
  edge: Edge;
  kind: DemandKind;
  text: string;
  expires: number;
}

export const DEMANDS: Record<DemandKind, { accept: string; reject: string }> = {
  water: { accept: '取水を認める（2,000万円の補償、関係 +8、緊張 −5）', reject: '断る（関係 −8、緊張 +12）' },
  border: { accept: '境界線で譲る（関係 +6、緊張 −8、防衛派・保守派の支持 −4）', reject: '突っぱねる（関係 −6、緊張 +10、防衛派 +2）' },
  dump: { accept: '受け入れる（関係 +8、環境派の支持 −5）', reject: '抗議する（関係 −6、緊張 +8、環境派 +3）' },
  evacuees: { accept: '被災者を受け入れる（1,500万円、関係 +15、緊張 −6、革新派 +3）', reject: '断る（関係 −12）' },
};

export function demandText(n: Neighbor, kind: DemandKind): string {
  switch (kind) {
    case 'water': return `上流の${n.name}が「川からの取水を増やしたい」と通告してきました。下流の水が減るおそれがあります`;
    case 'border': return `${n.name}が境界線の位置に異議を唱え、「山林の一部はうちの土地だ」と主張しています`;
    case 'dump': return `${n.name}が境界の近くにゴミ処分場をつくる計画を示しました`;
    case 'evacuees': return `${n.name}が大雨で被災しました。被災者の受け入れと応援を求めています`;
  }
}

// ---------- ふるさと納税 ----------
export interface FurusatoState {
  /** 返礼品の割合（寄付額に対して） */
  rate: number;
  /** 先月の寄付額 */
  received: number;
  /** 先月の返礼品と事務の費用 */
  gifts: number;
  /** 先月、住民がほかの町に寄付して減った住民税 */
  lost: number;
  /** 3 割を超えている月数 */
  overMonths: number;
  /** 制度から外されている期限（日） */
  excludedUntil: number;
}

export const FURUSATO_LIMIT = 0.3;
export const FURUSATO_RATES = [0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5];

export interface DiplomacyState {
  furusato: FurusatoState;
  demands: DiploDemand[];
  /** 県に仲裁を頼める日 */
  mediateDay: number;
}

export const newDiplomacy = (): DiplomacyState => ({
  furusato: { rate: 0.3, received: 0, gifts: 0, lost: 0, overMonths: 0, excludedUntil: 0 },
  demands: [],
  mediateDay: 0,
});

/** 返礼品の魅力。割合が高いほど、特産品が多いほど寄付が集まる */
const pull = (rate: number, goods: number) => Math.pow(rate, 1.2) * (0.3 + goods);

export interface FurusatoInput {
  day: number;
  population: number;
  /** 市の特産品の多さ 0〜1（工業と商業の大きさ） */
  goods: number;
  /** 住民税の月の収入 */
  resTax: number;
}

/** 月ごとのふるさと納税。寄付と返礼品の費用、住民の流出で減る住民税を計算する */
export function furusatoMonth(f: FurusatoState, r: RegionState, m: FurusatoInput): { net: number; lost: number } {
  const others = active(r);
  const ours = pull(f.rate, m.goods + 0.3);
  const theirs = others.reduce((s, n) => s + pull(n.furusatoRate, NEIGHBOR_KINDS[n.kind].gifts), 0);
  const share = ours / (ours + theirs + 0.35);
  const pool = 3_000 + m.population * 0.3;
  f.received = m.day < f.excludedUntil ? 0 : Math.round(pool * share);
  f.gifts = Math.round(f.received * (f.rate + 0.1));
  const avgOther = others.length ? others.reduce((s, n) => s + n.furusatoRate, 0) / others.length : 0.3;
  f.lost = Math.round(m.resTax * (0.02 + 0.1 * avgOther));
  if (f.rate > FURUSATO_LIMIT + 1e-9) f.overMonths++;
  else f.overMonths = 0;
  return { net: f.received - f.gifts, lost: f.lost };
}

/** 隣町どうしの返礼品競争。こちらが勝ちすぎると、隣町も割合を上げて関係が冷える */
export function furusatoRivals(f: FurusatoState, r: RegionState, rand: () => number): string[] {
  const out: string[] = [];
  for (const n of active(r)) {
    if (f.rate > n.furusatoRate + 0.05 && n.furusatoRate < 0.45 && rand() < 0.08) {
      n.furusatoRate = Math.round((n.furusatoRate + 0.05) * 100) / 100;
      n.relation = Math.max(-100, n.relation - 3);
      out.push(`${n.name}がふるさと納税の返礼品を増やしました（${Math.round(n.furusatoRate * 100)}％）。返礼品競争に批判も`);
    } else if (n.furusatoRate > 0.3 && rand() < 0.03) {
      n.furusatoRate = 0.3;
    }
  }
  return out;
}

// ---------- 緊張の移り変わり ----------
export interface TensionInput {
  /** こちらの軍の強さ */
  ourPower: number;
  hawkMayor: boolean;
  warEnabled: boolean;
  day: number;
}

/** 緊張の上限（協定や設定による） */
export function tensionCap(n: Neighbor, warEnabled: boolean, day: number): number {
  let cap = 100;
  if (!warEnabled) cap = 79;
  if (n.treaties.includes('nonaggression') || day < n.truceUntil) cap = Math.min(cap, 59);
  if (day < n.vassalUntil) cap = Math.min(cap, 30);
  return cap;
}

/** 月ごとの緊張と軍備の変化 */
export function tensionMonth(n: Neighbor, m: TensionInput, rand: () => number): void {
  const def = NEIGHBOR_KINDS[n.kind];
  let d = n.relation < -10 ? -n.relation / 50 : n.relation > 30 ? -1.5 : -0.6;
  d += (def.army - 1) * 0.4;
  if (m.hawkMayor) d += 1.5;
  // 軍備に大きな差があると強気になる（抑止）。軍の小さな町は強気になれない
  const ratio = n.military / Math.max(1, m.ourPower);
  if (ratio > 2 && n.military > 50) d += 0.4;
  else if (ratio < 0.7) d -= 0.8;
  if (n.sanction) d += 1;
  d += (rand() - 0.5) * 1.5;
  n.tension = Math.max(0, Math.min(tensionCap(n, m.warEnabled, m.day), n.tension + d));
  // 軍拡：緊張が高いほど軍備を増やす。制裁されていると伸びない
  const base = (n.population / 1000) * def.army;
  let growth = (n.tension / 100) * base * 0.5 - (n.tension < 20 ? n.military * 0.004 : 0);
  if (n.sanction) growth = growth * 0.4 - n.military * 0.004;
  // 軍拡にも限りがある（ふだんの 3 倍まで）
  n.military = Math.max(0, Math.min(armyBase(n.kind, n.population) * 3, n.military + growth));
}

/** 相手が宣戦布告に踏み切るか（勝てると見たときだけ） */
export function willAttack(n: Neighbor, ourPower: number): boolean {
  return n.military >= 20 && n.military >= ourPower * 1.2;
}

/** 協定の上限を超えている緊張を下げる（協定を結んだ直後など） */
export function clampTension(n: Neighbor, warEnabled: boolean, day: number): void {
  n.tension = Math.min(n.tension, tensionCap(n, warEnabled, day));
}

/** 合併に応じてもらえる見込み（0〜1）と、できない理由 */
export function mergeOdds(n: Neighbor, ourPop: number): { odds: number; reason?: string } {
  if (n.merged) return { odds: 0, reason: '合併済みです' };
  if (ourPop < 1_000) return { odds: 0, reason: '市の人口が 1,000 人以上必要です' };
  if (n.relation < 50) return { odds: 0, reason: '関係が 50 以上必要です' };
  if (n.tension >= 20) return { odds: 0, reason: '緊張がある間は話し合えません' };
  if (n.kind === 'village') return { odds: 0.85 };
  if (n.population > ourPop * 1.5) return { odds: 0, reason: `相手のほうがずっと大きい町です（人口 ${n.population.toLocaleString()} 人）` };
  const odds = 0.25 + (n.relation - 50) / 100 + (ourPop > n.population * 2 ? 0.2 : 0);
  return { odds: Math.max(0.05, Math.min(0.9, odds)) };
}
