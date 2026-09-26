import { formatYen } from '../city/economy';
import { dateOf } from '../sim/clock';
import { loadSave, serialize, type SaveData } from '../save/save';
import { SLOT_COUNT, deleteSlot, listSlots, readSlot, slotIds, writeSlot, type SlotMeta } from '../save/slots';

export interface SaveDeps {
  /** 今の街（ゲーム中でなければ null） */
  snapshot: () => SaveData | null;
  meta: () => Omit<SlotMeta, 'id' | 'thumb'>;
  thumb: () => string;
  load: (data: SaveData, label: string) => void;
  toast: (m: string) => void;
  onClose?: () => void;
}

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { cls?: string } = {}, ...kids: (Node | string)[]) => {
  const el = document.createElement(tag);
  const { cls, ...rest } = props;
  if (cls) el.className = cls;
  Object.assign(el, rest);
  el.append(...kids);
  return el;
};

const when = (m: Pick<SlotMeta, 'day'>) => { const d = dateOf(m.day); return `復興暦 ${d.year}年 ${d.month}月`; };
const savedAt = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** セーブデータの画面（保存・読み込み・削除・書き出し） */
export class SaveScreen {
  private el = document.getElementById('saves')!;
  private grid = document.getElementById('savesGrid')!;
  mode: 'save' | 'load' = 'load';
  private armed = '';

  constructor(private deps: SaveDeps) {
    document.getElementById('savesClose')!.onclick = () => this.close();
    document.querySelectorAll<HTMLButtonElement>('#saves .tabs button').forEach((b) => {
      b.onclick = () => { this.mode = b.dataset.mode as 'save' | 'load'; void this.render(); };
    });
    this.el.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.close(); });
  }

  get isOpen(): boolean { return !this.el.hidden; }

  async open(mode: 'save' | 'load'): Promise<void> {
    this.mode = this.deps.snapshot() ? mode : 'load';
    this.armed = '';
    this.el.hidden = false;
    await this.render();
    (this.el.querySelector('button') as HTMLButtonElement | null)?.focus();
  }

  close(): void {
    this.el.hidden = true;
    this.deps.onClose?.();
  }

  private async render(): Promise<void> {
    const canSave = !!this.deps.snapshot();
    document.querySelectorAll<HTMLButtonElement>('#saves .tabs button').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.mode === this.mode));
      b.disabled = b.dataset.mode === 'save' && !canSave;
    });
    const metas = new Map((await listSlots()).map((m) => [m.id, m]));
    const cards: HTMLElement[] = [];
    // 自動保存（読み込みだけ）
    const auto = loadSave('auto');
    if (this.mode === 'load' && auto) {
      let thumb = '';
      try { thumb = localStorage.getItem('mizuho-city/autothumb') ?? ''; } catch { /* なし */ }
      const population = auto.city.buildings.reduce((a, b) => a + (b.residents ?? 0), 0);
      cards.push(this.card({ id: 'auto', cityName: auto.cityName, savedAt: auto.savedAt, day: auto.sim.day, population, money: auto.city.economy?.money ?? 0, scenario: '', thumb }, true));
    }
    for (const id of slotIds()) cards.push(this.card(metas.get(id) ?? null, false, id));
    this.grid.replaceChildren(...cards);
    document.getElementById('savesNote')!.textContent = this.mode === 'save'
      ? `保存したいスロットを選んでください（${SLOT_COUNT} つまで）。上書きするときは 2 回押します。`
      : '読み込むデータを選んでください。自動保存は毎月 1 日とページを閉じるときに作られます。';
  }

  private card(m: SlotMeta | null, auto: boolean, id = m?.id ?? ''): HTMLElement {
    const thumb = h('div', { cls: 'slot-thumb' });
    if (m?.thumb) thumb.append(h('img', { src: m.thumb, alt: '' }));
    else thumb.append(h('span', {}, m ? (auto ? '自動保存' : '画像なし') : '空き'));
    const label = auto ? '自動保存' : `スロット ${id.replace('slot', '')}`;
    const info = m
      ? h('div', { cls: 'slot-info' },
        h('b', {}, m.cityName),
        h('span', {}, `${when(m)}${m.population >= 0 ? `・人口 ${m.population.toLocaleString()} 人` : ''}`),
        h('span', {}, `資金 ${formatYen(m.money)}${m.scenario ? `・${m.scenario}` : ''}`),
        h('small', {}, savedAt(m.savedAt)))
      : h('div', { cls: 'slot-info empty' }, h('b', {}, '空きスロット'));
    const actions = h('div', { cls: 'row' });
    const arm = (key: string, label: string, run: () => void, danger = false) => {
      const armedNow = this.armed === key;
      const b = h('button', { cls: `${danger ? 'warn' : ''}${armedNow ? ' armed' : ''}`, onclick: () => { if (this.armed === key) { this.armed = ''; run(); } else { this.armed = key; void this.render(); } } }, armedNow ? 'もう一度押す' : label);
      return b;
    };
    if (this.mode === 'save' && !auto) {
      const doSave = async () => {
        const snap = this.deps.snapshot();
        if (!snap) return;
        const r = await writeSlot({ ...this.deps.meta(), id, thumb: this.deps.thumb() }, snap);
        this.deps.toast(r ?? `${label}に保存しました`);
        await this.render();
      };
      actions.append(m ? arm(`save:${id}`, '上書き保存', () => void doSave()) : h('button', { cls: 'primary', onclick: () => void doSave() }, 'ここに保存'));
    }
    if (this.mode === 'load' && m) {
      actions.append(h('button', {
        cls: 'primary',
        onclick: async () => {
          const data = auto ? loadSave('auto') : await readSlot(id);
          if (!data) { this.deps.toast('このデータは読み込めませんでした'); return; }
          this.el.hidden = true;
          this.deps.load(data, label);
        },
      }, '読み込む'));
    }
    if (m && !auto) {
      actions.append(h('button', {
        onclick: async () => {
          const data = await readSlot(id);
          if (!data) return;
          const a = document.createElement('a');
          a.href = URL.createObjectURL(new Blob([serialize(data)], { type: 'application/json' }));
          a.download = `${data.cityName}-${dateOf(data.sim.day).year}年目.json`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        },
      }, '書き出す'));
      actions.append(arm(`del:${id}`, '削除', async () => { await deleteSlot(id); this.deps.toast(`${label}を削除しました`); await this.render(); }, true));
    }
    return h('div', { cls: `slot${m ? '' : ' free'}` }, h('div', { cls: 'slot-label' }, label), thumb, info, actions);
  }
}
