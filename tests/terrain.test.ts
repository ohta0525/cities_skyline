import { describe, expect, it } from 'vitest';
import { GRID, HALF, SEA_LEVEL, generateTerrain, gridHeight, heightAt, landKind } from '../src/world/terrain';

const t = generateTerrain(12345);

function avgRow(v: number): number {
  const j = Math.round(v * GRID);
  let s = 0;
  for (let i = 0; i <= GRID; i++) s += gridHeight(t, i, j);
  return s / (GRID + 1);
}

describe('地形（河川平野＋海岸）', () => {
  it('同じシードなら同じ地形になる', () => {
    const t2 = generateTerrain(12345);
    expect(t2.heights).toEqual(t.heights);
    expect(generateTerrain(999).heights).not.toEqual(t.heights);
  });
  it('北は山、中央は平野、南は海', () => {
    expect(avgRow(0.05)).toBeGreaterThan(60);
    const mid = avgRow(0.55);
    expect(mid).toBeGreaterThan(1);
    expect(mid).toBeLessThan(25);
    expect(avgRow(0.97)).toBeLessThan(SEA_LEVEL);
  });
  it('川は周りより低く、下流ほど水面が下がる', () => {
    const inland = t.river.filter((p) => p.level > SEA_LEVEL);
    expect(inland.length).toBeGreaterThan(100);
    for (let k = 1; k < inland.length; k++) expect(inland[k].level).toBeLessThanOrEqual(inland[k - 1].level);
    for (const p of inland.filter((_, k) => k % 40 === 0)) {
      const center = heightAt(t, p.x, p.z);
      expect(center).toBeLessThan(p.level);
      expect(heightAt(t, Math.min(HALF, p.x + p.width * 2), p.z)).toBeGreaterThan(center);
    }
    // 川は海に注ぐ
    expect(t.river[t.river.length - 1].level).toBe(SEA_LEVEL);
  });
  it('地点の種類を判定できる', () => {
    expect(landKind(t, 0, HALF - 5)).toBe('海');
    const p = t.river[150];
    expect(landKind(t, p.x, p.z)).toBe('川');
  });
});
