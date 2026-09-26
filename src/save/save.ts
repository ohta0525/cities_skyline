import type { CityData } from '../city/city';
import type { SimState } from '../sim/protocol';
import type { TerrainPreset } from '../world/terrain';

export const SAVE_VERSION = 2;

export interface CameraState {
  x: number;
  z: number;
  yaw: number;
  pitch: number;
  distance: number;
}

export interface SaveData {
  version: typeof SAVE_VERSION;
  savedAt: string;
  cityName: string;
  terrain: { seed: number; preset: TerrainPreset };
  sim: SimState;
  camera: CameraState;
  city: CityData;
}

export const emptyCity = (): CityData => ({
  roads: { nextId: 1, nodes: [], segments: [] },
  zones: [],
  buildings: [],
  nextBuildingId: 1,
  districts: { list: [], grid: '' },
});

function isCityData(c: any): c is CityData {
  return !!c && typeof c === 'object'
    && c.roads && Array.isArray(c.roads.nodes) && Array.isArray(c.roads.segments) && isNum(c.roads.nextId)
    && Array.isArray(c.zones) && Array.isArray(c.buildings) && isNum(c.nextBuildingId)
    && c.districts && Array.isArray(c.districts.list) && typeof c.districts.grid === 'string';
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function serialize(data: SaveData): string {
  return JSON.stringify(data);
}

/** 文字列をセーブデータとして読む。形が合わなければ null */
export function deserialize(text: string): SaveData | null {
  let d: unknown;
  try {
    d = JSON.parse(text);
  } catch {
    return null;
  }
  if (!d || typeof d !== 'object') return null;
  const o = d as Record<string, any>;
  // v1（P0）には街のデータがないので、空の街として読む
  if (o.version === 1) o.city = emptyCity();
  else if (o.version !== SAVE_VERSION || !isCityData(o.city)) return null;
  if (typeof o.cityName !== 'string') return null;
  if (!o.terrain || !isNum(o.terrain.seed) || o.terrain.preset !== 'river-coast') return null;
  if (!o.sim || !isNum(o.sim.day) || o.sim.day < 0) return null;
  const c = o.camera;
  if (!c || ![c.x, c.z, c.yaw, c.pitch, c.distance].every(isNum)) return null;
  return {
    version: SAVE_VERSION,
    savedAt: typeof o.savedAt === 'string' ? o.savedAt : '',
    cityName: o.cityName.slice(0, 40),
    terrain: { seed: o.terrain.seed >>> 0, preset: 'river-coast' },
    sim: { day: o.sim.day },
    camera: { x: c.x, z: c.z, yaw: c.yaw, pitch: c.pitch, distance: c.distance },
    city: o.city,
  };
}

const SLOT_KEY = 'mizuho-city/save';
const AUTO_KEY = 'mizuho-city/autosave';

export type Slot = 'manual' | 'auto';
const keyOf = (slot: Slot) => (slot === 'manual' ? SLOT_KEY : AUTO_KEY);

export function storeSave(slot: Slot, data: SaveData): boolean {
  try {
    localStorage.setItem(keyOf(slot), serialize(data));
    return true;
  } catch {
    return false;
  }
}

export function loadSave(slot: Slot): SaveData | null {
  try {
    const raw = localStorage.getItem(keyOf(slot));
    return raw ? deserialize(raw) : null;
  } catch {
    return null;
  }
}
