export type ScenarioId = 'campaign' | 'sandbox' | 'tsunami' | 'village' | 'peace';

export interface ScenarioDef {
  name: string;
  /** 選ぶ画面の説明 */
  intro: string;
  /** 目標（画面上に出す） */
  goal: string;
  /** 期限（年）。なければ期限なし */
  years?: number;
}

export const SCENARIOS: Record<ScenarioId, ScenarioDef> = {
  campaign: {
    name: 'キャンペーン（100 年）', intro: '災害の多い国土で、隣町と支え合い競いながら、100 年続く街をつくる。100 年目に街が評価されます。',
    goal: '100 年続く街をつくる',
  },
  sandbox: {
    name: 'サンドボックス', intro: 'お金は使い放題。災害や紛争のあり／なしは設定で自由に変えられます。評価はありません。',
    goal: '自由に街をつくる',
  },
  tsunami: {
    name: 'シナリオ：海辺の街を津波から守れ', intro: '海辺に古い港町がある。専門家は「12 年以内に巨大津波が来る」と警告している。防潮堤と避難タワー、避難所を整え、逃げ遅れを 50 人以下に抑えよ。',
    goal: '12 年目の巨大津波で、逃げ遅れを 50 人以下に抑える', years: 12,
  },
  village: {
    name: 'シナリオ：合併した過疎の村を立て直せ', intro: '山あいの村と合併したばかり。借金を抱え、住民は年老いている。15 年のうちに人口 3,000 人の街に育てよ。財政再生団体に 1 年以上いると失敗。',
    goal: '15 年以内に人口 3,000 人。財政再生団体に 12 か月以上いない', years: 15,
  },
  peace: {
    name: 'シナリオ：隣町との紛争を戦わずに収めよ', intro: '西の軍事都市との関係は最悪で、緊張は封鎖寸前。10 年間、一度も紛争を起こさずに、緊張を「平穏」（20 未満）まで下げよ。',
    goal: '10 年間紛争を起こさず、西の町との緊張を 20 未満にする', years: 10,
  },
};

export interface ScenarioState {
  id: ScenarioId;
  /** 結果が出た */
  result: 'won' | 'lost' | null;
  /** 財政再生団体にいた月数（village） */
  bankruptMonths: number;
  note: string;
}

export const newScenario = (id: ScenarioId = 'campaign'): ScenarioState => ({ id, result: null, bankruptMonths: 0, note: '' });
