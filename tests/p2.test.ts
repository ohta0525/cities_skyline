import { describe, expect, it } from 'vitest';
import { City } from '../src/city/city';
import { generateTerrain, HALF, MAP_SIZE } from '../src/world/terrain';
import type { Snap } from '../src/city/roads';

const free = (x: number, z: number): Snap => ({ kind: 'free', p: { x, z } });

function setup() {
  const t = generateTerrain(12345);
  const city = new City(t, 7);
  const k = Math.round(((60 + HALF) / MAP_SIZE) * 512);
  const rx = t.river[k].x;
  const o = { x: rx > 0 ? rx - 420 : rx + 420, z: 60 };
  city.buildRoad(city.planRoad(free(o.x - 150, o.z), free(o.x + 150, o.z), null, 'local'));
  return { t, city, o };
}

describe('P2：経済と住民', () => {
  it('道路を作るとお金が減り、撤去すると半分戻る', () => {
    const { city, o } = setup();
    const m0 = city.econ.money;
    const plan = city.planRoad(free(o.x, o.z - 100), free(o.x, o.z + 100), null, 'local');
    const cost = city.roadCost(plan);
    expect(cost).toBeGreaterThan(1500);
    city.buildRoad(plan);
    expect(city.econ.money).toBeCloseTo(m0 - cost, 0);
    const seg = [...city.net.segments.values()].at(-1)!;
    const m1 = city.econ.money;
    city.removeRoad(seg.id);
    expect(city.econ.money).toBeGreaterThan(m1);
  });

  it('お金が足りなければ道路は作れない', () => {
    const { city, o } = setup();
    city.econ.money = 100;
    const plan = city.planRoad(free(o.x, o.z - 100), free(o.x, o.z + 100), null, 'avenue');
    expect(city.checkRoad(plan)).toMatch(/資金が足りません/);
  });

  it('月末に税収が入り、報告が残る。建物には建築年がある', () => {
    const { city, o } = setup();
    city.paintZone(o, 200, 1);
    city.advanceTo(60);
    expect(city.econ.reports.length).toBe(2);
    expect(city.econ.reports[1].income.res).toBeGreaterThan(0);
    const b = [...city.buildings.values()][0];
    expect(b.built).toBe(1);
    expect(b.seismic).toBe('old');
    expect(city.news.some((n) => n.text.includes('最初の建物'))).toBe(true);
  });

  it('住宅だけの街では失業が出て、仕事の需要が上がる', () => {
    const { city, o } = setup();
    city.paintZone(o, 200, 1);
    city.advanceTo(90);
    expect(city.stats.workers).toBeGreaterThan(0);
    expect(city.stats.unemployment).toBeGreaterThan(0.3);
    expect(city.stats.demand.com).toBeGreaterThan(20);
  });

  it('地図の端まで道路を引くと隣町につながり、通勤が始まる', () => {
    const { city, o } = setup();
    city.paintZone(o, 200, 1);
    city.advanceTo(60);
    expect(city.region.neighbors.every((n) => !n.connected)).toBe(true);
    // 西の端まで、何本かに分けて道路を延ばす
    let x = o.x - 150;
    let start: Snap = city.snap({ x, z: o.z });
    let guard = 0;
    while (x > -HALF + 30 && guard++ < 40) {
      const nx = Math.max(-HALF + 20, x - 160);
      const plan = city.planRoad(start, free(nx, o.z), null, 'local');
      if (!plan.ok) break;
      city.buildRoad(plan);
      x = nx;
      start = city.snap({ x, z: o.z });
    }
    const west = city.region.neighbors.find((n) => n.edge === 'west')!;
    expect(west.connected).toBe(true);
    city.advanceTo(90);
    expect(city.stats.commuteOut).toBeGreaterThan(0);
    expect(city.stats.unemployment).toBeLessThan(0.3);
  });

  it('4 年目の終わりに選挙があり、支持が低いと落選して AI 市長になる', () => {
    const { city, o } = setup();
    city.paintZone(o, 200, 1);
    city.advanceTo(3 * 360 + 271);
    expect(city.politics.pledgeChoiceOpen).toBe(true);
    city.choosePledge('taxcut');
    // 支持を大きく下げる
    city.setTax('res', 15);
    city.setTax('biz', 15);
    for (const f of Object.keys(city.politics.support)) city.politics.modifiers.push({ faction: f as never, amount: -60, until: 99999, reason: 'テスト' });
    city.advanceTo(4 * 360 + 1);
    const e = city.politics.elections.at(-1)!;
    expect(e.year).toBe(5);
    expect(e.won).toBe(false);
    expect(city.politics.mayor).not.toBe('player');
    expect(city.blockedReason()).toMatch(/任期中/);
    expect(city.opposition('speech')).toBeNull();
    expect(city.opposition('speech')).toMatch(/か月後/);
  });

  it('保存して読み戻すと財政・政治・隣町・ニュースも戻る', () => {
    const { city, o } = setup();
    city.paintZone(o, 200, 1);
    city.setTax('res', 12);
    city.borrow(10_000);
    city.advanceTo(65);
    const data = JSON.parse(JSON.stringify(city.toJSON()));
    const c2 = new City(generateTerrain(12345), 7);
    c2.load(data, 65);
    expect(c2.econ.money).toBeCloseTo(city.econ.money, 3);
    expect(c2.econ.taxes.res).toBe(12);
    expect(c2.econ.loans.length).toBe(1);
    expect(c2.region.neighbors.map((n) => n.name)).toEqual(city.region.neighbors.map((n) => n.name));
    expect(c2.news.length).toBe(city.news.length);
    expect(c2.politics.approval).toBeCloseTo(city.politics.approval);
  });
});
