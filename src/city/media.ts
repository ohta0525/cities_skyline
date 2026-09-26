import type { City } from './city';
import { formatYen } from './economy';
import { stageOf } from './region';
import { unrestStage } from './society';
import { decreeActive } from './policies';
import { dateOf } from '../sim/clock';

/** 地元紙の 1 号（月に 1 回） */
export interface Edition {
  day: number;
  no: number;
  headline: string;
  subs: string[];
  /** 社説 */
  column: string;
}

const pick = <T>(list: T[], r: () => number): T => list[Math.floor(r() * list.length)];

/** 先月のニュースと街の様子から、月の初めの紙面をつくる */
export function makeEdition(c: City, no: number, r: () => number): Edition {
  const since = c.day - 30;
  const month = c.news.filter((n) => n.day > since);
  const score = (k: string) => (k === 'bad' ? 4 : k === 'politics' ? 3 : k === 'era' ? 5 : k === 'good' ? 2 : 1);
  const ranked = [...month].sort((a, b) => score(b.kind) - score(a.kind) || b.day - a.day);
  const clean = (t: string) => t.replace(/^【[^】]+】/, '').replace(/（「.*」.*）$/, '');
  const s = c.stats;
  const feature = [
    `人口 ${s.population.toLocaleString()} 人、市の歩みは続く`,
    s.unemployment > 0.08 ? `失業率 ${(s.unemployment * 100).toFixed(1)}％、仕事を求める声` : `働き手は足りているか　失業率 ${(s.unemployment * 100).toFixed(1)}％`,
    c.traffic.avgCommute > 25 ? `通勤に片道 ${Math.round(c.traffic.avgCommute)} 分、渋滞に悲鳴` : '朝の道路は順調、通勤時間は短め',
  ];
  const headline = ranked.length ? clean(ranked[0].text) : pick(feature, r);
  const subs = ranked.slice(1, 4).map((n) => clean(n.text));
  while (subs.length < 2) subs.push(pick(feature, r));
  return { day: c.day, no, headline, subs, column: editorial(c, r) };
}

/** 社説：市政へのひとこと */
function editorial(c: City, r: () => number): string {
  const s = c.stats;
  const lines: string[] = [];
  if (c.econ.bankrupt) lines.push('財政再生団体となった市政の責任は重い。身の丈に合った予算を求めたい。');
  if (c.connections.suspicion > 50) lines.push('市長と業者の会食が重なっている。市民に説明する責任がある。');
  if (unrestStage(c.society.unrest) >= 2) lines.push('街頭の声に耳を傾けよ。デモは市政への警告である。');
  if (c.defense.war) lines.push(`${c.defense.war.name}との紛争が長引いている。一日も早い講和を望む。`);
  if (s.oldSeismicShare > 0.4) lines.push('旧耐震の建物がまだ多い。次の大地震は待ってくれない。');
  if (c.traffic.congestion > 0.25) lines.push('渋滞は街の血流を止める。公共交通への投資をためらうべきではない。');
  if (s.happiness > 70) lines.push('暮らしやすい街だという声が多い。この歩みを続けてほしい。');
  if (!lines.length) lines.push(pick(['街は静かに育っている。百年先を見すえた計画を。', '防災は日々の積み重ねだ。避難訓練に参加しよう。', '隣町とのつきあいは、困ったときの助けになる。'], r));
  return pick(lines, r);
}

