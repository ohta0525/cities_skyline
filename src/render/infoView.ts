import * as THREE from 'three';
import { floodDepth, landslide, liquefaction, shakingAmp } from '../city/hazard';
import { HALF, MAP_SIZE, heightAt, type Terrain } from '../world/terrain';

export type InfoMode =
  | 'none' | 'power' | 'water' | 'sewage' | 'garbage' | 'fire' | 'police' | 'health' | 'education' | 'happiness'
  | 'flood' | 'liquefaction' | 'landslide' | 'shaking'
  | 'traffic' | 'transit';

export const HAZARD_MODES: InfoMode[] = ['flood', 'liquefaction', 'landslide', 'shaking'];

/** ハザードマップ用の配色（日本のハザードマップに近い、黄 → 橙 → 赤 → 紫） */
const RAMP = ['#f7f5a8', '#ffd87a', '#f7a660', '#e8615a', '#b34a8f'].map((c) => new THREE.Color(c));
function ramp(v: number, out: THREE.Color): THREE.Color {
  const f = Math.min(0.999, Math.max(0, v)) * (RAMP.length - 1);
  const i = Math.floor(f);
  return out.copy(RAMP[i]).lerp(RAMP[i + 1], f - i);
}

const STEP = 8;

/** ハザードを地面に重ねて塗る */
export function buildHazardOverlay(t: Terrain, mode: InfoMode): THREE.Mesh {
  const n = MAP_SIZE / STEP + 1;
  const pos = new Float32Array(n * n * 3), col = new Float32Array(n * n * 4);
  const c = new THREE.Color();
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = i * STEP - HALF, z = j * STEP - HALF;
      const k = j * n + i;
      const h = heightAt(t, x, z);
      pos[k * 3] = x; pos[k * 3 + 1] = Math.max(0, h) + 1.5; pos[k * 3 + 2] = z;
      let v = 0;
      if (mode === 'flood') v = floodDepth(t, x, z) / 5;
      else if (mode === 'liquefaction') v = liquefaction(t, x, z);
      else if (mode === 'landslide') v = landslide(t, x, z);
      else if (mode === 'shaking') v = (shakingAmp(t, x, z) + 0.3) / 1.1;
      if (h < 0) v = 0;
      ramp(v, c);
      col[k * 4] = c.r; col[k * 4 + 1] = c.g; col[k * 4 + 2] = c.b;
      col[k * 4 + 3] = v < 0.06 ? 0 : 0.35 + v * 0.45;
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
    const a = j * n + i, b = a + 1, cc = a + n, d = cc + 1;
    idx.push(a, cc, b, b, cc, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 4));
  g.setIndex(idx);
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -12,
  }));
  m.renderOrder = 5;
  return m;
}

export const TINTS = {
  good: '#3f93dc',
  ok: '#5fbf6a',
  warn: '#e8b83e',
  bad: '#e0513e',
  none: '#9aa3a8',
} as const;
export type Tint = keyof typeof TINTS;
