import { describe, expect, it } from 'vitest';
import { City } from '../src/city/city';
import { furusatoMonth, newDiplomacy, tensionMonth } from '../src/city/diplomacy';
import { BORDER, ownerAt, stageOf, tradeIncome, updateConnections } from '../src/city/region';
import { deserialize, serialize } from '../src/save/save';
import { generateTerrain, HALF, MAP_SIZE } from '../src/world/terrain';

/** 川から離れた平地に住宅地がある街 */
function town() {
  const t = generateTerrain(12345);
  const city = new City(t, 7);
  city.disastersEnabled = false;
  city.econ.money = 5_000_000;
  const k = Math.round(((60 + HALF) / MAP_SIZE) * 512);
  const rp = t.river[k];
  const x = rp.x + (rp.x > 0 ? -1 : 1) * (rp.width / 2 + 70);
  const plan = city.planRoad(city.snap({ x, z: -40 }), city.snap({ x, z: 200 }), null, 'local');
  expect(plan.ok, plan.reason).toBe(true);
  city.buildRoad(plan);
  city.placeFacility(city.planFacility({ x: x + 12, z: 190 }, 'solar'));
  city.paintZone({ x, z: 80 }, 130, 1);
  city.advanceTo(120);
  return { t, city, x };
}

/** 西の境界まで道路を延ばす */
function linkWest(city: City, x0: number, z: number) {
  let x = x0;
  let start = city.snap({ x, z });
  for (let guard = 0; x > -BORDER + 20 && guard < 40; guard++) {
    const nx = Math.max(-BORDER + 8, x - 160);
    const plan = city.planRoad(start, city.snap({ x: nx, z }, false), null, 'local');
    if (!plan.ok) break;
    city.buildRoad(plan);
    x = nx;
    start = city.snap({ x, z });
  }
}

describe('P6：市の境界', () => {
  it('隣町の土地には道路を引けず、境界まで引くとつながる', () => {
    const { city, x } = town();
    const west = city.region.neighbors.find((n) => n.edge === 'west')!;
    expect(ownerAt(city.region, -800, 0)).toBe(west);
    expect(ownerAt(city.region, 0, 0)).toBeNull();
    const bad = city.planRoad(city.snap({ x: -BORDER + 60, z: 0 }), city.snap({ x: -BORDER - 120, z: 0 }, false), null, 'local');
    expect(bad.ok).toBe(false);
    expect(bad.reason).toContain(west.name);
    linkWest(city, x - 150, 0);
    expect(west.connected).toBe(true);
  });

  it('合併すると隣町の土地が使えるようになり、家並みと借金を引き継ぐ', () => {
    const { city } = town();
    const north = city.region.neighbors.find((n) => n.edge === 'north')!;
    const debt0 = city.econ.loans.length;
    const before = city.buildings.size;
    city.mergeNeighbor(north, false);
    expect(north.merged).toBe(true);
    expect(city.ownsLand({ x: 0, z: -800 })).toBe(true);
    expect(city.buildings.size).toBeGreaterThan(before);
    expect([...city.buildings.values()].some((b) => b.z < -BORDER)).toBe(true);
    expect(city.econ.loans.length).toBe(debt0 + 1);
    expect(city.events.some((e) => e.type === 'war' && e.kind === 'merged')).toBe(true);
  });

  it('関係が悪いと合併を申し入れられない', () => {
    const { city } = town();
    expect(city.proposeMerger('west')).toMatch(/人口|関係/);
  });
});

describe('道路の修正', () => {
  it('幹線道路を端からまっすぐ延ばせる', () => {
    const city = new City(generateTerrain(999), 7);
    city.econ.money = 5e6;
    const a = city.planRoad(city.snap({ x: 0, z: 20 }), city.snap({ x: -150, z: 20 }, false), null, 'avenue');
    expect(a.ok, a.reason).toBe(true);
    city.buildRoad(a);
    const b = city.planRoad(city.snap({ x: -150, z: 20 }), city.snap({ x: -300, z: 20 }, false), null, 'avenue');
    expect(b.ok, b.reason).toBe(true);
  });
});

