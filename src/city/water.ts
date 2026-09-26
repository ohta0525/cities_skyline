import { HALF, MAP_SIZE, heightAt, riverDistAt, type Terrain } from '../world/terrain';
import { landslide, riverLevelNear } from './hazard';

/**
 * 水害（洪水・内水氾濫・高潮・津波）と土砂災害。
 * 川は 160 m ごとの区間に分け、区間ごとに堤防の高さを持つ。
 * 海岸も 160 m ごとの区間に分け、区間ごとに防潮堤の高さを持つ。
 */
export const SECTION = 160;
export const RIVER_SECTIONS = Math.ceil(MAP_SIZE / SECTION);
export const COAST_SECTIONS = Math.ceil(MAP_SIZE / SECTION);
/** 堤防がないときの川岸の余裕（m） */
export const NATURAL_BANK = 3.5;
export const LEVEE_STEP = 2;
export const LEVEE_MAX = 3;
export const SEAWALL_HEIGHTS = [0, 5, 10];
export const LEVEE_COST = 20_000;
export const SEAWALL_COST = [0, 30_000, 50_000];

export const riverSection = (z: number) => Math.max(0, Math.min(RIVER_SECTIONS - 1, Math.floor((z + HALF) / SECTION)));
export const coastSection = (x: number) => Math.max(0, Math.min(COAST_SECTIONS - 1, Math.floor((x + HALF) / SECTION)));

export interface Defenses {
  /** 川の区間ごとの堤防の段階（0〜3） */
  levees: number[];
  /** 海岸の区間ごとの防潮堤の段階（0〜2） */
  seawalls: number[];
}

export const newDefenses = (): Defenses => ({ levees: new Array(RIVER_SECTIONS).fill(0), seawalls: new Array(COAST_SECTIONS).fill(0) });

export const bankProtection = (d: Defenses, sec: number) => NATURAL_BANK + (d.levees[sec] ?? 0) * LEVEE_STEP;

export function coastDistance(t: Terrain, x: number, z: number): number {
  const i = Math.min(t.coastZ.length - 1, Math.max(0, Math.round(((x + HALF) / MAP_SIZE) * (t.coastZ.length - 1))));
  return t.coastZ[i] - z;
}

export type StormKind = 'typhoon' | 'rain';

export interface StormForecast {
  /** 川の水位の上昇（m）の見込みの幅 */
  rise: [number, number];
  /** 風の強さ 0〜1 */
  wind: [number, number];
  /** 高潮（m） */
  surge: [number, number];
}

export interface Storm {
  id: number;
  kind: StormKind;
  name: string;
  /** 予報が出た日、上陸（大雨のピーク）の日、終わる日 */
  start: number;
  hit: number;
  end: number;
  forecast: StormForecast;
  /** 実際の値（上陸まで伏せておく） */
  actual: { rise: number; wind: number; surge: number };
  evacuated: boolean;
  evacDay: number;
  done: boolean;
}

/** 警戒レベル（1〜5）。上陸までの日数と予報の強さで上がる */
export function alertLevel(s: Storm, day: number): number {
  if (s.done) return 0;
  const severity = Math.max(s.forecast.rise[1] / 7, s.forecast.wind[1], s.forecast.surge[1] / 3);
  const days = s.hit - day;
  if (days <= 0) return severity > 0.6 ? 5 : 4;
  if (days <= 1) return severity > 0.5 ? 4 : 3;
  if (days <= 2) return severity > 0.5 ? 3 : 2;
  return severity > 0.4 ? 2 : 1;
}

export const ALERT_NAMES = ['', '早期注意情報', '大雨・洪水注意報', '高齢者等避難', '避難指示', '緊急安全確保'];
export const ALERT_COLORS = ['#888', '#f5f5f0', '#f2d34a', '#e0413a', '#8a3fb0', '#1b1b1b'];

