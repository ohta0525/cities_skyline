import { describe, expect, it } from 'vitest';
import { advance, dateOf, formatDate, msPerDay, seasonOf, YEAR_DAYS } from '../src/sim/clock';

describe('復興暦', () => {
  it('1 年目は 4 月 1 日に始まる', () => {
    expect(dateOf(0)).toEqual({ year: 1, month: 4, day: 1 });
    expect(formatDate(dateOf(0))).toBe('復興暦 1年 4月 1日');
  });
  it('月と年が正しく繰り上がる', () => {
    expect(dateOf(29)).toEqual({ year: 1, month: 4, day: 30 });
    expect(dateOf(30)).toEqual({ year: 1, month: 5, day: 1 });
    expect(dateOf(30 * 9)).toEqual({ year: 1, month: 1, day: 1 });
    expect(dateOf(YEAR_DAYS - 1)).toEqual({ year: 1, month: 3, day: 30 });
    expect(dateOf(YEAR_DAYS)).toEqual({ year: 2, month: 4, day: 1 });
  });
  it('設定した分数で 1 年が過ぎる', () => {
    for (const ym of [5, 15, 30] as const) {
      expect(advance(0, ym * 60_000, ym, 1)).toBeCloseTo(YEAR_DAYS);
      expect(advance(0, ym * 60_000, ym, 4)).toBeCloseTo(YEAR_DAYS * 4);
    }
    expect(advance(10, 5000, 15, 0)).toBe(10);
    expect(msPerDay(15)).toBeCloseTo(2500);
  });
  it('季節', () => {
    expect(seasonOf(4)).toBe('春');
    expect(seasonOf(7)).toBe('夏');
    expect(seasonOf(10)).toBe('秋');
    expect(seasonOf(1)).toBe('冬');
  });
});
