import { describe, expect, it } from 'vitest';
import { City } from '../src/city/city';
import { intensityAt, prob30, quakeDamage, shindoLabel } from '../src/city/disasters';
import { floodDepth, landslide, liquefaction } from '../src/city/hazard';
import { generateTerrain, HALF, MAP_SIZE } from '../src/world/terrain';
import type { Snap } from '../src/city/roads';

const free = (x: number, z: number): Snap => ({ kind: 'free', p: { x, z } });

function setup(disasters = false) {
  const t = generateTerrain(12345);
  const city = new City(t, 7);
  city.disastersEnabled = disasters;
  const k = Math.round(((60 + HALF) / MAP_SIZE) * 512);
  const rx = t.river[k].x;
  const o = { x: rx > 0 ? rx - 420 : rx + 420, z: 60, rx };
  city.buildRoad(city.planRoad(free(o.x - 150, o.z), free(o.x + 150, o.z), null, 'local'));
  return { t, city, o };
}

describe('P3：インフラ', () => {
  it('発電所と浄水場がないと電気・水道が足りない', () => {
    const { city, o } = setup();
    city.paintZone(o, 200, 1);
    city.advanceTo(60);
    expect(city.services!.util.power.served).toBeLessThan(0.1);
    expect(city.services!.util.water.served).toBeLessThan(0.1);
  });

  it('道路沿いに発電所を置くと、つながった建物に電気が届く', () => {
    const { city, o } = setup();
    city.paintZone({ x: o.x - 80, z: o.z }, 60, 1);
    const plan = city.planFacility({ x: o.x + 100, z: o.z + 12 }, 'solar');
    expect(plan.ok, plan.reason).toBe(true);
    const m0 = city.econ.money;
    city.placeFacility(plan);
    expect(city.econ.money).toBe(m0 - plan.cost);
    city.advanceTo(90);
    expect(city.buildings.size).toBeGreaterThan(0);
    expect(city.services!.util.power.served).toBe(1);
    const b = [...city.buildings.values()][0];
    expect(city.services!.per.get(b.id)!.power).toBe(true);
  });

  it('道路でつながっていない発電所の電気は届かない', () => {
    const { city, o } = setup();
    city.paintZone(o, 200, 1);
    city.buildRoad(city.planRoad(free(o.x - 150, o.z + 200), free(o.x + 150, o.z + 200), null, 'local'));
    const plan = city.planFacility({ x: o.x, z: o.z + 212 }, 'thermal');
    expect(plan.ok, plan.reason).toBe(true);
    city.placeFacility(plan);
    city.advanceTo(90);
    expect(city.services!.util.power.supply).toBe(30_000);
    expect(city.services!.util.power.served).toBeLessThan(0.1);
  });

  it('浄水場は川か海の近くにしか建てられない', () => {
    const { city, o } = setup();
    expect(city.planFacility({ x: o.x, z: o.z + 12 }, 'waterworks').reason).toMatch(/川か海/);
  });

  it('施設の届く範囲にある建物はサービスを受けられる', () => {
    const { city, o } = setup();
    city.paintZone(o, 200, 1);
    city.placeFacility(city.planFacility({ x: o.x, z: o.z + 12 }, 'koban'));
    city.advanceTo(90);
    const near = [...city.buildings.values()].filter((b) => Math.hypot(b.x - o.x, b.z - o.z) < 150);
    expect(near.length).toBeGreaterThan(0);
    for (const b of near) expect(city.services!.per.get(b.id)!.police).toBeGreaterThan(0);
  });
});

