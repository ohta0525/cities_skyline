import { describe, expect, it } from 'vitest';
import { City } from '../src/city/city';
import { seasonLook } from '../src/city/calendar';
import { fmLine, voices } from '../src/city/media';
import { unrestTarget, unrestStage } from '../src/city/society';
import { deserialize, serialize } from '../src/save/save';
import { generateTerrain, HALF, MAP_SIZE } from '../src/world/terrain';

function town(seed = 12345) {
  const t = generateTerrain(seed);
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

describe('P7：不満と暴動', () => {
  it('満足度が低く失業が多いほど不満の目標は高い', () => {
    const base = { happiness: 65, unemployment: 0.03, approval: 55, displacedShare: 0, crime: 0, curfew: false, martialLaw: false, tribute: false, atWar: false, festival: false };
    expect(unrestStage(unrestTarget(base))).toBe(0);
    expect(unrestTarget({ ...base, happiness: 30, unemployment: 0.2, approval: 25 })).toBeGreaterThan(65);
  });

  it('小さな町では暴動にならない', () => {
    const { city } = town();
    city.society.unrest = 90;
    city.advanceTo(city.day + 30);
    expect(city.society.unrest).toBeLessThan(45);
    expect(city.society.riots).toBe(0);
  });

  it('大きな街で不満が高いと暴動が起き、対話集会で下がる', () => {
    const city = new City(generateTerrain(12345), 7);
    city.disastersEnabled = false;
    city.econ.money = 5_000_000;
    city.seedTown((p) => Math.hypot(p.x, p.z - 100) < 420 && city.ownsLand(p), [[2, 0.7], [4, 0.3]], 3_000, 10, 30);
    city.day = 3 * 360;
    city.advanceTo(city.day + 1);
    expect(city.stats.population).toBeGreaterThan(1_000);
    for (let m = 0; m < 6 && !city.society.riots; m++) {
      city.society.unrest = 95;
      city.advanceTo(city.day + 30);
    }
    expect(city.society.riots).toBeGreaterThan(0);
    expect(city.society.hotspot).not.toBeNull();
    const u = city.society.unrest;
    expect(city.societyAction('dialogue')).toBeNull();
    expect(city.society.unrest).toBeLessThan(u);
    expect(city.societyAction('dialogue')).toMatch(/か月/);
  });
});

describe('P7：クーデター', () => {
  it('強い軍と低い防衛派の支持が続くとクーデターで市政が終わる', () => {
    const { city } = town();
    for (let k = 0; k < 8; k++) city.defense.units.push({ id: k + 1, kind: 'mobile', since: 0 });
    city.politics.modifiers.push({ faction: 'defense', amount: -80, until: 99_999, reason: 'test' });
    city.society.coupRisk = 95;
    let guard = 0;
    while (!city.ending && guard++ < 24) city.advanceTo(city.day + 30);
    expect(city.ending?.kind).toBe('coup');
    expect(city.blockedReason()).toContain('クーデター');
  });

  it('待遇改善でクーデターの危険が下がる', () => {
    const { city } = town();
    city.society.coupRisk = 60;
    expect(city.societyAction('treatment')).toBeNull();
    expect(city.society.coupRisk).toBe(45);
  });
});

describe('P7：季節と祭り、地元紙', () => {
  it('4 月は桜、1 月は雪、11 月は紅葉', () => {
    expect(seasonLook(10).blossom).toBeGreaterThan(0.5);
    expect(seasonLook(9 * 30 + 10).snow).toBeGreaterThan(0.5);
    expect(seasonLook(7 * 30 + 10).autumn).toBeGreaterThan(0.5);
    expect(seasonLook(4 * 30 + 10).snow).toBe(0);
  });

  it('7 月に夏祭りを決めると、8 月に祭りになる', () => {
    const { city } = town();
    // 2 年目の 7 月 1 日は 450 日目
    city.events = [];
    while (city.day < 450) city.advanceTo(Math.min(450, city.day + 30));
    expect(city.events.some((e) => e.type === 'festival')).toBe(true);
    expect(city.holdSummerFestival(true)).toBeNull();
    city.advanceTo(481);
    expect(city.policies.decrees.festival).toBeGreaterThan(city.day);
  });

  it('毎月、地元紙の紙面ができ、FM と市民の声が出る', () => {
    const { city } = town();
    expect(city.editions.length).toBeGreaterThan(0);
    const e = city.editions.at(-1)!;
    expect(e.headline.length).toBeGreaterThan(0);
    expect(e.column.length).toBeGreaterThan(0);
    expect(fmLine(city, Math.random).length).toBeGreaterThan(0);
    expect(voices(city, 3, Math.random).length).toBeGreaterThan(0);
  });
});

describe('P7：シナリオとエンディング', () => {
  it('過疎の村のシナリオは合併した状態で始まる', () => {
    const city = new City(generateTerrain(4242), 3);
    city.setupScenario('village');
    expect(city.neighbor('north')!.merged).toBe(true);
    expect(city.buildings.size).toBeGreaterThan(0);
    expect(city.scenarioProgress()).toContain('3,000');
  });

  it('紛争を避けるシナリオで紛争になると失敗', () => {
    const { city } = town();
    city.setupScenario('peace');
    expect(city.neighbor('west')!.kind).toBe('military');
    city.defense.units.push({ id: 1, kind: 'mobile', since: 0 });
    city.neighbor('west')!.military = 5;
    expect(city.declareWar('west')).toBeNull();
    city.advanceTo(city.day + 31);
    expect(city.scenario.result).toBe('lost');
  });

  it('津波のシナリオでは海辺に古い町ができる', () => {
    const city = new City(generateTerrain(12345), 7);
    city.setupScenario('tsunami');
    expect(city.buildings.size).toBeGreaterThan(20);
    expect([...city.buildings.values()].every((b) => b.seismic === 'old')).toBe(true);
  });

  it('サンドボックスではお金が尽きない', () => {
    const { city } = town();
    city.setupScenario('sandbox');
    city.econ.money = -5_000;
    city.advanceTo(city.day + 31);
    expect(city.econ.money).toBeGreaterThan(1_000_000);
  });

  it('100 年目が終わると評価が出る', () => {
    const { city } = town();
    city.day = 36_000 - 5;
    city.advanceTo(36_000);
    expect(city.ending?.kind).toBe('century');
    expect(city.ending!.total).toBeGreaterThan(0);
    expect(city.ending!.parts.length).toBe(7);
    expect(city.events.some((e) => e.type === 'ending')).toBe(true);
  });

  it('P7 の状態を保存して復元できる', () => {
    const { t, city } = town();
    city.setupScenario('peace');
    city.society.unrest = 42;
    city.society.festivalYear = 3;
    const save = { version: 2, savedAt: '', cityName: 'x', terrain: { seed: t.seed, preset: t.preset }, sim: { day: city.day }, camera: { x: 0, z: 0, distance: 900, yaw: 0, pitch: 0.9 }, city: city.toJSON() };
    const back = deserialize(serialize(save as never))!;
    const c2 = new City(generateTerrain(t.seed), 7);
    c2.load(back.city, back.sim.day);
    expect(c2.scenario.id).toBe('peace');
    expect(c2.society.unrest).toBe(42);
    expect(c2.editions.length).toBe(city.editions.length);
  });
});
