import type { City } from '../city/city';
import {
  EXPENSE_NAMES, INCOME_NAMES, LOAN_OPTIONS, TAX_LIMITS, TAX_NAMES, formatYen, totalDebt,
  type ExpenseKey, type IncomeKey, type TaxKey,
} from '../city/economy';
import { MILESTONES, RANKS, eraOf, yearOf } from '../city/eras';
import { AI_MAYORS, FACTIONS, OPPOSITION_ACTIONS, PLEDGES, isElectionYear, type OppositionAction, type PledgeId } from '../city/politics';
import { EDGE_NAMES, NEIGHBOR_KINDS } from '../city/region';
import { dateOf, formatDate } from '../sim/clock';

import { DECREES, POLICIES, decreeActive, type DecreeId, type PolicyId } from '../city/policies';
import { IMPORT, UTILITY_NAMES, UTILITY_UNITS, type Utility } from '../city/services';
import { prob30 } from '../city/disasters';
import type { InfoMode } from '../render/infoView';

import { MODES, roundTripMinutes } from '../city/transit';
import { ACTIONS, NPCS, REQUESTS, type ActionId, type NpcId } from '../city/connections';

import { ALERT_NAMES, alertLevel, SEAWALL_HEIGHTS } from '../city/water';
import { FACILITIES } from '../city/facilities';

export type PanelId = 'finance' | 'people' | 'politics' | 'region' | 'transport' | 'npc' | 'policy' | 'disaster' | 'info' | 'news';

const TITLES: Record<PanelId, string> = { finance: '財政', people: '住民', politics: '政治', region: '地域', transport: '交通と公共交通', npc: '関係者（コネ）', disaster: '防災と復興', policy: '政策と布告', info: '情報とハザードマップ', news: '新聞' };

