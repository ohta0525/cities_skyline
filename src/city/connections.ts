import type { FactionId } from './politics';

export type NpcId = 'rail' | 'builder' | 'governor' | 'chamber' | 'reporter';

export interface Npc {
  id: NpcId;
  name: string;
  title: string;
  faction?: FactionId;
  intro: string;
  perks: { at: number; text: string }[];
}

export const NPCS: Record<NpcId, Npc> = {
  rail: {
    id: 'rail', name: '瀬川 鉄之助', title: '瑞穂電鉄 社長', faction: 'business',
    intro: '沿線の地価を上げたい私鉄の社長。仲が良くなると、鉄道の建設を私鉄が引き受けてくれる。',
    perks: [
      { at: 40, text: '鉄道の路線を私鉄に任せられる（建設費の 7 割と車両の費用を私鉄が持つ。運賃収入は私鉄のもの）' },
      { at: 70, text: '私鉄の駅のまわりで商業が育ちやすくなる（沿線開発）' },
    ],
  },
  builder: {
    id: 'builder', name: '大城 建', title: '大城建設 社長',
    intro: '地元の建設会社。公共工事がほしい。',
    perks: [
      { at: 50, text: '道路と線路の建設費が 15％安くなる' },
      { at: 70, text: '災害のがれきの片付けが 2 倍速くなる' },
    ],
  },
  governor: {
    id: 'governor', name: '水野 静香', title: '県知事',
    intro: '県の予算を握る知事。防災に熱心。',
    perks: [
      { at: 50, text: '県からの補助金が毎月 300万円増える' },
      { at: 70, text: '毎年 1 億円の特別補助金' },
    ],
  },
  chamber: {
    id: 'chamber', name: '金森 商太郎', title: '商工会議所 会頭', faction: 'business',
    intro: '街の商店や企業の代表。法人の税に厳しい。',
    perks: [{ at: 30, text: '関係が良いほど経済界の支持が上がる' }],
  },
  reporter: {
    id: 'reporter', name: '真田 記子', title: '地元紙 記者',
    intro: '市政を追いかける記者。疑惑を見逃さない。',
    perks: [{ at: 50, text: '疑惑がスクープされにくくなる（半分）' }],
  },
};

export type ActionId = 'dinner' | 'visit' | 'favor';

export const ACTIONS: Record<ActionId, { name: string; cost: number; rel: number; suspicion: number; cooldown: number; note: string }> = {
  dinner: { name: '会食', cost: 200, rel: 8, suspicion: 3, cooldown: 60, note: '料亭で会食する（200万円、疑惑度 +3）' },
  visit: { name: '視察に同行', cost: 0, rel: 4, suspicion: 0, cooldown: 120, note: '現場を一緒に見て回る（費用なし）' },
  favor: { name: '便宜を図る', cost: 1_000, rel: 20, suspicion: 14, cooldown: 180, note: '相手の得になるよう取り計らう（1,000万円、疑惑度 +14）' },
};

export type RequestKind = 'stationCommercial' | 'publicWorks' | 'drill' | 'bizTax' | 'disclosure';

export interface NpcRequest {
  npc: NpcId;
  kind: RequestKind;
  text: string;
  expires: number;
}

export const REQUESTS: Record<NpcId, { kind: RequestKind; text: string; effect: string }> = {
  rail: { kind: 'stationCommercial', text: '「駅前をにぎやかにしたい。駅のまわりを商業地域にしてくれませんか」', effect: '駅のまわり 120 m を商業地域に塗る（関係 +15、疑惑度 +4）' },
  builder: { kind: 'publicWorks', text: '「公共事業をもう少し回してもらえませんか」', effect: '1 億円の公共事業を発注する（関係 +18、疑惑度 +8）' },
  governor: { kind: 'drill', text: '「県の防災訓練に協力してほしい」', effect: '500万円を負担する（関係 +12、保守・伝統の支持 +3）' },
  chamber: { kind: 'bizTax', text: '「法人の税を 1％下げてもらえないか」', effect: '法人の税を 1％下げる（関係 +15）' },
  reporter: { kind: 'disclosure', text: '「市の会議録を公開してもらえませんか」', effect: '情報を公開する（関係 +10、疑惑度 −10、経済界の支持 −3）' },
};

export interface ConnectionsState {
  rel: Record<NpcId, number>;
  /** 疑惑度 0〜100 */
  suspicion: number;
  cooldowns: Record<string, number>;
  requests: NpcRequest[];
  scoops: number;
  /** リコールの住民投票を行う日 */
  recallDay: number;
  lastGrantYear: number;
}

export const newConnections = (): ConnectionsState => ({
  rel: { rail: 10, builder: 20, governor: 20, chamber: 20, reporter: 0 },
  suspicion: 0, cooldowns: {}, requests: [], scoops: 0, recallDay: 0, lastGrantYear: 0,
});

export const relOf = (c: ConnectionsState, id: NpcId) => c.rel[id] ?? 0;
