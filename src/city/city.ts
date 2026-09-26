import { mulberry32 } from '../core/rng';
import type { Terrain } from '../world/terrain';
import { KINDS, buildingValue, kindsForZone, weightedOrder, type Building, type BuildingKind } from './buildings';
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
  day = 0;
  stats: CityStats = { ...EMPTY_STATS };
  /** 変更のたびに増える番号。描画側はこれを見て作り直す */
  versions = { roads: 0, cells: 0, buildings: 0, districts: 0, economy: 0, news: 0 };
  /** 地形を変えた範囲（描画側が取り出して反映する） */
  terrainChanges: GridRange[] = [];
  /** 画面に知らせたい出来事（選挙結果など）。描画側が取り出す */
  events: { type: 'election'; result: ElectionResult }[] = [];
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
    this.rehomeBuildings();
    updateConnections(this.region, this.net);
    this.versions.roads++;
    this.versions.cells++;
    this.versions.economy++;
    this.recount();
  }

  /** 道路が変わったあと、建物を新しいマスに載せ直す。載らない建物は取り壊す */
  private rehomeBuildings(): void {
    const index = this.cellIndex();
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
      if (c.zone === zone || (onlyEmpty && c.zone)) continue;
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

  /** 日付を進める。1 日ごとに建物が建ち、月末に財政・政治・隣町を締める */
  advanceTo(day: number): void {
    const target = Math.floor(day);
    // 長く止まっていたあとでも一度に進めすぎない
    let d = Math.max(this.day, target - 90);
    while (d < target) {
      d++;
      this.day = d;
      this.growDay(d);
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
      const fronts = [...this.cells.values()].filter((c) => c.depth === 0 && !c.building && zones.has(c.zone));
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
    const era = eraOf(yearOf(day));
    const kinds = weightedOrder(kindsForZone(front.zone).filter((k) => !era.locked.includes(k)), (k) => KINDS[k].weight, this.rand);
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
    const year = yearOf(day);
    const cap = eraOf(year).maxFloors[kind] ?? def.floors[1];
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
    });
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

  // ---------- 集計 ----------
  recount(): void {
    let population = 0, comJobs = 0, indJobs = 0, oldSeismic = 0;
    for (const b of this.buildings.values()) {
      population += b.residents;
      if (b.zone === 3 || b.zone === 4) comJobs += b.jobs;
      else indJobs += b.jobs;
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
    const pollution = this.pollution();
    const unemployment = workers ? unemployed / workers : 0;
    const t = this.econ.taxes;
    const happiness = clamp01(64 - unemployment * 160 - (t.res - DEFAULT_TAXES.res) * 2.5 - pollution * 40 - (this.econ.bankrupt ? 15 : 0));
    const connected = this.region.neighbors.some((n) => n.connected);
    this.stats = {
      population, comJobs, indJobs, buildings: this.buildings.size,
      ages, workers, unemployed, unemployment, shortage, commuteOut: flow.out, commuteIn: flow.inn,
      commuteCapacity: capacity, happiness, pollution,
      oldSeismicShare: this.buildings.size ? oldSeismic / this.buildings.size : 0,
      demand: {
        res: clamp(45 + (jobs + Math.min(capacity, 400) - workers) * 0.35 - (t.res - 10) * 3 + (happiness - 55) * 0.4),
        com: clamp(20 + (population * 0.18 - comJobs) * 0.9 - (t.biz - 10) * 3 - shortage * 0.15),
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
    this.rehomeBuildings();
    this.districts.list = data.districts.list.map((d) => ({ ...d }));
    this.districts.decode(data.districts.grid);
    if (data.economy) this.econ = structuredClone(data.economy);
    if (data.politics) this.politics = structuredClone(data.politics);
    if (data.region) this.region = structuredClone(data.region);
    if (data.news) this.news = data.news.slice();
    if (data.meta) this.meta = { ...data.meta };
    this.day = Math.floor(day);
    updateConnections(this.region, this.net);
    for (const k of Object.keys(this.versions) as (keyof typeof this.versions)[]) this.versions[k]++;
    this.recount();
    this.lastJobs = this.stats.comJobs + this.stats.indJobs;
  }
}
