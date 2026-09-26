import type { YearMinutes } from '../sim/clock';

export type Quality = 'high' | 'medium' | 'low';

export interface Settings {
  yearMinutes: YearMinutes;
  quality: Quality;
  /** ミニチュア効果（周辺のぼかし）の強さ 0〜1 */
  miniature: number;
  helpSeen: boolean;
  disasters: boolean;
  /** 紛争・戦争が起こるか（false で平和モード） */
  war: boolean;
}

const KEY = 'mizuho-city/settings';

export const DEFAULT_SETTINGS: Settings = { yearMinutes: 15, quality: 'high', miniature: 0.6, helpSeen: false, disasters: true, war: true };

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const o = JSON.parse(raw) as Partial<Settings>;
    return {
      yearMinutes: o.yearMinutes === 5 || o.yearMinutes === 30 ? o.yearMinutes : 15,
      quality: o.quality === 'medium' || o.quality === 'low' ? o.quality : 'high',
      miniature: typeof o.miniature === 'number' ? Math.min(1, Math.max(0, o.miniature)) : DEFAULT_SETTINGS.miniature,
      helpSeen: o.helpSeen === true,
      disasters: o.disasters !== false,
      war: o.war !== false,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // 保存できなくても遊べるので無視する
  }
}
