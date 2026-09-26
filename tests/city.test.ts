import { describe, expect, it } from 'vitest';
import { City } from '../src/city/city';
import { generateTerrain, heightAt, HALF, MAP_SIZE, type Terrain } from '../src/world/terrain';
import type { Snap } from '../src/city/roads';

/** 川から離れた、平らな平野の中心を探す */
function plainSpot(t: Terrain): { x: number; z: number } {
  const z = 60;
  const k = Math.round(((z + HALF) / MAP_SIZE) * 512);
  const rx = t.river[k].x;
  const x = rx > 0 ? rx - 420 : rx + 420;
  return { x, z };
}

const free = (x: number, z: number): Snap => ({ kind: 'free', p: { x, z } });

function freshCity() {
  const t = generateTerrain(12345);
  return { t, city: new City(t, 7), o: plainSpot(t) };
}

describe('道路', () => {
  it('平野にまっすぐな道路を置ける', () => {
    const { city, o } = freshCity();
    const plan = city.planRoad(free(o.x - 100, o.z), free(o.x + 100, o.z), null, 'local');
    expect(plan.ok, plan.reason).toBe(true);
    city.buildRoad(plan);
    expect(city.net.segments.size).toBe(1);
    expect(city.net.nodes.size).toBe(2);
  });

  it('交差させると交差点ができ、両方の道路が分割される', () => {
    const { city, o } = freshCity();
    city.buildRoad(city.planRoad(free(o.x - 100, o.z), free(o.x + 100, o.z), null, 'local'));
    const plan = city.planRoad(free(o.x, o.z - 100), free(o.x, o.z + 100), null, 'avenue');
    expect(plan.ok, plan.reason).toBe(true);
    city.buildRoad(plan);
    expect(city.net.segments.size).toBe(4);
    expect(city.net.nodes.size).toBe(5);
    const center = [...city.net.nodes.values()].find((n) => Math.hypot(n.x - o.x, n.z - o.z) < 1);
    expect(center).toBeDefined();
    expect(city.net.segmentsAt(center!.id).length).toBe(4);
  });

  it('既存の道路の端に吸着してつながる', () => {
    const { city, o } = freshCity();
    city.buildRoad(city.planRoad(free(o.x - 100, o.z), free(o.x, o.z), null, 'local'));
    const s = city.snap({ x: o.x + 3, z: o.z + 2 });
    expect(s.kind).toBe('node');
    city.buildRoad(city.planRoad(s, free(o.x, o.z + 120), null, 'local'));
    expect(city.net.nodes.size).toBe(3);
  });

  it('短すぎる道路、平行に重なる道路、海の上で終わる道路は置けない', () => {
    const { city, o } = freshCity();
    expect(city.planRoad(free(o.x, o.z), free(o.x + 4, o.z), null, 'local').ok).toBe(false);
    city.buildRoad(city.planRoad(free(o.x - 100, o.z), free(o.x + 100, o.z), null, 'local'));
    const par = city.planRoad(free(o.x - 80, o.z + 3), free(o.x + 80, o.z + 3), null, 'local');
    expect(par.ok).toBe(false);
    expect(city.planRoad(free(o.x, HALF - 60), free(o.x, HALF - 10), null, 'local').ok).toBe(false);
  });

  it('川をまたぐと橋になる', () => {
    const { t, city } = freshCity();
    const k = Math.round(((60 + HALF) / MAP_SIZE) * 512);
    const rx = t.river[k].x;
    const plan = city.planRoad(free(rx - 70, 60), free(rx + 70, 60), null, 'local');
    expect(plan.ok, plan.reason).toBe(true);
    expect(plan.bridgeLength).toBeGreaterThan(10);
  });

  it('道路の下の地形は路面の高さにならされる', () => {
    const { t, city, o } = freshCity();
    city.buildRoad(city.planRoad(free(o.x - 100, o.z), free(o.x + 100, o.z), null, 'local'));
    const seg = [...city.net.segments.values()][0];
    const mid = seg.ys[Math.floor(seg.ys.length / 2)];
    expect(Math.abs(heightAt(t, o.x, o.z) - mid)).toBeLessThan(0.5);
  });

  it('曲線の道路を置ける', () => {
    const { city, o } = freshCity();
    const plan = city.planRoad(free(o.x - 100, o.z), free(o.x + 100, o.z), { x: o.x, z: o.z - 80 }, 'local');
    expect(plan.ok, plan.reason).toBe(true);
    expect(plan.length).toBeGreaterThan(210);
  });
});

