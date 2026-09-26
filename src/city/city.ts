import { mulberry32 } from '../core/rng';
import type { Terrain } from '../world/terrain';
import { KINDS, buildingValue, isWooden, kindsForZone, weightedOrder, type Building, type BuildingKind } from './buildings';
import { FACILITIES, type Facility, type FacilityKind } from './facilities';
import { computeServices, type ServiceReport } from './services';
import { bigQuakeRate, intensityAt, liquefaction, quakeDamage, quakeFireChance, shindoLabel, type Fire, type QuakeReport, type Rubble } from './disasters';
import { DECREES, POLICIES, decreeActive, hasPolicy, newPolicies, type DecreeId, type PolicyId, type PolicyState } from './policies';
import type { FactionId } from './politics';
import { waterLevelAt } from '../world/terrain';
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
import { commute, monthlyRegion, neighborJobs, neighborWorkers, newRegion, tradeIncome, updateConnections, type RegionState } from './region';
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
}

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
  private nextFacilityId = 1;
  private nextRubbleId = 1;
  day = 0;
  stats: CityStats = { ...EMPTY_STATS };
  /** 変更のたびに増える番号。描画側はこれを見て作り直す */
  versions = { roads: 0, cells: 0, buildings: 0, districts: 0, economy: 0, news: 0, facilities: 0, fires: 0, services: 0 };
  /** 地形を変えた範囲（描画側が取り出して反映する） */
  terrainChanges: GridRange[] = [];
  /** 画面に知らせたい出来事（選挙結果など）。描画側が取り出す */
  events: ({ type: 'election'; result: ElectionResult } | { type: 'quake'; report: QuakeReport })[] = [];
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
    return this.net.plan(start, end, control, type);
  }

  roadCost(plan: RoadPlan): number {
    return planCost(plan);
  }

  /** 道路を作れるか（お金・市長・財政）。できなければ理由 */
  checkRoad(plan: RoadPlan): string | null {
    if (!plan.ok) return plan.reason ?? 'ここには置けません';
    const blocked = this.blockedReason();
    if (blocked) return blocked;
    if (this.econ.bankrupt) return '財政再生団体のため、新しい道路は作れません';
    const cost = planCost(plan);
    if (cost > this.econ.money) return `資金が足りません（必要 ${formatYen(cost)}）`;
    return null;
  }

  buildRoad(plan: RoadPlan): number[] {
    const cost = planCost(plan);
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
    this.cells = generateCells(this.net, this.terrain, old);
    this.rehomeFacilities();
    this.rehomeBuildings();
    updateConnections(this.region, this.net);
    this.refreshServices();
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
      if (c.zone === zone || (onlyEmpty && c.zone) || c.facility) continue;
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
      const fronts = [...this.cells.values()].filter((c) => c.depth === 0 && !c.building && !c.facility && zones.has(c.zone));
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
    if (u && (u.power.served < 0.6 || u.water.served < 0.6) && this.rand() < 0.7) return false;
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
    let cap = eraOf(year).maxFloors[kind] ?? def.floors[1];
    if (hasPolicy(this.policies, district, 'heightLimit')) cap = Math.min(cap, 4);
    const hi = Math.max(def.floors[0], Math.min(def.floors[1], cap));
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
    closeMonth(this.econ, {
      day,
      residents: s.population,
      jobs: s.comJobs + s.indJobs - s.shortage,
      buildingValue: buildingValueSum,
      roadLength,
      trade: tradeIncome(this.region, s.indJobs, s.comJobs),
      grant: 300 + s.population * 0.05,
      defense: aiActive && mayor === 'hawk' ? 800 : 0,
      services: [...this.facilities.values()].reduce((a, f) => a + FACILITIES[f.kind].upkeep, 0),
      imports: this.services?.importCost ?? 0,
      policies: this.policyCost(),
    });
    if (!wasBankrupt && this.econ.bankrupt) this.say('財政再生団体に転落しました。新しい道路は作れず、税率も下げられません', 'bad');
    if (wasBankrupt && !this.econ.bankrupt) this.say('財政再生団体から脱しました', 'good');

    // 隣町
    monthlyRegion(this.region, this.rand);

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
    for (const r of [...this.rubble]) if (day >= r.clearDay - (emergency ? 20 : 0)) this.clearRubble(r.id, true);
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
    if (decreeActive(this.policies, 'curfew', day)) add('progress', -15);
    return extra;
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
    const happiness = clamp01(base - unemployment * 100 - (t.res - DEFAULT_TAXES.res) * 2.5 - (this.econ.bankrupt ? 15 : 0) + festival + smoke + curfew + saving);
    const connected = this.region.neighbors.some((n) => n.connected);
    this.stats = {
      population, comJobs, indJobs, buildings: this.buildings.size,
      ages, workers, unemployed, unemployment, shortage, commuteOut: flow.out, commuteIn: flow.inn,
      commuteCapacity: capacity, happiness, pollution,
      oldSeismicShare: this.buildings.size ? oldSeismic / this.buildings.size : 0,
      demand: {
        res: clamp(45 + (jobs + Math.min(capacity, 400) - workers) * 0.35 - (t.res - 10) * 3 + (happiness - 55) * 0.4),
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
    if (data.region) this.region = structuredClone(data.region);
    if (data.news) this.news = data.news.slice();
    if (data.meta) this.meta = { ...data.meta };
    this.day = Math.floor(day);
    updateConnections(this.region, this.net);
    this.refreshServices();
    for (const k of Object.keys(this.versions) as (keyof typeof this.versions)[]) this.versions[k]++;
    this.recount();
    this.lastJobs = this.stats.comJobs + this.stats.indJobs;
  }
}
