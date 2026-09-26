import { describe, expect, it } from 'vitest';
import { City } from '../src/city/city';
import { alertLevel, coastalDepth, makeStorm, newDefenses, riverFloodDepth } from '../src/city/water';
import { generateTerrain, HALF, MAP_SIZE } from '../src/world/terrain';

/** 川沿いに住宅地がある街 */
function riverside() {
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
  return { t, city, x, rp };
}

describe('P5：水害の計算', () => {
  it('警戒レベルは上陸が近づくほど上がる', () => {
    const s = makeStorm('typhoon', 1, 100, 1, () => 0.5, 0.9);
    expect(alertLevel(s, 100)).toBeLessThan(alertLevel(s, 104));
    expect(alertLevel(s, 105)).toBe(5);
  });

  it('堤防が高いほど洪水の深さは小さくなる', () => {
    const { t, x } = riverside();
    const d0 = newDefenses();
    const d3 = newDefenses();
    d3.levees = d3.levees.map(() => 3);
    const deep = riverFloodDepth(t, d0, x, 60, 7, 0, 0);
    expect(deep).toBeGreaterThan(0.3);
    expect(riverFloodDepth(t, d3, x, 60, 7, 0, 0)).toBe(0);
  });

  it('防潮堤は波の高さまで津波を防ぐ', () => {
    const { t } = riverside();
    const x = -300;
    const z = t.coastZ[Math.round(((x + HALF) / MAP_SIZE) * (t.coastZ.length - 1))] - 30;
    const d = newDefenses();
    expect(coastalDepth(t, d, x, z, 6)).toBeGreaterThan(1);
    d.seawalls = d.seawalls.map(() => 2);
    expect(coastalDepth(t, d, x, z, 6)).toBe(0);
  });
});

describe('P5：嵐と避難', () => {
  it('強い台風で川があふれ、避難指示を出していないと逃げ遅れが出る', () => {
    const { city } = riverside();
    const before = city.buildings.size;
    expect(before).toBeGreaterThan(3);
    const st = city.spawnStorm('typhoon', 1);
    city.advanceTo(st.end + 1);
    const r = city.disasterReports.at(-1)!;
    expect(r.breaches).toBeGreaterThan(0);
    expect(r.above + r.collapsed).toBeGreaterThan(0);
    expect(r.stranded).toBeGreaterThan(0);
    expect(city.flood).not.toBeNull();
  });

  it('前もって避難指示を出せば逃げ遅れはいない', () => {
    const { city } = riverside();
    const st = city.spawnStorm('typhoon', 1);
    expect(city.evacuate()).toBeNull();
    city.advanceTo(st.end + 1);
    expect(city.disasterReports.at(-1)!.stranded).toBe(0);
  });

  it('堤防を最大まで上げると同じ台風でも川はあふれない', () => {
    const { city } = riverside();
    city.defenses.levees = city.defenses.levees.map(() => 3);
    const st = city.spawnStorm('typhoon', 0.6);
    city.advanceTo(st.end + 1);
    expect(city.disasterReports.at(-1)!.breaches).toBe(0);
  });

  it('川岸をクリックすると堤防が 1 段上がる', () => {
    const { city, rp } = riverside();
    const m0 = city.econ.money;
    expect(city.buildLevee({ x: rp.x + rp.width / 2 + 10, z: rp.z })).toBeNull();
    expect(city.econ.money).toBeLessThan(m0);
    expect(city.defenses.levees.some((l) => l === 1)).toBe(true);
    expect(city.buildLevee({ x: rp.x + 400, z: rp.z })).toMatch(/川岸/);
  });
});

describe('P5：津波・原発・復興', () => {
  it('海で起きた大地震は津波を起こす', () => {
    const { city } = riverside();
    city.earthquake(8.0, { x: 0, z: 3000 });
    expect(city.disasterReports.some((r) => r.kind === 'tsunami')).toBe(true);
  });

  it('家を失った人は、仮設住宅がないと市外へ出ていく', () => {
    const { city } = riverside();
    city.displaced = 2000;
    city.advanceTo(city.day + 31);
    const without = city.displaced;
    const { city: c2, x } = riverside();
    for (let i = 0; i < 5; i++) {
      const p = c2.planFacility({ x: x + 12, z: -20 + i * 18 }, 'tempHousing');
      if (p.ok) c2.placeFacility(p);
    }
    c2.displaced = 2000;
    c2.advanceTo(c2.day + 31);
    expect(c2.displaced).toBeGreaterThan(without);
  });

  it('防衛隊は災害から 30 日以内に派遣を要請できる', () => {
    const { city } = riverside();
    expect(city.requestDispatch()).toMatch(/駐屯地/);
  });

  it('高台移転で川沿いの危ない土地の建物がなくなる', () => {
    const { city, x } = riverside();
    const d = city.newDistrict();
    city.paintDistrict({ x, z: 80 }, 200, d.id);
    const before = city.buildings.size;
    expect(city.relocate(d.id)).toBeNull();
    expect(city.buildings.size).toBeLessThan(before);
  });

  it('保存して読み戻すと堤防・嵐・被災者も戻る', () => {
    const { city } = riverside();
    city.defenses.levees[5] = 2;
    city.spawnStorm('rain', 0.3);
    city.displaced = 123;
    const data = JSON.parse(JSON.stringify(city.toJSON()));
    const c2 = new City(generateTerrain(12345), 7);
    c2.load(data, city.day);
    expect(c2.defenses.levees[5]).toBe(2);
    expect(c2.activeStorm()?.kind).toBe('rain');
    expect(c2.displaced).toBe(123);
  });
});
