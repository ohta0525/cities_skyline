import { mulberry32 } from '../core/rng';
import type { Terrain } from '../world/terrain';
import { KINDS, buildingValue, isWooden, kindsForZone, weightedOrder, type Building, type BuildingKind } from './buildings';
import { FACILITIES, type Facility, type FacilityKind } from './facilities';
import { computeServices, type ServiceReport } from './services';
import { bigQuakeRate, intensityAt, liquefaction, quakeDamage, quakeFireChance, shindoLabel, type Fire, type QuakeReport, type Rubble } from './disasters';
import { DECREES, POLICIES, decreeActive, hasPolicy, newPolicies, type DecreeId, type PolicyId, type PolicyState } from './policies';
import type { FactionId } from './politics';
import { computeTraffic, EMPTY_TRAFFIC, type TrafficResult } from './traffic';
import {
  MODES, findCrossings, newTransit, ridership, roadPath, snapStopToRoad, trackCost, trackCurve, trackFor, trackPath, trackProfile,
  transitObstacles, type Crossing, type Line, type Ridership, type Stop, type TrackLevel, type TransitMode, type TransitState,
} from './transit';
import { ACTIONS, NPCS, REQUESTS, newConnections, type ActionId, type ConnectionsState, type NpcId } from './connections';
import type { NodeControl } from './roads';
import {
  ALERT_NAMES, LEVEE_COST, bankProtection, effectiveRise, LEVEE_MAX, SEAWALL_COST, SEAWALL_HEIGHTS, alertLevel, coastDistance, coastSection, coastalDepth,
  floodDamage, landslideChance, makeStorm, newDefenses, riverFloodDepth, riverSection, type Defenses, type Storm, type StormKind,
} from './water';
import { floodDepth as hazardFlood } from './hazard';
import { heightAt, waterLevelAt } from '../world/terrain';
import { Districts, type District } from './districts';
import {
  DEFAULT_TAXES, ROAD_COST, BRIDGE_FACTOR, ROAD_REFUND, closeMonth, formatYen, newEconomy, planCost, refund, setTax, spend, takeLoan,
  type EconomyState, type TaxKey,
} from './economy';
import { ERAS, MILESTONES, RANKS, SEISMIC_LAW_YEAR, ageMix, eraOf, rankOf, yearOf } from './eras';
import { curveLength, type P2 } from './geometry';
import { pushNews, type NewsItem, type NewsKind } from './news';
import {
  AI_MAYORS, OPPOSITION_ACTIONS, PLEDGES, addModifier, isElectionYear, newPolitics, pledgeKept, runElection, updateSupport,
  type AiMayorType, type ElectionResult, type OppositionAction, type PledgeId, type PoliticsState,
} from './politics';
import {
  BORDER, STAGE_NAMES, active, canTrade, commute, monthlyRegion, neighborJobs, neighborWorkers, newRegion, normalizeRegion, ownerAt, stageOf, tradeIncome,
  updateConnections, type Edge, type Neighbor, type RegionState, type TreatyId,
} from './region';
import {
  DEMANDS, DIPLO_ACTIONS, TREATIES, clampTension, willAttack, demandText, furusatoMonth, furusatoRivals, mergeOdds, newDiplomacy, tensionMonth, treatyBlock,
  type DemandKind, type DiploActionId, type DiplomacyState,
} from './diplomacy';
import {
  UNITS, UNITS_PER_GARRISON, newDefense, ourPower, peaceTerms, unitCount, upkeepOf, warStep,
  type DefenseState, type UnitKind, type VictoryChoice, type War, type WarResult,
} from './defense';
import { IMPORT } from './services';
import { HALF } from '../world/terrain';
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
  /** 子ども・働く世代・高齢者 */
  ages: [number, number, number];
  workers: number;
  unemployed: number;
  unemployment: number;
  /** 人が足りずに埋まらない仕事 */
  shortage: number;
  commuteOut: number;
  commuteIn: number;
  /** 隣町で受け入れてもらえる働き口の見込み */
  commuteCapacity: number;
  happiness: number;
  /** 工業の近くに住む人の割合 */
  pollution: number;
  oldSeismicShare: number;
}

export interface CityMeta {
  rank: number;
  milestone: number;
  aiStartDay: number;
  lastQuakeYear?: number;
  lastUtilityWarn?: number;
}

export interface FacilityPlan {
  ok: boolean;
  reason?: string;
  kind: FacilityKind;
  cells: Cell[];
  cost: number;
  /** 敷地の正面の中央と向き（見本の表示用） */
  x: number; z: number; y: number; ax: number; az: number; nx: number; nz: number;
}

export interface CityData {
  roads: { nextId: number; nodes: RoadNode[]; segments: RoadSegment[] };
  zones: number[];
  buildings: Building[];
  nextBuildingId: number;
  districts: { list: District[]; grid: string };
  economy?: EconomyState;
  politics?: PoliticsState;
  region?: RegionState;
  news?: NewsItem[];
  meta?: CityMeta;
  facilities?: Facility[];
  nextFacilityId?: number;
  fires?: Fire[];
  rubble?: Rubble[];
  policies?: PolicyState;
  quakes?: QuakeReport[];
  defenses?: Defenses;
  storms?: Storm[];
  disasterReports?: DisasterReport[];
  displaced?: number;
  restricted?: Restricted[];
  stormNo?: number;
  transit?: { stops: Stop[]; tracks: import('./transit').Track[]; lines: Line[]; nextId: number };
  connections?: ConnectionsState;
  diplomacy?: DiplomacyState;
  defense?: DefenseState;
}

export interface DisasterReport {
  day: number;
  kind: 'typhoon' | 'rain' | 'tsunami' | 'nuclear';
  title: string;
  /** 浸水（床下・床上）、全壊、損傷、土砂災害、逃げ遅れ（救助された人）、家を失った人 */
  below: number;
  above: number;
  collapsed: number;
  damaged: number;
  landslides: number;
  stranded: number;
  displaced: number;
  breaches: number;
  evacuated: boolean;
  aid: number;
  note: string;
}

/** 立ち入りが制限された区域（原発事故） */
export interface Restricted { x: number; z: number; r: number; until: number }

/** 水が引くまで表示する浸水の範囲 */
export interface FloodView { day: number; until: number; wave: number; rise: number; kind: 'river' | 'coast' }

export const NODE_CONTROL_COST: Record<NodeControl, number> = { auto: 0, turnlane: 300, grade: 50_000 };
export const NODE_CONTROL_NAMES: Record<NodeControl, string> = { auto: '信号', turnlane: '右折レーン付き信号', grade: '立体交差' };

const clamp = (v: number) => Math.max(-100, Math.min(100, v));
const clamp01 = (v: number) => Math.max(0, Math.min(100, v));

const EMPTY_STATS: CityStats = {
  population: 0, comJobs: 0, indJobs: 0, buildings: 0, demand: { res: 45, com: 20, ind: 25 },
  ages: [0, 0, 0], workers: 0, unemployed: 0, unemployment: 0, shortage: 0, commuteOut: 0, commuteIn: 0,
  commuteCapacity: 0, happiness: 60, pollution: 0, oldSeismicShare: 0,
};

/**
 * 街の状態（道路、区画、建物、地区、財政、政治、隣町）と、その変化のルール。
 * 描画は versions の変化を見て作り直す。
 */
export class City {
  readonly net: RoadNetwork;
  cells = new Map<string, Cell>();
  buildings = new Map<number, Building>();
  districts = new Districts();
  econ: EconomyState = newEconomy();
  politics: PoliticsState = newPolitics();
  region: RegionState;
  news: NewsItem[] = [];
  meta: CityMeta = { rank: 0, milestone: -1, aiStartDay: 0 };
  facilities = new Map<number, Facility>();
  fires: Fire[] = [];
  rubble: Rubble[] = [];
  policies: PolicyState = newPolicies();
  quakes: QuakeReport[] = [];
  services: ServiceReport | null = null;
  /** 災害を起こすかどうか（設定） */
  disastersEnabled = true;
  transit: TransitState = newTransit();
  traffic: TrafficResult = EMPTY_TRAFFIC;
  riders: Ridership | null = null;
  crossings: Crossing[] = [];
  connections: ConnectionsState = newConnections();
  defenses: Defenses = newDefenses();
  storms: Storm[] = [];
  disasterReports: DisasterReport[] = [];
  displaced = 0;
  restricted: Restricted[] = [];
  diplomacy: DiplomacyState = newDiplomacy();
  defense: DefenseState = newDefense();
  /** 設定で戦争をなくせる（平和モード） */
  warEnabled = true;
  /** 合併のときに建物を一気に建てる間は、電気や水道の不足で建ちにくくならない */
  private seeding = false;
  flood: FloodView | null = null;
  private stormNo = 0;
  private dispatchUntil = 0;
  private trafficDirty = true;
  private nextFacilityId = 1;
  private nextRubbleId = 1;
  day = 0;
  stats: CityStats = { ...EMPTY_STATS };
  /** 変更のたびに増える番号。描画側はこれを見て作り直す */
  versions = { roads: 0, cells: 0, buildings: 0, districts: 0, economy: 0, news: 0, facilities: 0, fires: 0, services: 0, transit: 0, traffic: 0, water: 0, territory: 0, war: 0 };
  /** 地形を変えた範囲（描画側が取り出して反映する） */
  terrainChanges: GridRange[] = [];
  /** 画面に知らせたい出来事（選挙結果など）。描画側が取り出す */
  events: (
    | { type: 'election'; result: ElectionResult }
    | { type: 'quake'; report: QuakeReport }
    | { type: 'disaster'; report: DisasterReport }
    | { type: 'war'; kind: 'declared' | 'won' | 'lost' | 'peace' | 'merged' | 'refused'; name: string; text: string }
  )[] = [];
  private nextBuildingId = 1;
  private rand: () => number;
  private lastJobs = 0;

  constructor(public terrain: Terrain, seed = 1) {
    this.net = new RoadNetwork(terrain);
    this.rand = mulberry32(seed ^ 0x51ed270b);
    this.region = newRegion(mulberry32(seed ^ 0x2545f491));
  }

  get year(): number {
    return yearOf(this.day);
  }

  private say(text: string, kind: NewsKind = 'info'): void {
    pushNews(this.news, this.day, text, kind);
    this.versions.news++;
  }

  /** プレイヤーが街を作れない理由（なければ null） */
  blockedReason(): string | null {
    if (this.politics.mayor !== 'player') return `今は ${AI_MAYORS[this.politics.mayor].name} 市長の任期中です。次の選挙で返り咲いてください`;
    return null;
  }

  // ---------- 道路 ----------
  snap(p: P2, enabled = true): Snap {
    return this.net.snap(p, enabled);
  }

  planRoad(start: Snap, end: Snap, control: P2 | null, type: RoadType): RoadPlan {
    const plan = this.net.plan(start, end, control, type);
    if (!plan.ok) return plan;
    // 隣町の土地には道路を引けない（境界までは引ける）
    const c = plan.curve;
    for (let k = 0; k <= 16; k++) {
      const t = k / 16, u = 1 - t;
      const x = u * u * c.p0.x + 2 * u * t * c.c.x + t * t * c.p2.x;
      const z = u * u * c.p0.z + 2 * u * t * c.c.z + t * t * c.p2.z;
      const n = ownerAt(this.region, x, z);
      if (n) return { ...plan, ok: false, reason: `ここから先は${n.name}の土地です（合併すると使えます）` };
    }
    return plan;
  }

  /** 市の土地か（隣町の土地でない） */
  ownsLand(p: P2): boolean {
    return !ownerAt(this.region, p.x, p.z);
  }

  roadCost(plan: RoadPlan): number {
    return Math.round(planCost(plan) * this.buildDiscount());
  }

  /** 建設会社との関係が良いと安くなる */
  buildDiscount(): number {
    return this.connections.rel.builder >= 50 ? 0.85 : 1;
  }

  /** 道路を作れるか（お金・市長・財政）。できなければ理由 */
  checkRoad(plan: RoadPlan): string | null {
    if (!plan.ok) return plan.reason ?? 'ここには置けません';
    const blocked = this.blockedReason();
    if (blocked) return blocked;
    if (this.econ.bankrupt) return '財政再生団体のため、新しい道路は作れません';
    const cost = this.roadCost(plan);
    if (cost > this.econ.money) return `資金が足りません（必要 ${formatYen(cost)}）`;
    return null;
  }

  buildRoad(plan: RoadPlan): number[] {
    const cost = this.roadCost(plan);
    const ids = this.net.build(plan);
    if (!ids.length) return ids;
    spend(this.econ, cost);
    for (const id of ids) this.flatten(id);
    this.afterRoadChange();
    return ids;
  }

  removeRoad(segId: number): void {
    const s = this.net.segments.get(segId);
    if (!s) return;
    const len = curveLength(this.net.curveOf(s));
    const bridgeShare = s.bridge.filter(Boolean).length / Math.max(1, s.bridge.length);
    refund(this.econ, len * ROAD_COST[s.type] * (1 + (BRIDGE_FACTOR - 1) * bridgeShare) * ROAD_REFUND);
    this.net.removeSegment(segId);
    this.afterRoadChange();
  }

  private flatten(segId: number): void {
    const s = this.net.segments.get(segId)!;
    this.terrainChanges.push(flattenRoad(this.terrain, this.net.curveOf(s), s.ys, s.bridge, halfWidth(s.type)));
  }

  private afterRoadChange(): void {
    const old = this.cells;
    this.cells = generateCells(this.net, this.terrain, old, transitObstacles(this.transit));
    this.rehomeFacilities();
    this.rehomeBuildings();
    updateConnections(this.region, this.net);
    this.rehomeStops();
    this.refreshServices();
    this.trafficDirty = true;
    this.versions.roads++;
    this.versions.cells++;
    this.versions.economy++;
    this.recount();
  }

  /** 道路が変わったあと、施設とがれきを新しいマスに載せ直す */
  private rehomeFacilities(): void {
    const index = this.cellIndex();
    for (const f of this.facilities.values()) {
      const keys: string[] = [];
      for (let k = 0; k < f.cellPos.length; k += 2) {
        const c = this.findCell(index, f.cellPos[k], f.cellPos[k + 1]);
        if (!c || c.facility) break;
        c.facility = f.id;
        keys.push(c.key);
      }
      if (keys.length * 2 !== f.cellPos.length) {
        for (const k of keys) this.cells.get(k)!.facility = 0;
        this.facilities.delete(f.id);
        this.say(`道路の変更で${FACILITIES[f.kind].name}が使えなくなり、取り壊されました`, 'bad');
        continue;
      }
      f.cells = keys;
    }
    this.rubble = this.rubble.filter((r) => {
      const cs: Cell[] = [];
      for (let k = 0; k < r.cellPos.length; k += 2) {
        const c = this.findCell(index, r.cellPos[k], r.cellPos[k + 1]);
        if (c && !c.facility) cs.push(c);
      }
      for (const c of cs) c.building = -r.id;
      return cs.length > 0;
    });
    this.versions.facilities++;
    this.versions.fires++;
  }

