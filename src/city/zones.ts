import { bbox, closestOnCurve, curveLength, arcTable, leftNormal, pointAt, tAtLength, tangentAt, type P2 } from './geometry';
import { halfWidth, sampleProfile, type RoadNetwork } from './roads';
import { HALF, heightAt, waterLevelAt, type Terrain } from '../world/terrain';

export type ZoneId = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type ZoneGroup = 'res' | 'com' | 'ind';

export interface ZoneDef {
  id: Exclude<ZoneId, 0>;
  name: string;
  short: string;
  /** 日本の都市計画図の配色に合わせる */
  color: string;
  group: ZoneGroup;
}

export const ZONES: ZoneDef[] = [
  { id: 1, name: '低層住宅', short: '低住', color: '#3cb878', group: 'res' },
  { id: 2, name: '中高層住宅', short: '中住', color: '#b5d95b', group: 'res' },
  { id: 3, name: '近隣商業', short: '近商', color: '#f5a3c1', group: 'com' },
  { id: 4, name: '商業', short: '商業', color: '#e6475a', group: 'com' },
  { id: 5, name: '準工業', short: '準工', color: '#b48ce0', group: 'ind' },
  { id: 6, name: '工業', short: '工業', color: '#5fa8e6', group: 'ind' },
];
export const zoneDef = (id: number) => ZONES.find((z) => z.id === id);

export const CELL_SIZE = 8;
export const ZONE_DEPTH = 4;

export interface Cell {
  key: string;
  seg: number;
  side: 1 | -1;
  i: number;
  depth: number;
  x: number;
  z: number;
  y: number;
  /** 道路に沿った向き（単位ベクトル） */
  ax: number;
  az: number;
  /** 道路から離れる向き */
  nx: number;
  nz: number;
  /** 手前の道路の路面の高さ */
  roadY: number;
  zone: ZoneId;
  building: number;
}

export const cellKey = (seg: number, side: number, i: number, depth: number) => `${seg}:${side}:${i}:${depth}`;

/** 道路網から区画のマスを作り直す。前のマスの用途地域は位置で引き継ぐ */
export function generateCells(net: RoadNetwork, terrain: Terrain, previous: Map<string, Cell>): Map<string, Cell> {
  const candidates: Cell[] = [];
  const segs = [...net.segments.values()];
  const curves = new Map(segs.map((s) => [s.id, net.curveOf(s)]));
  const boxes = new Map(segs.map((s) => [s.id, bbox(curves.get(s.id)!, halfWidth(s.type) + 6)]));

  const nearOtherRoad = (p: P2, own: number, ownHalf: number): boolean => {
    for (const s of segs) {
      const bb = boxes.get(s.id)!;
      if (p.x < bb.minX || p.x > bb.maxX || p.z < bb.minZ || p.z > bb.maxZ) continue;
      const d = closestOnCurve(curves.get(s.id)!, p).d;
      const limit = s.id === own ? ownHalf + 3.6 : halfWidth(s.type) + 4.2;
      if (d < limit) return true;
    }
    return false;
  };

  for (const s of segs) {
    const cv = curves.get(s.id)!;
    const len = curveLength(cv);
    const table = arcTable(cv, 64);
    const n = Math.floor(len / CELL_SIZE);
    if (n < 1) continue;
    const off = (len - n * CELL_SIZE) / 2;
    const half = halfWidth(s.type);
    for (let i = 0; i < n; i++) {
      const t = tAtLength(table, off + (i + 0.5) * CELL_SIZE);
      if (s.bridge[Math.round(t * (s.bridge.length - 1))]) continue;
      const p = pointAt(cv, t);
      const tan = tangentAt(cv, t);
      const nrm = leftNormal(tan);
      const roadY = sampleProfile(s.ys, t);
      for (const side of [1, -1] as const) {
        for (let depth = 0; depth < ZONE_DEPTH; depth++) {
          const o = half + CELL_SIZE / 2 + CELL_SIZE * depth;
          const x = p.x + nrm.x * side * o, z = p.z + nrm.z * side * o;
          if (Math.abs(x) > HALF - 5 || Math.abs(z) > HALF - 5) break;
          if (waterLevelAt(terrain, x, z) !== null) break;
          const y = heightAt(terrain, x, z);
          if (Math.abs(y - roadY) > 3 + depth * 1.5) break;
          if (nearOtherRoad({ x, z }, s.id, half)) break;
          candidates.push({
            key: cellKey(s.id, side, i, depth), seg: s.id, side, i, depth, x, z, y,
            ax: tan.x, az: tan.z, nx: nrm.x * side, nz: nrm.z * side, roadY, zone: 0, building: 0,
          });
        }
      }
    }
  }

  // 重なったマスは、道路に近い（depth が小さい）方を残す
  candidates.sort((a, b) => a.depth - b.depth || a.seg - b.seg);
  const grid = new Map<string, Cell[]>();
  const bucket = (x: number, z: number) => `${Math.floor(x / CELL_SIZE)},${Math.floor(z / CELL_SIZE)}`;
  const accepted = new Map<string, Cell>();
  for (const c of candidates) {
    if (c.depth > 0 && !accepted.has(cellKey(c.seg, c.side, c.i, c.depth - 1))) continue;
    const bx = Math.floor(c.x / CELL_SIZE), bz = Math.floor(c.z / CELL_SIZE);
    let clash = false;
    for (let dz = -1; dz <= 1 && !clash; dz++) {
      for (let dx = -1; dx <= 1 && !clash; dx++) {
        for (const o of grid.get(`${bx + dx},${bz + dz}`) ?? []) {
          if (Math.hypot(o.x - c.x, o.z - c.z) < CELL_SIZE * 0.8) { clash = true; break; }
        }
      }
    }
    if (clash) continue;
    accepted.set(c.key, c);
    const k = bucket(c.x, c.z);
    const list = grid.get(k);
    if (list) list.push(c); else grid.set(k, [c]);
  }

  // 用途地域を位置で引き継ぐ
  if (previous.size) {
    const old = new Map<string, Cell[]>();
    for (const c of previous.values()) {
      if (!c.zone) continue;
      const k = bucket(c.x, c.z);
      const list = old.get(k);
      if (list) list.push(c); else old.set(k, [c]);
    }
    for (const c of accepted.values()) {
      const bx = Math.floor(c.x / CELL_SIZE), bz = Math.floor(c.z / CELL_SIZE);
      let best: Cell | null = null, bestD = 3;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          for (const o of old.get(`${bx + dx},${bz + dz}`) ?? []) {
            const d = Math.hypot(o.x - c.x, o.z - c.z);
            if (d < bestD && Math.abs(o.ax * c.ax + o.az * c.az) > 0.85) { best = o; bestD = d; }
          }
        }
      }
      if (best) c.zone = best.zone;
    }
  }
  return accepted;
}

/** マスの 4 隅（道路沿い × 奥行き） */
export function cellCorners(c: Cell, inset = 0): P2[] {
  const h = CELL_SIZE / 2 - inset;
  return [
    { x: c.x - c.ax * h - c.nx * h, z: c.z - c.az * h - c.nz * h },
    { x: c.x + c.ax * h - c.nx * h, z: c.z + c.az * h - c.nz * h },
    { x: c.x + c.ax * h + c.nx * h, z: c.z + c.az * h + c.nz * h },
    { x: c.x - c.ax * h + c.nx * h, z: c.z - c.az * h + c.nz * h },
  ];
}
