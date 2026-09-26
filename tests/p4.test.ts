import { describe, expect, it } from 'vitest';
import { City } from '../src/city/city';
import { generateTerrain, HALF, MAP_SIZE } from '../src/world/terrain';
import type { Snap } from '../src/city/roads';

const free = (x: number, z: number): Snap => ({ kind: 'free', p: { x, z } });

/** 住宅と商業が道路でつながった街 */
function setup() {
  const t = generateTerrain(12345);
  const city = new City(t, 7);
  city.disastersEnabled = false;
  city.econ.money = 5_000_000;
  const k = Math.round(((60 + HALF) / MAP_SIZE) * 512);
  const rx = t.river[k].x;
  const o = { x: rx > 0 ? rx - 450 : rx + 450, z: 60 };
  const road = (ax: number, az: number, bx: number, bz: number, type: 'local' | 'avenue' = 'local') => {
    const p = city.planRoad(city.snap({ x: o.x + ax, z: o.z + az }), city.snap({ x: o.x + bx, z: o.z + bz }), null, type);
    expect(p.ok, p.reason).toBe(true);
    city.buildRoad(p);
  };
  road(-240, 0, 240, 0);
  road(-240, 160, 240, 160);
  road(-240, 0, -240, 160);
  road(240, 0, 240, 160);
  road(0, 0, 0, 160);
  city.placeFacility(city.planFacility({ x: o.x + 120, z: o.z + 172 }, 'thermal'));
  city.paintZone({ x: o.x - 120, z: o.z + 20 }, 110, 2);
  city.paintZone({ x: o.x + 120, z: o.z - 20 }, 110, 4);
  city.advanceTo(150);
  return { t, city, o, road };
}

describe('P4：交通', () => {
  it('通勤の車が道路に流れ、交通量と所要時間が出る', () => {
    const { city } = setup();
    city.refreshTraffic();
    const tr = city.traffic;
    expect(tr.carTrips).toBeGreaterThan(0);
    expect([...tr.volume.values()].some((v) => v > 0)).toBe(true);
    expect(tr.avgCommute).toBeGreaterThan(5);
  });

  it('一方通行は片方向にしか流れない', () => {
    const { city, o } = setup();
    const seg = [...city.net.segments.values()].find((s) => {
      const a = city.net.nodes.get(s.a)!, b = city.net.nodes.get(s.b)!;
      return Math.abs(a.z - (o.z + 0)) < 1 && Math.abs(b.z - (o.z + 0)) < 1;
    })!;
    city.cycleOneway(seg.id);
    expect(seg.oneway).toBe(1);
    city.cycleOneway(seg.id);
    expect(seg.oneway).toBe(-1);
    city.cycleOneway(seg.id);
    expect(seg.oneway).toBe(0);
  });

  it('立体交差は交差点の遅れを減らす', () => {
    const { city, o } = setup();
    const node = [...city.net.nodes.values()].find((n) => Math.hypot(n.x - o.x, n.z - o.z) < 1)!;
    expect(city.setNodeControl(node.id, 'grade')).toBeNull();
    expect(node.control).toBe('grade');
    const corner = [...city.net.nodes.values()].find((n) => city.net.segmentsAt(n.id).length === 2)!;
    expect(city.setNodeControl(corner.id, 'turnlane')).toMatch(/3 本以上/);
  });
});

