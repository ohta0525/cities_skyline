import type { City } from './city';
import { totalDebt } from './economy';

export interface EndingPart { label: string; score: number; max: number; note: string }

export interface Ending {
  kind: 'century' | 'coup';
  day: number;
  title: string;
  total: number;
  parts: EndingPart[];
  summary: string;
}

const clamp = (v: number, max: number) => Math.max(0, Math.min(max, Math.round(v)));

/** 100 年目の評価。人口・暮らし・財政・防災・平和・地域・政治で 100 点満点 */
export function evaluate(c: City): Ending {
  const s = c.stats;
  const debt = totalDebt(c.econ);
  const reports = c.disasterReports;
  const stranded = reports.reduce((a, r) => a + r.stranded, 0);
  const wars = c.defense.records;
  const lost = wars.filter((w) => w.result === 'lost').length;
  const started = wars.length;
  const merged = c.region.neighbors.filter((n) => n.merged).length;
  const friends = c.region.neighbors.filter((n) => !n.merged && n.relation > 30).length;
  const elections = c.politics.elections;
  const won = elections.filter((e) => e.won).length;
  const parts: EndingPart[] = [
    { label: '人口', score: clamp(s.population / 1000, 25), max: 25, note: `${s.population.toLocaleString()} 人` },
    { label: '暮らし', score: clamp((s.happiness - 30) / 2, 20), max: 20, note: `満足度 ${Math.round(s.happiness)}` },
    { label: '財政', score: clamp(10 + (c.econ.money - debt) / 50_000, 15), max: 15, note: `資金から借金を引いて ${Math.round((c.econ.money - debt) / 10_000).toLocaleString()} 億円` },
    { label: '防災', score: clamp(15 - stranded / 40 - (s.oldSeismicShare * 10), 15), max: 15, note: `災害 ${reports.length} 回・逃げ遅れ ${stranded.toLocaleString()} 人` },
    { label: '平和', score: clamp(10 - lost * 4 - Math.max(0, started - lost) * 1.5, 10), max: 10, note: started ? `紛争 ${started} 回（負け ${lost}）` : '一度も紛争なし' },
    { label: '地域', score: clamp(merged * 3 + friends * 2, 8), max: 8, note: `合併 ${merged}・友好的な隣町 ${friends}` },
    { label: '政治', score: clamp(won * 1.5 - c.connections.scoops, 7), max: 7, note: `選挙 ${won} 勝 ${elections.length - won} 敗` },
  ];
  const total = parts.reduce((a, p) => a + p.score, 0);
  const title = total >= 85 ? '百年の都' : total >= 70 ? '瑞穂に名高い街' : total >= 55 ? '堅実に続いた街' : total >= 40 ? 'なんとか続いた街' : '苦難の百年';
  const best = [...parts].sort((a, b) => b.score / b.max - a.score / a.max)[0];
  const worst = [...parts].sort((a, b) => a.score / a.max - b.score / b.max)[0];
  const summary = `復興暦 100 年。${best.label}では誇れる街になりましたが、${worst.label}には課題が残りました。この街の物語は、次の百年へ続きます。`;
  return { kind: 'century', day: c.day, title, total, parts, summary };
}

/** クーデターで市政が終わったとき */
export function coupEnding(c: City): Ending {
  const e = evaluate(c);
  return {
    ...e, kind: 'coup', title: 'クーデター',
    summary: '防衛隊が市役所を占拠し、市長は職を追われました。強すぎる軍と、軍を顧みない市政。その組み合わせが街の民主主義を終わらせました。',
  };
}
