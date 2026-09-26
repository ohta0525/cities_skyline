export type FactionId = 'business' | 'labor' | 'tradition' | 'progress' | 'green' | 'defense';

export interface Faction {
  id: FactionId;
  name: string;
  leader: string;
  wants: string;
  color: string;
}

export const FACTIONS: Faction[] = [
  { id: 'business', name: '経済界', leader: '商工会議所会頭', wants: '法人の税を下げる、雇用と企業を増やす', color: '#e0a93b' },
  { id: 'labor', name: '労働者', leader: '労働組合委員長', wants: '失業を減らす、住民税を下げる', color: '#d9573f' },
  { id: 'tradition', name: '保守・伝統', leader: '町内会長', wants: '低い町並み、安定した財政', color: '#8c6d4f' },
  { id: 'progress', name: '革新', leader: '市民団体代表', wants: '暮らしの満足度、公約を守る市政', color: '#4f8fd9' },
  { id: 'green', name: '環境', leader: '環境団体代表', wants: '公害を減らす、緑を残す', color: '#3ea865' },
  { id: 'defense', name: '防衛', leader: '防衛隊司令', wants: '健全な財政と備え（防衛隊は P6 で登場）', color: '#6b7a8f' },
];

export type AiMayorType = 'doken' | 'eco' | 'populist' | 'hawk';

export const AI_MAYORS: Record<AiMayorType, { name: string; title: string; style: string; favored: FactionId[] }> = {
  doken: { name: '大工原 剛', title: '土建屋', style: '道路を次々に引き、公共事業で借金を増やす', favored: ['business', 'labor'] },
  eco: { name: '森川 みどり', title: 'エコ', style: '工業地域を住宅に塗り替えて工場を減らす', favored: ['green', 'progress'] },
  populist: { name: '甘利 誠', title: 'ポピュリスト', style: '税を大きく下げ、足りない分は市債で埋める', favored: ['labor', 'progress'] },
  hawk: { name: '武田 厳', title: 'タカ派', style: '防衛費を積み上げ、税を上げる', favored: ['defense', 'tradition'] },
};

export type PledgeId = 'taxcut' | 'jobs' | 'green';
export const PLEDGES: Record<PledgeId, { name: string; promise: string; boost: FactionId[] }> = {
  taxcut: { name: '減税', promise: '任期中、住民税を今より上げない', boost: ['labor', 'business'] },
  jobs: { name: '雇用', promise: '次の選挙までに失業率を 5％未満にする', boost: ['labor', 'progress'] },
  green: { name: '緑の街', promise: '任期中、工業の割合を今より増やさない', boost: ['green', 'tradition'] },
};

export interface Modifier {
  faction: FactionId | 'all';
  amount: number;
  until: number;
  reason: string;
}

export interface ElectionResult {
  year: number;
  player: number;
  opponent: number;
  opponentName: string;
  won: boolean;
  byFaction: Record<FactionId, number>;
}

export interface PoliticsState {
  support: Record<FactionId, number>;
  share: Record<FactionId, number>;
  approval: number;
  /** 'player' ならプレイヤーが市長。それ以外は AI 市長の任期中 */
  mayor: 'player' | AiMayorType;
  /** 次の選挙の相手（選挙の 3 か月前に決まる） */
  challenger: AiMayorType | null;
  pledge: { id: PledgeId; baseline: number; madeYear: number } | null;
  pledgeChoiceOpen: boolean;
  modifiers: Modifier[];
  elections: ElectionResult[];
  /** 野党としての活動が次に使える日 */
  cooldowns: Record<string, number>;
  /** 署名活動で AI 市長の施策を止めている期限 */
  blockAiUntil: number;
}

const ids = FACTIONS.map((f) => f.id);
const record = (v: number) => Object.fromEntries(ids.map((id) => [id, v])) as Record<FactionId, number>;

export function newPolitics(): PoliticsState {
  return {
    support: record(55), share: record(1 / ids.length), approval: 55, mayor: 'player', challenger: null,
    pledge: null, pledgeChoiceOpen: false, modifiers: [], elections: [], cooldowns: {}, blockAiUntil: 0,
  };
}

export interface PoliticalMetrics {
  day: number;
  unemployment: number;
  happiness: number;
  pollution: number;
  lowriseShare: number;
  industryShare: number;
  comShare: number;
  elderlyShare: number;
  taxes: { res: number; biz: number; prop: number };
  bankrupt: boolean;
  moneyHealthy: boolean;
  debtRatio: number;
  jobsGrowth: number;
  /** 警察が届いていない住民の割合 */
  crime?: number;
  /** 教育が届いている住民の割合 */
  education?: number;
  /** 施設・政策・布告による上乗せ */
  extra?: Partial<Record<FactionId, number>>;
}

