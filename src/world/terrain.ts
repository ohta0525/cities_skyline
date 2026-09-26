import { createNoise2D, fbm, lerp, smoothstep } from '../core/noise';
import { mulberry32 } from '../core/rng';

/**
 * 地形の生成と参照。
 * 座標はメートル。x は東、z は南が正。地図の中心が原点。
 * プリセット「河川平野＋海岸」：北に山、中央に平野、川が南の湾に注ぐ。
 */
export const MAP_SIZE = 2048;
export const GRID = 256;
export const CELL = MAP_SIZE / GRID;
export const HALF = MAP_SIZE / 2;
export const SEA_LEVEL = 0;
export const BASE_Y = -60;

export type TerrainPreset = 'river-coast';

export interface RiverPoint {
  x: number;
  z: number;
  /** 川幅（m） */
  width: number;
  /** 水面の高さ（m） */
  level: number;
}

export interface Terrain {
  seed: number;
  preset: TerrainPreset;
  /** (GRID+1)² 個の標高。行優先（z が行） */
  heights: Float32Array;
  /** 森の濃さ 0〜1。heights と同じ並び */
  forest: Float32Array;
  /** 川の中心線からの距離（m）。川がない行は大きな値。heights と同じ並び */
  riverDist: Float32Array;
  /** 北から南へ並んだ川の中心線 */
  river: RiverPoint[];
  /** 各 x 列ごとの海岸線の z 座標 */
  coastZ: Float32Array;
}

const N = GRID + 1;
const RIVER_STEPS = 512;

export function generateTerrain(seed: number, preset: TerrainPreset = 'river-coast'): Terrain {
  const rand = mulberry32(seed);
  const nBase = createNoise2D(rand);
  const nRidge = createNoise2D(rand);
  const nCoast = createNoise2D(rand);
  const nRiver = createNoise2D(rand);
  const nForest = createNoise2D(rand);
  const phase = rand() * Math.PI * 2;

  // u: 西 0 → 東 1、v: 北 0 → 南 1
  const coastV = (u: number) =>
    0.8 + 0.045 * fbm(nCoast, u * 3, 0.5, 3) - 0.07 * Math.exp(-(((u - 0.6) / 0.11) ** 2));
  const riverU = (v: number) =>
    0.42 + 0.18 * v + 0.06 * Math.sin(v * 9 + phase) + 0.025 * nRiver(v * 5, 3.7);

  const baseHeight = (u: number, v: number): number => {
    const plain = 5 + 4 * fbm(nBase, u * 4, v * 4, 4);
    const mountain = smoothstep(0.55, 0.02, v);
    const ridged = 1 - Math.abs(fbm(nRidge, u * 3.2, v * 3.2, 5));
    const peaks = Math.pow(mountain, 1.4) * (40 + 170 * ridged * ridged);
    // 東西の端にゆるい丘
    const edge = smoothstep(0.22, 0, u) + smoothstep(0.8, 1, u);
    const hills = edge * (10 + 25 * (0.5 + 0.5 * fbm(nBase, u * 6 + 9, v * 6, 3)));
    return plain + peaks + hills * (1 - mountain * 0.5);
  };

  const shoreHeight = (h: number, u: number, v: number): number => {
    const dc = v - coastV(u);
    if (dc <= 0) return lerp(h, 1.2, smoothstep(-0.035, 0, dc));
    return lerp(1.2, -24 + 4 * fbm(nBase, u * 5, v * 5, 2), smoothstep(0, 0.07, dc));
  };

  // 川の中心線。水面は下流に向かって下がり続けるようにする
  const river: RiverPoint[] = [];
  let level = Infinity;
  for (let s = 0; s <= RIVER_STEPS; s++) {
    const v = s / RIVER_STEPS;
    const u = riverU(v);
    const ground = shoreHeight(baseHeight(u, v), u, v);
    level = Math.min(level, ground - 2);
    // 河口の手前までは川底が海面より上に来るようにする（低い平野では堤防で囲まれた川になる）
    const floor = 0.4 + 2.6 * smoothstep(0, 0.08, coastV(u) - v);
    level = Math.max(level, floor);
    const mouth = v > coastV(u);
    river.push({
      x: u * MAP_SIZE - HALF,
      z: v * MAP_SIZE - HALF,
      width: 18 + 40 * v * v,
      level: mouth ? SEA_LEVEL : Math.max(0.4, level),
    });
    if (mouth && v > coastV(u) + 0.05) break;
  }

  const heights = new Float32Array(N * N);
  const forest = new Float32Array(N * N);
  const riverDist = new Float32Array(N * N).fill(1e5);
  for (let j = 0; j < N; j++) {
    const v = j / GRID;
    // この行に最も近い川の点（川はほぼ南北に流れる）
    const rs = Math.min(river.length - 1, Math.round(v * RIVER_STEPS));
    const rp = river[rs];
    const prev = river[Math.max(0, rs - 1)], next = river[Math.min(river.length - 1, rs + 1)];
    const slope = (next.x - prev.x) / Math.max(1e-6, next.z - prev.z);
    const cosA = 1 / Math.sqrt(1 + slope * slope);
    const riverActive = v <= coastV(rp.x / MAP_SIZE + 0.5) + 0.01;
    for (let i = 0; i < N; i++) {
      const u = i / GRID;
      const x = u * MAP_SIZE - HALF;
      const mountain = smoothstep(0.55, 0.02, v);
      let h = shoreHeight(baseHeight(u, v), u, v);
      let dRiver = 1e5;
      if (riverActive) {
        dRiver = Math.abs(x - rp.x) * cosA;
        const half = rp.width / 2;
        const bank = 24 + 90 * mountain;
        if (dRiver < half + bank) {
          h = lerp(rp.level + 0.6, h, smoothstep(half, half + bank, dRiver));
        }
        if (dRiver < half) {
          const k = dRiver / half;
          h = rp.level - 2.6 * (1 - k * k);
        }
      }
      heights[j * N + i] = h;
      riverDist[j * N + i] = dRiver;

      const f = 0.5 + 0.5 * fbm(nForest, u * 7, v * 7, 3);
      const wet = dRiver < rp.width / 2 + 12 || h < 2;
      forest[j * N + i] = wet ? 0 : smoothstep(0.5, 0.75, f + mountain * 0.35) * (h > 185 ? 0 : 1);
    }
  }

  const coastZ = new Float32Array(N);
  for (let i = 0; i < N; i++) coastZ[i] = coastV(i / GRID) * MAP_SIZE - HALF;

  return { seed, preset, heights, forest, riverDist, river, coastZ };
}

