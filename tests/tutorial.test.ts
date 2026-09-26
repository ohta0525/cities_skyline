import { describe, expect, it } from 'vitest';
import { City } from '../src/city/city';
import { STEPS, type TutorialContext } from '../src/ui/tutorial';
import { generateTerrain, HALF, MAP_SIZE } from '../src/world/terrain';

const cam = { x: 0, z: 60, yaw: 0.35, pitch: 0.6, distance: 2700 };
const ctx = (city: City, extra: Partial<TutorialContext> = {}): TutorialContext => ({ city, camera: cam, panel: null, infoMode: 'none', speed: 0, tool: 'none', ...extra });
const step = (title: string) => STEPS.find((s) => s.title === title)!;

describe('チュートリアルの判定', () => {
  it('最初と最後は「次へ」で進むステップ', () => {
    expect(STEPS[0].done).toBeUndefined();
    expect(STEPS.at(-1)!.done).toBeUndefined();
    expect(STEPS.length).toBe(11);
  });

  it('カメラを動かすと進む', () => {
    const city = new City(generateTerrain(1), 1);
    const s = step('カメラを動かす');
    expect(s.done!(ctx(city), ctx(city))).toBe(false);
    expect(s.done!(ctx(city, { camera: { ...cam, x: 200 } }), ctx(city))).toBe(true);
  });

  it('道路・住宅地・建物・発電所・水道・仕事の順に、街の状態で進む', () => {
    const t = generateTerrain(12345);
    const city = new City(t, 7);
    city.disastersEnabled = false;
    const c = ctx(city);
    expect(step('道路を引く').done!(c, c)).toBe(false);
    const k = Math.round(((60 + HALF) / MAP_SIZE) * 512);
    const rp = t.river[k];
    const x = rp.x + (rp.x > 0 ? -1 : 1) * (rp.width / 2 + 60);
    for (const [a, b] of [[-40, 60], [60, 160], [160, 260]]) {
      const plan = city.planRoad(city.snap({ x, z: a }), city.snap({ x, z: b }), null, 'local');
      expect(plan.ok, plan.reason).toBe(true);
      city.buildRoad(plan);
    }
    expect(step('道路を引く').done!(c, c)).toBe(true);
    expect(step('住宅地をつくる').done!(c, c)).toBe(false);
    city.paintZone({ x, z: 60 }, 90, 1);
    expect(step('住宅地をつくる').done!(c, c)).toBe(true);
    const place = (kind: 'solar' | 'waterworks') => {
      for (const z of [240, 200, 160, 120, 80, 40, 0, -30]) {
        for (const dx of [12, -12]) {
          const p = city.planFacility({ x: x + dx, z }, kind);
          if (p.ok) { city.placeFacility(p); return true; }
        }
      }
      return false;
    };
    expect(place('solar')).toBe(true);
    expect(step('電気を通す').done!(c, c)).toBe(true);
    expect(place('waterworks')).toBe(true);
    expect(step('水道を引く').done!(c, c)).toBe(true);
    city.advanceTo(60);
    expect(step('時間を進める').done!(c, c)).toBe(true);
    expect(step('働く場所をつくる').done!(c, c)).toBe(false);
    city.paintZone({ x, z: 200 }, 40, 3);
    city.paintZone({ x, z: 130 }, 40, 5);
    expect(step('働く場所をつくる').done!(c, c)).toBe(true);
  });

  it('財政パネルと浸水のハザードマップで進む', () => {
    const city = new City(generateTerrain(1), 1);
    expect(step('市役所を見る').done!(ctx(city, { panel: 'finance' }), ctx(city))).toBe(true);
    expect(step('災害に備える').done!(ctx(city, { infoMode: 'flood' }), ctx(city))).toBe(true);
  });
});