/** ローカル FM の DJ のひとこと。街の様子を少し皮肉まじりに */
export function fmLine(c: City, r: () => number): string {
  const s = c.stats;
  const d = dateOf(c.day);
  const out: string[] = [];
  const st = c.activeStorm();
  if (st) out.push(st.evacuated ? `${st.name}が接近中。避難指示が出ています。ラジオはつけっぱなしで、懐中電灯の電池も確認を！` : `${st.name}が近づいてるってのに、市役所はまだ様子見かな？ みんなは自分で早めに動こう！`);
  if (c.defense.war) out.push(`${c.defense.war.name}との紛争${Math.floor((c.day - c.defense.war.startDay) / 30)} か月目。リクエスト曲は相変わらず「平和の歌」ばかりです`);
  const u = unrestStage(c.society.unrest);
  if (u >= 3) out.push('今日も駅前は荒れてます。窓ガラス屋さんだけが大忙し。市長、聞いてますか？');
  else if (u === 2) out.push('駅前でデモ。プラカードの字がなかなか達筆でした。言いたいことはわかるよね、市長');
  if (c.society.martialLaw) out.push('戒厳令のなか、この番組も「検閲済み」でお送りしています……なんてね');
  if (c.traffic.avgCommute > 25) out.push(`交通情報です。本日も市内全域でのろのろ運転。平均 ${Math.round(c.traffic.avgCommute)} 分、車内で聞いてくれてありがとう！`);
  if (c.econ.taxes.res > 11) out.push('住民税がまた上がったって？ 財布のひもはきつく、声は大きく、がこの街のモットー');
  if (c.econ.bankrupt) out.push('市の金庫はからっぽ。この番組のギャラも……いや、なんでもないです');
  if (c.connections.suspicion > 60) out.push('市長の会食グルメ情報、今週も記者さんがしっかりメモしてました');
  if (c.politics.mayor !== 'player') out.push('新しい市長さん、今日もまた変わった政策を発表したみたい。次の選挙まであと少し！');
  if (s.unemployment > 0.1) out.push('求人情報のコーナー、今週は……ごめん、少なめです');
  if (decreeActive(c.policies, 'festival', c.day)) out.push(d.month === 8 ? '今夜は花火大会！ 川沿いの特等席はもう埋まってるかも' : '祭りばやしが聞こえてきたら、そう、今日はお祭りです！');
  if (c.diplomacy.furusato.rate > 0.3) out.push('ふるさと納税の返礼品、うちの市はちょっと太っ腹すぎない？ 国に怒られても知らないよ');
  if (c.region.neighbors.some((n) => !n.merged && stageOf(n.tension) >= 3)) out.push('隣町との境界はまだ封鎖中。向こうのおいしいパン屋さんに行けなくて悲しい');
  const seasonal: Record<number, string[]> = {
    1: ['あけましておめでとう！ おみくじは大吉だった？'], 2: ['寒い日が続きます。路面の凍結に気をつけて'], 3: ['卒業シーズン。旅立つみんなにこの曲を'],
    4: ['桜が見ごろ！ 花見の場所取りは新人さんの仕事、なんて時代じゃないよね'], 5: ['新緑の季節。窓を開けてこの番組を聞いてね'], 6: ['梅雨入り。傘を忘れずに。川には近づかないで'],
    7: ['夏休みが始まったね。熱中症に気をつけて水分補給！'], 8: ['セミの声に負けないボリュームでお届けしています'], 9: ['台風シーズン。ハザードマップ、一度は見ておこう'],
    10: ['秋祭りの神輿、今年も元気に練り歩いてます'], 11: ['紅葉が見ごろ。山の方はきれいだよ'], 12: ['年の瀬。今年もこの番組を聞いてくれてありがとう'],
  };
  out.push(...(seasonal[d.month] ?? []));
  out.push(`人口 ${s.population.toLocaleString()} 人のみんな、こんにちは！ FM みずほ、DJ タケシです`);
  if (c.econ.money > 500_000) out.push(`市の貯金は ${formatYen(c.econ.money)}。うらやましい……いや、使い道はちゃんと考えてね`);
  return pick(out, r);
}

export interface Voice {
  handle: string;
  text: string;
  mood: 'good' | 'bad' | 'info';
}

const HANDLES = ['みずほママ', '通勤戦士', '駅前の八百屋', '定年おじさん', '高校生A', '町内会長代理', '猫と暮らす', '夜勤明け', '川沿い住まい', '新しく越してきた人', '工場勤め', '学生バイト'];

/** 市民のつぶやき（SNS 風の短い声） */
export function voices(c: City, n: number, r: () => number): Voice[] {
  const s = c.stats;
  const pool: Voice[] = [];
  const add = (text: string, mood: Voice['mood'] = 'info') => pool.push({ handle: pick(HANDLES, r), text, mood });
  const util = c.services?.util;
  if (util && util.power.served < 0.9) add('また停電……冷蔵庫の中身が心配', 'bad');
  if (util && util.water.served < 0.9) add('水が出ない日があるのはさすがに困る', 'bad');
  if (c.traffic.avgCommute > 22) add(`通勤 ${Math.round(c.traffic.avgCommute)} 分。電車があればなあ`, 'bad');
  if (c.transit.lines.size) add('新しい路線、便利になったね', 'good');
  if (s.unemployment > 0.08) add('仕事が見つからない。隣町まで行くしかないか', 'bad');
  if (s.happiness > 68) add('この街、住みやすいと思う', 'good');
  if (c.econ.taxes.res > 11) add('住民税高すぎ。引っ越そうかな', 'bad');
  if (c.econ.taxes.res < 9) add('税金安いのは助かる。でも市のお金、大丈夫？', 'info');
  if (c.displaced > 50) add('仮設住宅の暮らしはまだ続きそう', 'bad');
  if (c.fires.length) add('サイレンの音が止まらない。火事だって', 'bad');
  if (unrestStage(c.society.unrest) >= 2) add('駅前のデモ、人がすごかった', 'bad');
  if (c.society.martialLaw) add('街に装甲車がいるのは落ち着かない', 'bad');
  if (c.defense.war) add('早く紛争が終わりますように', 'bad');
  if (decreeActive(c.policies, 'festival', c.day)) add('お祭り楽しい！ 屋台のたこ焼き最高', 'good');
  if (c.connections.suspicion > 50) add('市長、また料亭？ 説明してほしい', 'bad');
  if (s.pollution > 0.2) add('工場の煙で洗濯物が干せない', 'bad');
  if (c.hasFacility('shrine')) add('神社の森、散歩にちょうどいい', 'good');
  if (c.hasFacility('park')) add('公園で子どもが遊べるのはありがたい', 'good');
  if (!pool.length) add('今日も平和な一日');
  const out: Voice[] = [];
  const bag = [...pool];
  while (out.length < n && bag.length) out.push(bag.splice(Math.floor(r() * bag.length), 1)[0]);
  return out;
}