const clamp = (v: number) => Math.max(0, Math.min(100, v));

/** 月ごとに派閥の支持と割合、全体の支持率を計算し直す */
export function updateSupport(p: PoliticsState, m: PoliticalMetrics): void {
  p.modifiers = p.modifiers.filter((x) => x.until > m.day);
  const mod = (id: FactionId) => p.modifiers.filter((x) => x.faction === id || x.faction === 'all').reduce((s, x) => s + x.amount, 0) + (m.extra?.[id] ?? 0);
  const broke = m.bankrupt ? -18 : 0;
  const raw: Record<FactionId, number> = {
    business: 55 + (10 - m.taxes.biz) * 4 + Math.max(-15, Math.min(15, m.jobsGrowth * 0.3)) + broke,
    labor: 62 - m.unemployment * 220 + (10 - m.taxes.res) * 3.5 + broke * 0.5,
    tradition: 52 + (m.lowriseShare - 0.5) * 30 + (m.moneyHealthy ? 6 : -8) - m.debtRatio * 10 + broke - (m.crime ?? 0) * 14,
    progress: 45 + (m.happiness - 50) * 0.5 + broke * 0.5 + ((m.education ?? 0.5) - 0.5) * 12,
    green: 62 - m.pollution * 90 - m.industryShare * 25,
    defense: 50 + (m.moneyHealthy ? 5 : -5) + broke * 0.5,
  };
  for (const id of ids) p.support[id] = clamp(raw[id] + mod(id));
  const share: Record<FactionId, number> = {
    business: 0.1 + m.comShare * 0.12,
    labor: 0.2 + m.industryShare * 0.15,
    tradition: 0.14 + m.elderlyShare * 0.3,
    progress: 0.16,
    green: 0.13,
    defense: 0.08,
  };
  const total = ids.reduce((s, id) => s + share[id], 0);
  for (const id of ids) p.share[id] = share[id] / total;
  p.approval = ids.reduce((s, id) => s + p.share[id] * p.support[id], 0);
}

export function addModifier(p: PoliticsState, faction: FactionId | 'all', amount: number, until: number, reason: string): void {
  p.modifiers.push({ faction, amount, until, reason });
}

/** 選挙の年か（5 年目、9 年目…の 4 月 1 日） */
export const isElectionYear = (year: number) => year > 1 && (year - 1) % 4 === 0;

/** 公約が守られたか */
export function pledgeKept(p: PoliticsState, m: { resTax: number; unemployment: number; industryShare: number }): boolean | null {
  if (!p.pledge) return null;
  if (p.pledge.id === 'taxcut') return m.resTax <= p.pledge.baseline + 1e-6;
  if (p.pledge.id === 'jobs') return m.unemployment < 0.05;
  return m.industryShare <= p.pledge.baseline + 0.02;
}

/**
 * 選挙。プレイヤー（現職または挑戦者）の得票率を派閥ごとに求める。
 * rand は -1〜1 のゆらぎ。
 */
export function runElection(p: PoliticsState, year: number, opponent: AiMayorType, kept: boolean | null, rand: () => number): ElectionResult {
  const byFaction = record(0);
  const incumbent = p.mayor === 'player';
  for (const f of FACTIONS) {
    // 挑戦者のときは、AI 市長への不満がそのまま追い風になる
    let s = incumbent ? p.support[f.id] : 100 - p.support[f.id] + 8;
    if (p.pledge && PLEDGES[p.pledge.id].boost.includes(f.id)) s += 8;
    if (AI_MAYORS[opponent].favored.includes(f.id)) s -= 8;
    if (kept === true) s += 5;
    if (kept === false) s -= 12;
    byFaction[f.id] = clamp(s + (rand() * 2 - 1) * 6);
  }
  const player = FACTIONS.reduce((s, f) => s + p.share[f.id] * byFaction[f.id], 0);
  const result: ElectionResult = {
    year, player, opponent: 100 - player, opponentName: `${AI_MAYORS[opponent].name}（${AI_MAYORS[opponent].title}）`,
    won: player >= 50, byFaction,
  };
  p.elections.push(result);
  p.mayor = result.won ? 'player' : opponent;
  p.pledge = null;
  p.challenger = null;
  return result;
}

export const OPPOSITION_ACTIONS = {
  speech: { name: '街頭演説', effect: '労働者・革新の支持 +6（1 年）', cooldown: 180 },
  petition: { name: '署名活動', effect: 'AI 市長の施策を半年止める', cooldown: 360 },
  column: { name: '地元紙に寄稿', effect: '保守・革新の支持 +6（1 年）', cooldown: 180 },
} as const;
export type OppositionAction = keyof typeof OPPOSITION_ACTIONS;
