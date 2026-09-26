/**
 * ゲーム内の暦。「復興暦」は 4 月 1 日に始まり、1 年は 12 か月 × 30 日。
 * 時間の単位は「日」（小数あり）。
 */
export const MONTH_DAYS = 30;
export const YEAR_DAYS = MONTH_DAYS * 12;
export const START_MONTH = 4;

export type YearMinutes = 5 | 15 | 30;
export type Speed = 0 | 1 | 2 | 4;

export interface GameDate {
  year: number;
  month: number;
  day: number;
}

export function dateOf(totalDays: number): GameDate {
  const d = Math.max(0, Math.floor(totalDays));
  const year = Math.floor(d / YEAR_DAYS) + 1;
  const monthIndex = Math.floor((d % YEAR_DAYS) / MONTH_DAYS);
  const month = ((START_MONTH - 1 + monthIndex) % 12) + 1;
  return { year, month, day: (d % MONTH_DAYS) + 1 };
}

/** 標準速度で 1 日が何ミリ秒か */
export function msPerDay(yearMinutes: YearMinutes): number {
  return (yearMinutes * 60_000) / YEAR_DAYS;
}

/** 実時間 dtMs が経ったあとの日付 */
export function advance(totalDays: number, dtMs: number, yearMinutes: YearMinutes, speed: Speed): number {
  return totalDays + (dtMs * speed) / msPerDay(yearMinutes);
}

export function seasonOf(month: number): '春' | '夏' | '秋' | '冬' {
  if (month >= 3 && month <= 5) return '春';
  if (month >= 6 && month <= 8) return '夏';
  if (month >= 9 && month <= 11) return '秋';
  return '冬';
}

export function formatDate(d: GameDate): string {
  return `復興暦 ${d.year}年 ${d.month}月 ${d.day}日`;
}
