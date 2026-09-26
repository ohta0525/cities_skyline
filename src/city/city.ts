import { mulberry32 } from '../core/rng';
import type { Terrain } from '../world/terrain';
import { KINDS, kindsForZone, weightedOrder, type Building, type BuildingKind } from './buildings';
import { Districts, type District } from './districts';
import type { P2 } from './geometry';
import { RoadNetwork, halfWidth, type RoadPlan, type RoadType, type Snap, type RoadNode, type RoadSegment } from './roads';
import { flattenRoad, type GridRange } from './terrainEdit';
import { CELL_SIZE, ZONES, cellKey, generateCells, type Cell, type ZoneGroup, type ZoneId } from './zones';

export interface Demand { res: number; com: number; ind: number }

export interface CityStats {
  population: number;
  comJobs: number;
  indJobs: number;
  buildings: number;
  demand: Demand;
}

export interface CityData {
  roads: { nextId: number; nodes: RoadNode[]; segments: RoadSegment[] };
  zones: number[];
  buildings: Building[];
  nextBuildingId: number;
  districts: { list: District[]; grid: string };
}

const clamp = (v: number) => Math.max(-100, Math.min(100, v));

/**
 * 街の状態（道路、区画、建物、地区）と、その変化のルール。
 * 描画は versions の変化を見て作り直す。
 */
export class City {
  readonly net: RoadNetwork;
  cells = new Map<string, Cell>();
  buildings = new Map<number, Building>();
  districts = new Districts();
  day = 0;
  stats: CityStats = { population: 0, comJobs: 0, indJobs: 0, buildings: 0, demand: { res: 45, com: 20, ind: 25 } };
  /** 変更のたびに増える番号。描画側はこれを見て作り直す */
  versions = { roads: 0, cells: 0, buildings: 0, districts: 0 };
  /** 地形を変えた範囲（描画側が取り出して反映する） */
  terrainChanges: GridRange[] = [];
  private nextBuildingId = 1;
  private rand: () => number;

  constructor(public terrain: Terrain, seed = 1) {
    this.net = new RoadNetwork(terrain);
    this.rand = mulberry32(seed ^ 0x51ed270b);
  }

  // ---------- 道路 ----------
  snap(p: P2, enabled = true): Snap {
    return this.net.snap(p, enabled);
  }

  planRoad(start: Snap, end: Snap, control: P2 | null, type: RoadType): RoadPlan {
    return this.net.plan(start, end, control, type);
  }

  buildRoad(plan: RoadPlan): number[] {
    const ids = this.net.build(plan);
    for (const id of ids) this.flatten(id);
    this.afterRoadChange();
    return ids;
  }

  removeRoad(segId: number): void {
    this.net.removeSegment(segId);
    this.afterRoadChange();
  }

  private flatten(segId: number): void {
    const s = this.net.segments.get(segId)!;
    this.terrainChanges.push(flattenRoad(this.terrain, this.net.curveOf(s), s.ys, s.bridge, halfWidth(s.type)));
  }

  private afterRoadChange(): void {
    const old = this.cells;
    this.cells = generateCells(this.net, this.terrain, old);
    this.rehomeBuildings();
    this.versions.roads++;
    this.versions.cells++;
    this.recount();
  }

  /** 道路が変わったあと、建物を新しいマスに載せ直す。載らない建物は取り壊す */
  private rehomeBuildings(): void {
    const index = this.cellIndex();
    let removed = false;
    for (const b of this.buildings.values()) {
      const keys: string[] = [];
      for (let k = 0; k < b.cellPos.length; k += 2) {
        const c = this.findCell(index, b.cellPos[k], b.cellPos[k + 1]);
        if (!c || c.building || c.zone !== b.zone) break;
        c.building = b.id;
        keys.push(c.key);
      }
      if (keys.length * 2 !== b.cellPos.length) {
        for (const k of keys) this.cells.get(k)!.building = 0;
        this.buildings.delete(b.id);
        removed = true;
        continue;
      }
      b.cells = keys;
    }
    if (removed || this.buildings.size) this.versions.buildings++;
  }