const INFO_VIEWS: { mode: InfoMode; label: string; group: string }[] = [
  { mode: 'none', label: 'ふつう', group: '表示' },
  { mode: 'power', label: '電気', group: 'インフラ' }, { mode: 'water', label: '水道', group: 'インフラ' },
  { mode: 'sewage', label: '下水', group: 'インフラ' }, { mode: 'garbage', label: 'ゴミ', group: 'インフラ' },
  { mode: 'fire', label: '消防', group: 'サービス' }, { mode: 'police', label: '警察', group: 'サービス' },
  { mode: 'health', label: '医療', group: 'サービス' }, { mode: 'education', label: '教育', group: 'サービス' },
  { mode: 'happiness', label: '満足度', group: 'サービス' },
  { mode: 'traffic', label: '交通量', group: '交通' }, { mode: 'transit', label: '路線', group: '交通' },
  { mode: 'flood', label: '浸水', group: 'ハザードマップ' }, { mode: 'liquefaction', label: '液状化', group: 'ハザードマップ' },
  { mode: 'landslide', label: '土砂災害', group: 'ハザードマップ' }, { mode: 'shaking', label: '揺れやすさ', group: 'ハザードマップ' },
];

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { cls?: string } = {}, ...kids: (Node | string)[]) => {
  const el = document.createElement(tag);
  const { cls, ...rest } = props;
  if (cls) el.className = cls;
  Object.assign(el, rest);
  el.append(...kids);
  return el;
};
const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}％`;
const row = (k: string, v: string | Node, cls = '') => h('div', { cls: `kv ${cls}` }, h('span', { cls: 'k' }, k), typeof v === 'string' ? h('span', { cls: 'v' }, v) : v);
const bar = (value: number, max: number, color: string, center = false) => {
  const wrap = h('span', { cls: `meter${center ? ' center' : ''}` });
  const fill = h('i');
  if (center) {
    const w = (Math.abs(value) / max) * 50;
    fill.style.width = `${w}%`;
    fill.style.left = value >= 0 ? '50%' : `${50 - w}%`;
  } else fill.style.width = `${Math.max(0, Math.min(100, (value / max) * 100))}%`;
  fill.style.background = color;
  wrap.append(fill);
  return wrap;
};

/** 左側の「市役所」パネル */
export class Panels {
  open: PanelId | null = null;
  private el = document.getElementById('panel')!;
  private seen = -1;
  private seenNews = 0;
  infoMode: InfoMode = 'none';
  private lastRender = 0;
  private policyDistrict = 0;

  constructor(private getCity: () => City, private ui: { toast: (m: string) => void; setInfo: (m: InfoMode) => void }) {
    document.querySelectorAll<HTMLButtonElement>('.rail button[data-panel]').forEach((b) => {
      b.onclick = () => this.toggle(b.dataset.panel as PanelId);
    });
    document.getElementById('ticker')!.onclick = () => this.toggle('news', true);
  }

  toggle(id: PanelId, force = false): void {
    this.open = this.open === id && !force ? null : id;
    // 情報パネルを閉じたら、ふつうの表示に戻す
    if (this.open !== 'info' && this.infoMode !== 'none') { this.infoMode = 'none'; this.ui.setInfo('none'); }
    if (this.open === 'news') this.seenNews = this.getCity().versions.news;
    this.seen = -1;
    this.render();
  }

  /** 毎フレーム呼ぶ。変化があったときだけ描き直す */
  update(): void {
    const c = this.getCity();
    const v = c.versions.economy * 1000 + c.versions.news + c.versions.buildings * 7 + c.versions.services * 13 + c.versions.fires * 17 + c.versions.transit * 19 + c.versions.traffic * 23 + c.versions.water * 29;
    document.querySelectorAll<HTMLButtonElement>('.rail button[data-panel]').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.panel === this.open));
    });
    const badge = document.getElementById('newsBadge')!;
    badge.hidden = this.open === 'news' || c.versions.news <= this.seenNews || !c.news.length;
    document.getElementById('politicsBadge')!.hidden = !c.politics.pledgeChoiceOpen;
    document.getElementById('npcBadge')!.hidden = !c.connections.requests.length;
    document.getElementById('disasterBadge')!.hidden = !c.activeStorm() && c.displaced < 50;
    const last = c.news.at(-1);
    const ticker = document.getElementById('tickerText')!;
    const text = last ? `${formatDate(dateOf(last.day))}　${last.text}` : 'まだ記事はありません';
    if (ticker.textContent !== text) ticker.textContent = text;
    if (this.open === 'news') this.seenNews = c.versions.news;
    if (v === this.seen) return;
    // マウスがパネルの上にある間は描き直さない。それ以外も 1.5 秒に 1 回まで（ボタンを押しやすくする）
    if (this.seen !== -1 && this.el.matches(':hover')) return;
    const now = performance.now();
    if (this.seen !== -1 && now - this.lastRender < 1500) return;
    // 入力中（税率のつまみを動かしている間など）は描き直さない
    const active = document.activeElement;
    if (active && this.el.contains(active) && active.tagName === 'INPUT') return;
    this.seen = v;
    this.lastRender = now;
    this.render();
  }

  private render(): void {
    this.el.hidden = !this.open;
    if (!this.open) return;
    const c = this.getCity();
    const body = h('div', { cls: 'pbody' });
    const head = h('div', { cls: 'phead' }, h('h2', {}, TITLES[this.open]), h('button', { cls: 'close', onclick: () => this.toggle(this.open!), title: '閉じる' }, '×'));
    ({
      finance: () => this.finance(c, body), people: () => this.people(c, body), politics: () => this.politics(c, body),
      region: () => this.region(c, body), policy: () => this.policy(c, body),
      transport: () => this.transport(c, body), npc: () => this.npc(c, body), disaster: () => this.disaster(c, body), info: () => this.info(c, body), news: () => this.newsList(c, body),
    })[this.open]();
    const scroll = this.el.querySelector('.pbody')?.scrollTop ?? 0;
    this.el.replaceChildren(head, body);
    body.scrollTop = scroll;
  }

  private finance(c: City, el: HTMLElement): void {
    const e = c.econ;
    const last = e.reports.at(-1);
    if (e.bankrupt) el.append(h('p', { cls: 'alert' }, '財政再生団体です。新しい道路は作れず、税率も標準より下げられません。黒字が 3 か月続くと脱出できます。'));
    el.append(
      row('資金', formatYen(e.money), e.money < 0 ? 'neg' : ''),
      row('先月の収支', last ? `${last.net >= 0 ? '+' : ''}${formatYen(last.net)}` : '月末に集計します', last && last.net < 0 ? 'neg' : 'pos'),
      row('市債の残高', formatYen(totalDebt(e))),
    );
    if (last) {
      const t = h('table', { cls: 'ledger' });
      t.append(h('tr', {}, h('th', {}, '収入'), h('th', {}, '')));
      for (const k of Object.keys(last.income) as IncomeKey[]) if (last.income[k] > 0.5) t.append(h('tr', {}, h('td', {}, INCOME_NAMES[k]), h('td', {}, formatYen(last.income[k]))));
      t.append(h('tr', {}, h('th', {}, '支出'), h('th', {}, '')));
      for (const k of Object.keys(last.expense) as ExpenseKey[]) if (last.expense[k] > 0.5) t.append(h('tr', {}, h('td', {}, EXPENSE_NAMES[k]), h('td', {}, formatYen(last.expense[k]))));
      el.append(h('h3', {}, '先月の内訳'), t);
    }
    if (e.reports.length > 1) {
      const t = h('table', { cls: 'ledger' });
      t.append(h('tr', {}, h('th', {}, '月'), h('th', {}, '収支'), h('th', {}, '資金')));
      for (const r of e.reports.slice(-6).reverse()) {
        const d = dateOf(r.day - 1);
        t.append(h('tr', {}, h('td', {}, `${d.year}年${d.month}月`), h('td', { cls: r.net < 0 ? 'neg' : 'pos' }, `${r.net >= 0 ? '+' : ''}${formatYen(r.net)}`), h('td', {}, formatYen(r.money))));
      }
      el.append(h('h3', {}, '最近の推移'), t);
    }
    el.append(h('h3', {}, '税率'));
    const hints: Record<TaxKey, string> = { res: '上げると住宅の需要と住民の満足度が下がる', biz: '上げると商業・工業の需要と経済界の支持が下がる', prop: '建物の資産価値にかかる。標準は 1.4％' };
    const blocked = c.blockedReason();
    for (const key of Object.keys(TAX_NAMES) as TaxKey[]) {
      const [lo, hi, step] = TAX_LIMITS[key];
      const out = h('b', {}, `${e.taxes[key].toFixed(1)}％`);
      const input = h('input', { type: 'range', min: String(lo), max: String(hi), step: String(step), value: String(e.taxes[key]), id: `tax-${key}`, disabled: !!blocked });
      input.oninput = () => { out.textContent = `${Number(input.value).toFixed(1)}％`; };
      input.onchange = () => { c.setTax(key, Number(input.value)); };
      el.append(h('label', { cls: 'tax', htmlFor: `tax-${key}` }, h('span', {}, TAX_NAMES[key]), out), input, h('p', { cls: 'note' }, hints[key]));
    }
    el.append(h('h3', {}, '市債（借入）'));
    const btns = h('div', { cls: 'row' });
    for (const amt of LOAN_OPTIONS) {
      btns.append(h('button', { onclick: () => { const r = c.borrow(amt); this.ui.toast(r ?? `${formatYen(amt)} を借り入れました`); }, disabled: !!blocked }, `${formatYen(amt)} 借りる`));
    }
    el.append(btns, h('p', { cls: 'note' }, '年利 1.2％、10 年で元利均等返済。残高は 30 億円まで。'));
    for (const l of e.loans) el.append(row(`市債 #${l.id}`, `残り ${formatYen(l.remaining)}（月 ${formatYen(l.monthly)}、あと ${l.monthsLeft} か月）`));
  }

  private people(c: City, el: HTMLElement): void {
    const s = c.stats;
    const year = yearOf(c.day), era = eraOf(year);
    const rank = RANKS[c.meta.rank], next = RANKS[c.meta.rank + 1];
    el.append(
      row('人口', `${s.population.toLocaleString()} 人`),
      row('市の格', next ? `${rank.name}（人口 ${next.pop.toLocaleString()} 人で${next.name}）` : rank.name),
      row('時代', `${era.name}（${year} 年目）`),
      h('h3', {}, '年齢構成'),
      row('子ども', `${s.ages[0].toLocaleString()} 人`), row('働く世代', `${s.ages[1].toLocaleString()} 人`), row('高齢者', `${s.ages[2].toLocaleString()} 人（${s.population ? pct(s.ages[2] / s.population) : '—'}）`),
      h('h3', {}, '仕事'),
      row('働き手', `${s.workers.toLocaleString()} 人`),
      row('市内の雇用', `${(s.comJobs + s.indJobs).toLocaleString()} 人（商業 ${s.comJobs.toLocaleString()}／工業 ${s.indJobs.toLocaleString()}）`),
      row('失業率', pct(s.unemployment), s.unemployment > 0.1 ? 'neg' : ''),
      row('隣町へ通勤', `${s.commuteOut.toLocaleString()} 人`),
      row('隣町から通勤', `${s.commuteIn.toLocaleString()} 人`),
      row('人手不足', `${s.shortage.toLocaleString()} 人分`, s.shortage > 0 ? 'neg' : ''),
      h('h3', {}, '暮らし'),
      row('満足度', h('span', { cls: 'v' }, bar(s.happiness, 100, s.happiness >= 50 ? '#3ea865' : '#d9573f'), ` ${Math.round(s.happiness)}`)),
      row('工業の近くに住む人', pct(s.pollution), s.pollution > 0.2 ? 'neg' : ''),
      row('旧耐震の建物', pct(s.oldSeismicShare, 0)),
    );
    const nextM = MILESTONES[c.meta.milestone + 1];
    if (nextM) el.append(h('p', { cls: 'note' }, `次の節目：人口 ${nextM.toLocaleString()} 人（国から補助金）`));
    el.append(h('p', { cls: 'note' }, '旧耐震の建物は、のちの地震（P3）で壊れやすくなります。新耐震基準は 31 年目に施行されます。'));
  }

  private politics(c: City, el: HTMLElement): void {
    const p = c.politics;
    const year = yearOf(c.day);
    let next = year + 1;
    while (!isElectionYear(next)) next++;
    const monthsLeft = Math.max(0, Math.ceil(((next - 1) * 360 - c.day) / 30));
    el.append(
      row('市長', p.mayor === 'player' ? 'あなた' : `${AI_MAYORS[p.mayor].name}（${AI_MAYORS[p.mayor].title}）`),
      row('支持率', h('span', { cls: 'v' }, bar(p.approval, 100, p.approval >= 50 ? '#3ea865' : '#d9573f'), ` ${p.approval.toFixed(1)}％`)),
      row('次の市長選挙', `${next} 年目の 4 月（あと ${monthsLeft} か月）`),
    );
    if (p.mayor !== 'player') {
      const ai = AI_MAYORS[p.mayor];
      el.append(h('p', { cls: 'alert' }, `${ai.name} 市長の任期中です。方針：${ai.style}。あなたは野党として活動し、次の選挙で返り咲きを狙います。`));
      el.append(h('h3', {}, '野党としての活動'));
      for (const [id, a] of Object.entries(OPPOSITION_ACTIONS)) {
        const ready = (p.cooldowns[id] ?? 0) <= c.day;
        el.append(h('div', { cls: 'action' },
          h('button', { onclick: () => { const r = c.opposition(id as OppositionAction); if (r) this.ui.toast(r); }, disabled: !ready }, a.name),
          h('span', { cls: 'note' }, ready ? a.effect : `あと ${Math.ceil(((p.cooldowns[id] ?? 0) - c.day) / 30)} か月`)));
      }
    }
    if (p.pledgeChoiceOpen) {
      el.append(h('h3', {}, '公約を選ぶ（選挙まであと少し）'));
      for (const [id, pl] of Object.entries(PLEDGES)) {
        el.append(h('div', { cls: 'action' }, h('button', { onclick: () => c.choosePledge(id as PledgeId) }, pl.name), h('span', { cls: 'note' }, `${pl.promise}（${pl.boost.map((f) => FACTIONS.find((x) => x.id === f)!.name).join('・')}の支持が上がる）`)));
      }
    } else if (p.pledge) {
      el.append(row('掲げている公約', `${PLEDGES[p.pledge.id].name}：${PLEDGES[p.pledge.id].promise}`));
    }
    el.append(h('h3', {}, '派閥'));
    for (const f of FACTIONS) {
      el.append(h('div', { cls: 'faction' },
        h('div', { cls: 'fhead' }, h('i', { cls: 'dot' }), h('b', {}, f.name), h('span', { cls: 'note' }, `市民の ${pct(p.share[f.id], 0)}　代表：${f.leader}`)),
        h('div', { cls: 'fbar' }, bar(p.support[f.id], 100, f.color), h('span', {}, `${Math.round(p.support[f.id])}`)),
        h('p', { cls: 'note' }, `望むこと：${f.wants}`)));
      (el.lastElementChild!.querySelector('.dot') as HTMLElement).style.background = f.color;
    }
    if (p.elections.length) {
      el.append(h('h3', {}, '選挙の記録'));
      for (const r of [...p.elections].reverse()) el.append(row(`${r.year} 年目`, `${r.won ? '当選' : '落選'}　${r.player.toFixed(1)}％ 対 ${r.opponent.toFixed(1)}％（${r.opponentName}）`, r.won ? 'pos' : 'neg'));
    }
  }

  private region(c: City, el: HTMLElement): void {
    const last = c.econ.reports.at(-1);
    el.append(row('交易の収入（先月）', last ? formatYen(last.income.trade) : '—'));
    el.append(h('p', { cls: 'note' }, '地図の端まで道路を引くと、その方角の隣町とつながります。つながると通勤と交易が始まります。'));
    for (const n of c.region.neighbors) {
      el.append(h('div', { cls: 'neighbor' },
        h('div', { cls: 'fhead' }, h('b', {}, n.name), h('span', { cls: 'note' }, `${EDGE_NAMES[n.edge]}・${NEIGHBOR_KINDS[n.kind].name}`)),
        row('人口', `${n.population.toLocaleString()} 人`),
        row('関係', h('span', { cls: 'v' }, bar(n.relation, 100, n.relation >= 0 ? '#3ea865' : '#d9573f', true), ` ${Math.round(n.relation)}`)),
        row('道路', n.connected ? 'つながっている' : `未接続（地図の${EDGE_NAMES[n.edge].replace('（山側）', '')}端まで道路を引く）`, n.connected ? 'pos' : ''),
        row('通勤', n.connected ? `行く ${n.outCommute.toLocaleString()} 人／来る ${n.inCommute.toLocaleString()} 人` : '—')));
    }
  }

  private policy(c: City, el: HTMLElement): void {
    const blocked = c.blockedReason();
    if (blocked) el.append(h('p', { cls: 'alert' }, blocked));
    el.append(h('h3', {}, '政策をかける場所'));
    const seg = h('div', { cls: 'chips' });
    const places = [{ id: 0, name: '市全体' }, ...c.districts.list.map((d) => ({ id: d.id, name: d.name }))];
    if (!places.some((p) => p.id === this.policyDistrict)) this.policyDistrict = 0;
    for (const p of places) {
      seg.append(h('button', { onclick: () => { this.policyDistrict = p.id; this.seen = -1; this.render(); }, ariaPressed: String(this.policyDistrict === p.id) }, p.name));
    }
    el.append(seg);
    if (!c.districts.list.length) el.append(h('p', { cls: 'note' }, '地区を塗り分けると、地区ごとに政策をかけられます。'));
    const active = c.policies.districts[this.policyDistrict] ?? [];
    for (const [id, def] of Object.entries(POLICIES) as [PolicyId, (typeof POLICIES)[PolicyId]][]) {
      const on = active.includes(id);
      const cost = def.costFlat ? `月 ${formatYen(def.costFlat)}` : def.costPerBuilding ? `旧耐震 1 棟あたり月 ${formatYen(def.costPerBuilding)}` : '費用なし';
      el.append(h('div', { cls: 'policy-row' },
        h('button', { onclick: () => c.togglePolicy(this.policyDistrict, id), ariaPressed: String(on), disabled: !!blocked }, on ? '実施中' : '実施'),
        h('div', {}, h('b', {}, def.name), h('p', { cls: 'note' }, `${def.effect}（${cost}）`))));
    }
    el.append(h('h3', {}, '布告（市全体）'));
    for (const [id, def] of Object.entries(DECREES) as [DecreeId, (typeof DECREES)[DecreeId]][]) {
      const on = decreeActive(c.policies, id, c.day);
      const label = def.kind === 'toggle' ? (on ? '解除する' : '出す') : on ? '実施中' : '出す';
      el.append(h('div', { cls: 'policy-row' },
        h('button', { onclick: () => { const r = c.decree(id); if (r) this.ui.toast(r); }, ariaPressed: String(on), disabled: !!blocked || (def.kind === 'once' && on) }, label),
        h('div', {}, h('b', {}, def.name), h('p', { cls: 'note' }, def.effect))));
    }
  }

  private info(c: City, el: HTMLElement): void {
    let group = '';
    let seg: HTMLElement | null = null;
    for (const v of INFO_VIEWS) {
      if (v.group !== group) {
        group = v.group;
        el.append(h('h3', {}, group));
        seg = h('div', { cls: 'chips' });
        el.append(seg);
      }
      seg!.append(h('button', { ariaPressed: String(this.infoMode === v.mode), onclick: () => { this.infoMode = v.mode; this.ui.setInfo(v.mode); this.seen = -1; this.render(); } }, v.label));
    }
    const m = this.infoMode;
    if (['power', 'water', 'sewage', 'garbage'].includes(m)) {
      el.append(h('div', { cls: 'chips' }, h('span', {}, h('i', { style: 'background:#3f93dc' } as never), '届いている'), h('span', {}, h('i', { style: 'background:#e0513e' } as never), '届いていない')));
    } else if (['fire', 'police', 'health', 'education', 'happiness'].includes(m)) {
      el.append(h('div', { cls: 'chips' }, h('span', {}, h('i', { style: 'background:#3f93dc' } as never), '十分'), h('span', {}, h('i', { style: 'background:#5fbf6a' } as never), 'まあまあ'), h('span', {}, h('i', { style: 'background:#e8b83e' } as never), '不足'), h('span', {}, h('i', { style: 'background:#e0513e' } as never), '届いていない')));
      if (m !== 'happiness') el.append(h('p', { cls: 'note' }, '水色の円は施設のサービスが届く範囲です。'));
    } else if (m === 'traffic') {
      el.append(h('div', { cls: 'chips' }, ...[['#4cc26a', 'すいている'], ['#e8d23e', 'やや混雑'], ['#f08a2e', '混雑'], ['#e0413a', '渋滞']].map(([c2, t]) => h('span', {}, h('i', { style: `background:${c2}` } as never), t))));
    } else if (m === 'transit') {
      el.append(h('p', { cls: 'note' }, '路線の色で道のりを、白い丸で停留所と駅を示します。地下鉄も地上から見えるように表示します。'));
    } else if (['flood', 'liquefaction', 'landslide', 'shaking'].includes(m)) {
      const bar = h('i');
      bar.style.background = 'linear-gradient(90deg, #f7f5a8, #ffd87a, #f7a660, #e8615a, #b34a8f)';
      el.append(h('div', { cls: 'legend' }, '低い', bar, '高い'));
      const notes: Record<string, string> = {
        flood: '川があふれたときや高潮のときに水につかりやすい場所。濃いほど深い（最大 5 m 程度）。',
        liquefaction: '地震のとき地面が液状になって建物が傾きやすい場所。海辺や川沿いの低い土地。',
        landslide: 'がけ崩れや土石流が起きやすい急な斜面。',
        shaking: '地盤がやわらかく、地震で揺れが大きくなりやすい場所。',
      };
      el.append(h('p', { cls: 'note' }, notes[m]));
    }

    const s = c.services;
    if (s) {
      el.append(h('h3', {}, 'インフラ（供給／需要）'));
      for (const k of Object.keys(UTILITY_NAMES) as Utility[]) {
        const u = s.util[k];
        const txt = `${Math.round(u.supply).toLocaleString()}／${Math.round(u.demand).toLocaleString()} ${UTILITY_UNITS[k]}・届いている ${pct(u.served, 0)}${u.imported > 0 ? `（隣町から ${Math.round(u.imported).toLocaleString()} を購入）` : ''}`;
        el.append(row(UTILITY_NAMES[k], txt, u.served < 0.95 ? 'neg' : ''));
      }
      el.append(h('p', { cls: 'note' }, `電線と水道管は道路に沿って通ります。発電所や浄水場と道路でつながっていない建物には届きません。地図の端で隣町とつながっていれば、足りない分を買えます（電気は最大 ${IMPORT.power.cap.toLocaleString()} kW）。`));
      el.append(h('h3', {}, 'サービスが届いている住民'));
      el.append(row('消防', pct(s.coverage.fire, 0)), row('警察', pct(s.coverage.police, 0)), row('医療', pct(s.coverage.health, 0)), row('教育', pct(s.coverage.education, 0)));
    }
    el.append(h('h3', {}, '防災'));
    const since = yearOf(c.day) - (c.meta.lastQuakeYear ?? 0);
    el.append(row('今後 30 年以内に大地震（M7 前後）が起きる確率', pct(prob30(since), 0)));
    el.append(row('燃えている建物', `${c.fires.length} 棟`, c.fires.length ? 'neg' : ''));
    el.append(row('がれき', `${c.rubble.length} か所`));
    el.append(row('旧耐震の建物', pct(c.stats.oldSeismicShare, 0)));
    if (c.quakes.length) {
      el.append(h('h3', {}, '地震の記録'));
      for (const q of [...c.quakes].reverse().slice(0, 6)) {
        el.append(row(formatDate(dateOf(q.day)), `M${q.magnitude}・最大震度 ${q.maxShindo}・全壊 ${q.collapsed}・損傷 ${q.damaged}`));
      }
    }
  }

  private transport(c: City, el: HTMLElement): void {
    const t = c.traffic;
    el.append(
      row('車の通勤の平均時間（片道）', t.carTrips ? `${t.avgCommute.toFixed(0)} 分` : '—', t.avgCommute > 30 ? 'neg' : ''),
      row('渋滞している道路を走る車', pct(t.congestion, 0), t.congestion > 0.25 ? 'neg' : ''),
      row('車で通勤する人（1 日）', `${t.carTrips.toLocaleString()} 人`),
      row('公共交通の利用（1 日・片道）', `${(c.riders?.total ?? 0).toLocaleString()} 人`),
      row('踏切', `${c.crossings.length} か所${t.busyCrossings ? `（うち開かずの踏切 ${t.busyCrossings}）` : ''}`, t.busyCrossings ? 'neg' : ''),
    );
    el.append(h('p', { cls: 'note' }, '渋滞がひどいと、住民の満足度と住宅の需要、経済界の支持が下がります。「情報」の交通量で混んでいる道路が見られます。'));
    el.append(h('h3', {}, '路線'));
    if (!c.transit.lines.size) el.append(h('p', { cls: 'note' }, '下の「公共交通」から、バス・路面電車・鉄道・地下鉄の路線をつくれます。'));
    const blocked = !!c.blockedReason();
    for (const l of c.transit.lines.values()) {
      const def = MODES[l.mode];
      const trip = roundTripMinutes(l);
      const stops = l.stops.map((id, i) => {
        const st = c.transit.stops.get(id);
        const num = l.mode === 'rail' || l.mode === 'subway' ? `${l.code}${String(i + 1).padStart(2, '0')}` : '';
        return h('span', {}, num ? h('b', {}, num) : '', `${st?.name ?? '？'}${i < l.stops.length - 1 ? ' ― ' : ''}`);
      });
      const stepper = (label: string, value: string, dec: () => void, inc: () => void) =>
        h('span', { cls: 'stepper' }, label, h('button', { onclick: dec, disabled: blocked, title: '減らす' }, '−'), h('b', {}, value), h('button', { onclick: inc, disabled: blocked, title: '増やす' }, '+'));
      const sw = h('i', { cls: 'swatch' });
      sw.style.background = l.color;
      el.append(h('div', { cls: 'line-card' },
        h('div', { cls: 'lhead' }, sw, h('b', {}, l.name), h('span', { cls: 'note' }, `${def.name}${l.operator === 'private' ? '（私鉄）' : ''}${l.broken ? '・不通' : ''}`)),
        h('p', { cls: 'stops' }, ...stops),
        row('利用者（1 日）', `${l.riders.toLocaleString()} 人`),
        row('運行間隔', `${Math.max(1, Math.round(trip / l.vehicles))} 分ごと（1 周 ${Math.round(trip)} 分）`),
        l.operator === 'city' ? row('月の収支', `${formatYen(l.income - l.cost)}（運賃 ${formatYen(l.income)}／運行費 ${formatYen(l.cost)}）`, l.income - l.cost < 0 ? 'neg' : 'pos') : row('運営', '瑞穂電鉄（収支は私鉄）'),
        h('div', { cls: 'row' },
          stepper('車両 ', `${l.vehicles}`, () => c.setLine(l.id, { vehicles: l.vehicles - 1 }), () => c.setLine(l.id, { vehicles: l.vehicles + 1 })),
          stepper('　運賃 ', `${l.fare}円`, () => c.setLine(l.id, { fare: l.fare - 10 }), () => c.setLine(l.id, { fare: l.fare + 10 })),
          h('button', { onclick: () => c.removeLine(l.id), disabled: blocked }, '廃止')),
      ));
    }
  }

  private npc(c: City, el: HTMLElement): void {
    const k = c.connections;
    el.append(row('疑惑度', h('span', { cls: 'v' }, bar(k.suspicion, 100, k.suspicion > 60 ? '#d9573f' : k.suspicion > 30 ? '#e8b83e' : '#3ea865'), ` ${Math.round(k.suspicion)}`), k.suspicion > 60 ? 'neg' : ''));
    el.append(h('p', { cls: 'note' }, '会食や便宜で関係が深まると、見返りが得られます。ただし疑惑度がたまると、記者にスクープされて支持率が下がり、90 を超えるとリコールの出直し選挙になります。疑惑度は毎月少しずつ下がります。'));
    if (k.recallDay) el.append(h('p', { cls: 'alert' }, `リコールの出直し選挙まであと ${Math.ceil((k.recallDay - c.day) / 30)} か月です。`));
    const blocked = !!c.blockedReason();
    for (const id of Object.keys(NPCS) as NpcId[]) {
      const n = NPCS[id];
      const rel = k.rel[id];
      const card = h('div', { cls: 'npc' },
        h('div', { cls: 'who' }, h('b', {}, n.name), h('span', { cls: 'note' }, n.title)),
        h('p', { cls: 'note' }, n.intro),
        row('関係', h('span', { cls: 'v' }, bar(rel, 100, rel >= 50 ? '#3ea865' : '#6fb1d9'), ` ${Math.round(rel)}`)),
        ...n.perks.map((p) => h('p', { cls: `perk${rel >= p.at ? ' on' : ''}` }, `${rel >= p.at ? '✓' : `関係 ${p.at}〜`}　${p.text}`)),
      );
      const req = k.requests.find((r) => r.npc === id);
      if (req) {
        card.append(h('div', { cls: 'request' }, h('b', {}, '陳情　'), req.text, h('br'), h('span', { cls: 'note' }, `受けると：${REQUESTS[id].effect}`),
          h('div', { cls: 'row' },
            h('button', { onclick: () => { const r = c.answerRequest(id, true); if (r) this.ui.toast(r); }, disabled: blocked }, '受ける'),
            h('button', { onclick: () => c.answerRequest(id, false) }, '断る（関係 −5）'))));
      }
      const acts = h('div', { cls: 'row' });
      for (const a of Object.keys(ACTIONS) as ActionId[]) {
        const def = ACTIONS[a];
        const ready = (k.cooldowns[`${id}:${a}`] ?? 0) <= c.day;
        const b = h('button', { onclick: () => { const r = c.npcAction(id, a); if (r) this.ui.toast(r); }, disabled: blocked || !ready, title: def.note }, ready ? def.name : `${def.name}（${Math.ceil(((k.cooldowns[`${id}:${a}`] ?? 0) - c.day) / 30)} か月後）`);
        acts.append(b);
      }
      card.append(acts);
      el.append(card);
    }
  }

  private disasterDistrict = 0;

  private disaster(c: City, el: HTMLElement): void {
    const st = c.activeStorm();
    if (st) {
      const lv = alertLevel(st, c.day);
      el.append(h('p', { cls: 'alert' }, `${st.name}：警戒レベル ${lv}（${ALERT_NAMES[lv]}）。最も強まるのは ${Math.max(0, st.hit - c.day)} 日後。${st.evacuated ? '避難指示を出しています' : 'まだ避難指示は出していません'}`));
    }
    el.append(h('h3', {}, '備え'));
    const riverSecs = c.defenses.levees.filter((_, i) => {
      const z = i * 160 - 1024 + 80;
      const k = Math.min(c.terrain.river.length - 1, Math.max(0, Math.round(((z + 1024) / 2048) * 512)));
      return c.terrain.river[k].level > 0.01;
    });
    const avgLevee = riverSecs.length ? riverSecs.reduce((a, v) => a + v, 0) / riverSecs.length : 0;
    const walls = c.defenses.seawalls.filter((v) => v > 0).length;
    let towers = 0, housing = 0;
    for (const f of c.facilities.values()) { if (f.kind === 'evacTower') towers++; housing += FACILITIES[f.kind].housing ?? 0; }
    el.append(
      row('堤防（川の区間の平均）', `${avgLevee.toFixed(1)} 段（水位 ${(3.5 + avgLevee * 2).toFixed(1)} m まで耐える）`),
      row('防潮堤のある海岸', `${walls} 区間（最大 ${SEAWALL_HEIGHTS[Math.max(0, ...c.defenses.seawalls)]} m）`),
      row('避難所の受け入れ', `${c.shelterCapacity().toLocaleString()} 人（人口 ${c.stats.population.toLocaleString()} 人）`, c.shelterCapacity() < c.stats.population * 0.3 ? 'neg' : ''),
      row('津波避難タワー', `${towers} 基`),
      row('防衛隊', c.hasFacility('garrison') ? '駐屯地あり（災害派遣を要請できる）' : 'なし'),
    );
    el.append(h('p', { cls: 'note' }, '「防災」で堤防と防潮堤を高くし、「施設」の防災から遊水地・地下放水路・砂防ダム・避難タワー・防災公園・仮設住宅・防衛隊駐屯地を建てられます。ハザードマップは「情報」で見られます。'));
    el.append(h('h3', {}, '復興'));
    el.append(
      row('住まいを失った人', `${c.displaced.toLocaleString()} 人`, c.displaced > housing ? 'neg' : ''),
      row('仮設住宅', `${housing.toLocaleString()} 人分`),
      row('がれき', `${c.rubble.length} か所`),
      row('修理を待つ建物', `${[...c.buildings.values()].filter((b) => b.damagedUntil && b.damagedUntil > c.day).length} 棟`),
    );
    el.append(h('div', { cls: 'row' }, h('button', { onclick: () => { const r = c.requestDispatch(); this.ui.toast(r ?? '防衛隊に災害派遣を要請しました'); } }, '防衛隊に災害派遣を要請')));
    if (c.districts.list.length) {
      const chips = h('div', { cls: 'chips' });
      if (!c.districts.get(this.disasterDistrict)) this.disasterDistrict = c.districts.list[0].id;
      for (const d of c.districts.list) chips.append(h('button', { ariaPressed: String(d.id === this.disasterDistrict), onclick: () => { this.disasterDistrict = d.id; this.seen = -1; this.render(); } }, d.name));
      el.append(h('h3', {}, '地区の復興事業'), chips,
        h('div', { cls: 'policy-row' }, h('button', { onclick: () => { const r = c.readjust(this.disasterDistrict); this.ui.toast(r ?? '区画整理をしました'); } }, '区画整理'),
          h('div', {}, h('b', {}, '復興区画整理'), h('p', { cls: 'note' }, 'がれきを片付け、地区の建物を新耐震・防火の造りに建て直す（区画 1 マスあたり 20万円）'))),
        h('div', { cls: 'policy-row' }, h('button', { onclick: () => { const r = c.relocate(this.disasterDistrict); this.ui.toast(r ?? '高台移転をしました'); } }, '高台移転'),
          h('div', {}, h('b', {}, '高台移転'), h('p', { cls: 'note' }, '地区の中で浸水の危険が高い土地から建物を移し、住宅地をやめる（1 棟 30万円）'))));
    } else {
      el.append(h('p', { cls: 'note' }, '地区を塗り分けると、地区ごとに復興区画整理や高台移転ができます。'));
    }
    if (c.disasterReports.length) {
      el.append(h('h3', {}, '災害の記録'));
      for (const r of [...c.disasterReports].reverse().slice(0, 8)) {
        el.append(row(formatDate(dateOf(r.day)), `${r.title.replace('の被害', '')}：床上 ${r.above}・全壊 ${r.collapsed}・土砂 ${r.landslides}・逃げ遅れ ${r.stranded}`, r.stranded ? 'neg' : ''));
      }
    }
  }

  private newsList(c: City, el: HTMLElement): void {
    if (!c.news.length) { el.append(h('p', { cls: 'note' }, 'まだ記事はありません。')); return; }
    for (const n of [...c.news].reverse()) {
      el.append(h('article', { cls: `news ${n.kind}` }, h('time', {}, formatDate(dateOf(n.day))), h('p', {}, n.text)));
    }
  }
}
