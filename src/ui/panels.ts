import type { City } from '../city/city';
import {
  EXPENSE_NAMES, INCOME_NAMES, LOAN_OPTIONS, TAX_LIMITS, TAX_NAMES, formatYen, totalDebt,
  type ExpenseKey, type IncomeKey, type TaxKey,
} from '../city/economy';
import { MILESTONES, RANKS, eraOf, yearOf } from '../city/eras';
import { AI_MAYORS, FACTIONS, OPPOSITION_ACTIONS, PLEDGES, isElectionYear, type OppositionAction, type PledgeId } from '../city/politics';
import { EDGE_NAMES, NEIGHBOR_KINDS } from '../city/region';
import { dateOf, formatDate } from '../sim/clock';

export type PanelId = 'finance' | 'people' | 'politics' | 'region' | 'news';

const TITLES: Record<PanelId, string> = { finance: '財政', people: '住民', politics: '政治', region: '地域', news: '新聞' };

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

  constructor(private getCity: () => City, private ui: { toast: (m: string) => void }) {
    document.querySelectorAll<HTMLButtonElement>('.rail button[data-panel]').forEach((b) => {
      b.onclick = () => this.toggle(b.dataset.panel as PanelId);
    });
    document.getElementById('ticker')!.onclick = () => this.toggle('news', true);
  }

  toggle(id: PanelId, force = false): void {
    this.open = this.open === id && !force ? null : id;
    if (this.open === 'news') this.seenNews = this.getCity().versions.news;
    this.seen = -1;
    this.render();
  }

  /** 毎フレーム呼ぶ。変化があったときだけ描き直す */
  update(): void {
    const c = this.getCity();
    const v = c.versions.economy * 1000 + c.versions.news + c.versions.buildings * 7;
    document.querySelectorAll<HTMLButtonElement>('.rail button[data-panel]').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.panel === this.open));
    });
    const badge = document.getElementById('newsBadge')!;
    badge.hidden = this.open === 'news' || c.versions.news <= this.seenNews || !c.news.length;
    document.getElementById('politicsBadge')!.hidden = !c.politics.pledgeChoiceOpen;
    const last = c.news.at(-1);
    const ticker = document.getElementById('tickerText')!;
    const text = last ? `${formatDate(dateOf(last.day))}　${last.text}` : 'まだ記事はありません';
    if (ticker.textContent !== text) ticker.textContent = text;
    if (this.open === 'news') this.seenNews = c.versions.news;
    if (v === this.seen) return;
    // 入力中（税率のつまみを動かしている間など）は描き直さない
    const active = document.activeElement;
    if (active && this.el.contains(active) && active.tagName === 'INPUT') return;
    this.seen = v;
    this.render();
  }

  private render(): void {
    this.el.hidden = !this.open;
    if (!this.open) return;
    const c = this.getCity();
    const body = h('div', { cls: 'pbody' });
    const head = h('div', { cls: 'phead' }, h('h2', {}, TITLES[this.open]), h('button', { cls: 'close', onclick: () => this.toggle(this.open!), title: '閉じる' }, '×'));
    ({ finance: () => this.finance(c, body), people: () => this.people(c, body), politics: () => this.politics(c, body), region: () => this.region(c, body), news: () => this.newsList(c, body) })[this.open]();
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

  private newsList(c: City, el: HTMLElement): void {
    if (!c.news.length) { el.append(h('p', { cls: 'note' }, 'まだ記事はありません。')); return; }
    for (const n of [...c.news].reverse()) {
      el.append(h('article', { cls: `news ${n.kind}` }, h('time', {}, formatDate(dateOf(n.day))), h('p', {}, n.text)));
    }
  }
}
