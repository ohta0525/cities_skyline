import { deserialize, loadSave, serialize, type SaveData } from './save';

/** セーブスロットの見出し（一覧に出す情報） */
export interface SlotMeta {
  id: string;
  cityName: string;
  savedAt: string;
  day: number;
  population: number;
  money: number;
  scenario: string;
  /** 画面の縮小画像（JPEG の data URL） */
  thumb: string;
}

export const SLOT_COUNT = 8;
export const slotIds = () => Array.from({ length: SLOT_COUNT }, (_, i) => `slot${i + 1}`);

const DB = 'mizuho-city';
const META = 'meta';
const DATA = 'data';
const LS_PREFIX = 'mizuho-city/slot/';

let dbp: Promise<IDBDatabase | null> | null = null;

/** IndexedDB を開く。使えないブラウザでは null（localStorage に保存する） */
function db(): Promise<IDBDatabase | null> {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') { resolve(null); return; }
      // ファイルを直接開いたときなど、ブラウザによっては応答がないまま止まるので、待ちすぎない
      const timer = setTimeout(() => resolve(null), 1500);
      const done = (v: IDBDatabase | null) => { clearTimeout(timer); resolve(v); };
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(META)) d.createObjectStore(META, { keyPath: 'id' });
        if (!d.objectStoreNames.contains(DATA)) d.createObjectStore(DATA);
      };
      req.onsuccess = () => done(req.result);
      req.onerror = () => done(null);
      req.onblocked = () => done(null);
    } catch {
      resolve(null);
    }
  });
  return dbp;
}

function tx<T>(d: IDBDatabase, stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const t = d.transaction(stores, mode);
    let result: T | undefined;
    const req = fn(t);
    if (req) req.onsuccess = () => { result = req.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function listSlots(): Promise<SlotMeta[]> {
  const d = await db();
  if (!d) {
    const out: SlotMeta[] = [];
    for (const id of slotIds()) {
      try {
        const raw = localStorage.getItem(`${LS_PREFIX}${id}/meta`);
        if (raw) out.push(JSON.parse(raw) as SlotMeta);
      } catch { /* 読めないスロットは空とみなす */ }
    }
    return out;
  }
  return (await tx<SlotMeta[]>(d, [META], 'readonly', (t) => t.objectStore(META).getAll())) ?? [];
}

/** スロットに保存する。できなければ理由を返す */
export async function writeSlot(meta: SlotMeta, data: SaveData): Promise<string | null> {
  const text = serialize(data);
  const d = await db();
  try {
    if (!d) {
      localStorage.setItem(`${LS_PREFIX}${meta.id}/data`, text);
      localStorage.setItem(`${LS_PREFIX}${meta.id}/meta`, JSON.stringify(meta));
      return null;
    }
    await tx(d, [META, DATA], 'readwrite', (t) => {
      t.objectStore(DATA).put(text, meta.id);
      t.objectStore(META).put(meta);
    });
    return null;
  } catch {
    return 'ブラウザの保存領域がいっぱいか、使えない状態です。ほかのスロットを削除するか、ファイルに書き出してください';
  }
}

export async function readSlot(id: string): Promise<SaveData | null> {
  const d = await db();
  try {
    const text = d ? await tx<string>(d, [DATA], 'readonly', (t) => t.objectStore(DATA).get(id)) : localStorage.getItem(`${LS_PREFIX}${id}/data`);
    return text ? deserialize(text) : null;
  } catch {
    return null;
  }
}

export async function deleteSlot(id: string): Promise<void> {
  const d = await db();
  try {
    if (!d) {
      localStorage.removeItem(`${LS_PREFIX}${id}/data`);
      localStorage.removeItem(`${LS_PREFIX}${id}/meta`);
      return;
    }
    await tx(d, [META, DATA], 'readwrite', (t) => {
      t.objectStore(DATA).delete(id);
      t.objectStore(META).delete(id);
    });
  } catch { /* 消せなくても遊べる */ }
}

/** P7 までの「保存」（1 つだけ）を、空いているスロットに移す */
export async function migrateOldSave(metaOf: (s: SaveData) => Omit<SlotMeta, 'id' | 'thumb'>): Promise<void> {
  try {
    const old = loadSave('manual');
    if (!old) return;
    const used = new Set((await listSlots()).map((m) => m.id));
    const free = slotIds().find((id) => !used.has(id));
    if (!free) return;
    if (await writeSlot({ ...metaOf(old), id: free, thumb: '' }, old)) return;
    localStorage.removeItem('mizuho-city/save');
  } catch { /* 移せなくても遊べる */ }
}
