import * as THREE from 'three';
import type { City } from '../city/city';
import { SEAWALL_HEIGHTS, coastalDepth, riverFloodDepth, riverSection } from '../city/water';
import { HALF, MAP_SIZE, heightAt } from '../world/terrain';

/** 堤防と防潮堤 */
export function buildDefenses(city: City, mat: THREE.Material): THREE.Mesh {
  const pos: number[] = [], col: number[] = [], nrm: number[] = [];
  const c = new THREE.Color();
  const quad = (a: number[], b: number[], cc: number[], d: number[], color: string) => {
    c.set(color);
    const n = new THREE.Vector3().subVectors(new THREE.Vector3(...b), new THREE.Vector3(...a)).cross(new THREE.Vector3().subVectors(new THREE.Vector3(...cc), new THREE.Vector3(...a))).normalize();
    for (const p of [a, b, cc, a, cc, d]) { pos.push(...p); nrm.push(n.x, n.y, n.z); col.push(c.r, c.g, c.b); }
  };
  const t = city.terrain;
  // 堤防：川の両岸の土手（上は草、上面は道）
  for (let k = 1; k < t.river.length; k++) {
    const p = t.river[k], q = t.river[k - 1];
    if (p.level <= 0.01) continue;
    const level = city.defenses.levees[riverSection(p.z)] ?? 0;
    if (!level) continue;
    const h = p.level + 2 + level * 2;
    for (const side of [-1, 1]) {
      const inner = p.width / 2 + 3, outer = inner + 4 + level * 3;
      const P = (pt: typeof p, off: number, y: number) => [pt.x + side * off, y, pt.z];
      const gq = Math.max(heightAt(t, q.x + side * outer, q.z), 0), gp = Math.max(heightAt(t, p.x + side * outer, p.z), 0);
      quad(P(q, inner, q.level + 0.5), P(p, inner, p.level + 0.5), P(p, inner + 2, h), P(q, inner + 2, h), '#7fae5a');
      quad(P(q, inner + 2, h), P(p, inner + 2, h), P(p, outer - 2, h), P(q, outer - 2, h), '#c9b690');
      quad(P(q, outer - 2, h), P(p, outer - 2, h), P(p, outer, gp), P(q, outer, gq), '#7fae5a');
    }
  }
  // 防潮堤：海岸線に沿ったコンクリートの壁
  const n = t.coastZ.length;
  for (let i = 1; i < n; i++) {
    const x0 = ((i - 1) / (n - 1)) * MAP_SIZE - HALF, x1 = (i / (n - 1)) * MAP_SIZE - HALF;
    const lvl = city.defenses.seawalls[Math.max(0, Math.min(city.defenses.seawalls.length - 1, Math.floor(((x0 + x1) / 2 + HALF) / 160)))] ?? 0;
    if (!lvl) continue;
    const z0 = t.coastZ[i - 1] - 6, z1 = t.coastZ[i] - 6;
    const top = SEAWALL_HEIGHTS[lvl] + 1;
    quad([x0, -1, z0 + 1.5], [x1, -1, z1 + 1.5], [x1, top, z1 + 1.5], [x0, top, z0 + 1.5], '#b9b6ae');
    quad([x0, top, z0 + 1.5], [x1, top, z1 + 1.5], [x1, top, z1 - 1.5], [x0, top, z0 - 1.5], '#d6d3cb');
    quad([x0, top, z0 - 1.5], [x1, top, z1 - 1.5], [x1, 0, z1 - 1.5], [x0, 0, z0 - 1.5], '#a9a59c');
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const m = new THREE.Mesh(g, mat);
  m.castShadow = true;
  m.receiveShadow = true;
  (m.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
  return m;
}

/** 浸水している範囲の濁った水面。水が引くにつれて下がる */
export function buildFloodWater(city: City, fade: number): THREE.Mesh | null {
  const f = city.flood;
  if (!f) return null;
  const STEP = 8;
  const n = MAP_SIZE / STEP + 1;
  const t = city.terrain;
  let retention = 0, discharge = 0;
  for (const x of city.facilities.values()) { if (x.kind === 'retention') retention++; if (x.kind === 'discharge') discharge++; }
  const depth = new Float32Array(n * n);
  const ground = new Float32Array(n * n);
  let any = false;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = i * STEP - HALF, z = j * STEP - HALF;
      const h = heightAt(t, x, z);
      ground[j * n + i] = h;
      if (h < 0) continue;
      const d = f.kind === 'coast' ? coastalDepth(t, city.defenses, x, z, f.wave) : Math.max(riverFloodDepth(t, city.defenses, x, z, f.rise, retention, discharge), coastalDepth(t, city.defenses, x, z, f.wave));
      depth[j * n + i] = d * fade;
      if (d * fade > 0.05) any = true;
    }
  }
  if (!any) return null;
  const pos: number[] = [];
  const idx: number[] = [];
  const map = new Int32Array(n * n).fill(-1);
  const vert = (i: number, j: number) => {
    const k = j * n + i;
    if (map[k] < 0) { map[k] = pos.length / 3; pos.push(i * STEP - HALF, ground[k] + depth[k] + 0.1, j * STEP - HALF); }
    return map[k];
  };
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const ks = [j * n + i, j * n + i + 1, (j + 1) * n + i, (j + 1) * n + i + 1];
      if (ks.every((k) => depth[k] <= 0.05)) continue;
      const a = vert(i, j), b = vert(i + 1, j), c = vert(i, j + 1), d = vert(i + 1, j + 1);
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: '#8b7a55', transparent: true, opacity: 0.82, roughness: 0.25, depthWrite: false }));
  m.renderOrder = 3;
  return m;
}

/** 雨 */
export class Rain {
  readonly lines: THREE.LineSegments;
  private count = 3500;
  private area = 900;
  constructor() {
    const pos = new Float32Array(this.count * 6);
    for (let i = 0; i < this.count; i++) {
      const x = (Math.random() - 0.5) * this.area, y = Math.random() * 400, z = (Math.random() - 0.5) * this.area;
      pos.set([x, y, z, x + 1.5, y + 9, z + 0.8], i * 6);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: '#cfd8e0', transparent: true, opacity: 0.45 }));
    this.lines.frustumCulled = false;
    this.lines.visible = false;
  }
  update(dt: number, center: THREE.Vector3, strength: number): void {
    this.lines.visible = strength > 0.02;
    if (!this.lines.visible) return;
    (this.lines.material as THREE.LineBasicMaterial).opacity = 0.2 + strength * 0.4;
    this.lines.position.set(center.x, center.y, center.z);
    const p = this.lines.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = p.array as Float32Array;
    const fall = dt * 260;
    for (let i = 0; i < this.count; i++) {
      const k = i * 6;
      arr[k + 1] -= fall; arr[k + 4] -= fall;
      if (arr[k + 1] < -20) { arr[k + 1] += 420; arr[k + 4] += 420; }
    }
    p.needsUpdate = true;
  }
}
