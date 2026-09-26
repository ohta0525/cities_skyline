import type { Terrain } from '../world/terrain';
import { isWooden, type Building } from './buildings';
import { liquefaction, shakingAmp } from './hazard';

export interface Fire {
  /** 燃えている建物の id */
  building: number;
  start: number;
  /** 0〜1。1 になると焼け落ちる */
  intensity: number;
  fought: boolean;
}

export interface Rubble {
  id: number;
  x: number;
  z: number;
  y: number;
  ax: number;
  az: number;
  nx: number;
  nz: number;
  w: number;
  d: number;
  cellPos: number[];
  clearDay: number;
  seed: number;
}

export interface QuakeReport {
  day: number;
  magnitude: number;
  epicenter: { x: number; z: number };
  maxShindo: string;
  collapsed: number;
  damaged: number;
  fires: number;
  evacuees: number;
  injured: number;
  liquefied: number;
  plantsStopped: number;
}

/** 気象庁の震度階級 */
export function shindoLabel(i: number): string {
  if (i < 0.5) return '0';
  if (i < 1.5) return '1';
  if (i < 2.5) return '2';
  if (i < 3.5) return '3';
  if (i < 4.5) return '4';
  if (i < 5.0) return '5弱';
  if (i < 5.5) return '5強';
  if (i < 6.0) return '6弱';
  if (i < 6.5) return '6強';
  return '7';
}

/** 計測震度の目安（マグニチュードと震源からの距離、地盤から） */
export function intensityAt(t: Terrain, magnitude: number, epi: { x: number; z: number }, x: number, z: number, depthKm = 10): number {
  const km = Math.hypot(epi.x - x, epi.z - z) / 1000;
  const r = Math.sqrt(km * km + depthKm * depthKm);
  return Math.max(0, magnitude * 1.3 - 1.4 - 2.2 * Math.log10(r + 1) + shakingAmp(t, x, z));
}

const sigmoid = (v: number) => 1 / (1 + Math.exp(-v));

/** 震度から、倒壊・損傷の確率を求める */
export function quakeDamage(b: Pick<Building, 'kind' | 'seismic' | 'fireproof' | 'floors'>, intensity: number, liq: number): { collapse: number; damage: number } {
  const wood = isWooden(b);
  let thr = b.seismic === 'old' ? (wood ? 5.8 : 6.2) : (wood ? 6.5 : 7.0);
  if (b.floors >= 8) thr += b.seismic === 'old' ? -0.1 : 0.2;
  const eff = intensity + liq * 0.6;
  const collapse = sigmoid((eff - thr) * 3);
  const damage = Math.max(0, sigmoid((eff - thr + 0.9) * 3) - collapse);
  return { collapse, damage };
}

/** 揺れのあとの出火の確率 */
export function quakeFireChance(b: Pick<Building, 'kind' | 'fireproof'>, intensity: number): number {
  if (intensity < 5) return 0;
  return (isWooden(b) ? 0.05 : 0.012) * (intensity - 4.8);
}

/** 1 年あたりの大地震（M7 前後）の起こりやすさ。前の地震から時間がたつほど上がる */
export function bigQuakeRate(yearsSince: number): number {
  return 0.012 * (1 + yearsSince / 35);
}

/** 今後 30 年以内に大地震が起きる確率 */
export function prob30(yearsSince: number): number {
  let p = 1;
  for (let y = 0; y < 30; y++) p *= 1 - bigQuakeRate(yearsSince + y);
  return 1 - p;
}

export { liquefaction };