describe('区画と建物', () => {
  it('道路の両側に奥行き 4 マスの区画ができる', () => {
    const { city, o } = freshCity();
    city.buildRoad(city.planRoad(free(o.x - 100, o.z), free(o.x + 100, o.z), null, 'local'));
    const cells = [...city.cells.values()];
    expect(cells.filter((c) => c.side === 1 && c.depth === 3).length).toBeGreaterThan(20);
    expect(cells.filter((c) => c.side === -1 && c.depth === 0).length).toBeGreaterThan(20);
  });

  it('用途地域を塗ると建物が建ち、人口が増える', () => {
    const { city, o } = freshCity();
    city.buildRoad(city.planRoad(free(o.x - 150, o.z), free(o.x + 150, o.z), null, 'local'));
    expect(city.paintZone(o, 200, 1)).toBeGreaterThan(50);
    city.advanceTo(20);
    expect(city.buildings.size).toBeGreaterThan(5);
    expect(city.stats.population).toBeGreaterThan(10);
    // 建物どうしは同じマスを取り合わない
    const used = new Set<string>();
    for (const b of city.buildings.values()) for (const k of b.cells) { expect(used.has(k)).toBe(false); used.add(k); }
  });

  it('交差する道路を後から引くと、重なる建物は取り壊される', () => {
    const { city, o } = freshCity();
    city.buildRoad(city.planRoad(free(o.x - 150, o.z), free(o.x + 150, o.z), null, 'local'));
    city.paintZone(o, 200, 1);
    city.advanceTo(40);
    const before = city.buildings.size;
    city.buildRoad(city.planRoad(free(o.x, o.z - 60), free(o.x, o.z + 60), null, 'local'));
    for (const b of city.buildings.values()) {
      for (const k of b.cells) expect(city.cells.get(k)?.building).toBe(b.id);
    }
    expect(city.buildings.size).toBeLessThanOrEqual(before);
  });

  it('道路を消すと、その道路沿いの建物もなくなる', () => {
    const { city, o } = freshCity();
    city.buildRoad(city.planRoad(free(o.x - 150, o.z), free(o.x + 150, o.z), null, 'local'));
    city.paintZone(o, 200, 1);
    city.advanceTo(20);
    city.removeRoad([...city.net.segments.keys()][0]);
    expect(city.buildings.size).toBe(0);
    expect(city.cells.size).toBe(0);
  });
});

describe('保存', () => {
  it('保存して読み戻すと道路・用途地域・建物・地区が戻る', () => {
    const { city, o } = freshCity();
    city.buildRoad(city.planRoad(free(o.x - 150, o.z), free(o.x + 150, o.z), null, 'local'));
    city.buildRoad(city.planRoad(free(o.x, o.z - 100), free(o.x, o.z + 100), null, 'local'));
    city.paintZone(o, 200, 4);
    city.advanceTo(25);
    const d = city.newDistrict();
    city.paintDistrict(o, 100, d.id);
    const data = JSON.parse(JSON.stringify(city.toJSON()));

    const t2 = generateTerrain(12345);
    const c2 = new City(t2, 7);
    c2.load(data, 25);
    expect(c2.net.segments.size).toBe(city.net.segments.size);
    expect(c2.buildings.size).toBe(city.buildings.size);
    expect([...c2.cells.values()].filter((c) => c.zone === 4).length).toBe([...city.cells.values()].filter((c) => c.zone === 4).length);
    expect(c2.districts.at(o)?.name).toBe(d.name);
    expect(c2.stats.population).toBe(city.stats.population);
    expect(heightAt(t2, o.x, o.z)).toBeCloseTo(heightAt(city.terrain, o.x, o.z), 3);
  });
});
