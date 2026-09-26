import { HALF, MAP_SIZE } from '../world/terrain';
import type { P2 } from './geometry';

export const DISTRICT_CELL = 32;
export const DN = MAP_SIZE / DISTRICT_CELL;

export interface District {
  id: number;
  name: string;
  color: string;
}

const COLORS = ['#e9a23b', '#6fb1d9', '#d56a8a', '#8cc063', '#a78bd4', '#e3c748', '#4fb3a3', '#d9774b', '#7c95e0', '#c1a07a'];
const HEAD = ['桜', '松', '本', '新', '東', '西', '南', '北', '中', '若葉', '緑', '旭', '栄', '泉', '宮', '川', '浜', '港', '竹', '梅', '青葉', '朝日', '富士見', '日の出', '柳', '稲', '藤', '菊', '白鳥', '千代'];
const TAIL = ['町', '台', 'ヶ丘', '原', '田', '野', '島', '沢', '坂', '通', '見', '里', '崎', '浦'];

export class Districts {
  grid = new Uint8Array(DN * DN);
  list: District[] = [];

  /** まだ使っていない地名を作る */
  newDistrict(rand: () => number): District {
    const used = new Set(this.list.map((d) => d.name));
    let name = '';
    for (let tries = 0; tries < 50; tries++) {
      name = HEAD[Math.floor(rand() * HEAD.length)] + TAIL[Math.floor(rand() * TAIL.length)];
      if (!used.has(name)) break;
    }
    const id = this.list.reduce((m, d) => Math.max(m, d.id), 0) + 1;
    if (id > 255) throw new Error('地区は 255 までです');
    const d = { id, name, color: COLORS[(id - 1) % COLORS.length] };
    this.list.push(d);
    return d;
  }

  get(id: number): District | undefined {
    return this.list.find((d) => d.id === id);
  }

  remove(id: number): void {
    this.list = this.list.filter((d) => d.id !== id);
    for (let k = 0; k < this.grid.length; k++) if (this.grid[k] === id) this.grid[k] = 0;
  }

  /** 円の中を塗る。id = 0 で消す。変わったマスの数を返す */
  paint(center: P2, radius: number, id: number): number {
    let changed = 0;
    const i0 = Math.max(0, Math.floor((center.x - radius + HALF) / DISTRICT_CELL));
    const i1 = Math.min(DN - 1, Math.floor((center.x + radius + HALF) / DISTRICT_CELL));
    const j0 = Math.max(0, Math.floor((center.z - radius + HALF) / DISTRICT_CELL));
    const j1 = Math.min(DN - 1, Math.floor((center.z + radius + HALF) / DISTRICT_CELL));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const cx = (i + 0.5) * DISTRICT_CELL - HALF, cz = (j + 0.5) * DISTRICT_CELL - HALF;
        if (Math.hypot(cx - center.x, cz - center.z) > radius) continue;
        if (this.grid[j * DN + i] !== id) { this.grid[j * DN + i] = id; changed++; }
      }
    }
    return changed;
  }

  at(p: P2): District | undefined {
    const i = Math.floor((p.x + HALF) / DISTRICT_CELL), j = Math.floor((p.z + HALF) / DISTRICT_CELL);
    if (i < 0 || j < 0 || i >= DN || j >= DN) return undefined;
    return this.get(this.grid[j * DN + i]);
  }

  /** 地区の重心（名前ラベルの位置） */
  centroids(): Map<number, P2> {
    const sum = new Map<number, { x: number; z: number; n: number }>();
    for (let j = 0; j < DN; j++) {
      for (let i = 0; i < DN; i++) {
        const id = this.grid[j * DN + i];
        if (!id) continue;
        const s = sum.get(id) ?? { x: 0, z: 0, n: 0 };
        s.x += (i + 0.5) * DISTRICT_CELL - HALF; s.z += (j + 0.5) * DISTRICT_CELL - HALF; s.n++;
        sum.set(id, s);
      }
    }
    return new Map([...sum].map(([id, s]) => [id, { x: s.x / s.n, z: s.z / s.n }]));
  }

  /** 保存用：連長圧縮した文字列 */
  encode(): string {
    const out: string[] = [];
    let run = 1;
    for (let k = 1; k <= this.grid.length; k++) {
      if (k < this.grid.length && this.grid[k] === this.grid[k - 1]) { run++; continue; }
      out.push(`${this.grid[k - 1]}x${run}`);
      run = 1;
    }
    return out.join(',');
  }

  decode(s: string): void {
    this.grid.fill(0);
    let k = 0;
    for (const part of s.split(',')) {
      const [v, n] = part.split('x').map(Number);
      for (let r = 0; r < n && k < this.grid.length; r++) this.grid[k++] = v;
    }
  }
}