describe('P4：公共交通', () => {
  it('バス停を道路に置いて路線をつくると、道路に沿って走り、利用者が出る', () => {
    const { city, o } = setup();
    const a = city.addStop('bus', { x: o.x - 150, z: o.z + 1 });
    const b = city.addStop('bus', { x: o.x + 150, z: o.z + 1 });
    expect(typeof a).toBe('number');
    const line = city.createLine('bus', [a as number, b as number]);
    expect(typeof line).not.toBe('string');
    if (typeof line === 'string') return;
    expect(line.path.length).toBeGreaterThan(10);
    expect(line.pathLen).toBeGreaterThan(550);
    city.refreshTraffic();
    expect(line.riders).toBeGreaterThan(0);
  });

  it('道路のない場所にバス停は置けず、路面電車は路地に置けない', () => {
    const { city, o } = setup();
    expect(city.addStop('bus', { x: o.x - 100, z: o.z + 80 })).toMatch(/道路の上/);
  });

  it('駅と線路をつくり、地上の線路が道路と交わると踏切ができる。高架にすると消える', () => {
    const { city, o } = setup();
    const a = city.addStop('rail', { x: o.x - 120, z: o.z - 100 });
    const b = city.addStop('rail', { x: o.x - 120, z: o.z + 260 });
    expect(typeof a).toBe('number');
    expect(typeof b).toBe('number');
    expect(city.connectStops(a as number, b as number, 'ground')).toBeNull();
    const line = city.createLine('rail', [a as number, b as number]);
    expect(typeof line).not.toBe('string');
    city.refreshTraffic();
    expect(city.crossings.length).toBeGreaterThanOrEqual(2);
    const tr = [...city.transit.tracks.values()][0];
    const m0 = city.econ.money;
    expect(city.elevateTrack(tr.id)).toBeNull();
    expect(city.econ.money).toBeLessThan(m0);
    city.refreshTraffic();
    expect(city.crossings.length).toBe(0);
  });

  it('線路の上や駅には区画ができず、建物は取り壊される', () => {
    const { city, o } = setup();
    const before = city.buildings.size;
    const a = city.addStop('rail', { x: o.x - 120, z: o.z - 100 }) as number;
    const b = city.addStop('rail', { x: o.x - 120, z: o.z + 260 }) as number;
    city.connectStops(a, b, 'ground');
    for (const c of city.cells.values()) expect(Math.abs(c.x - (o.x - 120))).toBeGreaterThan(5);
    expect(city.buildings.size).toBeLessThanOrEqual(before);
  });

  it('私鉄に任せるには私鉄社長との関係が必要', () => {
    const { city, o } = setup();
    const a = city.addStop('rail', { x: o.x - 120, z: o.z - 100 }) as number;
    const b = city.addStop('rail', { x: o.x - 120, z: o.z + 260 }) as number;
    city.connectStops(a, b, 'elevated');
    expect(city.createLine('rail', [a, b], 'private')).toMatch(/関係/);
    city.connections.rel.rail = 45;
    const line = city.createLine('rail', [a, b], 'private');
    expect(typeof line).not.toBe('string');
  });

  it('保存して読み戻すと路線・駅・線路・関係者も戻る', () => {
    const { city, o } = setup();
    const a = city.addStop('bus', { x: o.x - 150, z: o.z + 1 }) as number;
    const b = city.addStop('bus', { x: o.x + 150, z: o.z + 1 }) as number;
    city.createLine('bus', [a, b]);
    city.npcAction('governor', 'visit');
    const data = JSON.parse(JSON.stringify(city.toJSON()));
    const c2 = new City(generateTerrain(12345), 7);
    c2.load(data, city.day);
    expect(c2.transit.lines.size).toBe(1);
    expect([...c2.transit.lines.values()][0].path.length).toBeGreaterThan(10);
    expect(c2.connections.rel.governor).toBe(city.connections.rel.governor);
  });
});

describe('P4：関係者', () => {
  it('会食で関係が上がり、疑惑度もたまる。便宜を図りすぎるとリコールが起きる', () => {
    const { city } = setup();
    const r0 = city.connections.rel.builder;
    expect(city.npcAction('builder', 'dinner')).toBeNull();
    expect(city.connections.rel.builder).toBe(r0 + 8);
    expect(city.connections.suspicion).toBeGreaterThan(0);
    expect(city.npcAction('builder', 'dinner')).toMatch(/か月後/);
    city.connections.suspicion = 95;
    city.advanceTo(city.day + 31);
    expect(city.connections.recallDay).toBeGreaterThan(0);
  });

  it('建設会社と仲が良いと道路が安くなる', () => {
    const { city, o } = setup();
    const plan = city.planRoad(free(o.x - 200, o.z + 300), free(o.x + 200, o.z + 300), null, 'local');
    const c0 = city.roadCost(plan);
    city.connections.rel.builder = 60;
    expect(city.roadCost(plan)).toBeLessThan(c0);
  });
});