  /** 道路が変わったあと、建物を新しいマスに載せ直す。載らない建物は取り壊す */
  private rehomeBuildings(): void {
    const index = this.cellIndex();
    for (const b of this.buildings.values()) {
      const keys: string[] = [];
      for (let k = 0; k < b.cellPos.length; k += 2) {
        const c = this.findCell(index, b.cellPos[k], b.cellPos[k + 1]);
        if (!c || c.building || c.facility || c.zone !== b.zone) break;
        c.building = b.id;
        keys.push(c.key);
      }
      if (keys.length * 2 !== b.cellPos.length) {
        for (const k of keys) this.cells.get(k)!.building = 0;
        this.buildings.delete(b.id);
        continue;
      }
      b.cells = keys;
    }
    this.versions.buildings++;
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
  /** 円の中のマスを塗る（zone = 0 で解除）。onlyEmpty なら未指定のマスだけ。変わったマスの数を返す */
  paintZone(center: P2, radius: number, zone: ZoneId, onlyEmpty = false): number {
    let changed = 0;
    for (const c of this.cells.values()) {
      if (Math.abs(c.x - center.x) > radius || Math.abs(c.z - center.z) > radius) continue;
      if (Math.hypot(c.x - center.x, c.z - center.z) > radius) continue;
      if (c.zone === zone || (onlyEmpty && c.zone) || c.facility || (zone && this.isRestricted(c))) continue;
      if (zone && !this.ownsLand(c)) continue;
      if (c.building > 0) this.removeBuilding(c.building);
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

  /** 日付を進める。1 日ごとに建物が建ち、月末に財政・政治・隣町を締める */
  advanceTo(day: number): void {
    const target = Math.floor(day);
    // 長く止まっていたあとでも一度に進めすぎない
    let d = Math.max(this.day, target - 90);
    while (d < target) {
      d++;
      this.day = d;
      this.growDay(d);
      this.disasterDay(d);
      this.stormDay(d);
      this.warDay(d);
      if (this.trafficDirty && d % 3 === 0) this.refreshTraffic();
      if (d % 30 === 0) this.monthly(d);
      if (d % 360 === 0) this.yearly(d);
    }
    this.day = Math.max(this.day, target);
  }

  private growDay(day: number): void {
    const d = this.stats.demand;
    const groups: [ZoneGroup, number][] = [['res', d.res], ['com', d.com], ['ind', d.ind]];
    let built = false;
    const before = this.buildings.size;
    for (const [group, demand] of groups) {
      if (demand <= 0) continue;
      const zones = new Set(ZONES.filter((z) => z.group === group).map((z) => z.id as number));
      const fronts = [...this.cells.values()].filter((c) => c.depth === 0 && !c.building && !c.facility && zones.has(c.zone) && !this.isRestricted(c));
      if (!fronts.length) continue;
      const attempts = Math.ceil(demand / 30);
      for (let a = 0; a < attempts; a++) {
        const c = fronts[Math.floor(this.rand() * fronts.length)];
        if (c.building) continue;
        if (this.tryBuild(c, day)) { built = true; this.recount(); }
      }
    }
    if (built) {
      if (before === 0) this.say('街に最初の建物が建ちました', 'good');
      this.versions.buildings++;
    }
  }

  private tryBuild(front: Cell, day: number): boolean {
    // 電気や水道が足りないと建ちにくい
    const u = this.services?.util;
    if (!this.seeding && u && (u.power.served < 0.6 || u.water.served < 0.6) && this.rand() < 0.7) return false;
    const district = this.districts.at(front)?.id ?? 0;
    if (hasPolicy(this.policies, district, 'fireproof') && this.rand() < 0.2) return false;
    const era = eraOf(yearOf(day));
    const lowOnly = hasPolicy(this.policies, district, 'heightLimit');
    const allowed = kindsForZone(front.zone).filter((k) => !era.locked.includes(k) && (!lowOnly || KINDS[k].floors[0] <= 4));
    const kinds = weightedOrder(allowed, (k) => KINDS[k].weight, this.rand);
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
        if (!c || c.building || c.facility || c.zone !== front.zone) return null;
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
    const year = yearOf(day);
    const district = this.districts.at({ x: x / n, z: z / n })?.id ?? 0;
    // 駅前は高くなる（私鉄と仲が良いと、私鉄の駅前はさらに）
    const st = this.nearestStation({ x: x / n, z: z / n }, 280);
    const bonus = st && (zone === 2 || zone === 4) ? (st.private && this.connections.rel.rail >= 70 ? 4 : 2) : 0;
    let hi = Math.min(def.floors[1], eraOf(year).maxFloors[kind] ?? def.floors[1]) + bonus;
    if (hasPolicy(this.policies, district, 'heightLimit')) hi = Math.min(hi, 4);
    hi = Math.max(def.floors[0], hi);
    const floors = def.floors[0] + Math.floor(this.rand() * (hi - def.floors[0] + 1));
    const id = this.nextBuildingId++;
    const b: Building = {
      id, kind, zone, x: x / n, z: z / n, y: y / n + 0.15,
      ax: ax / la, az: az / la, nx: nx / ln, nz: nz / ln, w, d, floors,
      seed: Math.floor(this.rand() * 0xffffffff), day,
      cells: cells.map((c) => c.key), cellPos: cells.flatMap((c) => [c.x, c.z]),
      residents: def.residents(floors, w, d), jobs: def.jobs(floors, w, d),
      built: year, seismic: year >= SEISMIC_LAW_YEAR ? 'new' : 'old',
      fireproof: hasPolicy(this.policies, district, 'fireproof') && isWooden({ kind, fireproof: false }),
      damagedUntil: 0,
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

  // ---------- 財政 ----------
  setTax(key: TaxKey, value: number): number {
    if (this.blockedReason()) return this.econ.taxes[key];
    const v = setTax(this.econ, key, value);
    this.versions.economy++;
    this.recount();
    return v;
  }

  borrow(amount: number): string | null {
    if (this.blockedReason()) return this.blockedReason();
    const r = takeLoan(this.econ, amount);
    this.versions.economy++;
    if (typeof r === 'string') return r;
    this.say(`市債 ${formatYen(amount)} を発行しました（10 年で返済）`);
    return null;
  }

  // ---------- 政治 ----------
  choosePledge(id: PledgeId): void {
    const p = this.politics;
    if (!p.pledgeChoiceOpen) return;
    const baseline = id === 'taxcut' ? this.econ.taxes.res : id === 'green' ? this.industryShare() : 0;
    p.pledge = { id, baseline, madeYear: this.year };
    p.pledgeChoiceOpen = false;
    this.say(`公約「${PLEDGES[id].name}」を掲げました：${PLEDGES[id].promise}`, 'politics');
    this.versions.economy++;
  }

  /** 野党としての活動。できなければ理由 */
  opposition(action: OppositionAction): string | null {
    const p = this.politics;
    if (p.mayor === 'player') return '今はあなたが市長です';
    const ready = p.cooldowns[action] ?? 0;
    if (this.day < ready) return `次にできるのは ${Math.ceil((ready - this.day) / 30)} か月後です`;
    p.cooldowns[action] = this.day + OPPOSITION_ACTIONS[action].cooldown;
    const year = this.day + 360;
    // 挑戦者の得票は「AI 市長への不支持」なので、下げたい派閥の支持を下げる
    if (action === 'speech') { addModifier(p, 'labor', -6, year, '街頭演説'); addModifier(p, 'progress', -6, year, '街頭演説'); }
    if (action === 'column') { addModifier(p, 'tradition', -6, year, '地元紙への寄稿'); addModifier(p, 'progress', -6, year, '地元紙への寄稿'); }
    if (action === 'petition') p.blockAiUntil = this.day + 180;
    this.say(`${OPPOSITION_ACTIONS[action].name}を行いました：${OPPOSITION_ACTIONS[action].effect}`, 'politics');
    this.versions.economy++;
    return null;
  }

  private industryShare(): number {
    const jobs = this.stats.comJobs + this.stats.indJobs;
    return jobs ? this.stats.indJobs / jobs : 0;
  }

  // ---------- 月と年の締め ----------
  private monthly(day: number): void {
    updateConnections(this.region, this.net);
    this.refreshServices();
    this.refreshTraffic();
    const transitMoney = this.transitMonth();
    this.policyMonth(day);
    this.recount();
    const s = this.stats;

    // 財政
    let buildingValueSum = 0;
    for (const b of this.buildings.values()) buildingValueSum += buildingValue(b);
    const roadLength: Record<RoadType, number> = { alley: 0, local: 0, avenue: 0 };
    for (const seg of this.net.segments.values()) roadLength[seg.type] += curveLength(this.net.curveOf(seg));
    const mayor = this.politics.mayor;
    const aiActive = mayor !== 'player' && day > this.politics.blockAiUntil;
    const wasBankrupt = this.econ.bankrupt;
    const dm = this.diplomacyMoney(day);
    closeMonth(this.econ, {
      day,
      residents: s.population,
      jobs: s.comJobs + s.indJobs - s.shortage,
      buildingValue: buildingValueSum,
      roadLength,
      trade: tradeIncome(this.region, s.indJobs, s.comJobs) + dm.arms,
      grant: 300 + s.population * 0.05 + (this.connections.rel.governor >= 50 ? 300 : 0) + dm.grant,
      defense: upkeepOf(this.defense),
      services: [...this.facilities.values()].reduce((a, f) => a + FACILITIES[f.kind].upkeep, 0),
      imports: Math.max(0, (this.services?.importCost ?? 0) - dm.importDiscount),
      furusato: dm.furusato,
      furusatoOut: dm.furusatoOut,
      tributeIn: dm.tributeIn,
      tributeOut: dm.tributeOut,
      policies: this.policyCost(),
      transitIncome: transitMoney.income,
      transitCost: transitMoney.cost,
    });
    this.connectionsMonth(day);
    this.waterMonth(day);
    if (!wasBankrupt && this.econ.bankrupt) this.say('財政再生団体に転落しました。新しい道路は作れず、税率も下げられません', 'bad');
    if (wasBankrupt && !this.econ.bankrupt) this.say('財政再生団体から脱しました', 'good');

    // 隣町
    monthlyRegion(this.region, this.rand);
    this.diplomacyMonth(day);

    // 政治
    const jobs = s.comJobs + s.indJobs;
    let lowrise = 0, res = 0;
    for (const b of this.buildings.values()) if (b.residents) { res++; if (b.floors <= 3) lowrise++; }
    updateSupport(this.politics, {
      day,
      unemployment: s.unemployment,
      happiness: s.happiness,
      pollution: s.pollution,
      lowriseShare: res ? lowrise / res : 1,
      industryShare: this.industryShare(),
      comShare: jobs ? s.comJobs / jobs : 0,
      elderlyShare: s.population ? s.ages[2] / s.population : 0.12,
      taxes: this.econ.taxes,
      bankrupt: this.econ.bankrupt,
      moneyHealthy: this.econ.money > 0,
      debtRatio: Math.min(1, this.econ.loans.reduce((a, l) => a + l.remaining, 0) / 300_000),
      jobsGrowth: jobs - this.lastJobs,
      crime: this.services?.crime ?? 0,
      education: this.services?.coverage.education ?? 0,
      extra: this.factionExtra(day),
    });
    const u = this.services?.util;
    if (u && this.buildings.size > 20 && day - (this.meta.lastUtilityWarn ?? -999) >= 180) {
      const short = (['power', 'water'] as const).filter((k) => u[k].served < 0.9);
      if (short.length) {
        this.meta.lastUtilityWarn = day;
        this.say(`${short.map((k) => (k === 'power' ? '電気' : '水道')).join('と')}が足りません。発電所や浄水場を建てるか、隣町と道路でつないで買いましょう`, 'bad');
      }
    }
    this.lastJobs = jobs;
    if (aiActive) this.aiMonth(mayor as AiMayorType, day);

    // 選挙の 3 か月前：公約と対立候補
    const nextYear = yearOf(day) + 1;
    if (day % 360 === 270 && isElectionYear(nextYear)) {
      const p = this.politics;
      if (p.mayor === 'player') {
        const types = Object.keys(AI_MAYORS) as AiMayorType[];
        p.challenger = types[Math.floor(this.rand() * types.length)];
        this.say(`市長選挙まであと 3 か月。${AI_MAYORS[p.challenger].name}（${AI_MAYORS[p.challenger].title}）が立候補を表明`, 'politics');
      } else {
        this.say('市長選挙まであと 3 か月。返り咲きを目指して公約を掲げましょう', 'politics');
      }
      p.pledgeChoiceOpen = true;
      for (const n of active(this.region)) {
        if (n.relation >= -30) continue;
        addModifier(p, 'all', -4, day + 100, `${n.name}の選挙介入`);
        this.say(`仲の悪い${n.name}が対立候補を支援しているとの報道。市長選に影を落とす`, 'politics');
      }
    }

    // 人口の節目と市の格
    while (this.meta.milestone + 1 < MILESTONES.length && s.population >= MILESTONES[this.meta.milestone + 1]) {
      this.meta.milestone++;
      const m = MILESTONES[this.meta.milestone];
      const grant = 2_000 * (this.meta.milestone + 1);
      refund(this.econ, grant);
      this.say(`人口が ${m.toLocaleString()} 人を突破。国から ${formatYen(grant)} の補助金`, 'good');
    }
    const rank = rankOf(s.population);
    if (rank > this.meta.rank) {
      this.meta.rank = rank;
      refund(this.econ, RANKS[rank].grant);
      this.say(`${RANKS[rank].name}に昇格しました。国から ${formatYen(RANKS[rank].grant)} の交付金`, 'good');
    }
    this.versions.economy++;
    this.recount();
  }

  private yearly(day: number): void {
    const year = yearOf(day);
    const era = ERAS.find((e) => e.from === year);
    if (era && year > 1) this.say(`【時代】${era.headline}`, 'era');
    if (year === SEISMIC_LAW_YEAR) this.say('建築基準法が改正され、新耐震基準が施行されました。これより前の建物は旧耐震です', 'era');
    // AI 市長の年ごとの施策
    const p = this.politics;
    if (p.mayor !== 'player' && day > p.blockAiUntil) {
      const t = this.econ.taxes;
      if (p.mayor === 'doken') setTax(this.econ, 'prop', t.prop + 0.1);
      if (p.mayor === 'eco') setTax(this.econ, 'biz', t.biz + 0.5);
      if (p.mayor === 'hawk') setTax(this.econ, 'res', t.res + 0.5);
    }
    if (isElectionYear(year)) this.election(year);
  }

  private election(year: number): void {
    const p = this.politics;
    const wasPlayer = p.mayor === 'player';
    const types = Object.keys(AI_MAYORS) as AiMayorType[];
    const opponent: AiMayorType = wasPlayer ? (p.challenger ?? types[Math.floor(this.rand() * types.length)]) : (p.mayor as AiMayorType);
    const kept = wasPlayer ? pledgeKept(p, { resTax: this.econ.taxes.res, unemployment: this.stats.unemployment, industryShare: this.industryShare() }) : null;
    if (kept === true) this.say('公約を守ったことが評価されています', 'politics');
    if (kept === false) this.say('公約違反を批判する声が広がっています', 'politics');
    p.pledgeChoiceOpen = false;
    const result = runElection(p, year, opponent, kept, this.rand);
    const pct = (v: number) => `${v.toFixed(1)}％`;
    if (wasPlayer && result.won) this.say(`市長選挙で再選。得票率 ${pct(result.player)}`, 'politics');
    else if (wasPlayer) {
      this.meta.aiStartDay = this.day;
      this.say(`市長選挙で落選。${result.opponentName}が新市長に（得票率 ${pct(result.opponent)}）。4 年後の返り咲きを目指します`, 'politics');
      if (opponent === 'populist') { setTax(this.econ, 'res', 6); setTax(this.econ, 'biz', 7); this.say('新市長が大幅な減税を発表', 'politics'); }
    } else if (result.won) this.say(`市長選挙で返り咲き。得票率 ${pct(result.player)}`, 'politics');
    else this.say(`市長選挙で再び敗れました。${result.opponentName}が続投`, 'politics');
    this.events.push({ type: 'election', result });
    this.versions.economy++;
  }

  /** AI 市長の月ごとの施策 */
  private aiMonth(type: AiMayorType, day: number): void {
    if (type === 'doken') {
      const nodes = [...this.net.nodes.values()];
      if (!nodes.length || this.econ.money < 20_000) return;
      const n = nodes[Math.floor(this.rand() * nodes.length)];
      const ang = Math.floor(this.rand() * 4) * (Math.PI / 2);
      const len = 64 + Math.floor(this.rand() * 8) * 8;
      const end = { x: n.x + Math.cos(ang) * len, z: n.z + Math.sin(ang) * len };
      const plan = this.planRoad({ kind: 'node', id: n.id, p: { x: n.x, z: n.z } }, this.snap(end), null, 'local');
      if (!plan.ok || planCost(plan) > this.econ.money * 0.3) return;
      this.buildRoad(plan);
      const zone = (1 + Math.floor(this.rand() * 6)) as ZoneId;
      this.paintZone({ x: (n.x + end.x) / 2, z: (n.z + end.z) / 2 }, 40, zone, true);
      if (this.rand() < 0.3) this.say('市長が新しい道路の建設を発表。「公共事業で街を元気に」', 'politics');
    } else if (type === 'eco') {
      const ind = [...this.cells.values()].filter((c) => c.zone === 5 || c.zone === 6).slice(0, 12);
      if (!ind.length) return;
      for (const c of ind) {
        if (c.building) this.removeBuilding(c.building);
        c.zone = 1;
      }
      this.versions.cells++;
      if (this.rand() < 0.4) this.say('市長が工業地域を住宅地域に変更。工場の閉鎖が相次ぐ', 'politics');
    } else if (type === 'populist') {
      if (this.econ.money < 10_000) {
        const r = takeLoan(this.econ, 50_000);
        if (typeof r !== 'string') this.say('市長が市債 5 億円を追加発行。「減税は続けます」', 'politics');
      }
    } else if (type === 'hawk') {
      if (day % 180 === 0) this.say('市長が防衛費の増額を表明', 'politics');
      const kind: UnitKind = this.rand() < 0.5 ? 'mobile' : 'infantry';
      if (this.econ.money > 30_000 && this.unitRoom() > 0 && this.rand() < 0.4) {
        this.addUnit(kind);
        this.say(`市長が${UNITS[kind].name}を新たに編成`, 'politics');
      }
      const rivals = active(this.region);
      if (rivals.length && this.rand() < 0.25) {
        const n = rivals[Math.floor(this.rand() * rivals.length)];
        n.tension = Math.min(100, n.tension + 8);
        n.relation = Math.max(-100, n.relation - 6);
        this.say(`市長が${n.name}を名指しで批判。「なめられてはいけない」`, 'politics');
      }
      const w = this.defense.war;
      if (w && !w.pendingVictory && w.front < -30 && day >= w.peaceTry) this.proposePeace(true);
      if (w?.pendingVictory) this.settleVictory('annex');
    }
    if (type !== 'hawk') {
      const w = this.defense.war;
      if (w && !w.pendingVictory && w.front < 0 && day >= w.peaceTry) this.proposePeace(true);
      if (w?.pendingVictory) this.settleVictory('reparations');
    }
  }


  // ---------- 施設 ----------
  /** カーソル位置に施設を置く計画（置けない理由も返す） */
  planFacility(p: P2, kind: FacilityKind): FacilityPlan {
    const def = FACILITIES[kind];
    let front: Cell | null = null, best = 18;
    for (const c of this.cells.values()) {
      if (c.depth !== 0) continue;
      const d = Math.hypot(c.x - p.x, c.z - p.z);
      if (d < best) { best = d; front = c; }
    }
    const fail = (reason: string, cells: Cell[] = []): FacilityPlan => ({ ok: false, reason, kind, cells, cost: def.cost, ...this.lotFrame(cells, front) });
    if (!front) return fail('道路沿いに置いてください');
    const cells: Cell[] = [];
    for (let k = 0; k < def.w; k++) {
      for (let dd = 0; dd < def.d; dd++) {
        const c = this.cells.get(cellKey(front.seg, front.side, front.i + k, dd));
        if (!c) return fail('敷地が足りません（道路沿いの区画のマスが必要です）', cells);
        if (c.facility) return fail('ほかの施設と重なっています', cells);
        cells.push(c);
      }
    }
    if (def.unlockYear && this.year < def.unlockYear) return fail(`${def.unlockYear} 年目から建てられます`, cells);
    if (cells.some((c) => !this.ownsLand(c))) return fail('隣町の土地には建てられません', cells);
    if (def.unique && this.hasFacility(kind)) return fail(`${def.name}は市に 1 つだけです`, cells);
    if (def.needsWater && !this.nearWater(cells)) return fail('川か海の近く（80 m 以内）に建ててください', cells);
    const blocked = this.blockedReason();
    if (blocked) return fail(blocked, cells);
    if (this.econ.bankrupt) return fail('財政再生団体のため、新しい施設は建てられません', cells);
    if (def.cost > this.econ.money) return fail(`資金が足りません（必要 ${formatYen(def.cost)}）`, cells);
    return { ok: true, kind, cells, cost: def.cost, ...this.lotFrame(cells, front) };
  }

  private lotFrame(cells: Cell[], front: Cell | null) {
    const fr = cells.filter((c) => c.depth === 0);
    const src = fr.length ? fr : front ? [front] : [];
    if (!src.length) return { x: 0, z: 0, y: 0, ax: 1, az: 0, nx: 0, nz: 1 };
    let x = 0, z = 0, y = 0, ax = 0, az = 0, nx = 0, nz = 0;
    for (const c of src) {
      x += c.x - c.nx * CELL_SIZE / 2; z += c.z - c.nz * CELL_SIZE / 2;
      y += c.roadY; ax += c.ax; az += c.az; nx += c.nx; nz += c.nz;
    }
    const n = src.length, la = Math.hypot(ax, az) || 1, ln = Math.hypot(nx, nz) || 1;
    return { x: x / n, z: z / n, y: y / n + 0.15, ax: ax / la, az: az / la, nx: nx / ln, nz: nz / ln };
  }

  private nearWater(cells: Cell[]): boolean {
    for (const c of cells) {
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        for (const r of [30, 55, 80]) {
          if (waterLevelAt(this.terrain, c.x + Math.cos(a) * r, c.z + Math.sin(a) * r) !== null) return true;
        }
      }
    }
    return false;
  }

  placeFacility(plan: FacilityPlan): number | null {
    if (!plan.ok) return null;
    const def = FACILITIES[plan.kind];
    for (const c of plan.cells) {
      if (c.building > 0) this.removeBuilding(c.building);
      if (c.building < 0) this.clearRubble(-c.building, false);
    }
    const id = this.nextFacilityId++;
    const f: Facility = {
      id, kind: plan.kind, x: plan.x, z: plan.z, y: plan.y, ax: plan.ax, az: plan.az, nx: plan.nx, nz: plan.nz,
      w: def.w, d: def.d, cells: plan.cells.map((c) => c.key), cellPos: plan.cells.flatMap((c) => [c.x, c.z]),
      built: this.year, day: this.day, seed: Math.floor(this.rand() * 0xffffffff), downUntil: 0,
    };
    for (const c of plan.cells) { c.facility = id; c.zone = 0; }
    this.facilities.set(id, f);
    spend(this.econ, def.cost);
    this.versions.facilities++;
    this.versions.cells++;
    this.versions.economy++;
    this.refreshServices();
    this.recount();
    return id;
  }

  removeFacility(id: number): void {
    const f = this.facilities.get(id);
    if (!f) return;
    for (const k of f.cells) { const c = this.cells.get(k); if (c) c.facility = 0; }
    this.facilities.delete(id);
    refund(this.econ, FACILITIES[f.kind].cost * ROAD_REFUND);
    this.versions.facilities++;
    this.versions.cells++;
    this.refreshServices();
    this.recount();
  }

  refreshServices(): void {
    this.services = computeServices({
      net: this.net, buildings: this.buildings.values(), facilities: this.facilities.values(), region: this.region, day: this.day,
      powerSaving: decreeActive(this.policies, 'powerSaving', this.day), curfew: decreeActive(this.policies, 'curfew', this.day),
    });
    this.versions.services++;
  }

  // ---------- 災害 ----------
  private disasterDay(day: number): void {
    if (this.disastersEnabled) {
      // 大地震（M6.8〜7.4）と中くらいの地震（M5.8〜6.6）
      const since = this.year - (this.meta.lastQuakeYear ?? 0);
      if (this.rand() < bigQuakeRate(since) / 360) this.earthquake(6.8 + this.rand() * 0.6);
      else if (this.rand() < 0.04 / 360) this.earthquake(5.8 + this.rand() * 0.8);
      this.igniteDay();
    }
    this.fireDay(day);
    // がれきの撤去と、被災した建物の修理
    const emergency = decreeActive(this.policies, 'emergency', day);
    const fast = (this.connections.rel.builder >= 70 ? 22 : 0) + (day < this.dispatchUntil ? 25 : 0) + (this.hasFacility('garrison') ? 5 : 0);
    for (const r of [...this.rubble]) if (day >= r.clearDay - (emergency ? 20 : 0) - fast) this.clearRubble(r.id, true);
    for (const b of this.buildings.values()) {
      if (b.damagedUntil && day >= b.damagedUntil - (emergency ? 45 : 0)) {
        b.damagedUntil = 0;
        spend(this.econ, buildingValue(b) * 0.05, 'other');
        this.versions.buildings++;
      }
    }
  }

  private igniteDay(): void {
    const water = this.services?.per;
    for (const b of this.buildings.values()) {
      let p = 0.00001 * (isWooden(b) ? 2.5 : 1) * (b.fireproof ? 0.4 : 1);
      if (water && water.get(b.id)?.water === false) p *= 1.5;
      if (this.rand() < p) this.startFire(b.id);
    }
  }

  startFire(buildingId: number): void {
    if (!this.buildings.has(buildingId) || this.fires.some((f) => f.building === buildingId)) return;
    this.fires.push({ building: buildingId, start: this.day, intensity: 0.05, fought: false });
    this.versions.fires++;
    if (this.fires.length === 1) {
      const b = this.buildings.get(buildingId)!;
      const where = this.districts.at(b)?.name;
      this.say(`${where ? where + 'で' : ''}${KINDS[b.kind].name}から出火`, 'bad');
    }
  }

  private fireDay(day: number): void {
    if (!this.fires.length) return;
    const svc = this.services?.per;
    const emergency = decreeActive(this.policies, 'emergency', day);
    // 消防署ごとの消防車の数だけ、同時に消火できる
    const trucks = new Map<number, number>();
    for (const f of this.facilities.values()) if (FACILITIES[f.kind].cat === 'fire') trucks.set(f.id, FACILITIES[f.kind].capacity ?? 1);
    const center = (f: Facility) => ({ x: f.x + f.nx * f.d * 4, z: f.z + f.nz * f.d * 4 });
    const grid = new Map<string, Building[]>();
    const G = 32;
    for (const b of this.buildings.values()) {
      const k = `${Math.floor(b.x / G)},${Math.floor(b.z / G)}`;
      const l = grid.get(k);
      if (l) l.push(b); else grid.set(k, [b]);
    }
    const spread: number[] = [];
    let destroyed = 0, out = 0;
    for (const fire of [...this.fires]) {
      const b = this.buildings.get(fire.building);
      if (!b) { this.fires = this.fires.filter((x) => x !== fire); continue; }
      const bx = b.x + b.nx * b.d * 4, bz = b.z + b.nz * b.d * 4;
      let station: Facility | null = null, bestD = Infinity;
      for (const f of this.facilities.values()) {
        const def = FACILITIES[f.kind];
        if (def.cat !== 'fire' || (trucks.get(f.id) ?? 0) <= 0) continue;
        const c = center(f);
        const d = Math.hypot(c.x - bx, c.z - bz);
        if (d < (def.radius ?? 0) && d < bestD) { station = f; bestD = d; }
      }
      fire.fought = !!station;
      if (station) {
        trucks.set(station.id, trucks.get(station.id)! - 1);
        const base = station.kind === 'fireStation' ? 0.55 : 0.3;
        const hasWater = svc?.get(b.id)?.water !== false;
        if (this.rand() < base * (hasWater ? 1 : 0.4) * (emergency ? 1.3 : 1)) {
          this.fires = this.fires.filter((x) => x !== fire);
          if (fire.intensity > 0.45) b.damagedUntil = day + 60;
          out++;
          continue;
        }
      }
      fire.intensity += station ? 0.12 : 0.3;
      if (fire.intensity >= 1) {
        this.fires = this.fires.filter((x) => x !== fire);
        this.destroyBuilding(b, day);
        destroyed++;
        continue;
      }
      if (fire.intensity > 0.35) {
        const gx = Math.floor(b.x / G), gz = Math.floor(b.z / G);
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
          for (const o of grid.get(`${gx + dx},${gz + dz}`) ?? []) {
            if (o.id === b.id) continue;
            const reach = (Math.max(b.w, b.d) + Math.max(o.w, o.d)) * 4 * 0.6 + 5;
            const ox = o.x + o.nx * o.d * 4, oz = o.z + o.nz * o.d * 4;
            if (Math.hypot(ox - bx, oz - bz) > reach) continue;
            const hood = hasPolicy(this.policies, this.districts.at(o)?.id ?? 0, 'fireproof') ? 0.6 : 1;
            if (this.rand() < 0.18 * (isWooden(o) ? 1.6 : 0.4) * (o.fireproof ? 0.3 : 1) * hood) spread.push(o.id);
          }
        }
      }
    }
    for (const id of spread) this.startFire(id);
    if (destroyed) this.say(`火災で ${destroyed} 棟が焼失しました`, 'bad');
    if (out && !this.fires.length) this.say('火災は消し止められました', 'info');
    this.versions.fires++;
  }

  /** 建物を失い、がれきにする */
  private destroyBuilding(b: Building, day: number): void {
    const emergency = decreeActive(this.policies, 'emergency', day);
    const r: Rubble = {
      id: this.nextRubbleId++, x: b.x, z: b.z, y: b.y, ax: b.ax, az: b.az, nx: b.nx, nz: b.nz, w: b.w, d: b.d,
      cellPos: b.cellPos.slice(), clearDay: day + (emergency ? 25 : 45), seed: b.seed,
    };
    const keys = b.cells.slice();
    this.removeBuilding(b.id);
    for (const k of keys) { const c = this.cells.get(k); if (c) c.building = -r.id; }
    this.rubble.push(r);
    this.fires = this.fires.filter((f) => f.building !== b.id);
    this.versions.fires++;
  }

  private clearRubble(id: number, charge: boolean): void {
    const r = this.rubble.find((x) => x.id === id);
    if (!r) return;
    for (const c of this.cells.values()) if (c.building === -id) c.building = 0;
    this.rubble = this.rubble.filter((x) => x !== r);
    if (charge) spend(this.econ, 300, 'other');
    this.versions.fires++;
    this.versions.cells++;
  }

  /** 地震を起こす。震源を省くと、地図の中か近くのどこか */
  earthquake(magnitude: number, epicenter?: P2): QuakeReport {
    const day = this.day;
    const epi = epicenter ?? { x: (this.rand() - 0.5) * 6000, z: (this.rand() - 0.5) * 6000 };
    const report: QuakeReport = {
      day, magnitude: Math.round(magnitude * 10) / 10, epicenter: epi, maxShindo: '0',
      collapsed: 0, damaged: 0, fires: 0, evacuees: 0, injured: 0, liquefied: 0, plantsStopped: 0,
    };
    let maxI = intensityAt(this.terrain, magnitude, epi, 0, 0);
    const fireStarts: number[] = [];
    for (const b of [...this.buildings.values()]) {
      const I = intensityAt(this.terrain, magnitude, epi, b.x, b.z);
      maxI = Math.max(maxI, I);
      const liqRaw = I > 5 ? liquefaction(this.terrain, b.x, b.z) : 0;
      const liq = liqRaw > 0.4 ? liqRaw : 0;
      if (liq) report.liquefied++;
      const { collapse, damage } = quakeDamage(b, I, liq);
      const r = this.rand();
      if (r < collapse) {
        report.collapsed++;
        report.evacuees += b.residents;
        report.injured += Math.round(b.residents * 0.12);
        this.destroyBuilding(b, day);
        continue;
      }
      if (r < collapse + damage) {
        report.damaged++;
        report.evacuees += Math.round(b.residents * 0.5);
        report.injured += Math.round(b.residents * 0.02);
        b.damagedUntil = day + 120;
      }
      if (this.rand() < quakeFireChance(b, I)) fireStarts.push(b.id);
    }
    for (const f of this.facilities.values()) {
      const I = intensityAt(this.terrain, magnitude, epi, f.x, f.z);
      if (I >= 5.5 && FACILITIES[f.kind].cat === 'power') {
        f.downUntil = day + (I >= 6.5 ? 25 : 6);
        report.plantsStopped++;
      }
    }
    for (const id of fireStarts) this.startFire(id);
    report.fires = fireStarts.length;
    this.displaced += report.evacuees;
    this.nuclearCheck(magnitude, epi, 0);
    // 海で起きた大きな地震は津波を起こす
    const inSea = coastDistance(this.terrain, Math.max(-1000, Math.min(1000, epi.x)), Math.max(-1000, Math.min(1000, epi.z))) < -150 || epi.z > 1024;
    if (inSea && magnitude >= 7) this.tsunami(Math.round(((magnitude - 6.8) * 6 + this.rand() * 2) * 10) / 10);
    report.maxShindo = shindoLabel(maxI);
    if (magnitude >= 6.8) this.meta.lastQuakeYear = this.year;
    this.policies.lastDisasterDay = day;
    this.quakes.push(report);
    if (this.quakes.length > 20) this.quakes.shift();
    const dmg = report.collapsed + report.damaged > 0 ? `全壊 ${report.collapsed} 棟、損傷 ${report.damaged} 棟` : '建物の被害はなし';
    this.say(`【地震】マグニチュード ${report.magnitude}、最大震度 ${report.maxShindo}。${dmg}${report.fires ? `、火災 ${report.fires} 件` : ''}`, report.collapsed ? 'bad' : 'info');
    if (report.plantsStopped) this.say(`揺れで発電所 ${report.plantsStopped} か所が停止。しばらく停電が続きます`, 'bad');
    this.events.push({ type: 'quake', report });
    this.versions.buildings++;
    this.versions.facilities++;
    this.refreshServices();
    this.recount();
    return report;
  }


  // ---------- 交通（道路の制御） ----------
  /** 一方通行を切り替える（なし → a→b → b→a → なし） */
  cycleOneway(segId: number): string | null {
    const blocked = this.blockedReason();
    if (blocked) return blocked;
    const s = this.net.segments.get(segId);
    if (!s) return null;
    s.oneway = s.oneway === 1 ? -1 : s.oneway === -1 ? 0 : 1;
    this.versions.roads++;
    this.trafficDirty = true;
    this.rerouteLines();
    return null;
  }

  setNodeControl(nodeId: number, control: NodeControl): string | null {
    const blocked = this.blockedReason();
    if (blocked) return blocked;
    const n = this.net.nodes.get(nodeId);
    if (!n) return null;
    if (this.net.segmentsAt(nodeId).length < 3) return '3 本以上の道路が交わる交差点にしか設定できません';
    const cost = Math.round(NODE_CONTROL_COST[control] * this.buildDiscount());
    if ((n.control ?? 'auto') === control) return null;
    if (cost > this.econ.money) return `資金が足りません（必要 ${formatYen(cost)}）`;
    spend(this.econ, cost);
    n.control = control;
    this.versions.roads++;
    this.trafficDirty = true;
    return null;
  }

  refreshTraffic(): void {
    this.crossings = findCrossings(this.transit, this.net);
    this.riders = ridership(this.transit, this.buildings.values(), (id) => this.lineCongestion(id), (st) => this.stationBoost(st));
    this.traffic = computeTraffic({
      net: this.net, buildings: this.buildings.values(), region: this.region,
      commuteOut: this.stats.commuteOut, commuteIn: this.stats.commuteIn, workers: this.stats.workers,
      transitShare: this.riders.shareByBuilding, crossings: this.crossings,
      staggered: decreeActive(this.policies, 'staggered', this.day),
      priced: (b) => hasPolicy(this.policies, this.districts.at(b)?.id ?? 0, 'roadPricing'),
    });
    for (const l of this.transit.lines.values()) l.riders = this.riders.riders.get(l.id) ?? 0;
    this.trafficDirty = false;
    this.versions.traffic++;
  }

  /** バス・路面電車が走る道路の混み具合の平均 */
  private lineCongestion(lineId: number): number {
    const l = this.transit.lines.get(lineId);
    if (!l || (l.mode !== 'bus' && l.mode !== 'tram') || !this.traffic.vc.size) return 0;
    let sum = 0, n = 0;
    for (const id of l.stops) {
      const st = this.transit.stops.get(id);
      if (st?.seg === undefined) continue;
      sum += Math.min(2, this.traffic.vc.get(st.seg) ?? 0);
      n++;
    }
    return n ? Math.max(0, sum / n - 0.5) : 0;
  }

  /** パークアンドライドの駐車場が近い駅は、使える範囲が広がる */
  private stationBoost(st: Stop): number {
    if (st.mode !== 'rail' && st.mode !== 'subway') return 1;
    for (const f of this.facilities.values()) {
      if (f.kind !== 'parkRide') continue;
      if (Math.hypot(f.x - st.x, f.z - st.z) < 250) return 1.6;
    }
    return 1;
  }

  // ---------- 公共交通 ----------
  private stopName(mode: TransitMode, p: P2): string {
    const d = this.districts.at(p)?.name;
    const base = d ?? ['本町', '中央', '市役所前', '緑町', '栄町', '旭町', '港町', '桜台', '松原', '若葉', '新町', '川端'][Math.floor(this.rand() * 12)];
    const suffix = mode === 'bus' ? '' : mode === 'tram' ? '' : '駅';
    let name = base + suffix;
    const used = new Set([...this.transit.stops.values()].map((s) => s.name));
    for (let k = 2; used.has(name); k++) name = `${base}${['東', '西', '南', '北', '中央', '本'][k % 6]}${suffix}`;
    return name;
  }

  /** 停留所・駅を置けるか調べる。置ける場合は置く位置と費用 */
  planStop(mode: TransitMode, p: P2, level: TrackLevel = 'ground', privately = false): { ok: boolean; reason?: string; cost: number; p: P2; reuse?: number; seg?: number; t?: number } {
    const def = MODES[mode];
    for (const st of this.transit.stops.values()) {
      if (st.mode === mode && Math.hypot(st.x - p.x, st.z - p.z) < (mode === 'bus' || mode === 'tram' ? 20 : 60)) return { ok: true, cost: 0, p: st, reuse: st.id };
    }
    const blocked = this.blockedReason();
    if (blocked) return { ok: false, reason: blocked, cost: 0, p };
    if (!this.ownsLand(p)) return { ok: false, reason: '隣町の土地には置けません', cost: 0, p };
    let cost = Math.round(def.stopCost * (privately ? 0.3 : 1));
    if (mode === 'bus' || mode === 'tram') {
      const snap = snapStopToRoad(this.net, p, mode === 'tram');
      if (!snap) return { ok: false, reason: mode === 'tram' ? '生活道路か幹線道路の上に置いてください（路地は不可）' : '道路の上に置いてください', cost, p };
      if (cost > this.econ.money) return { ok: false, reason: `資金が足りません（必要 ${formatYen(cost)}）`, cost, p: snap.p };
      return { ok: true, cost, p: snap.p, seg: snap.seg, t: snap.t };
    }
    if (!insideMapSafe(p)) return { ok: false, reason: '地図の外です', cost, p };
    if (waterLevelAt(this.terrain, p.x, p.z) !== null) return { ok: false, reason: '水の上には駅を置けません', cost, p };
    for (const st of this.transit.stops.values()) {
      if ((st.mode === 'rail' || st.mode === 'subway') && Math.hypot(st.x - p.x, st.z - p.z) < 150) return { ok: false, reason: 'ほかの駅に近すぎます（150 m 以上離す）', cost, p };
    }
    cost = Math.round(cost * (level === 'elevated' ? 1.3 : 1));
    if (cost > this.econ.money) return { ok: false, reason: `資金が足りません（必要 ${formatYen(cost)}）`, cost, p };
    return { ok: true, cost, p };
  }

  /** 停留所・駅を置く（すでに近くにあればそれを使う）。id を返す */
  addStop(mode: TransitMode, p: P2, level: TrackLevel = 'ground', privately = false): number | string {
    const plan = this.planStop(mode, p, level, privately);
    if (!plan.ok) return plan.reason ?? '置けません';
    if (plan.reuse) return plan.reuse;
    const id = this.transit.nextId++;
    const h = Math.max(0, heightAt(this.terrain, plan.p.x, plan.p.z));
    const lvl: TrackLevel = mode === 'subway' ? 'under' : mode === 'rail' ? level : 'ground';
    this.transit.stops.set(id, {
      id, mode, x: plan.p.x, z: plan.p.z, name: this.stopName(mode, plan.p), seg: plan.seg, t: plan.t, level: lvl,
      y: lvl === 'elevated' ? h + 9 : mode === 'bus' || mode === 'tram' ? this.roadY(plan.seg!, plan.t!) : h,
      private: privately || undefined,
    } as Stop & { private?: boolean });
    spend(this.econ, plan.cost);
    this.versions.transit++;
    if (mode === 'rail' || mode === 'subway') this.afterTransitChange();
    return id;
  }

  private roadY(seg: number, t: number): number {
    const s = this.net.segments.get(seg);
    return s ? sampleProfileY(s.ys, t) : 0;
  }

  /** 2 つの駅を線路でつなぐ計画 */
  planTrack(a: number, b: number, level: TrackLevel, privately = false): { ok: boolean; reason?: string; cost: number } {
    const sa = this.transit.stops.get(a), sb = this.transit.stops.get(b);
    if (!sa || !sb || sa.id === sb.id) return { ok: false, reason: '別の駅を選んでください', cost: 0 };
    if (trackFor(this.transit, a, b)) return { ok: true, cost: 0 };
    const mode = sa.mode as 'rail' | 'subway';
    const lvl: TrackLevel = mode === 'subway' ? 'under' : level;
    const prof = trackProfile(this.terrain, { p0: sa, c: { x: (sa.x + sb.x) / 2, z: (sa.z + sb.z) / 2 }, p2: sb }, lvl);
    const cost = Math.round(trackCost(mode, lvl, prof.length) * this.buildDiscount() * (privately ? 0.3 : 1));
    if (!prof.ok) return { ok: false, reason: prof.reason, cost };
    if (prof.length > 3000) return { ok: false, reason: '駅と駅の間が長すぎます（3 km まで）', cost };
    if (cost > this.econ.money) return { ok: false, reason: `資金が足りません（必要 ${formatYen(cost)}）`, cost };
    return { ok: true, cost };
  }

  connectStops(a: number, b: number, level: TrackLevel, privately = false): string | null {
    const plan = this.planTrack(a, b, level, privately);
    if (!plan.ok) return plan.reason ?? '線路を引けません';
    if (trackFor(this.transit, a, b)) return null;
    const sa = this.transit.stops.get(a)!;
    const mode = sa.mode as 'rail' | 'subway';
    const lvl: TrackLevel = mode === 'subway' ? 'under' : level;
    const cv = { p0: sa, c: { x: (sa.x + this.transit.stops.get(b)!.x) / 2, z: (sa.z + this.transit.stops.get(b)!.z) / 2 }, p2: this.transit.stops.get(b)! };
    const prof = trackProfile(this.terrain, cv, lvl);
    const id = this.transit.nextId++;
    this.transit.tracks.set(id, { id, a, b, mode, level: lvl, ys: prof.ys, bridge: prof.bridge });
    spend(this.econ, plan.cost);
    if (lvl === 'ground') this.terrainChanges.push(flattenRoad(this.terrain, trackCurve(this.transit, this.transit.tracks.get(id)!), prof.ys, prof.bridge, 4));
    this.afterTransitChange();
    return null;
  }

  /** 路線をつくる。バス・路面電車は道路に沿って、鉄道・地下鉄は線路に沿って走る */
  createLine(mode: TransitMode, stopIds: number[], operator: 'city' | 'private' = 'city'): Line | string {
    if (stopIds.length < 2) return '停留所（駅）を 2 つ以上選んでください';
    if (operator === 'private' && (mode !== 'rail' || this.connections.rel.rail < 40)) return '私鉄に任せられるのは、私鉄社長との関係が 40 以上のときの鉄道だけです';
    const def = MODES[mode];
    const id = this.transit.nextId++;
    const same = [...this.transit.lines.values()].filter((l) => l.mode === mode);
    const codes = 'MKTSHNAYCFGR';
    const first = this.transit.stops.get(stopIds[0])!, last = this.transit.stops.get(stopIds.at(-1)!)!;
    const baseName = (s: Stop) => s.name.replace(/駅$/, '');
    const name = mode === 'bus' ? `市営バス ${same.length + 1} 系統`
      : mode === 'tram' ? `路面電車 ${baseName(first)}線`
      : operator === 'private' ? `瑞穂電鉄 ${baseName(first)}線` : mode === 'subway' ? `地下鉄 ${baseName(first)}線` : `${baseName(first)}${baseName(last)}線`;
    const line: Line = {
      id, mode, name, code: codes[[...this.transit.lines.values()].length % codes.length], color: def.colors[same.length % def.colors.length],
      stops: stopIds.slice(), vehicles: def.vehicles, fare: def.fare, operator, path: [], pathLen: 0, broken: false, riders: 0, income: 0, cost: 0,
    };
    this.transit.lines.set(id, line);
    this.routeLine(line);
    if (line.broken) {
      this.transit.lines.delete(id);
      return mode === 'bus' || mode === 'tram' ? '停留所どうしが道路でつながっていません' : '駅どうしが線路でつながっていません';
    }
    this.say(`${line.name}が開業しました（${line.stops.map((sid) => this.transit.stops.get(sid)!.name).join('・')}）`, 'good');
    if (operator === 'private') this.connections.rel.rail = Math.min(100, this.connections.rel.rail + 10);
    this.versions.transit++;
    this.trafficDirty = true;
    return line;
  }

  private routeLine(l: Line): void {
    const stops = l.stops.map((id) => this.transit.stops.get(id)).filter((s): s is Stop => !!s);
    const r = l.mode === 'bus' || l.mode === 'tram' ? roadPath(this.net, stops, l.mode === 'tram') : trackPath(this.transit, stops);
    l.path = r.path;
    l.pathLen = polylineLen(r.path);
    l.broken = !r.ok || stops.length < 2;
  }

  private rerouteLines(): void {
    for (const l of this.transit.lines.values()) this.routeLine(l);
    this.versions.transit++;
  }

  removeLine(id: number): void {
    const l = this.transit.lines.get(id);
    if (!l) return;
    this.transit.lines.delete(id);
    this.say(`${l.name}を廃止しました`, 'bad');
    this.versions.transit++;
    this.trafficDirty = true;
  }

  setLine(id: number, change: { vehicles?: number; fare?: number }): void {
    const l = this.transit.lines.get(id);
    if (!l || this.blockedReason()) return;
    if (change.vehicles !== undefined) l.vehicles = Math.max(1, Math.min(40, Math.round(change.vehicles)));
    if (change.fare !== undefined) l.fare = Math.max(0, Math.min(1000, Math.round(change.fare / 10) * 10));
    this.versions.transit++;
    this.trafficDirty = true;
  }

  /** 停留所・駅をなくす（使っている路線からも外す） */
  removeStop(id: number): void {
    const st = this.transit.stops.get(id);
    if (!st) return;
    this.transit.stops.delete(id);
    for (const [tid, tr] of this.transit.tracks) if (tr.a === id || tr.b === id) this.transit.tracks.delete(tid);
    for (const l of [...this.transit.lines.values()]) {
      l.stops = l.stops.filter((s) => s !== id);
      if (l.stops.length < 2) this.transit.lines.delete(l.id);
    }
    refund(this.econ, MODES[st.mode].stopCost * ROAD_REFUND);
    this.rerouteLines();
    if (st.mode === 'rail' || st.mode === 'subway') this.afterTransitChange();
  }

  /** 踏切をなくすため、地上の線路を高架にする */
  elevateTrack(trackId: number): string | null {
    const blocked = this.blockedReason();
    if (blocked) return blocked;
    const tr = this.transit.tracks.get(trackId);
    if (!tr || tr.level !== 'ground') return null;
    const prof = trackProfile(this.terrain, trackCurve(this.transit, tr), 'elevated');
    if (!prof.ok) return prof.reason ?? '高架にできません';
    const cost = Math.round((trackCost('rail', 'elevated', prof.length) - trackCost('rail', 'ground', prof.length)) * this.buildDiscount());
    if (cost > this.econ.money) return `資金が足りません（必要 ${formatYen(cost)}）`;
    spend(this.econ, cost);
    tr.level = 'elevated';
    tr.ys = prof.ys;
    tr.bridge = prof.bridge;
    this.say('連続立体交差事業が完了。線路が高架になり、踏切がなくなりました', 'good');
    this.afterTransitChange();
    return null;
  }

  elevateCost(trackId: number): number {
    const tr = this.transit.tracks.get(trackId);
    if (!tr) return 0;
    const len = curveLength(trackCurve(this.transit, tr));
    return Math.round((trackCost('rail', 'elevated', len) - trackCost('rail', 'ground', len)) * this.buildDiscount());
  }

  private afterTransitChange(): void {
    // 線路や駅は、区画のマスと建物にとって障害物になる
    this.afterRoadChange();
    this.rerouteLines();
    this.trafficDirty = true;
  }

  /** 道路が変わったら、バス停・電停を近くの道路に載せ直す */
  private rehomeStops(): void {
    for (const st of [...this.transit.stops.values()]) {
      if (st.mode !== 'bus' && st.mode !== 'tram') continue;
      const snap = snapStopToRoad(this.net, st, st.mode === 'tram');
      if (!snap) { this.transit.stops.delete(st.id); continue; }
      st.seg = snap.seg; st.t = snap.t; st.x = snap.p.x; st.z = snap.p.z;
    }
    for (const l of [...this.transit.lines.values()]) {
      l.stops = l.stops.filter((id) => this.transit.stops.has(id));
      if (l.stops.length < 2) { this.transit.lines.delete(l.id); continue; }
      this.routeLine(l);
    }
    this.versions.transit++;
  }

  nearestStation(p: P2, within: number): (Stop & { private?: boolean }) | null {
    let best: (Stop & { private?: boolean }) | null = null, bd = within;
    for (const st of this.transit.stops.values()) {
      if (st.mode !== 'rail' && st.mode !== 'subway') continue;
      const d = Math.hypot(st.x - p.x, st.z - p.z);
      if (d < bd) { bd = d; best = st; }
    }
    return best;
  }

  /** 月ごとの公共交通の収支 */
  private transitMonth(): { income: number; cost: number } {
    let income = 0, cost = 0;
    const usedStops = new Set<number>();
    for (const l of this.transit.lines.values()) {
      const def = MODES[l.mode];
      l.income = (l.riders * 2 * l.fare * 22) / 10_000;
      l.cost = l.vehicles * def.vehicleUpkeep + l.stops.length * def.stopUpkeep;
      if (l.operator === 'private') {
        if (l.riders > 100) this.connections.rel.rail = Math.min(100, this.connections.rel.rail + 0.5);
        continue;
      }
      income += l.income;
      cost += l.cost;
      for (const s of l.stops) usedStops.add(s);
    }
    // 路線に使われていない駅の維持費
    for (const st of this.transit.stops.values()) if (!usedStops.has(st.id)) cost += MODES[st.mode].stopUpkeep;
    return { income, cost };
  }

  // ---------- 関係者（コネ） ----------
  npcAction(npc: NpcId, action: ActionId): string | null {
    const blocked = this.blockedReason();
    if (blocked) return blocked;
    const a = ACTIONS[action], c = this.connections;
    const key = `${npc}:${action}`;
    if ((c.cooldowns[key] ?? 0) > this.day) return `次にできるのは ${Math.ceil((c.cooldowns[key] - this.day) / 30)} か月後です`;
    if (a.cost > this.econ.money) return `資金が足りません（必要 ${formatYen(a.cost)}）`;
    if (a.cost) spend(this.econ, a.cost, 'other');
    c.rel[npc] = Math.min(100, c.rel[npc] + a.rel);
    c.suspicion = Math.min(100, c.suspicion + a.suspicion * (npc === 'reporter' ? 1.5 : 1));
    c.cooldowns[key] = this.day + a.cooldown;
    if (action === 'favor') this.say(`市長が${NPCS[npc].title}の${NPCS[npc].name}氏に便宜を図ったとのうわさ`, 'politics');
    this.versions.economy++;
    return null;
  }

  answerRequest(npc: NpcId, accept: boolean): string | null {
    const c = this.connections;
    const req = c.requests.find((r) => r.npc === npc);
    if (!req) return null;
    if (!accept) {
      c.requests = c.requests.filter((r) => r !== req);
      c.rel[npc] = Math.max(0, c.rel[npc] - 5);
      this.versions.economy++;
      return null;
    }
    const blocked = this.blockedReason();
    if (blocked) return blocked;
    switch (req.kind) {
      case 'stationCommercial': {
        const st = [...this.transit.stops.values()].find((s) => s.mode === 'rail');
        if (!st) return '鉄道の駅がまだありません';
        this.paintZone(st, 120, 4);
        c.rel.rail += 15; c.suspicion += 4;
        break;
      }
      case 'publicWorks':
        if (this.econ.money < 10_000) return '資金が足りません（必要 1億円）';
        spend(this.econ, 10_000);
        c.rel.builder += 18; c.suspicion += 8;
        break;
      case 'drill':
        if (this.econ.money < 500) return '資金が足りません';
        spend(this.econ, 500, 'other');
        c.rel.governor += 12;
        addModifier(this.politics, 'tradition', 3, this.day + 360, '防災訓練');
        break;
      case 'bizTax':
        setTax(this.econ, 'biz', this.econ.taxes.biz - 1);
        c.rel.chamber += 15;
        break;
      case 'disclosure':
        c.rel.reporter += 10; c.suspicion = Math.max(0, c.suspicion - 10);
        addModifier(this.politics, 'business', -3, this.day + 360, '情報公開');
        break;
    }
    for (const k of Object.keys(c.rel) as NpcId[]) c.rel[k] = Math.min(100, c.rel[k]);
    c.suspicion = Math.min(100, c.suspicion);
    c.requests = c.requests.filter((r) => r !== req);
    this.versions.economy++;
    this.recount();
    return null;
  }

  private connectionsMonth(day: number): void {
    const c = this.connections;
    c.suspicion = Math.max(0, c.suspicion - 1);
    c.requests = c.requests.filter((r) => r.expires > day);
    // 陳情が届く
    if (this.rand() < 0.15) {
      const ids = (Object.keys(NPCS) as NpcId[]).filter((id) => !c.requests.some((r) => r.npc === id));
      if (ids.length) {
        const npc = ids[Math.floor(this.rand() * ids.length)];
        c.requests.push({ npc, kind: REQUESTS[npc].kind, text: REQUESTS[npc].text, expires: day + 90 });
        this.say(`${NPCS[npc].title}の${NPCS[npc].name}氏から陳情が届きました`, 'politics');
      }
    }
    // スクープ
    if (c.suspicion > 40) {
      const p = ((c.suspicion - 40) / 200) * (c.rel.reporter >= 50 ? 0.5 : 1);
      if (this.rand() < p) {
        c.scoops++;
        c.suspicion = Math.max(0, c.suspicion - 20);
        addModifier(this.politics, 'all', -8, day + 360, 'スクープ');
        this.say('【スクープ】地元紙が市長と業界の癒着疑惑を報道。支持率が急落', 'bad');
      }
    }
    // リコール
    if (c.suspicion >= 90 && !c.recallDay && this.politics.mayor === 'player') {
      c.recallDay = day + 60;
      this.say('市民団体がリコールの署名を集め始めました。2 か月後に住民投票（出直し選挙）です', 'bad');
    }
    if (c.recallDay && day >= c.recallDay) {
      c.recallDay = 0;
      this.say('リコールによる出直し市長選挙が行われます', 'politics');
      this.election(this.year);
    }
    // 県の特別補助金
    if (c.rel.governor >= 70 && c.lastGrantYear !== this.year) {
      c.lastGrantYear = this.year;
      refund(this.econ, 10_000);
      this.say('県知事から 1 億円の特別補助金が届きました', 'good');
    }
  }


  // ---------- 水害と防災 ----------
  isRestricted(p: P2): boolean {
    return this.restricted.some((r) => r.until > this.day && Math.hypot(r.x - p.x, r.z - p.z) < r.r);
  }

  hasFacility(kind: FacilityKind): boolean {
    for (const f of this.facilities.values()) if (f.kind === kind) return true;
    return false;
  }

  private countFacility(kind: FacilityKind): number {
    let n = 0;
    for (const f of this.facilities.values()) if (f.kind === kind) n++;
    return n;
  }

  /** 川岸をクリックして堤防を 1 段高くする */
  planLevee(p: P2): { ok: boolean; reason?: string; sec: number; cost: number; level: number } {
    const k = Math.min(this.terrain.river.length - 1, Math.max(0, Math.round(((p.z + 1024) / 2048) * 512)));
    const rp = this.terrain.river[k];
    const sec = riverSection(p.z);
    const level = this.defenses.levees[sec] ?? 0;
    const cost = Math.round(LEVEE_COST * this.buildDiscount());
    if (Math.hypot(rp.x - p.x, rp.z - p.z) > rp.width / 2 + 90 || rp.level <= 0.01) return { ok: false, reason: '川岸の近く（海より上流）をクリックしてください', sec, cost, level };
    if (!this.ownsLand(p)) return { ok: false, reason: '隣町の土地です', sec, cost, level };
    if (level >= LEVEE_MAX) return { ok: false, reason: 'この区間の堤防はこれ以上高くできません', sec, cost, level };
    const blocked = this.blockedReason();
    if (blocked) return { ok: false, reason: blocked, sec, cost, level };
    if (cost > this.econ.money) return { ok: false, reason: `資金が足りません（必要 ${formatYen(cost)}）`, sec, cost, level };
    return { ok: true, sec, cost, level };
  }

  buildLevee(p: P2): string | null {
    const plan = this.planLevee(p);
    if (!plan.ok) return plan.reason ?? '造れません';
    spend(this.econ, plan.cost);
    this.defenses.levees[plan.sec] = plan.level + 1;
    this.versions.water++;
    return null;
  }

  planSeawall(p: P2): { ok: boolean; reason?: string; sec: number; cost: number; level: number } {
    const sec = coastSection(p.x);
    const level = this.defenses.seawalls[sec] ?? 0;
    const cost = Math.round((SEAWALL_COST[level + 1] ?? 0) * this.buildDiscount());
    if (Math.abs(coastDistance(this.terrain, p.x, p.z)) > 140) return { ok: false, reason: '海岸線の近くをクリックしてください', sec, cost, level };
    if (!this.ownsLand(p)) return { ok: false, reason: '隣町の土地です', sec, cost, level };
    if (level >= SEAWALL_HEIGHTS.length - 1) return { ok: false, reason: 'この区間の防潮堤はこれ以上高くできません', sec, cost, level };
    const blocked = this.blockedReason();
    if (blocked) return { ok: false, reason: blocked, sec, cost, level };
    if (cost > this.econ.money) return { ok: false, reason: `資金が足りません（必要 ${formatYen(cost)}）`, sec, cost, level };
    return { ok: true, sec, cost, level };
  }

  buildSeawall(p: P2): string | null {
    const plan = this.planSeawall(p);
    if (!plan.ok) return plan.reason ?? '造れません';
    spend(this.econ, plan.cost);
    this.defenses.seawalls[plan.sec] = plan.level + 1;
    this.versions.water++;
    return null;
  }

  /** いま来ている（予報が出ている）嵐 */
  activeStorm(): Storm | null {
    return this.storms.find((s) => !s.done) ?? null;
  }

  /** 嵐を起こす（テストや設定からも使う） */
  spawnStorm(kind: StormKind, strength?: number): Storm {
    if (kind === 'typhoon') this.stormNo++;
    const st = makeStorm(kind, this.transit.nextId++, this.day, this.stormNo, this.rand, strength);
    this.storms.push(st);
    if (this.storms.length > 30) this.storms.shift();
    const lv = alertLevel(st, this.day);
    this.say(`【気象】${st.name}の予報。${st.hit - this.day} 日後に最も強まる見込み（警戒レベル ${lv}：${ALERT_NAMES[lv]}）`, 'bad');
    this.versions.water++;
    return st;
  }

  /** 避難指示を出す（もう一度で解除） */
  evacuate(on = true): string | null {
    const st = this.activeStorm();
    if (!st) return '今は避難指示を出す必要のある災害はありません';
    if (this.politics.mayor !== 'player') return this.blockedReason();
    st.evacuated = on;
    st.evacDay = this.day;
    this.say(on ? `市が全域に避難指示（警戒レベル 4）を出しました。避難所 ${this.shelterCapacity().toLocaleString()} 人分を開設` : '避難指示を解除しました', 'politics');
    this.versions.water++;
    return null;
  }

  shelterCapacity(): number {
    let n = 0;
    for (const f of this.facilities.values()) n += FACILITIES[f.kind].shelter ?? 0;
    return n;
  }

  private stormDay(day: number): void {
    for (const st of this.storms) {
      if (st.done) continue;
      if (st.evacuated && day < st.end) {
        // 避難中は店や工場が止まる
        spend(this.econ, (this.stats.comJobs + this.stats.indJobs) * 0.15, 'other');
      }
      if (day === st.hit) this.applyStorm(st);
      if (day >= st.end) {
        st.done = true;
        if (st.evacuated) this.say('避難指示を解除しました', 'politics');
        this.versions.water++;
      }
      const lv = alertLevel(st, day);
      if (day === st.hit - 1 && !st.evacuated) this.say(`【警戒レベル ${lv}】${st.name}が明日最も強まります。${ALERT_NAMES[lv]}`, 'bad');
    }
  }

  /** 嵐がいちばん強まった日の被害 */
  private applyStorm(st: Storm): void {
    const a = st.actual, day = this.day;
    const retention = this.countFacility('retention'), discharge = this.countFacility('discharge');
    const sabo = [...this.facilities.values()].filter((f) => f.kind === 'sabo');
    const sewage = this.services?.util.sewage.served ?? 0;
    const rain = Math.min(1, a.rise / 7);
    const r: DisasterReport = {
      day, kind: st.kind, title: `${st.name}の被害`, below: 0, above: 0, collapsed: 0, damaged: 0, landslides: 0,
      stranded: 0, displaced: 0, breaches: 0, evacuated: st.evacuated, aid: 0, note: '',
    };
    for (let sec = 0; sec < this.defenses.levees.length; sec++) {
      const zc = sec * 160 - 1024 + 80;
      const k = Math.min(this.terrain.river.length - 1, Math.max(0, Math.round(((zc + 1024) / 2048) * 512)));
      if (this.terrain.river[k].level <= 0.01) continue;
      if (effectiveRise(a.rise, zc, retention, discharge) > bankProtection(this.defenses, sec)) r.breaches++;
    }
    let exposed = 0;
    for (const b of [...this.buildings.values()]) {
      const cx = b.x + b.nx * b.d * 4, cz = b.z + b.nz * b.d * 4;
      let depth = Math.max(
        riverFloodDepth(this.terrain, this.defenses, cx, cz, a.rise, retention, discharge),
        coastalDepth(this.terrain, this.defenses, cx, cz, a.surge),
      );
      // 内水氾濫：下水が足りないと、低い土地に雨水がたまる
      if (b.y < 8 && hazardFlood(this.terrain, cx, cz) > 0.3) depth = Math.max(depth, rain * (1 - sewage) * 0.9);
      const dmg = floodDamage(depth, isWooden(b));
      const slide = landslideChance(this.terrain, cx, cz, rain, sabo.some((f) => Math.hypot(f.x - cx, f.z - cz) < 320));
      if (this.rand() < slide) {
        r.landslides++;
        exposed += b.residents;
        r.displaced += b.residents;
        this.destroyBuilding(b, day);
        continue;
      }
      if (dmg === 'below') r.below++;
      else if (dmg === 'above') { r.above++; b.damagedUntil = day + 60; exposed += b.residents * 0.5; r.displaced += Math.round(b.residents * 0.3); }
      else if (dmg === 'severe') { r.above++; b.damagedUntil = day + 120; exposed += b.residents; r.displaced += b.residents; }
      else if (dmg === 'collapse') { r.collapsed++; exposed += b.residents; r.displaced += b.residents; this.destroyBuilding(b, day); continue; }
      // 強い風で古い木造の屋根が飛ぶ
      if (dmg === 'none' && this.rand() < a.wind * (isWooden(b) ? (b.seismic === 'old' ? 0.12 : 0.05) : 0.01)) {
        r.damaged++;
        b.damagedUntil = day + 40;
      }
    }
    // 避難指示が出ていれば逃げ遅れはいない。遅すぎた（当日）ときは一部
    const lateness = !st.evacuated ? 1 : st.evacDay >= st.hit ? 0.4 : 0;
    const rescue = (this.hasFacility('garrison') || day < this.dispatchUntil ? 0.5 : 1) * this.rescueFactor();
    r.stranded = Math.round(exposed * 0.12 * lateness * rescue);
    this.finishDisaster(r, st.evacuated && r.above + r.collapsed + r.landslides === 0);
    // 浸水の範囲を表示する
    this.flood = { day, until: day + 6, wave: a.surge, rise: a.rise, kind: 'river' };
    this.versions.water++;
  }

  /** 津波。海岸の低い土地が浸水する */
  tsunami(height: number): DisasterReport {
    const day = this.day;
    const towers = [...this.facilities.values()].filter((f) => f.kind === 'evacTower');
    const r: DisasterReport = {
      day, kind: 'tsunami', title: `津波（高さ ${height} m）の被害`, below: 0, above: 0, collapsed: 0, damaged: 0, landslides: 0,
      stranded: 0, displaced: 0, breaches: 0, evacuated: true, aid: 0, note: '',
    };
    this.say(`【大津波警報】高さ ${height} m の津波が押し寄せます。ただちに高台へ`, 'bad');
    let exposed = 0, unsafe = 0;
    for (const b of [...this.buildings.values()]) {
      const cx = b.x + b.nx * b.d * 4, cz = b.z + b.nz * b.d * 4;
      const depth = coastalDepth(this.terrain, this.defenses, cx, cz, height);
      if (depth < 0.05) continue;
      const safe = towers.some((f) => Math.hypot(f.x - cx, f.z - cz) < 400) || this.highGroundNear(cx, cz);
      exposed += b.residents;
      if (!safe) unsafe += b.residents;
      const dmg = floodDamage(depth, isWooden(b));
      if (dmg === 'collapse' && this.rand() < (isWooden(b) ? 0.9 : 0.35)) {
        r.collapsed++; r.displaced += b.residents; this.destroyBuilding(b, day); continue;
      }
      if (dmg === 'below') r.below++;
      else { r.above++; b.damagedUntil = day + 150; r.displaced += Math.round(b.residents * 0.7); }
    }
    const rescue = (this.hasFacility('garrison') ? 0.5 : 1) * this.rescueFactor() * (this.hasFacility('coastwatch') ? 0.8 : 1);
    r.stranded = Math.round(unsafe * 0.25 * rescue);
    r.note = exposed ? `浸水した地域の ${Math.round((1 - unsafe / exposed) * 100)}％ の人は、避難タワーや高台に逃げられました` : '';
    this.nuclearCheck(0, null, height);
    this.finishDisaster(r, false);
    this.flood = { day, until: day + 8, wave: height, rise: 0, kind: 'coast' };
    this.versions.water++;
    return r;
  }

  /** 近く（700 m 以内）に高さ 12 m 以上の高台があるか */
  private highGroundNear(x: number, z: number): boolean {
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      for (const d of [250, 500, 700]) if (heightAt(this.terrain, x + Math.cos(a) * d, z + Math.sin(a) * d) > 12) return true;
    }
    return false;
  }

  /** 災害の締め：国の支援、支持率、ニュース、家を失った人 */
  private finishDisaster(r: DisasterReport, falseAlarm: boolean): void {
    const damage = r.collapsed * 3 + r.above + r.landslides * 3 + r.damaged * 0.5;
    if (damage >= 20) {
      r.aid = Math.round(r.collapsed * 300 + r.above * 80 + r.landslides * 300 + r.damaged * 40);
      refund(this.econ, r.aid);
      const friends = active(this.region).filter((n) => n.treaties.includes('aid') || (n.connected && n.relation > 30));
      if (friends.length) {
        const help = friends.reduce((a, n) => a + (n.treaties.includes('aid') ? 6_000 : 3_000), 0);
        refund(this.econ, help);
        r.aid += help;
        this.say(`${friends.map((n) => n.name).join('・')}から応援の職員と義援金 ${formatYen(help)} が届きました`, 'good');
      }
      this.say(`国が激甚災害に指定。復旧のため ${formatYen(r.aid)} を支援`, 'good');
    }
    this.displaced += r.displaced;
    this.policies.lastDisasterDay = r.day;
    if (r.stranded > 0) {
      addModifier(this.politics, 'all', -Math.min(20, 4 + r.stranded / 30), r.day + 720, '避難の遅れ');
      this.say(`逃げ遅れて救助された人が ${r.stranded.toLocaleString()} 人。市の避難の判断に批判が集まっています`, 'bad');
    } else if (r.evacuated && damage > 0) {
      addModifier(this.politics, 'all', 5, r.day + 360, '早めの避難');
      this.say('早めの避難指示で、逃げ遅れた人はいませんでした', 'good');
    } else if (falseAlarm) {
      addModifier(this.politics, 'business', -2, r.day + 180, '空振り');
      this.say('避難指示は空振りに終わりましたが、「命を守る判断」と評価する声も', 'politics');
    }
    const parts = [
      r.breaches ? `堤防を越えた区間 ${r.breaches}` : '', r.above ? `床上浸水 ${r.above} 棟` : '', r.below ? `床下浸水 ${r.below} 棟` : '',
      r.collapsed ? `全壊 ${r.collapsed} 棟` : '', r.landslides ? `土砂災害 ${r.landslides} 棟` : '', r.damaged ? `風の被害 ${r.damaged} 棟` : '',
    ].filter(Boolean);
    this.say(`【被害】${r.title.replace('の被害', '')}：${parts.length ? parts.join('、') : '大きな被害はありませんでした'}`, parts.length ? 'bad' : 'info');
    this.disasterReports.push(r);
    if (this.disasterReports.length > 20) this.disasterReports.shift();
    this.events.push({ type: 'disaster', report: r });
    this.versions.buildings++;
    this.refreshServices();
    this.recount();
  }

  /** 原発事故の判定。強い揺れか、防潮堤を越える津波で起きることがある */
  private nuclearCheck(magnitude: number, epi: P2 | null, wave: number): void {
    for (const f of [...this.facilities.values()]) {
      if (f.kind !== 'nuclear' || f.downUntil > this.day + 3000) continue;
      const I = epi ? intensityAt(this.terrain, magnitude, epi, f.x, f.z) : 0;
      const flood = wave > 0 ? coastalDepth(this.terrain, this.defenses, f.x, f.z, wave) : 0;
      const p = (I >= 6.3 ? 0.25 : 0) + (flood > 1 ? 0.6 : 0);
      if (p <= 0 || this.rand() >= p) continue;
      const r = 1500;
      this.restricted.push({ x: f.x, z: f.z, r, until: this.day + 360 * 12 });
      let lost = 0;
      for (const b of [...this.buildings.values()]) {
        if (Math.hypot(b.x - f.x, b.z - f.z) < r) { lost += b.residents; this.removeBuilding(b.id); }
      }
      for (const c of this.cells.values()) if (Math.hypot(c.x - f.x, c.z - f.z) < r) c.zone = 0;
      f.downUntil = this.day + 360 * 100;
      this.displaced += lost;
      addModifier(this.politics, 'all', -25, this.day + 360 * 4, '原発事故');
      addModifier(this.politics, 'green', -30, this.day + 360 * 8, '原発事故');
      const report: DisasterReport = {
        day: this.day, kind: 'nuclear', title: '原子力発電所の事故', below: 0, above: 0, collapsed: 0, damaged: 0, landslides: 0,
        stranded: 0, displaced: lost, breaches: 0, evacuated: true, aid: 0,
        note: '半径 1.5 km が帰還困難区域になり、12 年間は立ち入れません。発電所は廃炉になります',
      };
      this.say('【原発事故】原子力発電所で深刻な事故。半径 1.5 km に避難指示、帰還困難区域に', 'bad');
      this.disasterReports.push(report);
      this.events.push({ type: 'disaster', report });
      this.versions.cells++;
      this.versions.facilities++;
      this.versions.water++;
    }
  }

  /** 防衛隊に災害派遣を要請する（災害から 30 日以内） */
  requestDispatch(): string | null {
    if (!this.hasFacility('garrison')) return '防衛隊駐屯地がありません（「施設」の防災から建てられます）';
    if (this.day - this.policies.lastDisasterDay > 30) return '災害から 30 日以内に要請できます';
    if (this.day < this.dispatchUntil) return 'すでに派遣されています';
    this.dispatchUntil = this.day + 45;
    for (const r of [...this.rubble]) r.clearDay = Math.min(r.clearDay, this.day + 10);
    for (const b of this.buildings.values()) if (b.damagedUntil && b.damagedUntil > this.day) b.damagedUntil -= 30;
    this.displaced = Math.round(this.displaced * Math.max(0.55, 0.85 - unitCount(this.defense, 'rescue') * 0.05));
    addModifier(this.politics, 'defense', 6, this.day + 360, '災害派遣');
    this.say('防衛隊が災害派遣。救助とがれきの撤去、給水・入浴支援が始まりました', 'good');
    this.versions.economy++;
    return null;
  }

  /** 復興区画整理：地区のがれきを片付け、建物を新しい基準（耐震・防火）にする */
  readjust(districtId: number): string | null {
    const blocked = this.blockedReason();
    if (blocked) return blocked;
    const inD = (p: P2) => this.districts.at(p)?.id === districtId;
    let cells = 0;
    for (const c of this.cells.values()) if (inD(c)) cells++;
    if (!cells) return 'この地区には区画がありません';
    const cost = cells * 20;
    if (cost > this.econ.money) return `資金が足りません（必要 ${formatYen(cost)}）`;
    spend(this.econ, cost);
    for (const r of [...this.rubble]) if (inD(r)) this.clearRubble(r.id, false);
    let n = 0;
    for (const b of this.buildings.values()) {
      if (!inD(b)) continue;
      b.seismic = 'new';
      if (isWooden({ kind: b.kind, fireproof: false })) b.fireproof = true;
      b.damagedUntil = 0;
      n++;
    }
    addModifier(this.politics, 'progress', 3, this.day + 360, '区画整理');
    addModifier(this.politics, 'tradition', -2, this.day + 360, '区画整理');
    this.say(`${this.districts.get(districtId)?.name}で復興区画整理。${n} 棟が新しい基準で建て直されました（${formatYen(cost)}）`, 'good');
    this.versions.buildings++;
    this.versions.fires++;
    this.recount();
    return null;
  }

  /** 高台移転：地区の中で浸水の危険が高い土地の建物を移し、住宅地をやめる */
  relocate(districtId: number): string | null {
    const blocked = this.blockedReason();
    if (blocked) return blocked;
    const risky = (p: P2) => this.districts.at(p)?.id === districtId && (hazardFlood(this.terrain, p.x, p.z) > 1 || coastalDepth(this.terrain, newDefenses(), p.x, p.z, 6) > 1);
    const targets = [...this.buildings.values()].filter((b) => risky(b));
    let cells = 0;
    for (const c of this.cells.values()) if (risky(c)) cells++;
    if (!cells) return 'この地区には浸水の危険が高い土地がありません';
    const cost = targets.length * 30 + cells * 2;
    if (cost > this.econ.money) return `資金が足りません（必要 ${formatYen(cost)}）`;
    spend(this.econ, cost);
    for (const b of targets) this.removeBuilding(b.id);
    for (const c of this.cells.values()) if (risky(c)) c.zone = 0;
    addModifier(this.politics, 'tradition', -5, this.day + 720, '高台移転');
    addModifier(this.politics, 'progress', 2, this.day + 720, '高台移転');
    this.say(`${this.districts.get(districtId)?.name}の低い土地から ${targets.length} 棟が高台へ移転。跡地は住宅地をやめました`, 'politics');
    this.versions.cells++;
    this.recount();
    return null;
  }

  private waterMonth(day: number): void {
    // 梅雨の大雨（6〜7 月）と台風（8〜10 月）
    const month = ((3 + Math.floor((day % 360) / 30)) % 12) + 1;
    if (this.disastersEnabled && !this.activeStorm()) {
      if ((month === 6 || month === 7) && this.rand() < 0.22) this.spawnStorm('rain');
      else if (month >= 8 && month <= 10 && this.rand() < 0.25) this.spawnStorm('typhoon');
    }
    if (month === 4 && day % 360 === 0) this.stormNo = 0;
    // 家を失った人：仮設住宅に入れなければ、市外へ出ていく
    if (this.displaced > 0) {
      let housing = 0;
      for (const f of this.facilities.values()) housing += FACILITIES[f.kind].housing ?? 0;
      const homeless = Math.max(0, this.displaced - housing);
      const leave = Math.round(homeless * 0.25);
      if (leave >= 20) this.say(`住まいを失った ${leave.toLocaleString()} 人が市外へ移りました。仮設住宅が足りません`, 'bad');
      this.displaced = Math.max(0, Math.round((this.displaced - leave) * 0.85));
    }
    this.restricted = this.restricted.filter((r) => r.until > day);
    this.versions.water++;
  }

  // ---------- 政策と布告 ----------
  togglePolicy(districtId: number, id: PolicyId): boolean {
    if (this.blockedReason()) return false;
    const list = this.policies.districts[districtId] ?? [];
    const on = !list.includes(id);
    this.policies.districts[districtId] = on ? [...list, id] : list.filter((x) => x !== id);
    const where = districtId ? this.districts.get(districtId)?.name ?? '地区' : '市全体';
    this.say(`${where}で「${POLICIES[id].name}」を${on ? '始めました' : 'やめました'}`, 'politics');
    this.versions.economy++;
    return on;
  }

  /** 布告を出す（切り替え式はオン／オフ）。できなければ理由 */
  decree(id: DecreeId): string | null {
    const blocked = this.blockedReason();
    if (blocked) return blocked;
    const def = DECREES[id], p = this.policies, day = this.day;
    if (def.kind === 'toggle') {
      const on = p.decrees[id] !== true;
      p.decrees[id] = on;
      this.say(`${def.name}を${on ? '出しました' : '解除しました'}`, 'politics');
      this.refreshServices();
      this.versions.economy++;
      return null;
    }
    if ((p.cooldowns[id] ?? 0) > day) return `次に出せるのは ${Math.ceil(((p.cooldowns[id] ?? 0) - day) / 30)} か月後です`;
    if (id === 'emergency' && day - p.lastDisasterDay > 60) return '災害から 60 日以内でないと出せません';
    if (def.cost) {
      if (def.cost > this.econ.money) return `資金が足りません（必要 ${formatYen(def.cost)}）`;
      spend(this.econ, def.cost, 'other');
    }
    p.decrees[id] = day + (def.duration ?? 0);
    p.cooldowns[id] = day + (def.cooldown ?? 0);
    if (id === 'festival') addModifier(this.politics, 'tradition', 8, day + 90, '祭り');
    if (id === 'emergency') addModifier(this.politics, 'progress', -5, day + 60, '非常事態宣言');
    this.say(id === 'festival' ? '市をあげての祭りが開かれ、にぎわっています' : `${def.name}を出しました`, 'politics');
    this.versions.economy++;
    this.recount();
    return null;
  }

  /** 政策の月の費用 */
  private policyCost(): number {
    let cost = 0;
    for (const [did, list] of Object.entries(this.policies.districts)) {
      for (const id of list) {
        const def = POLICIES[id];
        cost += def.costFlat ?? 0;
        if (def.costPerBuilding) {
          for (const b of this.buildings.values()) {
            if (b.seismic !== 'old') continue;
            if (Number(did) === 0 || this.districts.at(b)?.id === Number(did)) cost += def.costPerBuilding;
          }
        }
      }
    }
    return cost;
  }

  private policyMonth(_day: number): void {
    // 耐震補助：旧耐震の建物を少しずつ改修する
    let retrofit = 0;
    for (const b of this.buildings.values()) {
      if (b.seismic !== 'old') continue;
      if (!hasPolicy(this.policies, this.districts.at(b)?.id ?? 0, 'seismicAid')) continue;
      if (this.rand() < 0.03) { b.seismic = 'new'; retrofit++; }
    }
    if (retrofit >= 5) this.say(`耐震補助で ${retrofit} 棟の耐震改修が終わりました`, 'good');
  }

  /** 施設・政策・布告による派閥の支持の上乗せ */
  private factionExtra(day: number): Partial<Record<FactionId, number>> {
    const extra: Partial<Record<FactionId, number>> = { ...(this.services?.factionBonus ?? {}) };
    const add = (id: FactionId, v: number) => { extra[id] = (extra[id] ?? 0) + v; };
    const total = Math.max(1, this.buildings.size);
    for (const [did, list] of Object.entries(this.policies.districts)) {
      let share = 1;
      if (Number(did) !== 0) {
        let n = 0;
        for (const b of this.buildings.values()) if (this.districts.at(b)?.id === Number(did)) n++;
        share = n / total;
      }
      for (const id of list) for (const [f, v] of Object.entries(POLICIES[id].faction ?? {})) add(f as FactionId, (v as number) * Math.max(0.3, share));
    }
    if (decreeActive(this.policies, 'powerSaving', day)) add('business', -6);
    if (decreeActive(this.policies, 'staggered', day)) add('business', -3);
    add('business', -this.traffic.congestion * 12 + Math.max(0, this.connections.rel.chamber - 30) / 8);
    if (decreeActive(this.policies, 'curfew', day)) add('progress', -15);
    this.defenseExtra(day, add);
    return extra;
  }

  // ---------- 外交 ----------
  neighbor(edge: Edge): Neighbor | undefined {
    return this.region.neighbors.find((n) => n.edge === edge);
  }

  /** 月末の収支に入る外交・防衛のお金 */
  private diplomacyMoney(day: number): { furusato: number; furusatoOut: number; tributeIn: number; tributeOut: number; arms: number; grant: number; importDiscount: number } {
    const s = this.stats;
    const resTax = s.population * 0.35 * (this.econ.taxes.res / 10);
    const goods = Math.min(0.7, (s.indJobs + s.comJobs * 0.5) / 5000);
    const f = furusatoMonth(this.diplomacy.furusato, this.region, { day, population: s.population, goods, resTax });
    const fs = this.diplomacy.furusato;
    if (fs.overMonths === 1) this.say(`中央政府が「返礼品は寄付額の 3 割以下に」と是正を求めています（今は ${Math.round(fs.rate * 100)}％）`, 'politics');
    if (fs.overMonths >= 6 && day >= fs.excludedUntil) {
      fs.excludedUntil = day + 360;
      fs.overMonths = 0;
      this.say('返礼品の是正に応じなかったため、ふるさと納税の制度から 1 年間外されました', 'bad');
    }
    let tributeIn = 0;
    for (const n of this.region.neighbors) if (day < n.vassalUntil) tributeIn += n.population * 0.05;
    let tributeOut = 0;
    const tr = this.defense.tribute;
    if (tr && day < tr.until) {
      const last = this.econ.reports.at(-1);
      const taxes = last ? last.income.res + last.income.biz + last.income.prop : resTax;
      tributeOut = taxes * tr.share;
    } else if (tr) {
      this.defense.tribute = null;
      this.say(`${tr.name}への上納金の支払いが終わりました`, 'good');
    }
    const linked = this.region.neighbors.some((n) => canTrade(n));
    let arms = 0, grant = 0;
    for (const fac of this.facilities.values()) {
      const def = FACILITIES[fac.kind];
      if (def.income && linked) arms += def.income;
      grant += def.grant ?? 0;
    }
    // 広域連携：ゴミと下水の購入費が半分
    let importDiscount = 0;
    const u = this.services?.util;
    if (u && this.region.neighbors.some((n) => n.connected && n.treaties.includes('wide'))) {
      importDiscount = (u.garbage.imported * IMPORT.garbage.price + u.sewage.imported * IMPORT.sewage.price) * 0.5;
    }
    return { furusato: f.net, furusatoOut: f.lost, tributeIn, tributeOut, arms, grant, importDiscount };
  }

  /** 月ごとの外交：緊張、事件、小競り合い、宣戦布告 */
  private diplomacyMonth(day: number): void {
    const power = this.militaryPower();
    const hawk = this.politics.mayor === 'hawk' && day > this.politics.blockAiUntil;
    for (const n of active(this.region)) {
      if (this.defense.war?.edge === n.edge) continue;
      const before = stageOf(n.tension);
      tensionMonth(n, { ourPower: power, hawkMayor: hawk, warEnabled: this.warEnabled, day }, this.rand);
      const after = stageOf(n.tension);
      if (after > before) {
        const text = [
          '', `${n.name}が市に抗議声明。両市の関係が冷え込んでいます`, `${n.name}が経済制裁を発動。交易が止まりました`,
          `${n.name}が境界を封鎖。通勤と物流が止まりました`, `境界付近で${n.name}の部隊と小競り合い。緊張が最高潮に`, '',
        ][after];
        if (text) this.say(`【外交】${text}`, 'bad');
        if (after >= 3) this.trafficDirty = true;
      } else if (after < before) {
        this.say(`【外交】${n.name}との緊張が和らぎ、「${STAGE_NAMES[after]}」に戻りました`, 'good');
        if (before >= 3) this.trafficDirty = true;
      }
      if (after === 4 && this.rand() < 0.5) {
        const hit = this.damageBorder(n.edge, 1 + Math.floor(this.rand() * 3), 220);
        if (hit) this.say(`境界付近で${n.name}側から砲撃。建物 ${hit} 棟に被害`, 'bad');
      }
      if (n.tension >= 100 && this.warEnabled && !this.defense.war) {
        if (willAttack(n, power)) this.startWar(n, 'them');
        else n.tension = 95;
      }
      // 事件（要求）
      if (!this.diplomacy.demands.some((d) => d.edge === n.edge) && this.rand() < 0.035) {
        const kinds: DemandKind[] = ['border', 'dump'];
        if (n.edge === 'north') kinds.push('water');
        if (n.treaties.includes('aid') || this.rand() < 0.3) kinds.push('evacuees');
        const kind = kinds[Math.floor(this.rand() * kinds.length)];
        this.diplomacy.demands.push({ edge: n.edge, kind, text: demandText(n, kind), expires: day + 60 });
        this.say(`【外交】${demandText(n, kind)}（「地域」パネルで対応を決めてください）`, 'politics');
      }
    }
    for (const d of [...this.diplomacy.demands]) {
      if (d.expires > day) continue;
      // 答えないまま期限が過ぎると、相手は少し気を悪くする
      this.diplomacy.demands.splice(this.diplomacy.demands.indexOf(d), 1);
      const n = this.neighbor(d.edge);
      if (!n || n.merged) continue;
      n.relation = Math.max(-100, n.relation - 5);
      n.tension = Math.min(tensionCapOf(n, this), n.tension + 4);
      this.say(`${n.name}の要求に答えないまま期限が過ぎ、相手は「無視された」と不満を漏らしています`, 'politics');
    }
    for (const t of furusatoRivals(this.diplomacy.furusato, this.region, this.rand)) this.say(t, 'politics');
    // 戦争の月ごとの報道と厭戦気分
    const w = this.defense.war;
    if (w && !w.pendingVictory) {
      const months = Math.floor((day - w.startDay) / 30);
      this.say(`【紛争】${w.name}との紛争 ${months} か月目。戦況 ${w.front >= 0 ? '優勢' : '劣勢'}（${Math.round(w.front)}）、失った部隊 ${w.ourLosses}`, w.front >= 0 ? 'politics' : 'bad');
    }
    updateConnections(this.region, this.net);
    this.versions.economy++;
  }

  /** 軍事力（部隊の力の合計に、訓練・士気・補給をかけたもの） */
  militaryPower(): number {
    return ourPower(this.defense, { training: this.hasFacility('training'), approval: this.politics.approval, money: this.econ.money });
  }

  /** 外交の手段を使う。できなければ理由 */
  diplomacyAction(edge: Edge, id: DiploActionId): string | null {
    const n = this.neighbor(edge);
    const def = DIPLO_ACTIONS[id];
    if (!n || n.merged) return 'その町はもうありません';
    const blocked = this.blockedReason();
    if (blocked) return blocked;
    if (this.defense.war?.edge === edge) return '紛争中です。「防衛」パネルから講和を申し入れてください';
    const cd = id === 'mediate' ? this.diplomacy.mediateDay : n.cooldowns[id] ?? 0;
    if (cd > this.day) return `あと ${Math.ceil((cd - this.day) / 30)} か月は使えません`;
    if (def.minTension && n.tension < def.minTension) return `緊張が ${def.minTension} 以上のときに使えます`;
    if (def.cost > this.econ.money) return `資金が足りません（必要 ${formatYen(def.cost)}）`;
    if (id === 'mediate' && this.connections.rel.governor < 40) return '県知事との関係が 40 以上必要です';
    let msg = '';
    switch (id) {
      case 'goodwill': n.relation += 6; n.tension -= 3; msg = `${n.name}を親善訪問。${n.mayor}市長と会談しました`; break;
      case 'aid': n.relation += 15; n.tension -= 8; msg = `${n.name}に経済支援。${n.mayor}市長が感謝を表明`; break;
      case 'protest':
        n.relation -= 10; n.tension += 8;
        addModifier(this.politics, 'defense', 2, this.day + 180, '隣町への抗議');
        msg = `${n.name}に抗議しました`; break;
      case 'negotiate': {
        const ratio = this.militaryPower() / Math.max(1, n.military);
        const chance = 0.35 + n.relation / 200 + Math.min(0.25, (ratio - 1) * 0.15);
        if (this.rand() < chance) { n.tension -= 20; msg = `${n.name}との交渉がまとまり、緊張が和らぎました`; }
        else { n.tension += 3; msg = `${n.name}との交渉は物別れに終わりました`; }
        break;
      }
      case 'concede':
        n.tension -= 30; n.relation += 5;
        addModifier(this.politics, 'defense', -6, this.day + 360, '隣町への譲歩');
        addModifier(this.politics, 'tradition', -3, this.day + 360, '隣町への譲歩');
        msg = `${n.name}の言い分を飲んで譲歩しました。「弱腰だ」との批判も`; break;
      case 'mediate':
        n.tension -= 35;
        this.connections.rel.governor -= 10;
        this.diplomacy.mediateDay = this.day + def.cooldown;
        msg = `県知事が${n.name}との間に入り、話し合いの場が設けられました`; break;
    }
    if (def.cost) spend(this.econ, def.cost, 'other');
    if (id !== 'mediate') n.cooldowns[id] = this.day + def.cooldown;
    n.relation = Math.max(-100, Math.min(100, n.relation));
    n.tension = Math.max(0, Math.min(100, n.tension));
    clampTension(n, this.warEnabled, this.day);
    updateConnections(this.region, this.net);
    this.say(msg, 'politics');
    this.versions.economy++;
    return null;
  }

  /** 経済制裁をかける・やめる */
  toggleSanction(edge: Edge): string | null {
    const n = this.neighbor(edge);
    if (!n || n.merged) return 'その町はもうありません';
    const blocked = this.blockedReason();
    if (blocked) return blocked;
    n.sanction = !n.sanction;
    if (n.sanction) {
      n.relation = Math.max(-100, n.relation - 15);
      n.tension = Math.min(100, n.tension + 15);
      clampTension(n, this.warEnabled, this.day);
      n.treaties = n.treaties.filter((t) => t === 'nonaggression');
      this.say(`${n.name}に経済制裁。交易を止めました`, 'politics');
    } else {
      n.tension = Math.max(0, n.tension - 5);
      this.say(`${n.name}への経済制裁を解除しました`, 'politics');
    }
    updateConnections(this.region, this.net);
    this.versions.economy++;
    return null;
  }

  /** 協定を結ぶ・やめる */
  toggleTreaty(edge: Edge, id: TreatyId): string | null {
    const n = this.neighbor(edge);
    if (!n || n.merged) return 'その町はもうありません';
    const blocked = this.blockedReason();
    if (blocked) return blocked;
    if (n.treaties.includes(id)) {
      n.treaties = n.treaties.filter((t) => t !== id);
      n.relation = Math.max(-100, n.relation - 20);
      n.tension = Math.min(100, n.tension + 10);
      clampTension(n, this.warEnabled, this.day);
      this.say(`${n.name}との${TREATIES[id].name}を破棄しました。相手は強く反発しています`, 'politics');
    } else {
      const why = treatyBlock(n, id);
      if (why) return why;
      n.treaties.push(id);
      n.relation = Math.min(100, n.relation + 3);
      clampTension(n, this.warEnabled, this.day);
      this.say(`${n.name}と${TREATIES[id].name}を結びました`, 'good');
      if (id === 'alliance') for (const o of active(this.region)) if (o !== n && o.relation < 0) o.tension = Math.min(tensionCapOf(o, this), o.tension + 6);
    }
    updateConnections(this.region, this.net);
    this.versions.economy++;
    return null;
  }

  /** 隣町の要求に答える */
  answerDemand(edge: Edge, accept: boolean): string | null {
    const i = this.diplomacy.demands.findIndex((d) => d.edge === edge);
    if (i < 0) return null;
    const d = this.diplomacy.demands[i];
    const n = this.neighbor(edge);
    this.diplomacy.demands.splice(i, 1);
    if (!n || n.merged) return null;
    const until = this.day + 360;
    const k = d.kind;
    if (accept) {
      if (k === 'water') { if (this.econ.money < 2_000) return '資金が足りません（必要 2,000万円）'; spend(this.econ, 2_000, 'other'); n.relation += 8; n.tension -= 5; }
      if (k === 'border') { n.relation += 6; n.tension -= 8; addModifier(this.politics, 'defense', -4, until, '境界線での譲歩'); addModifier(this.politics, 'tradition', -4, until, '境界線での譲歩'); }
      if (k === 'dump') { n.relation += 8; addModifier(this.politics, 'green', -5, until, '隣町のゴミ処分場'); }
      if (k === 'evacuees') { if (this.econ.money < 1_500) return '資金が足りません（必要 1,500万円）'; spend(this.econ, 1_500, 'other'); n.relation += 15; n.tension -= 6; addModifier(this.politics, 'progress', 3, until, '被災者の受け入れ'); }
      this.say(`${n.name}の要求を受け入れました：${DEMANDS[k].accept.replace(/（.*）/, '')}`, 'politics');
    } else {
      if (k === 'water') { n.relation -= 8; n.tension += 12; }
      if (k === 'border') { n.relation -= 6; n.tension += 10; addModifier(this.politics, 'defense', 2, until, '境界線で譲らない'); }
      if (k === 'dump') { n.relation -= 6; n.tension += 8; addModifier(this.politics, 'green', 3, until, 'ゴミ処分場に抗議'); }
      if (k === 'evacuees') n.relation -= 12;
      this.say(`${n.name}の要求を断りました`, 'politics');
    }
    n.relation = Math.max(-100, Math.min(100, n.relation));
    n.tension = Math.max(0, Math.min(100, n.tension));
    clampTension(n, this.warEnabled, this.day);
    updateConnections(this.region, this.net);
    this.versions.economy++;
    return null;
  }

  /** ふるさと納税の返礼品の割合を変える */
  setFurusatoRate(rate: number): void {
    this.diplomacy.furusato.rate = Math.round(Math.max(0.1, Math.min(0.5, rate)) * 100) / 100;
    this.versions.economy++;
  }

  /** 合併を申し入れる */
  proposeMerger(edge: Edge): string | null {
    const n = this.neighbor(edge);
    if (!n || n.merged) return 'その町はもうありません';
    const blocked = this.blockedReason();
    if (blocked) return blocked;
    if ((n.cooldowns.merge ?? 0) > this.day) return `断られたばかりです（あと ${Math.ceil((n.cooldowns.merge - this.day) / 30)} か月）`;
    const { odds, reason } = mergeOdds(n, this.stats.population);
    if (reason) return reason;
    if (this.rand() >= odds) {
      n.cooldowns.merge = this.day + 360;
      n.relation = Math.max(-100, n.relation - 5);
      this.say(`${n.name}の議会が合併案を否決しました。「町の名前と役場を残したい」`, 'politics');
      this.events.push({ type: 'war', kind: 'refused', name: n.name, text: `${n.name}の議会が合併案を否決しました。1 年たったら、もう一度申し入れられます。` });
      this.versions.economy++;
      return null;
    }
    this.mergeNeighbor(n, false);
    return null;
  }

  /** 隣町の土地と人を市に組み込む。forced は戦争での併合 */
  mergeNeighbor(n: Neighbor, forced: boolean): void {
    const pop = n.population;
    n.merged = true;
    n.connected = false;
    n.reach = false;
    n.treaties = [];
    n.sanction = false;
    n.tension = 0;
    this.diplomacy.demands = this.diplomacy.demands.filter((d) => d.edge !== n.edge);
    const residents = this.seedSettlement(n, forced);
    const until = this.day + 360 * 3;
    let text: string;
    if (forced) {
      addModifier(this.politics, 'all', -6, until, '強制的な併合');
      addModifier(this.politics, 'progress', -8, until, '強制的な併合');
      for (const o of active(this.region)) { o.relation = Math.max(-100, o.relation - 15); o.tension = Math.min(tensionCapOf(o, this), o.tension + 10); }
      text = `${n.name}を併合しました。住民 ${residents.toLocaleString()} 人が市民になりましたが、反発も根強く残っています。ほかの隣町は警戒を強めています。`;
    } else {
      const debt = Math.round(pop * 3);
      this.inheritDebt(debt);
      const bonus = Math.round(pop * 2);
      refund(this.econ, bonus);
      addModifier(this.politics, 'tradition', 4, until, '合併');
      text = `${n.name}との合併が住民投票で決まりました。住民 ${residents.toLocaleString()} 人が市民になり、${EDGE_LABEL[n.edge]}の土地が使えるようになります。借金 ${formatYen(debt)} を引き継ぎ、国から合併の支援 ${formatYen(bonus)} が入りました。`;
    }
    this.say(`【合併】${text}`, forced ? 'politics' : 'good');
    this.events.push({ type: 'war', kind: 'merged', name: n.name, text });
    updateConnections(this.region, this.net);
    this.versions.territory++;
    this.versions.economy++;
    this.refreshServices();
    this.recount();
  }

  private inheritDebt(amount: number): void {
    if (amount <= 0) return;
    const e = this.econ;
    const months = 120, rate = 1.2, r = rate / 100 / 12;
    e.loans.push({ id: e.nextLoanId++, principal: amount, remaining: amount, monthly: (amount * r) / (1 - Math.pow(1 + r, -months)), monthsLeft: months, rate });
  }

  /** 合併した土地に、もとの町の道路と家並みをつくる。市民になった人数を返す */
  private seedSettlement(n: Neighbor, forced: boolean): number {
    const inStrip = (p: P2) => Math.abs(p.x) < HALF - 50 && Math.abs(p.z) < HALF - 50 &&
      (n.edge === 'west' ? p.x < -BORDER + 10 : n.edge === 'east' ? p.x > BORDER - 10 : p.z < -BORDER + 10 && Math.abs(p.x) < BORDER);
    const dry = (p: P2) => heightAt(this.terrain, p.x, p.z) > 1.5 && waterLevelAt(this.terrain, p.x, p.z) === null;
    // いちばん平らで乾いた場所（山あいなら谷底）を探す
    let seed: P2 | null = null, bestScore = Infinity;
    for (let a = -HALF + 60; a <= HALF - 60; a += 24) {
      for (let b = -HALF + 60; b <= HALF - 60; b += 24) {
        const p = { x: a, z: b };
        if (!inStrip(p) || !dry(p)) continue;
        const h = heightAt(this.terrain, a, b);
        let rough = 0;
        for (const [dx, dz] of [[30, 0], [-30, 0], [0, 30], [0, -30], [21, 21], [-21, -21]]) {
          const q = { x: a + dx, z: b + dz };
          rough += Math.abs(heightAt(this.terrain, q.x, q.z) - h) + (dry(q) ? 0 : 20);
        }
        const score = rough + h * 0.01;
        if (score < bestScore) { bestScore = score; seed = p; }
      }
    }
    if (!seed) return 0;
    const before = new Set(this.net.segments.keys());
    // 道を少しずつ伸ばす（勾配が急な方向はあきらめる）
    const heads: { p: P2; dir: number }[] = [{ p: seed, dir: 0 }, { p: seed, dir: Math.PI }];
    const placed: P2[] = [seed];
    let built = 0;
    for (let guard = 0; guard < 120 && built < 18 && heads.length; guard++) {
      const h = heads.shift()!;
      const tries: [number, number][] = [];
      for (const len of [56 + Math.floor(this.rand() * 3) * 8, 40, 32]) {
        for (const turn of [0, 0.35, -0.35, 0.7, -0.7, 1.05, -1.05, Math.PI / 2, -Math.PI / 2, 2.2, -2.2]) tries.push([turn, len]);
      }
      for (const [turn, len] of tries) {
        const dir = h.dir + turn;
        const end = { x: h.p.x + Math.cos(dir) * len, z: h.p.z + Math.sin(dir) * len };
        if (!inStrip(end) || !dry(end)) continue;
        if (placed.some((q) => Math.hypot(q.x - end.x, q.z - end.z) < 28)) continue;
        const plan = this.net.plan(this.net.snap(h.p), this.net.snap(end), null, 'local');
        if (!plan.ok) continue;
        for (const id of this.net.build(plan)) this.flatten(id);
        placed.push(end);
        built++;
        heads.push({ p: end, dir });
        // ときどき横道を出す
        if (this.rand() < 0.45) heads.push({ p: end, dir: dir + (this.rand() < 0.5 ? 1 : -1) * Math.PI / 2 });
        break;
      }
    }
    if (!built) return 0;
    this.afterRoadChange();
    const fresh = [...this.net.segments.keys()].filter((id) => !before.has(id));
    if (!fresh.length) return 0;
    const mix: Record<Neighbor['kind'], [ZoneId, number][]> = {
      village: [[1, 0.7], [3, 0.2], [5, 0.1]],
      industrial: [[6, 0.35], [5, 0.2], [1, 0.3], [2, 0.15]],
      tourism: [[4, 0.3], [3, 0.2], [1, 0.5]],
      bedtown: [[1, 0.6], [2, 0.3], [3, 0.1]],
      military: [[1, 0.5], [2, 0.2], [5, 0.3]],
    };
    const pickZone = (): ZoneId => {
      let r = this.rand();
      for (const [z, w] of mix[n.kind]) { if ((r -= w) <= 0) return z; }
      return 1;
    };
    const freshSet = new Set(fresh);
    const blockZone = new Map<string, ZoneId>();
    const cells = [...this.cells.values()].filter((cl) => freshSet.has(cl.seg) && !cl.facility && this.ownsLand(cl));
    for (const cl of cells) {
      const key = `${cl.seg}:${cl.side}:${Math.floor(cl.i / 4)}`;
      if (!blockZone.has(key)) blockZone.set(key, pickZone());
      cl.zone = blockZone.get(key)!;
    }
    // 家並みを一気に建てる（古い町なので建築年は昔）
    const target = Math.min(1_800, Math.round(n.population * (forced ? 0.5 : 1)));
    const year = yearOf(this.day);
    let residents = 0, guard = 0;
    const known = new Set(this.buildings.keys());
    this.seeding = true;
    const fronts = cells.filter((cl) => cl.depth === 0);
    while (residents < target && guard++ < 1_500 && fronts.length) {
      const f = fronts[Math.floor(this.rand() * fronts.length)];
      if (f.building || f.zone === 0) continue;
      if (this.tryBuild(f, this.day)) {
        const b = this.buildings.get(f.building)!;
        if (!b || known.has(b.id)) continue;
        known.add(b.id);
        b.built = Math.max(1, year - Math.floor(this.rand() * (n.kind === 'village' ? 45 : 30)));
        b.seismic = b.built >= SEISMIC_LAW_YEAR ? 'new' : 'old';
        b.day = this.day - 10;
        residents += b.residents;
      }
    }
    this.seeding = false;
    this.versions.cells++;
    this.versions.buildings++;
    return residents;
  }

  // ---------- 防衛隊 ----------
  /** 救助隊が多いほど逃げ遅れが減る */
  private rescueFactor(): number {
    return Math.max(0.4, 1 - unitCount(this.defense, 'rescue') * 0.1);
  }

  /** あといくつ部隊を置けるか */
  unitRoom(): number {
    let garrisons = 0;
    for (const f of this.facilities.values()) if (f.kind === 'garrison') garrisons++;
    return garrisons * UNITS_PER_GARRISON - this.defense.units.length;
  }

  unitCost(kind: UnitKind): number {
    return Math.round(UNITS[kind].cost * (this.hasFacility('armsFactory') ? 0.8 : 1));
  }

  /** 部隊を編成できない理由 */
  unitBlock(kind: UnitKind): string | null {
    const def = UNITS[kind];
    if (this.unitRoom() <= 0) return this.hasFacility('garrison') ? `駐屯地が満員です（1 か所に ${UNITS_PER_GARRISON} 部隊まで）` : '防衛隊駐屯地がありません（「施設」の防衛から建てられます）';
    if (def.unlockYear && this.year < def.unlockYear) return `${def.unlockYear} 年目から編成できます`;
    if (def.needs && !this.hasFacility(def.needs)) return `${FACILITIES[def.needs].name}が必要です`;
    const cost = this.unitCost(kind);
    if (cost > this.econ.money) return `資金が足りません（必要 ${formatYen(cost)}）`;
    return null;
  }

  recruit(kind: UnitKind): string | null {
    const blocked = this.blockedReason();
    if (blocked) return blocked;
    const why = this.unitBlock(kind);
    if (why) return why;
    spend(this.econ, this.unitCost(kind));
    this.addUnit(kind);
    this.say(`防衛隊に${UNITS[kind].name}を編成しました`, 'politics');
    this.versions.economy++;
    return null;
  }

  private addUnit(kind: UnitKind): void {
    if (this.unitRoom() <= 0) return;
    this.defense.units.push({ id: this.defense.nextUnitId++, kind, since: this.day });
    this.versions.war++;
  }

  disband(kind: UnitKind): string | null {
    const blocked = this.blockedReason();
    if (blocked) return blocked;
    const i = this.defense.units.findIndex((u) => u.kind === kind);
    if (i < 0) return 'その部隊はありません';
    this.defense.units.splice(i, 1);
    this.say(`${UNITS[kind].name}を解散しました`, 'politics');
    this.versions.war++;
    this.versions.economy++;
    return null;
  }

  // ---------- 紛争 ----------
  /** 宣戦布告できない理由 */
  warBlock(edge: Edge): string | null {
    const n = this.neighbor(edge);
    if (!n || n.merged) return 'その町はもうありません';
    if (!this.warEnabled) return '平和モードです（設定で変えられます）';
    if (this.defense.war) return 'すでに紛争中です';
    if (this.day < n.truceUntil) return '停戦の約束の期間中です';
    if (this.day < n.vassalUntil) return '従属都市です';
    if (n.treaties.includes('nonaggression')) return '不可侵条約を結んでいます';
    if (n.tension < 60) return '緊張が「境界の封鎖」（60）以上のときだけ宣戦布告できます';
    if (!this.defense.units.length) return '部隊がありません';
    return null;
  }

  declareWar(edge: Edge): string | null {
    const blocked = this.blockedReason();
    if (blocked) return blocked;
    const why = this.warBlock(edge);
    if (why) return why;
    this.startWar(this.neighbor(edge)!, 'us');
    return null;
  }

  private startWar(n: Neighbor, aggressor: 'us' | 'them'): void {
    const w: War = {
      edge: n.edge, name: n.name, startDay: this.day, front: 0, aggressor, ourLosses: 0, theirLosses: 0, damaged: 0,
      pendingVictory: false, peaceTry: this.day + 20,
    };
    this.defense.war = w;
    n.tension = 100;
    n.treaties = [];
    n.relation = Math.min(n.relation, -50);
    this.diplomacy.demands = this.diplomacy.demands.filter((d) => d.edge !== n.edge);
    const until = this.day + 180;
    let text: string;
    if (aggressor === 'them') {
      addModifier(this.politics, 'all', 6, until, '国難に団結');
      text = `${n.name}が市に宣戦を布告しました。境界で部隊が衝突しています。部隊の数と訓練、支持率（士気）、資金（補給）で戦況が決まります。`;
    } else {
      addModifier(this.politics, 'defense', 8, until, '開戦');
      addModifier(this.politics, 'tradition', 4, until, '開戦');
      addModifier(this.politics, 'progress', -10, this.day + 720, '開戦');
      addModifier(this.politics, 'green', -5, this.day + 720, '開戦');
      for (const o of active(this.region)) if (o !== n) { o.relation = Math.max(-100, o.relation - 10); o.tension = Math.min(tensionCapOf(o, this), o.tension + 5); }
      text = `${n.name}に宣戦を布告しました。境界で部隊が衝突しています。ほかの隣町は警戒を強めています。`;
    }
    this.say(`【紛争】${text}`, 'bad');
    this.events.push({ type: 'war', kind: 'declared', name: n.name, text });
    updateConnections(this.region, this.net);
    this.trafficDirty = true;
    this.versions.war++;
    this.versions.economy++;
  }

  private warDay(day: number): void {
    const w = this.defense.war;
    if (!w || w.pendingVictory || day % 5 !== 0) return;
    const n = this.neighbor(w.edge);
    if (!n || n.merged) { this.defense.war = null; return; }
    let allies = 0;
    for (const o of active(this.region)) if (o !== n && o.treaties.includes('alliance')) allies += o.military * 0.5;
    const step = warStep(w, n, { ours: this.militaryPower(), allies, base: this.hasFacility('nationalBase') ? 150 : 0, rand: this.rand });
    if (step.lostUnit && this.defense.units.length) {
      const order: UnitKind[] = ['infantry', 'mobile', 'naval', 'air', 'rescue'];
      const kind = order.find((k) => unitCount(this.defense, k) > 0)!;
      this.defense.units.splice(this.defense.units.findIndex((u) => u.kind === kind), 1);
      w.ourLosses++;
      this.say(`【紛争】${UNITS[kind].name}が大きな損害を受け、戦えなくなりました`, 'bad');
    }
    if (step.hits) {
      const hits = Math.max(1, Math.round(step.hits * (this.hasFacility('airbase') ? 0.5 : 1)));
      w.damaged += this.damageBorder(w.edge, hits, 200 + Math.max(0, -w.front) * 4);
    }
    this.versions.war++;
    if (w.front >= 100 || n.military < 3) {
      w.front = 100;
      w.pendingVictory = true;
      const text = `${n.name}の部隊が撤退し、紛争に勝ちました。結末を選んでください。`;
      this.say(`【紛争】${text}`, 'good');
      this.events.push({ type: 'war', kind: 'won', name: n.name, text });
    } else if (w.front <= -100) {
      this.defeat(n);
    }
  }

  /** 境界近くの建物に被害を与える。被害を受けた棟数を返す */
  private damageBorder(edge: Edge, count: number, band: number): number {
    const dist = (x: number, z: number) => (edge === 'west' ? x + BORDER : edge === 'east' ? BORDER - x : z + BORDER);
    const list = [...this.buildings.values()].filter((b) => { const d = dist(b.x, b.z); return d > 0 && d < band; });
    let hit = 0;
    for (let k = 0; k < count && list.length; k++) {
      const b = list.splice(Math.floor(this.rand() * list.length), 1)[0];
      if (this.rand() < 0.4) { this.displaced += b.residents; this.destroyBuilding(b, this.day); }
      else { b.damagedUntil = this.day + 90; this.displaced += Math.round(b.residents * 0.3); }
      hit++;
    }
    for (const f of this.facilities.values()) {
      const d = dist(f.x, f.z);
      if (d > 0 && d < band * 0.6 && this.rand() < 0.05 * count) f.downUntil = Math.max(f.downUntil, this.day + 60);
    }
    if (hit) { this.versions.buildings++; this.recount(); }
    return hit;
  }

  /** 講和を申し入れる。auto は AI 市長が申し入れるとき */
  proposePeace(auto = false): string | null {
    const w = this.defense.war;
    if (!w) return '紛争中ではありません';
    if (w.pendingVictory) return '勝った紛争の結末を選んでください';
    if (!auto) { const blocked = this.blockedReason(); if (blocked) return blocked; }
    if (this.day < w.peaceTry) return `相手はまだ話し合いに応じません（あと ${w.peaceTry - this.day} 日）`;
    const n = this.neighbor(w.edge)!;
    const t = peaceTerms(w, n);
    if (t.kind === 'theyPay') {
      refund(this.econ, t.amount);
      this.endWar('peace', `${n.name}から賠償金 ${formatYen(t.amount)} を受け取り、講和しました`);
    } else if (t.kind === 'white') {
      if (this.rand() >= t.chance) {
        w.peaceTry = this.day + 30;
        this.say(`${n.name}は講和の申し入れを拒みました`, 'politics');
        this.versions.economy++;
        return `${n.name}は講和を拒みました（30 日後にもう一度申し入れられます）`;
      }
      this.endWar('peace', `${n.name}と講和しました（どちらも賠償なし）`);
    } else {
      spend(this.econ, t.amount, 'other');
      addModifier(this.politics, 'defense', -8, this.day + 720, '屈辱的な講和');
      this.endWar('peace', `${n.name}に賠償金 ${formatYen(t.amount)} を払って講和しました`);
    }
    return null;
  }

  /** 勝ったときの結末を選ぶ */
  settleVictory(choice: VictoryChoice): string | null {
    const w = this.defense.war;
    if (!w?.pendingVictory) return '選べる結末はありません';
    const n = this.neighbor(w.edge)!;
    let text = '';
    if (choice === 'annex') {
      this.endWar('won', `${n.name}に勝ち、併合しました`);
      this.mergeNeighbor(n, true);
      return null;
    }
    if (choice === 'reparations') {
      const amount = Math.round(n.population * 1.5 / 10) * 10;
      refund(this.econ, amount);
      text = `${n.name}に勝ち、賠償金 ${formatYen(amount)} を受け取りました`;
    } else {
      n.vassalUntil = this.day + 3600;
      text = `${n.name}に勝ち、従属都市にしました。10 年間、上納金が入ります`;
    }
    this.endWar('won', text);
    return null;
  }

  private defeat(n: Neighbor): void {
    const amount = Math.round(20_000 + n.population);
    spend(this.econ, amount, 'other');
    this.defense.tribute = { edge: n.edge, name: n.name, until: this.day + 1800, share: 0.08 };
    addModifier(this.politics, 'all', -12, this.day + 720, '紛争での敗北');
    this.endWar('lost', `${n.name}との紛争に敗れました。賠償金 ${formatYen(amount)} を払い、5 年間は税収の 8％を上納します`);
  }

  private endWar(result: WarResult, text: string): void {
    const w = this.defense.war;
    if (!w) return;
    const n = this.neighbor(w.edge);
    if (n) {
      n.tension = result === 'won' ? 20 : 35;
      n.truceUntil = this.day + 720;
      n.relation = Math.min(n.relation, result === 'peace' ? -20 : -40);
      n.military = Math.max(n.military, 5);
    }
    this.defense.records.push({ name: w.name, startDay: w.startDay, endDay: this.day, result, outcome: text });
    this.defense.war = null;
    if (result === 'won') addModifier(this.politics, 'all', 6, this.day + 360, '紛争の勝利');
    this.say(`【紛争】${text}`, result === 'lost' ? 'bad' : 'politics');
    this.events.push({ type: 'war', kind: result === 'lost' ? 'lost' : result === 'won' ? 'won' : 'peace', name: w.name, text });
    updateConnections(this.region, this.net);
    this.trafficDirty = true;
    this.versions.war++;
    this.versions.economy++;
  }

  /** 防衛と外交による派閥の支持の上乗せ */
  private defenseExtra(day: number, add: (id: FactionId, v: number) => void): void {
    const power = this.militaryPower();
    add('defense', Math.min(12, power / 25));
    const threat = active(this.region).some((n) => stageOf(n.tension) >= 2);
    if (threat && !this.defense.units.length) add('defense', -6);
    add('progress', -Math.min(8, power / 60));
    add('green', -Math.min(5, power / 100));
    if (this.hasFacility('nationalBase')) { add('defense', 6); add('green', -3); }
    let arms = 0;
    for (const f of this.facilities.values()) if (f.kind === 'armsFactory') arms++;
    add('progress', -Math.min(6, arms * 3));
    const w = this.defense.war;
    if (w && !w.pendingVictory) {
      const months = (day - w.startDay) / 30;
      const rally = w.aggressor === 'them' ? Math.max(0, 8 - months * 2) : Math.max(0, 3 - months);
      const weariness = Math.min(30, months * 2 + w.ourLosses * 1.5 + w.damaged * 0.2);
      for (const id of ['business', 'labor', 'tradition', 'progress', 'green', 'defense'] as FactionId[]) add(id, rally - weariness);
      add('defense', 8);
    }
    if (this.defense.tribute && day < this.defense.tribute.until) for (const id of ['business', 'labor', 'tradition', 'defense'] as FactionId[]) add(id, -4);
  }

  // ---------- 集計 ----------
  recount(): void {
    let population = 0, comJobs = 0, indJobs = 0, oldSeismic = 0;
    const svc = this.services?.per;
    for (const b of this.buildings.values()) {
      const hurt = b.damagedUntil && b.damagedUntil > this.day ? 0.5 : 1;
      const dark = svc?.get(b.id)?.power === false ? 0.5 : 1;
      population += Math.round(b.residents * hurt);
      if (b.zone === 3 || b.zone === 4) comJobs += Math.round(b.jobs * hurt * dark);
      else indJobs += Math.round(b.jobs * hurt * dark);
      if (b.seismic === 'old') oldSeismic++;
    }
    const jobs = comJobs + indJobs;
    const [c, w, e] = ageMix(this.year);
    const ages: [number, number, number] = [Math.round(population * c), Math.round(population * w), Math.round(population * e)];
    const workers = Math.round(ages[1] * 0.9);
    const flow = commute(this.region, workers, jobs);
    const unemployed = Math.max(0, workers - Math.min(workers, jobs) - flow.out);
    const shortage = Math.max(0, jobs - workers - flow.inn);
    const capacity = this.region.neighbors
      .filter((n) => n.connected)
      .reduce((s, n) => s + Math.max(0, neighborJobs(n) - neighborWorkers(n)) + neighborJobs(n) * 0.04, 0);
    const pollution = this.services ? this.services.pollution : this.pollution();
    const unemployment = workers ? unemployed / workers : 0;
    const t = this.econ.taxes;
    const base = this.services ? this.services.happiness + 6 : 64 - pollution * 40;
    const festival = decreeActive(this.policies, 'festival', this.day) ? 8 : 0;
    const smoke = (this.policies.districts[0] ?? []).includes('noSmoking') ? 1 : 0;
    const curfew = decreeActive(this.policies, 'curfew', this.day) ? -3 : 0;
    const saving = decreeActive(this.policies, 'powerSaving', this.day) ? -2 : 0;
    const commutePenalty = Math.max(0, this.traffic.avgCommute - 18) * 0.5 + (population ? Math.min(15, (this.displaced / population) * 40) : 0);
    const happiness = clamp01(base - commutePenalty - unemployment * 100 - (t.res - DEFAULT_TAXES.res) * 2.5 - (this.econ.bankrupt ? 15 : 0) + festival + smoke + curfew + saving);
    const connected = this.region.neighbors.some((n) => n.connected);
    this.stats = {
      population, comJobs, indJobs, buildings: this.buildings.size,
      ages, workers, unemployed, unemployment, shortage, commuteOut: flow.out, commuteIn: flow.inn,
      commuteCapacity: capacity, happiness, pollution,
      oldSeismicShare: this.buildings.size ? oldSeismic / this.buildings.size : 0,
      demand: {
        res: clamp(45 + (jobs + Math.min(capacity, 400) - workers) * 0.35 - (t.res - 10) * 3 + (happiness - 55) * 0.4 - commutePenalty),
        com: clamp(20 + (population * 0.18 - comJobs) * 0.9 - (t.biz - 10) * 3 - shortage * 0.15 - ((this.policies.districts[0] ?? []).includes('landscape') ? 3 : 0)),
        ind: clamp(25 + (population * 0.25 + (connected ? 120 : 0) - indJobs) * 0.7 - (t.biz - 10) * 3 - shortage * 0.15),
      },
    };
  }

  /** 工業の建物の近く（60 m 以内）に住んでいる人の割合 */
  private pollution(): number {
    const R = 60;
    const grid = new Map<string, Building[]>();
    const key = (x: number, z: number) => `${Math.floor(x / R)},${Math.floor(z / R)}`;
    for (const b of this.buildings.values()) {
      if (b.zone < 5) continue;
      const k = key(b.x, b.z);
      const l = grid.get(k);
      if (l) l.push(b); else grid.set(k, [b]);
    }
    if (!grid.size) return 0;
    let exposed = 0, total = 0;
    for (const b of this.buildings.values()) {
      if (!b.residents) continue;
      total += b.residents;
      const bx = Math.floor(b.x / R), bz = Math.floor(b.z / R);
      let score = 0;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        for (const o of grid.get(`${bx + dx},${bz + dz}`) ?? []) {
          if (Math.hypot(o.x - b.x, o.z - b.z) < R) score += o.zone === 6 ? 1 : 0.4;
        }
      }
      exposed += b.residents * Math.min(1, score / 2);
    }
    return total ? exposed / total : 0;
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
      economy: structuredClone(this.econ),
      politics: structuredClone(this.politics),
      region: structuredClone(this.region),
      news: this.news.slice(),
      meta: { ...this.meta },
      facilities: [...this.facilities.values()].map((f) => ({ ...f })),
      nextFacilityId: this.nextFacilityId,
      fires: this.fires.map((f) => ({ ...f })),
      rubble: this.rubble.map((r) => ({ ...r })),
      policies: structuredClone(this.policies),
      quakes: this.quakes.slice(),
      transit: {
        stops: [...this.transit.stops.values()].map((x) => ({ ...x })),
        tracks: [...this.transit.tracks.values()].map((x) => ({ ...x })),
        lines: [...this.transit.lines.values()].map((x) => ({ ...x, path: [] })),
        nextId: this.transit.nextId,
      },
      connections: structuredClone(this.connections),
      defenses: structuredClone(this.defenses),
      storms: structuredClone(this.storms),
      disasterReports: this.disasterReports.slice(),
      displaced: this.displaced,
      restricted: this.restricted.slice(),
      stormNo: this.stormNo,
      diplomacy: structuredClone(this.diplomacy),
      defense: structuredClone(this.defense),
    };
  }