function sampleGrid(arr: Float32Array, x: number, z: number): number {
  const gx = Math.min(GRID - 1e-6, Math.max(0, (x + HALF) / CELL));
  const gz = Math.min(GRID - 1e-6, Math.max(0, (z + HALF) / CELL));
  const i = Math.floor(gx), j = Math.floor(gz);
  const fx = gx - i, fz = gz - j;
  const a = arr[j * N + i], b = arr[j * N + i + 1];
  const c = arr[(j + 1) * N + i], d = arr[(j + 1) * N + i + 1];
  return lerp(lerp(a, b, fx), lerp(c, d, fx), fz);
}

/** 任意の地点の標高（双線形補間） */
export function heightAt(t: Terrain, x: number, z: number): number {
  return sampleGrid(t.heights, x, z);
}

export function riverDistAt(t: Terrain, x: number, z: number): number {
  return sampleGrid(t.riverDist, x, z);
}

export function forestAt(t: Terrain, x: number, z: number): number {
  return sampleGrid(t.forest, x, z);
}

export function insideMap(x: number, z: number): boolean {
  return x >= -HALF && x <= HALF && z >= -HALF && z <= HALF;
}

/** 格子点 (i, j) の標高 */
export function gridHeight(t: Terrain, i: number, j: number): number {
  return t.heights[j * N + i];
}

/** 地点の種類（画面下の表示用） */
export function landKind(t: Terrain, x: number, z: number): string {
  const h = heightAt(t, x, z);
  if (h < SEA_LEVEL) return '海';
  if (sampleGrid(t.riverDist, x, z) < 10) return '川';
  if (h < 2.5) return '海岸';
  if (h > 120) return '山地';
  if (h > 30) return '丘陵';
  return forestAt(t, x, z) > 0.5 ? '森' : '平野';
}
