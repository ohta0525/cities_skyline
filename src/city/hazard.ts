import { smoothstep } from '../core/noise';
import { HALF, MAP_SIZE, heightAt, riverDistAt, type Terrain } from '../world/terrain';

/**
 * ハザード（地形から見た災害の危険度）。地点ごとに 0〜1、浸水は想定の深さ（m）。
 */
export function riverLevelNear(t: Terrain, z: number): number {
  const k = Math.min(t.river.length - 1, Math.max(0, Math.round(((z + HALF) / MAP_SIZE) * 512)));
  return t.river[k].level;
}

function coastDist(t: Terrain, x: number, z: number): number {
  const i = Math.min(t.coastZ.length - 1, Math.max(0, Math.round(((x + HALF) / MAP_SIZE) * (t.coastZ.length - 1))));
  return t.coastZ[i] - z;
}

/** 洪水・高潮で想定される浸水の深さ（m） */
export function floodDepth(t: Terrain, x: number, z: number): number {
  const h = heightAt(t, x, z);
  if (h < 0) return 0;
  let d = 0;
  const rd = riverDistAt(t, x, z);
  if (rd < 380) d = Math.max(d, (riverLevelNear(t, z) + 4 - h) * (1 - smoothstep(140, 380, rd)));
  const cd = coastDist(t, x, z);
  if (cd < 500) d = Math.max(d, (3.5 - h) * (1 - smoothstep(200, 500, cd)));
  return Math.max(0, Math.min(5, d));
}

/** 液状化のしやすさ（海岸や川沿いの低い土地） */
export function liquefaction(t: Terrain, x: number, z: number): number {
  const h = heightAt(t, x, z);
  if (h < 0) return 0;
  const coast = (1 - smoothstep(100, 400, coastDist(t, x, z))) * (1 - smoothstep(2, 6, h));
  const river = (1 - smoothstep(40, 160, riverDistAt(t, x, z))) * (1 - smoothstep(riverLevelNear(t, z) + 2, riverLevelNear(t, z) + 5, h));
  return Math.max(coast, river);
}

/** 土砂災害の危険度（急な斜面） */
export function landslide(t: Terrain, x: number, z: number): number {
  const s = 6;
  const dx = (heightAt(t, x + s, z) - heightAt(t, x - s, z)) / (2 * s);
  const dz = (heightAt(t, x, z + s) - heightAt(t, x, z - s)) / (2 * s);
  const slope = Math.hypot(dx, dz);
  return smoothstep(0.35, 0.8, slope) * smoothstep(8, 20, heightAt(t, x, z));
}

/** 地震の揺れやすさ（柔らかい地盤ほど揺れる）。震度に足す値 */
export function shakingAmp(t: Terrain, x: number, z: number): number {
  const h = heightAt(t, x, z);
  return 0.5 * (1 - smoothstep(5, 40, h)) + 0.3 * liquefaction(t, x, z) - 0.3 * smoothstep(60, 140, h);
}