  private cellIndex(): Map<string, Cell[]> {
    const idx = new Map<string, Cell[]>();
    for (const c of this.cells.values()) {
      const k = `${Math.floor(c.x / CELL_SIZE)},${Math.floor(c.z / CELL_SIZE)}`;
      const list = idx.get(k);
      if (list) list.push(c); else idx.set(k, [c]);
    }
    return idx;
  }

  private findCell(idx: Map<string, Cell[]>, x: number, z: number): Cell | null {
    const bx = Math.floor(x / CELL_SIZE), bz = Math.floor(z / CELL_SIZE);
    let best: Cell | null = null, bestD = 2.5;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const c of idx.get(`${bx + dx},${bz + dz}`) ?? []) {
          const d = Math.hypot(c.x - x, c.z - z);
          if (d < bestD) { best = c; bestD = d; }
        }
      }
    }
    return best;
  }

  // ---------- 区画 ----------
  /** 円の中のマスを塗る（zone = 0 で解除）。変わったマスの数を返す */
  paintZone(center: P2, radius: number, zone: ZoneId): number {
    let changed = 0;
    for (const c of this.cells.values()) {
      if (Math.abs(c.x - center.x) > radius || Math.abs(c.z - center.z) > radius) continue;
      if (Math.hypot(c.x - center.x, c.z - center.z) > radius) continue;
      if (c.zone === zone) continue;
      if (c.building) this.removeBuilding(c.building);
      c.zone = zone;
      changed++;
    }
    if (changed) { this.versions.cells++; this.recount(); }
    return changed;
  }

  // ---------- 建物 ----------
  removeBuilding(id: number): void {
    const b = this.buildings.get(id);
    if (!b) return;
    for (const k of b.cells) {
      const c = this.cells.get(k);
      if (c) c.building = 0;
    }
    this.buildings.delete(id);
    this.versions.buildings++;
    this.versions.cells++;
    this.recount();
  }

  /** 日付を進める。1 日ごとに建物が建つ */
  advanceTo(day: number): void {
    const target = Math.floor(day);
    // 長く止まっていたあとでも一度に建てすぎない
    let from = Math.max(this.day, target - 30);
    while (from < target) {
      from++;
      this.growDay(from);
    }
    this.day = Math.max(this.day, target);
  }

  private growDay(day: number): void {
    const d = this.stats.demand;
    const groups: [ZoneGroup, number][] = [['res', d.res], ['com', d.com], ['ind', d.ind]];
    let built = false;
    for (const [group, demand] of groups) {
      if (demand <= 0) continue;
      const zones = new Set(ZONES.filter((z) => z.group === group).map((z) => z.id as number));
      const fronts = [...this.cells.values()].filter((c) => c.depth === 0 && !c.building && zones.has(c.zone));
      if (!fronts.length) continue;
      const attempts = Math.ceil(demand / 30);
      for (let a = 0; a < attempts; a++) {
        const c = fronts[Math.floor(this.rand() * fronts.length)];
        if (c.building) continue;
        if (this.tryBuild(c, day)) { built = true; this.recount(); }
      }
    }
    if (built) this.versions.buildings++;
  }

  private tryBuild(front: Cell, day: number): boolean {
    const kinds = weightedOrder(kindsForZone(front.zone), (k) => KINDS[k].weight, this.rand);
    for (const kind of kinds) {
      const def = KINDS[kind];
      const lots = weightedOrder(def.lots, () => 1, this.rand);
      for (const [w, d] of lots) {
        const cells = this.fitLot(front, w, d);
        if (cells) { this.place(kind, front.zone as Exclude<ZoneId, 0>, cells, w, d, day); return true; }
      }
    }
    return false;
  }

  private fitLot(front: Cell, w: number, d: number): Cell[] | null {
    const out: Cell[] = [];
    for (let k = 0; k < w; k++) {
      for (let dd = 0; dd < d; dd++) {
        const c = this.cells.get(cellKey(front.seg, front.side, front.i + k, dd));
        if (!c || c.building || c.zone !== front.zone) return null;
        out.push(c);
      }
    }
    return out;
  }

  private place(kind: BuildingKind, zone: Exclude<ZoneId, 0>, cells: Cell[], w: number, d: number, day: number): void {
    const fronts = cells.filter((c) => c.depth === 0);
    let x = 0, z = 0, y = 0, ax = 0, az = 0, nx = 0, nz = 0;
    for (const c of fronts) {
      x += c.x - c.nx * CELL_SIZE / 2; z += c.z - c.nz * CELL_SIZE / 2;
      y += c.roadY; ax += c.ax; az += c.az; nx += c.nx; nz += c.nz;
    }
    const n = fronts.length;
    const la = Math.hypot(ax, az) || 1, ln = Math.hypot(nx, nz) || 1;
    const def = KINDS[kind];
    const floors = def.floors[0] + Math.floor(this.rand() * (def.floors[1] - def.floors[0] + 1));
    const id = this.nextBuildingId++;
    const b: Building = {
      id, kind, zone, x: x / n, z: z / n, y: y / n + 0.15,
      ax: ax / la, az: az / la, nx: nx / ln, nz: nz / ln, w, d, floors,
      seed: Math.floor(this.rand() * 0xffffffff), day,
      cells: cells.map((c) => c.key), cellPos: cells.flatMap((c) => [c.x, c.z]),
      residents: def.residents(floors, w, d), jobs: def.jobs(floors, w, d),
    };
    for (const c of cells) c.building = id;
    this.buildings.set(id, b);
  }

  // ---------- 地区 ----------
  newDistrict(): District {
    const d = this.districts.newDistrict(this.rand);
    this.versions.districts++;
    return d;
  }

  paintDistrict(center: P2, radius: number, id: number): void {
    if (this.districts.paint(center, radius, id)) this.versions.districts++;
  }

  renameDistrict(id: number, name: string): void {
    const d = this.districts.get(id);
    if (d && name.trim()) { d.name = name.trim().slice(0, 12); this.versions.districts++; }
  }

  removeDistrict(id: number): void {
    this.districts.remove(id);
    this.versions.districts++;
  }

  // ---------- 集計 ----------
  recount(): void {
    let population = 0, comJobs = 0, indJobs = 0;
    for (const b of this.buildings.values()) {
      population += b.residents;
      if (b.zone === 3 || b.zone === 4) comJobs += b.jobs;
      else indJobs += b.jobs;
    }
    const jobs = comJobs + indJobs;
    this.stats = {
      population, comJobs, indJobs, buildings: this.buildings.size,
      demand: {
        res: clamp(45 + (jobs - population * 0.5) * 0.35),
        com: clamp(20 + (population * 0.18 - comJobs) * 0.9),
        ind: clamp(25 + (population * 0.25 - indJobs) * 0.7),
      },
    };
  }

  // ---------- 保存 ----------
  toJSON(): CityData {
    const zones: number[] = [];
    for (const c of this.cells.values()) {
      if (c.zone) zones.push(Math.round(c.x * 10) / 10, Math.round(c.z * 10) / 10, c.zone);
    }
    return {
      roads: this.net.toJSON(),
      zones,
      buildings: [...this.buildings.values()],
      nextBuildingId: this.nextBuildingId,
      districts: { list: this.districts.list.map((d) => ({ ...d })), grid: this.districts.encode() },
    };
  }

  /** 保存データから復元する。地形は生成し直したものを渡すこと（道路の造成をやり直す） */
  load(data: CityData, day: number): void {
    this.net.load(data.roads);
    for (const id of [...this.net.segments.keys()].sort((a, b) => a - b)) this.flatten(id);
    this.cells = generateCells(this.net, this.terrain, new Map());
    const idx = this.cellIndex();
    for (let k = 0; k < data.zones.length; k += 3) {
      const c = this.findCell(idx, data.zones[k], data.zones[k + 1]);
      if (c) c.zone = data.zones[k + 2] as ZoneId;
    }
    this.buildings = new Map(data.buildings.map((b) => [b.id, { ...b }]));
    this.nextBuildingId = data.nextBuildingId;
    this.rehomeBuildings();
    this.districts.list = data.districts.list.map((d) => ({ ...d }));
    this.districts.decode(data.districts.grid);
    this.day = Math.floor(day);
    this.versions.roads++; this.versions.cells++; this.versions.buildings++; this.versions.districts++;
    this.recount();
  }
}