describe('P3：災害', () => {
  it('震度の階級', () => {
    expect(shindoLabel(4.2)).toBe('4');
    expect(shindoLabel(5.2)).toBe('5強');
    expect(shindoLabel(6.7)).toBe('7');
  });

  it('旧耐震の木造は新耐震の非木造より壊れやすい', () => {
    const old = quakeDamage({ kind: 'house', seismic: 'old', floors: 2 }, 6.3, 0);
    const neu = quakeDamage({ kind: 'office', seismic: 'new', floors: 10 }, 6.3, 0);
    expect(old.collapse).toBeGreaterThan(neu.collapse * 5);
  });

  it('震源に近いほど強く揺れる', () => {
    const { t } = setup();
    expect(intensityAt(t, 7, { x: 0, z: 0 }, 0, 0)).toBeGreaterThan(intensityAt(t, 7, { x: 0, z: 0 }, 900, 900));
    expect(prob30(0)).toBeGreaterThan(0.2);
    expect(prob30(50)).toBeGreaterThan(prob30(0));
  });

  it('直下の大地震で建物が壊れ、がれきが残り、やがて片付く', () => {
    const { city, o } = setup();
    city.paintZone(o, 200, 1);
    city.placeFacility(city.planFacility({ x: o.x + 100, z: o.z + 12 }, 'solar'));
    city.advanceTo(120);
    const before = city.buildings.size;
    const r = city.earthquake(7.3, { x: o.x, z: o.z });
    expect(['6強', '7']).toContain(r.maxShindo);
    expect(r.collapsed + r.damaged).toBeGreaterThan(0);
    expect(city.buildings.size).toBe(before - r.collapsed);
    expect(city.rubble.length).toBe(r.collapsed);
    expect(city.news.at(-1)!.text + city.news.at(-2)!.text).toMatch(/地震/);
    city.advanceTo(200);
    expect(city.rubble.length).toBe(0);
  });

  it('消防署がないと火は広がりやすく、あると消し止められる', () => {
    const run = (withStation: boolean) => {
      const { city, o } = setup();
      city.paintZone(o, 200, 1);
      city.advanceTo(120);
      if (withStation) city.placeFacility(city.planFacility({ x: o.x + 20, z: o.z + 12 }, 'fireStation'));
      const lost0 = city.buildings.size;
      const target = [...city.buildings.values()].sort((a, b) => Math.hypot(a.x - o.x, a.z - o.z) - Math.hypot(b.x - o.x, b.z - o.z))[0];
      city.startFire(target.id);
      city.advanceTo(140);
      return lost0 - city.buildings.size;
    };
    expect(run(true)).toBeLessThanOrEqual(run(false));
  });
});

describe('P3：ハザード・政策', () => {
  it('川沿いの低い土地は浸水と液状化の危険が高く、山の斜面は土砂災害', () => {
    const { t, o } = setup();
    const k = Math.round(((60 + HALF) / MAP_SIZE) * 512);
    const p = t.river[k];
    expect(floodDepth(t, p.x + p.width, p.z)).toBeGreaterThan(floodDepth(t, o.x, o.z));
    expect(liquefaction(t, p.x + p.width, p.z)).toBeGreaterThan(0.3);
    let maxSlide = 0;
    for (let x = -900; x < 900; x += 40) maxSlide = Math.max(maxSlide, landslide(t, x, -800));
    expect(maxSlide).toBeGreaterThan(0.3);
  });

  it('高さ制限の地区では 4 階までしか建たない', () => {
    const { city, o } = setup();
    city.econ.money = 1e9;
    city.placeFacility(city.planFacility({ x: o.x + 130, z: o.z + 12 }, 'thermal'));
    city.togglePolicy(0, 'heightLimit');
    city.paintZone({ x: o.x - 40, z: o.z }, 100, 4);
    city.advanceTo(200);
    const tall = [...city.buildings.values()].filter((b) => b.floors > 4);
    expect(city.buildings.size).toBeGreaterThan(0);
    expect(tall.length).toBe(0);
  });

  it('祭りは 1 年に 1 回まで', () => {
    const { city } = setup();
    expect(city.decree('festival')).toBeNull();
    expect(city.decree('festival')).toMatch(/か月後/);
    expect(city.decree('emergency')).toMatch(/60 日以内/);
  });

  it('保存して読み戻すと施設・がれき・政策も戻る', () => {
    const { city, o } = setup();
    city.paintZone(o, 200, 1);
    city.placeFacility(city.planFacility({ x: o.x + 100, z: o.z + 12 }, 'solar'));
    city.togglePolicy(0, 'fireproof');
    city.advanceTo(90);
    city.earthquake(7.2, { x: o.x, z: o.z });
    const data = JSON.parse(JSON.stringify(city.toJSON()));
    const c2 = new City(generateTerrain(12345), 7);
    c2.load(data, city.day);
    expect(c2.facilities.size).toBe(1);
    expect(c2.rubble.length).toBe(city.rubble.length);
    expect(c2.policies.districts[0]).toContain('fireproof');
    expect(c2.services!.util.power.supply).toBe(city.services!.util.power.supply);
    expect(c2.facilities.values().next().value!.downUntil).toBeGreaterThan(city.day);
  });
});
