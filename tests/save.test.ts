import { describe, expect, it } from 'vitest';
import { SAVE_VERSION, deserialize, emptyCity, serialize, type SaveData } from '../src/save/save';

const sample: SaveData = {
  version: SAVE_VERSION,
  savedAt: '2026-09-26T00:00:00.000Z',
  cityName: '新市',
  terrain: { seed: 42, preset: 'river-coast' },
  sim: { day: 123.5 },
  camera: { x: 1, z: 2, yaw: 0.3, pitch: 0.6, distance: 900 },
  city: emptyCity(),
};

describe('セーブデータ', () => {
  it('書き出して読み戻すと同じになる', () => {
    expect(deserialize(serialize(sample))).toEqual(sample);
  });
  it('P0（v1）のセーブデータは空の街として読める', () => {
    const { city: _c, ...v1 } = sample;
    const d = deserialize(JSON.stringify({ ...v1, version: 1 }));
    expect(d?.city.roads.segments).toEqual([]);
    expect(d?.sim.day).toBe(123.5);
  });
  it('壊れたデータや違う形のデータは読まない', () => {
    expect(deserialize(JSON.stringify({ ...sample, city: { roads: 1 } }))).toBeNull();
    expect(deserialize('not json')).toBeNull();
    expect(deserialize('{}')).toBeNull();
    expect(deserialize(JSON.stringify({ ...sample, version: 99 }))).toBeNull();
    expect(deserialize(JSON.stringify({ ...sample, sim: { day: -1 } }))).toBeNull();
    expect(deserialize(JSON.stringify({ ...sample, camera: { ...sample.camera, x: 'a' } }))).toBeNull();
  });
});
