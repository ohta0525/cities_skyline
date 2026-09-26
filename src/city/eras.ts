import type { BuildingKind } from './buildings';

export interface Era {
  name: string;
  from: number;
  /** 建つ建物の最大階数（種類ごと） */
  maxFloors: Partial<Record<BuildingKind, number>>;
  /** まだ建たない建物 */
  locked: BuildingKind[];
  /** 年齢構成（子ども・働く世代・高齢者） */
  ages: [number, number, number];
  headline: string;
}

export const ERAS: Era[] = [
  { name: '再建期', from: 1, maxFloors: { mansion: 5, office: 7, zakkyo: 5 }, locked: ['danchi', 'depato'], ages: [0.26, 0.62, 0.12],
    headline: '復興暦が始まる。焼け野原からの再建へ' },
  { name: '成長期', from: 21, maxFloors: { mansion: 8, office: 10, zakkyo: 7 }, locked: [], ages: [0.23, 0.66, 0.11],
    headline: '成長期へ。団地と工業地帯が街を押し広げる' },
  { name: '繁栄期', from: 41, maxFloors: { mansion: 14, office: 18 }, locked: [], ages: [0.17, 0.66, 0.17],
    headline: '繁栄期へ。地価は上がり続け、高層ビルが空を埋める' },
  { name: '成熟期', from: 61, maxFloors: { mansion: 16, office: 20 }, locked: [], ages: [0.13, 0.58, 0.29],
    headline: '成熟期へ。高齢化と空き家が新たな課題に' },
  { name: '未来期', from: 81, maxFloors: { mansion: 20, office: 24 }, locked: [], ages: [0.12, 0.56, 0.32],
    headline: '未来期へ。100 年目に向けて、街の真価が問われる' },
];

/** 新耐震基準が施行される年 */
export const SEISMIC_LAW_YEAR = 31;

export function eraOf(year: number): Era {
  let e = ERAS[0];
  for (const x of ERAS) if (year >= x.from) e = x;
  return e;
}

export const yearOf = (day: number) => Math.floor(day / 360) + 1;

/** 年齢構成を、時代の境目でなめらかにつなぐ */
export function ageMix(year: number): [number, number, number] {
  const i = ERAS.indexOf(eraOf(year));
  const a = ERAS[i], b = ERAS[Math.min(ERAS.length - 1, i + 1)];
  const f = b === a ? 0 : Math.min(1, (year - a.from) / (b.from - a.from));
  return [0, 1, 2].map((k) => a.ages[k] + (b.ages[k] - a.ages[k]) * f) as [number, number, number];
}

/** 人口で決まる市の格 */
export const RANKS = [
  { name: '市', pop: 0, grant: 0 },
  { name: '中核市', pop: 20_000, grant: 50_000 },
  { name: '政令指定都市', pop: 50_000, grant: 100_000 },
];
export function rankOf(pop: number): number {
  let r = 0;
  RANKS.forEach((x, i) => { if (pop >= x.pop) r = i; });
  return r;
}

/** 人口の節目（ニュースと補助金） */
export const MILESTONES = [500, 1000, 2500, 5000, 10000, 20000, 35000, 50000, 75000, 100000];