  /** 保存データから復元する。地形は生成し直したものを渡すこと（道路の造成をやり直す） */
  load(data: CityData, day: number): void {
    this.net.load(data.roads);
    for (const id of [...this.net.segments.keys()].sort((a, b) => a - b)) this.flatten(id);
    if (data.transit) {
      this.transit = {
        stops: new Map(data.transit.stops.map((x) => [x.id, { ...x }])),
        tracks: new Map(data.transit.tracks.map((x) => [x.id, { ...x }])),
        lines: new Map(data.transit.lines.map((x) => [x.id, { ...x }])),
        nextId: data.transit.nextId,
      };
      for (const tr of this.transit.tracks.values()) {
        if (tr.level === 'ground') this.terrainChanges.push(flattenRoad(this.terrain, trackCurve(this.transit, tr), tr.ys, tr.bridge, 4));
      }
    }
    if (data.connections) this.connections = structuredClone(data.connections);
    if (data.defenses) this.defenses = structuredClone(data.defenses);
    this.storms = structuredClone(data.storms ?? []);
    this.disasterReports = (data.disasterReports ?? []).slice();
    this.displaced = data.displaced ?? 0;
    this.restricted = (data.restricted ?? []).slice();
    this.stormNo = data.stormNo ?? 0;
    this.cells = generateCells(this.net, this.terrain, new Map(), transitObstacles(this.transit));
    const idx = this.cellIndex();
    for (let k = 0; k < data.zones.length; k += 3) {
      const c = this.findCell(idx, data.zones[k], data.zones[k + 1]);
      if (c) c.zone = data.zones[k + 2] as ZoneId;
    }
    // P1 のデータには建築年がないので、1 年目の旧耐震として扱う
    this.buildings = new Map(data.buildings.map((b) => [b.id, { ...b, built: b.built ?? 1, seismic: b.seismic ?? 'old' }]));
    this.nextBuildingId = data.nextBuildingId;
    this.facilities = new Map((data.facilities ?? []).map((f) => [f.id, { ...f }]));
    this.nextFacilityId = data.nextFacilityId ?? 1;
    this.rubble = (data.rubble ?? []).map((r) => ({ ...r }));
    this.nextRubbleId = this.rubble.reduce((m, r) => Math.max(m, r.id), 0) + 1;
    this.rehomeFacilities();
    this.rehomeBuildings();
    this.fires = (data.fires ?? []).filter((f) => this.buildings.has(f.building)).map((f) => ({ ...f }));
    if (data.policies) this.policies = structuredClone(data.policies);
    this.quakes = (data.quakes ?? []).slice();
    this.districts.list = data.districts.list.map((d) => ({ ...d }));
    this.districts.decode(data.districts.grid);
    if (data.economy) this.econ = structuredClone(data.economy);
    if (data.politics) this.politics = structuredClone(data.politics);
    if (data.region) this.region = normalizeRegion(structuredClone(data.region));
    if (data.diplomacy) this.diplomacy = { ...newDiplomacy(), ...structuredClone(data.diplomacy) };
    if (data.defense) this.defense = { ...newDefense(), ...structuredClone(data.defense) };
    this.versions.territory++;
    if (data.news) this.news = data.news.slice();
    if (data.meta) this.meta = { ...data.meta };
    this.day = Math.floor(day);
    updateConnections(this.region, this.net);
    this.refreshServices();
    this.rerouteLines();
    this.refreshTraffic();
    for (const k of Object.keys(this.versions) as (keyof typeof this.versions)[]) this.versions[k]++;
    this.recount();
    this.lastJobs = this.stats.comJobs + this.stats.indJobs;
  }
}

const EDGE_LABEL: Record<Edge, string> = { west: '西', east: '東', north: '北の山側' };

function tensionCapOf(n: Neighbor, c: City): number {
  return n.treaties.includes('nonaggression') || c.day < n.truceUntil ? 59 : c.warEnabled ? 100 : 79;
}

function insideMapSafe(p: P2): boolean {
  return Math.abs(p.x) < 1000 && Math.abs(p.z) < 1000;
}

function sampleProfileY(arr: number[], t: number): number {
  const n = arr.length - 1;
  const f = Math.min(n, Math.max(0, t * n));
  const i = Math.min(n - 1, Math.floor(f));
  return arr[i] + (arr[i + 1] - arr[i]) * (f - i);
}

function polylineLen(pts: P2[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  return l;
}