describe('P6：外交', () => {
  it('交易協定には関係が必要で、結ぶと交易の収入が増える', () => {
    const { city, x } = town();
    linkWest(city, x - 150, 0);
    const west = city.neighbor('west')!;
    west.relation = 5;
    expect(city.toggleTreaty('west', 'trade')).toMatch(/関係/);
    const base = tradeIncome(city.region, 1000, 500);
    west.relation = 30;
    expect(city.toggleTreaty('west', 'trade')).toBeNull();
    expect(tradeIncome(city.region, 1000, 500)).toBeGreaterThan(base * 1.3);
  });

  it('緊張が上がると交易が止まり、封鎖で通勤も止まる', () => {
    const { city, x } = town();
    linkWest(city, x - 150, 0);
    const west = city.neighbor('west')!;
    const base = tradeIncome(city.region, 1000, 500);
    expect(base).toBeGreaterThan(0);
    west.tension = 45;
    expect(stageOf(west.tension)).toBe(2);
    expect(tradeIncome(city.region, 1000, 500)).toBe(0);
    west.tension = 65;
    updateConnections(city.region, city.net);
    expect(west.reach).toBe(true);
    expect(west.connected).toBe(false);
  });

  it('不可侵条約と平和モードは緊張に上限をつくる', () => {
    const { city } = town();
    const west = city.neighbor('west')!;
    west.relation = -100;
    west.tension = 95;
    tensionMonth(west, { ourPower: 0, hawkMayor: true, warEnabled: false, day: city.day }, () => 0.9);
    expect(west.tension).toBeLessThanOrEqual(79);
    west.treaties.push('nonaggression');
    tensionMonth(west, { ourPower: 0, hawkMayor: true, warEnabled: true, day: city.day }, () => 0.9);
    expect(west.tension).toBeLessThanOrEqual(59);
  });

  it('ふるさと納税：返礼品を増やすと寄付が集まるが、3 割を超え続けると外される', () => {
    const { city } = town();
    const f = newDiplomacy().furusato;
    const input = { day: 100, population: 5000, goods: 0.3, resTax: 1500 };
    f.rate = 0.2;
    furusatoMonth(f, city.region, input);
    const low = f.received;
    f.rate = 0.4;
    furusatoMonth(f, city.region, input);
    expect(f.received).toBeGreaterThan(low);
    city.setFurusatoRate(0.45);
    for (let m = 0; m < 7; m++) city.advanceTo(city.day + 30);
    expect(city.diplomacy.furusato.excludedUntil).toBeGreaterThan(city.day);
    expect(city.diplomacy.furusato.received).toBe(0);
  });

  it('隣町の要求に答えると関係と緊張が変わる', () => {
    const { city } = town();
    const west = city.neighbor('west')!;
    city.diplomacy.demands.push({ edge: 'west', kind: 'border', text: 'test', expires: city.day + 60 });
    const t0 = west.tension;
    city.answerDemand('west', false);
    expect(west.tension).toBeGreaterThan(t0);
    expect(city.diplomacy.demands.length).toBe(0);
  });
});

describe('P6：防衛と紛争', () => {
  it('駐屯地がないと部隊を編成できない', () => {
    const { city } = town();
    expect(city.recruit('infantry')).toContain('駐屯地');
  });

  it('強い部隊で紛争に勝ち、賠償金を取れる', () => {
    const { city } = town();
    const west = city.neighbor('west')!;
    west.military = 40;
    west.tension = 70;
    for (let k = 0; k < 6; k++) city.defense.units.push({ id: k + 1, kind: 'mobile', since: 0 });
    expect(city.declareWar('west')).toBeNull();
    expect(city.defense.war).not.toBeNull();
    city.advanceTo(city.day + 200);
    expect(city.defense.war?.pendingVictory).toBe(true);
    const money = city.econ.money;
    expect(city.settleVictory('reparations')).toBeNull();
    expect(city.econ.money).toBeGreaterThan(money);
    expect(city.defense.war).toBeNull();
    expect(city.defense.records.at(-1)?.result).toBe('won');
    expect(west.truceUntil).toBeGreaterThan(city.day);
  });

  it('弱いと負けて、賠償金と上納金を払う', () => {
    const { city } = town();
    const east = city.neighbor('east')!;
    east.military = 800;
    east.tension = 70;
    city.defense.units.push({ id: 1, kind: 'infantry', since: 0 });
    expect(city.declareWar('east')).toBeNull();
    const money = city.econ.money;
    city.advanceTo(city.day + 300);
    expect(city.defense.war).toBeNull();
    expect(city.defense.records.at(-1)?.result).toBe('lost');
    expect(city.defense.tribute).not.toBeNull();
    expect(city.econ.money).toBeLessThan(money);
  });

  it('勝って併合すると土地が広がる', () => {
    const { city } = town();
    const west = city.neighbor('west')!;
    west.military = 10;
    west.tension = 70;
    for (let k = 0; k < 6; k++) city.defense.units.push({ id: k + 1, kind: 'mobile', since: 0 });
    city.declareWar('west');
    city.advanceTo(city.day + 200);
    city.settleVictory('annex');
    expect(west.merged).toBe(true);
    expect(city.ownsLand({ x: -800, z: 0 })).toBe(true);
  });

  it('平和モードでは宣戦布告できない', () => {
    const { city } = town();
    city.warEnabled = false;
    city.neighbor('west')!.tension = 70;
    city.defense.units.push({ id: 1, kind: 'mobile', since: 0 });
    expect(city.declareWar('west')).toContain('平和モード');
  });

  it('外交と防衛の状態を保存して復元できる', () => {
    const { t, city } = town();
    city.defense.units.push({ id: 1, kind: 'rescue', since: 3 });
    city.neighbor('west')!.treaties.push('aid');
    city.setFurusatoRate(0.25);
    const save = { version: 2, savedAt: '', cityName: 'x', terrain: { seed: t.seed, preset: t.preset }, sim: { day: city.day }, camera: { x: 0, z: 0, distance: 900, yaw: 0, pitch: 0.9 }, city: city.toJSON() };
    const back = deserialize(serialize(save as never))!;
    const c2 = new City(generateTerrain(t.seed), 7);
    c2.load(back.city, back.sim.day);
    expect(c2.defense.units.length).toBe(1);
    expect(c2.neighbor('west')!.treaties).toContain('aid');
    expect(c2.diplomacy.furusato.rate).toBe(0.25);
  });
});
