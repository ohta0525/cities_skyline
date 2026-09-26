import { smoothstep } from '../core/noise';
import { bbox, closestOnCurve, type Curve } from './geometry';
import { sampleProfile } from './roads';
import { CELL, GRID, HALF, gridHeight, setGridHeight, waterLevelAt, type Terrain } from '../world/terrain';

export interface GridRange { i0: number; i1: number; j0: number; j1: number }

/** 道路の下と路肩の地形をならす。変えた格子の範囲を返す */
export function flattenRoad(t: Terrain, cv: Curve, ys: number[], bridge: boolean[], half: number): GridRange {
  const pad = half + 14;
  const bb = bbox(cv, pad);
  const r: GridRange = {
    i0: Math.max(0, Math.floor((bb.minX + HALF) / CELL)),
    i1: Math.min(GRID, Math.ceil((bb.maxX + HALF) / CELL)),
    j0: Math.max(0, Math.floor((bb.minZ + HALF) / CELL)),
    j1: Math.min(GRID, Math.ceil((bb.maxZ + HALF) / CELL)),
  };
  for (let j = r.j0; j <= r.j1; j++) {
    for (let i = r.i0; i <= r.i1; i++) {
      const x = i * CELL - HALF, z = j * CELL - HALF;
      const hit = closestOnCurve(cv, { x, z });
      if (hit.d > pad) continue;
      if (bridge[Math.round(hit.t * (bridge.length - 1))]) continue;
      if (waterLevelAt(t, x, z) !== null) continue;
      const w = 1 - smoothstep(half + 3, half + 14, hit.d);
      const h = gridHeight(t, i, j);
      const target = sampleProfile(ys, hit.t) - 0.08;
      setGridHeight(t, i, j, h + (target - h) * w);
    }
  }
  return r;
}
