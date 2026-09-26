import type { City } from '../city/city';
import type { CameraState } from '../save/save';

/** チュートリアルが見る、画面と街の様子 */
export interface TutorialContext {
  city: City;
  camera: CameraState;
  panel: string | null;
  infoMode: string;
  speed: number;
  tool: string;
}

export interface TutorialStep {
  title: string;
  text: string;
  hint?: string;
  /** 光らせる場所（CSS セレクター） */
  target?: string;
  /** 終わったか。なければ「次へ」で進む */
  done?: (c: TutorialContext, start: TutorialContext) => boolean;
}

const cellsOf = (c: City, zones: number[]) => {
  let n = 0;
  for (const cl of c.cells.values()) if (zones.includes(cl.zone)) n++;
  return n;
};

export const STEPS: TutorialStep[] = [
  {
    title: 'ようこそ、市長！',
    text: 'あなたは瑞穂連邦に新しくできた小さな市の、初代の市長です。まずは道路を引き、住宅地をつくって、人が住む街にしていきましょう。',
    hint: 'このチュートリアルは 10 のステップです。いつでも「スキップ」で飛ばせます。',
  },
  {
    title: 'カメラを動かす',
    text: '地図を見回してみましょう。W A S D（または矢印）で移動、右ドラッグで回転、ホイールでズームです。',
    hint: '少し動かすと次に進みます。Home キーで最初の位置に戻れます。',
    done: (c, s) => Math.hypot(c.camera.x - s.camera.x, c.camera.z - s.camera.z) > 60 || Math.abs(c.camera.yaw - s.camera.yaw) > 0.3 || Math.abs(c.camera.distance - s.camera.distance) > 300,
  },
  {
    title: '道路を引く',
    text: '下の「道路」を選び、地面をクリックして始点、もう一度クリックして終点を置きます。終点から続けて引けます。3 本引いてみましょう。',
    hint: '川をまたぐと橋になります。Esc で引くのをやめられます。平らな場所がおすすめです。',
    target: '[data-tool="road"]',
    done: (c) => c.city.net.segments.size >= 3,
  },
  {
    title: '住宅地をつくる',
    text: '「区画」を選び、「低層住宅」（緑）で道路沿いのマスをドラッグして塗ります。20 マスほど塗りましょう。',
    hint: '道路の両側に、区画のマスが自動でできています。',
    target: '[data-tool="zone"]',
    done: (c) => cellsOf(c.city, [1, 2]) >= 20,
  },
  {
    title: '時間を進める',
    text: '上の ▶ で時間が進みます。需要（住・商・工のバー）に応じて家が建っていきます。3 棟建つまで待ちましょう。',
    hint: '▶▶ や ▶▶▶ で速くなります。Space で一時停止です。',
    target: '.speed',
    done: (c) => c.city.buildings.size >= 3,
  },
  {
    title: '電気を通す',
    text: '「施設」の「電気」から、太陽光発電所か火力発電所を道路沿いに建てましょう。電気は道路に沿って届きます。',
    hint: '電気や水道がないと、家は建ちにくくなります（建物の上の「電」のしるし）。',
    target: '[data-tool="facility"]',
    done: (c) => c.city.hasFacility('solar') || c.city.hasFacility('thermal') || c.city.hasFacility('nuclear'),
  },
  {
    title: '水道を引く',
    text: '「施設」の「上下水道」から、浄水場を川か海の近くに建てましょう。',
    hint: '浄水場は水辺から 80 m 以内でないと建てられません。',
    target: '[data-tool="facility"]',
    done: (c) => c.city.hasFacility('waterworks'),
  },
  {
    title: '働く場所をつくる',
    text: '住む人には仕事が必要です。「区画」で商業系（ピンク・赤）と工業系（紫・青）を、それぞれ 8 マス以上塗りましょう。',
    hint: '工業は住宅から少し離すと、公害の不満が減ります。',
    target: '[data-tool="zone"]',
    done: (c) => cellsOf(c.city, [3, 4]) >= 8 && cellsOf(c.city, [5, 6]) >= 8,
  },
  {
    title: '市役所を見る',
    text: '画面左の市役所から「財政」を開いてみましょう。お金の出入りと税率、市債（借金）がわかります。',
    hint: '「住民」「政治」「地域」なども見ておくと、街の悩みがわかります。',
    target: '.rail button[data-panel="finance"]',
    done: (c) => c.panel === 'finance',
  },
  {
    title: '災害に備える',
    text: 'この国は災害が多い国です。「情報」を開き、ハザードマップの「浸水」を選んで、水につかりやすい場所を確かめましょう。',
    hint: '浸水しやすい低い土地に家を建てるなら、堤防（下の「防災」）や避難所が必要です。',
    target: '.rail button[data-panel="info"]',
    done: (c) => c.infoMode === 'flood',
  },
  {
    title: 'チュートリアル完了！',
    text: 'おつかれさまでした。ここからは自由に街を育ててください。隣町と道路でつなぐと通勤と交易が始まり、4 年ごとに市長選挙があります。',
    hint: '困ったら右上の「?」で操作方法を見られます。',
  },
];

/** 進み具合を持ち、毎フレーム判定する */
export class Tutorial {
  step = 0;
  active = false;
  private start: TutorialContext | null = null;
  private highlighted: Element[] = [];
  private el = document.getElementById('tutorial')!;
  private shown = -1;

  constructor(private get: () => TutorialContext, private onFinish: (completed: boolean) => void) {
    document.getElementById('tutNext')!.onclick = () => this.next();
    document.getElementById('tutSkip')!.onclick = () => this.next();
    document.getElementById('tutQuit')!.onclick = () => this.stop(false);
  }

  begin(): void {
    this.active = true;
    this.step = 0;
    this.shown = -1;
    this.start = this.get();
    this.render();
  }

  stop(completed: boolean): void {
    this.active = false;
    this.el.hidden = true;
    this.clearHighlight();
    this.onFinish(completed);
  }

  private next(): void {
    if (this.step >= STEPS.length - 1) { this.stop(true); return; }
    this.step++;
    this.start = this.get();
    this.render();
  }

  /** 毎フレーム呼ぶ */
  update(): void {
    if (!this.active) return;
    const s = STEPS[this.step];
    if (s.done && this.start && s.done(this.get(), this.start)) this.next();
    else if (this.shown !== this.step) this.render();
  }

  private clearHighlight(): void {
    for (const e of this.highlighted) e.classList.remove('tut-target');
    this.highlighted = [];
  }

  private render(): void {
    const s = STEPS[this.step];
    this.shown = this.step;
    this.el.hidden = false;
    document.getElementById('tutStep')!.textContent = `${this.step + 1} ／ ${STEPS.length}`;
    document.getElementById('tutTitle')!.textContent = s.title;
    document.getElementById('tutText')!.textContent = s.text;
    document.getElementById('tutHint')!.textContent = s.hint ?? '';
    const last = this.step === STEPS.length - 1;
    const next = document.getElementById('tutNext')!;
    next.hidden = !!s.done;
    next.textContent = last ? '終わる' : this.step === 0 ? 'はじめる' : '次へ';
    document.getElementById('tutSkip')!.hidden = !s.done;
    (document.getElementById('tutBar') as HTMLElement).style.width = `${((this.step + 1) / STEPS.length) * 100}%`;
    this.clearHighlight();
    if (s.target) {
      document.querySelectorAll(s.target).forEach((e) => { e.classList.add('tut-target'); this.highlighted.push(e); });
    }
  }
}