/** 嵐を作る。多くは弱く、まれに強い */
export function makeStorm(kind: StormKind, id: number, day: number, number: number, rand: () => number, strength?: number): Storm {
  const s = strength ?? Math.pow(rand(), 2);
  const rise = kind === 'typhoon' ? 1 + s * 6.5 : 1.5 + s * 6;
  const wind = kind === 'typhoon' ? 0.2 + s * 0.8 : 0.05;
  const surge = kind === 'typhoon' ? 0.3 + s * 3 : 0;
  const spread = (v: number, w: number): [number, number] => [Math.max(0, v - w * (0.4 + rand() * 0.4)), v + w * (0.3 + rand() * 0.5)];
  const lead = kind === 'typhoon' ? 5 : 2;
  const grade = s > 0.8 ? '猛烈な' : s > 0.55 ? '非常に強い' : s > 0.3 ? '強い' : '';
  return {
    id, kind,
    name: kind === 'typhoon' ? `${grade}台風 ${number} 号` : '線状降水帯による大雨',
    start: day, hit: day + lead, end: day + lead + (kind === 'typhoon' ? 1 : 2),
    forecast: { rise: spread(rise, 2), wind: spread(wind, 0.25), surge: spread(surge, 1) },
    actual: { rise, wind, surge },
    evacuated: false, evacDay: 0, done: false,
  };
}

/** 川沿いの区間の、実際にあふれる高さ（m）。遊水地と地下放水路で水位の上昇を抑える */
export function effectiveRise(rise: number, z: number, retention: number, discharge: number): number {
  const v = (z + HALF) / MAP_SIZE;
  return Math.max(0, rise * (0.6 + 0.4 * v) - Math.min(3, retention * 0.7) - discharge * 1.5);
}

/** 洪水の深さ（m）。近くの川の区間で水が堤防を越えたときだけ */
export function riverFloodDepth(t: Terrain, d: Defenses, x: number, z: number, rise: number, retention: number, discharge: number): number {
  const rd = riverDistAt(t, x, z);
  if (rd > 1200) return 0;
  const sec = riverSection(z);
  let overflow = 0;
  for (let k = Math.max(0, sec - 2); k <= Math.min(RIVER_SECTIONS - 1, sec + 2); k++) {
    const zc = k * SECTION - HALF + SECTION / 2;
    overflow = Math.max(overflow, effectiveRise(rise, zc, retention, discharge) - bankProtection(d, k));
  }
  if (overflow <= 0) return 0;
  const h = heightAt(t, x, z);
  const surface = riverLevelNear(t, z) + Math.min(effectiveRise(rise, z, retention, discharge), bankProtection(d, sec) + overflow * 1.5) - rd * 0.004;
  return Math.max(0, Math.min(6, surface - h));
}

/** 高潮・津波の深さ（m）。防潮堤の高さを超えた分だけ入ってくる */
export function coastalDepth(t: Terrain, d: Defenses, x: number, z: number, wave: number): number {
  if (wave <= 0) return 0;
  const inland = coastDistance(t, x, z);
  if (inland < -20) return 0;
  const wall = SEAWALL_HEIGHTS[d.seawalls[coastSection(x)] ?? 0];
  const over = wall >= wave ? 0 : wave - wall * 0.7;
  if (over <= 0) return 0;
  const reach = over * 140;
  if (inland > reach) return 0;
  const surface = over * (1 - Math.max(0, inland) / reach);
  return Math.max(0, surface - heightAt(t, x, z));
}

/** 土砂災害で建物が壊れる確率 */
export function landslideChance(t: Terrain, x: number, z: number, rain: number, saboNear: boolean): number {
  const hz = landslide(t, x, z);
  if (hz < 0.2 || rain < 0.4) return 0;
  return hz * (rain - 0.3) * 0.6 * (saboNear ? 0.2 : 1);
}

/** 浸水の深さで被害を分ける */
export function floodDamage(depth: number, wooden: boolean): 'none' | 'below' | 'above' | 'severe' | 'collapse' {
  if (depth < 0.05) return 'none';
  if (depth < 0.5) return 'below';
  if (depth < 1.5) return 'above';
  if (depth < 3) return wooden ? 'severe' : 'above';
  return 'collapse';
}

export function yearsFromDay(day: number): number {
  return Math.floor(day / 360) + 1;
}

export { MAP_SIZE, HALF };
