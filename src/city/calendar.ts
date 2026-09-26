import { MONTH_DAYS, YEAR_DAYS, dateOf } from '../sim/clock';

/** 年の中での位置を「月 + 日/30」で表す（1.0〜12.97） */
export function monthFloat(day: number): number {
  const d = dateOf(day);
  return d.month + (d.day - 1) / MONTH_DAYS;
}

const ramp = (x: number, a: number, b: number) => Math.max(0, Math.min(1, (x - a) / (b - a)));
/** a〜b で上がり、c〜d で下がる台形 */
const trap = (x: number, a: number, b: number, c: number, d: number) => Math.min(ramp(x, a, b), 1 - ramp(x, c, d));

export interface SeasonLook {
  /** 雪の積もり具合 0〜1 */
  snow: number;
  /** 桜 0〜1 */
  blossom: number;
  /** 紅葉 0〜1 */
  autumn: number;
  /** 夏の濃い緑 0〜1 */
  summer: number;
}

/** 見た目の季節（桜・新緑・紅葉・雪）。月の途中でなめらかに移る */
export function seasonLook(day: number): SeasonLook {
  const m = monthFloat(day);
  // 12 月〜翌 2 月を 1 本の軸で扱う
  const w = m >= 12 ? m - 12 : m;
  return {
    snow: m >= 12 ? ramp(m, 12.2, 12.9) * 0.9 : trap(w, -1, 0, 2.6, 3.3),
    blossom: trap(m, 3.6, 3.95, 4.45, 4.85),
    autumn: trap(m, 10.1, 10.8, 11.6, 12.1),
    summer: trap(m, 5.5, 6.5, 8.5, 9.4),
  };
}

export interface CalendarEvent {
  month: number;
  name: string;
  text: string;
}

/** 年中行事（ニュースと効果は City が出す） */
export const CALENDAR: CalendarEvent[] = [
  { month: 1, name: '初詣', text: '新しい年が明けました。神社は初詣の人でにぎわっています' },
  { month: 4, name: '花見', text: '桜が満開に。川沿いや公園は花見客でいっぱいです' },
  { month: 6, name: '梅雨入り', text: '梅雨入りしました。大雨に注意しましょう' },
  { month: 8, name: '夏祭り', text: '夏祭りの季節です' },
  { month: 10, name: '秋祭り', text: '秋祭り。神輿が町を練り歩きます' },
  { month: 12, name: '年の瀬', text: '年の瀬です。今年の街を振り返る特集が組まれています' },
];

export const YEAR_END = YEAR_DAYS;
