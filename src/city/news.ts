export type NewsKind = 'info' | 'good' | 'bad' | 'politics' | 'era';

export interface NewsItem {
  day: number;
  text: string;
  kind: NewsKind;
}

export const MAX_NEWS = 60;

export function pushNews(list: NewsItem[], day: number, text: string, kind: NewsKind = 'info'): void {
  list.push({ day, text, kind });
  if (list.length > MAX_NEWS) list.splice(0, list.length - MAX_NEWS);
}
