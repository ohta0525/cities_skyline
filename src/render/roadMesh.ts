import * as THREE from 'three';
import { arcTable, leftNormal, pointAt, tAtLength, tangentAt, type Curve } from '../city/geometry';
import { ROAD_TYPES, halfWidth, sampleProfile, type RoadNetwork, type RoadSegment, type RoadType } from '../city/roads';
import { heightAt, type Terrain } from '../world/terrain';

const C = {
  asphalt: new THREE.Color('#54575b'),
  alley: new THREE.Color('#8d8c86'),
  sidewalk: new THREE.Color('#c9c4b8'),
  curb: new THREE.Color('#aaa59a'),
  median: new THREE.Color('#6f9b4b'),
  white: new THREE.Color('#f1efe7'),
  deck: new THREE.Color('#b9b4a9'),
  rail: new THREE.Color('#dcd8cf'),
  pillar: new THREE.Color('#a9a499'),
};

/** 頂点を積み上げていくための入れ物 */
class Geo {
  pos: number[] = [];
  col: number[] = [];
  nrm: number[] = [];
  tri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, color: THREE.Color): void {
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
    for (const v of [a, b, c]) {
      this.pos.push(v.x, v.y, v.z);
      this.nrm.push(n.x, n.y, n.z);
      this.col.push(color.r, color.g, color.b);
    }
  }
  /** a b c d の順に反時計回り（表から見て） */
  quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, color: THREE.Color): void {
    this.tri(a, b, c, color);
    this.tri(a, c, d, color);
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    return g;
  }
}

interface Frame { p: THREE.Vector3; n: THREE.Vector3; s: number; bridge: boolean }

/** 曲線に沿って一定間隔で断面の位置を取る */
function frames(cv: Curve, ys: number[], bridge: boolean[], from: number, to: number, step = 2.5): Frame[] {
  const table = arcTable(cv, 64);
  const len = table[table.length - 1];
  const s0 = Math.max(0, from), s1 = Math.min(len, len - to);
  const out: Frame[] = [];
  if (s1 - s0 < 0.5) return out;
  const n = Math.max(1, Math.ceil((s1 - s0) / step));
  for (let k = 0; k <= n; k++) {
    const s = s0 + ((s1 - s0) * k) / n;
    const t = tAtLength(table, s);
    const p = pointAt(cv, t), tan = tangentAt(cv, t), nr = leftNormal(tan);
    out.push({
      p: new THREE.Vector3(p.x, sampleProfile(ys, t), p.z),
      n: new THREE.Vector3(nr.x, 0, nr.z),
      s,
      bridge: bridge[Math.round(t * (bridge.length - 1))],
    });
  }
  return out;
}

const at = (f: Frame, off: number, dy: number) => f.p.clone().addScaledVector(f.n, off).setY(f.p.y + dy);

/** 断面の帯（左端 off0 から右端 off1。左が正） */
function band(g: Geo, fs: Frame[], off0: number, off1: number, dy: number, color: THREE.Color, dash?: [number, number], down = false): void {
  for (let k = 0; k < fs.length - 1; k++) {
    const a = fs[k], b = fs[k + 1];
    if (dash) {
      const mid = (a.s + b.s) / 2;
      if (mid % (dash[0] + dash[1]) > dash[0]) continue;
    }
    // off0 側 → 進行方向 → off1 側の順で、上から見て反時計回り（法線が上）
    const q = [at(a, off0, dy), at(b, off0, dy), at(b, off1, dy), at(a, off1, dy)] as const;
    if (down) g.quad(q[3], q[2], q[1], q[0], color); else g.quad(q[0], q[1], q[2], q[3], color);
  }
}

/** 縁石など、帯の端の垂直な面 */
function wall(g: Geo, fs: Frame[], off: number, y0: number, y1: number, color: THREE.Color, facingLeft: boolean): void {
  for (let k = 0; k < fs.length - 1; k++) {
    const a = fs[k], b = fs[k + 1];
    const a0 = at(a, off, y0), a1 = at(a, off, y1), b0 = at(b, off, y0), b1 = at(b, off, y1);
    if (facingLeft) g.quad(b0, a0, a1, b1, color); else g.quad(a0, b0, b1, a1, color);
  }
}

const LIFT = 0.12;

function segmentGeometry(g: Geo, net: RoadNetwork, s: RoadSegment, terrain: Terrain): void {
  const cv = net.curveOf(s);
  const type = ROAD_TYPES[s.type];
  const hw = type.width / 2;
  const trimA = nodeRadius(net, s.a), trimB = nodeRadius(net, s.b);
  const fs = frames(cv, s.ys, s.bridge, 0, 0);
  if (fs.length < 2) return;
  const inner = hw - type.sidewalk;

  if (s.type === 'alley') {
    band(g, fs, -hw, hw, LIFT, C.alley);
  } else {
    band(g, fs, -inner, inner, LIFT, C.asphalt);
    band(g, fs, inner, hw, LIFT + 0.15, C.sidewalk);
    band(g, fs, -hw, -inner, LIFT + 0.15, C.sidewalk);
    wall(g, fs, inner, LIFT, LIFT + 0.15, C.curb, false);
    wall(g, fs, -inner, LIFT, LIFT + 0.15, C.curb, true);
  }
  if (type.median) {
    const m = type.median / 2;
    band(g, fs, -m, m, LIFT + 0.2, C.median);
    wall(g, fs, m, LIFT, LIFT + 0.2, C.curb, true);
    wall(g, fs, -m, LIFT, LIFT + 0.2, C.curb, false);
  }

  // 路面標示は交差点の手前で止める
  const marks = frames(cv, s.ys, s.bridge, trimA + 3.5, trimB + 3.5);
  const mdy = LIFT + 0.02;
  if (marks.length >= 2) {
    if (s.type === 'alley') {
      band(g, marks, hw - 0.45, hw - 0.3, mdy, C.white);
      band(g, marks, -hw + 0.3, -hw + 0.45, mdy, C.white);
    } else if (s.type === 'local') {
      band(g, marks, -0.08, 0.08, mdy, C.white, [5, 5]);
      band(g, marks, inner - 0.4, inner - 0.25, mdy, C.white);
      band(g, marks, -inner + 0.25, -inner + 0.4, mdy, C.white);
    } else {
      const m = type.median / 2;
      const laneMid = (m + inner) / 2;
      for (const sgn of [1, -1]) {
        band(g, marks, sgn * laneMid - 0.08, sgn * laneMid + 0.08, mdy, C.white, [6, 6]);
        band(g, marks, sgn > 0 ? inner - 0.4 : -inner + 0.25, sgn > 0 ? inner - 0.25 : -inner + 0.4, mdy, C.white);
      }
    }
  }

  // 交差点の手前の横断歩道（3 本以上つながる交差点だけ）
  if (s.type !== 'alley') {
    for (const [nid, fromStart] of [[s.a, true], [s.b, false]] as const) {
      if (net.segmentsAt(nid).length < 3) continue;
      const r = nodeRadius(net, nid);
      const f = frames(cv, s.ys, s.bridge, fromStart ? r + 0.8 : 0, fromStart ? 0 : r + 0.8);
      const edge = fromStart ? f.slice(0, 2) : f.slice(-2).reverse();
      if (edge.length < 2) continue;
      const base = edge[0];
      const dir = new THREE.Vector3().subVectors(edge[1].p, base.p).setY(0).normalize();
      const lenStripe = 3;
      for (let o = -inner + 0.6; o < inner - 0.5; o += 0.9) {
        if (type.median && Math.abs(o) < type.median / 2 + 0.3) continue;
        const p0 = at(base, o, mdy), p1 = at(base, o + 0.45, mdy);
        const p2 = p1.clone().addScaledVector(dir, lenStripe), p3 = p0.clone().addScaledVector(dir, lenStripe);
        const up = new THREE.Vector3().subVectors(p1, p0).cross(new THREE.Vector3().subVectors(p2, p0)).y > 0;
        if (up) g.quad(p0, p1, p2, p3, C.white); else g.quad(p0, p3, p2, p1, C.white);
      }
    }
  }

  // 橋：床版の側面、欄干、橋脚
  if (s.bridge.some(Boolean)) {
    const br = fs.filter((f) => f.bridge);
    const runs: Frame[][] = [];
    for (const f of fs) {
      if (!f.bridge) { if (runs.length && runs[runs.length - 1].length) runs.push([]); continue; }
      if (!runs.length) runs.push([]);
      runs[runs.length - 1].push(f);
    }
    for (const run of runs) {
      if (run.length < 2) continue;
      wall(g, run, hw, LIFT - 1.6, LIFT + 0.15, C.deck, true);
      wall(g, run, -hw, LIFT - 1.6, LIFT + 0.15, C.deck, false);
      band(g, run, -hw, hw, LIFT - 1.6, C.deck, undefined, true);
      wall(g, run, hw, LIFT + 0.15, LIFT + 1.1, C.rail, true);
      wall(g, run, hw, LIFT + 0.15, LIFT + 1.1, C.rail, false);
      wall(g, run, -hw, LIFT + 0.15, LIFT + 1.1, C.rail, false);
      wall(g, run, -hw, LIFT + 0.15, LIFT + 1.1, C.rail, true);
    }
    let last = -1e9;
    for (const f of br) {
      if (f.s - last < 26) continue;
      last = f.s;
      const ground = heightAt(terrain, f.p.x, f.p.z) - 1;
      pillar(g, f, Math.min(ground, f.p.y - 2), f.p.y + LIFT - 1.6, Math.min(hw * 0.6, 4));
    }
  }
}

function pillar(g: Geo, f: Frame, y0: number, y1: number, halfW: number): void {
  const along = new THREE.Vector3(-f.n.z, 0, f.n.x);
  const pts = (y: number) => [
    f.p.clone().addScaledVector(f.n, halfW).addScaledVector(along, 1).setY(y),
    f.p.clone().addScaledVector(f.n, -halfW).addScaledVector(along, 1).setY(y),
    f.p.clone().addScaledVector(f.n, -halfW).addScaledVector(along, -1).setY(y),
    f.p.clone().addScaledVector(f.n, halfW).addScaledVector(along, -1).setY(y),
  ];
  const lo = pts(y0), hi = pts(y1);
  const c = new THREE.Vector3(f.p.x, 0, f.p.z);
  for (let k = 0; k < 4; k++) {
    const a = lo[k], b = lo[(k + 1) % 4], cc = hi[(k + 1) % 4], d = hi[k];
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(cc, a));
    const out = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5).setY(0).sub(c);
    if (n.dot(out) >= 0) g.quad(a, b, cc, d, C.pillar); else g.quad(b, a, d, cc, C.pillar);
  }
}

/** 交差点の円の半径 */
export function nodeRadius(net: RoadNetwork, nodeId: number): number {
  const segs = net.segmentsAt(nodeId);
  if (segs.length < 2) return 0;
  return Math.max(...segs.map((s) => halfWidth(s.type))) + 0.5;
}

function nodeGeometry(g: Geo, net: RoadNetwork, nodeId: number): void {
  const segs = net.segmentsAt(nodeId);
  const node = net.nodes.get(nodeId)!;
  if (!segs.length) return;
  const onlyAlley = segs.every((s) => s.type === 'alley');
  const r = segs.length === 1 ? halfWidth(segs[0].type) : nodeRadius(net, nodeId);
  const color = onlyAlley ? C.alley : C.asphalt;
  const y = node.y + LIFT + (segs.length === 1 ? 0 : 0.01);
  const c = new THREE.Vector3(node.x, y, node.z);
  const N = 24;
  for (let k = 0; k < N; k++) {
    const a0 = (k / N) * Math.PI * 2, a1 = ((k + 1) / N) * Math.PI * 2;
    const p0 = new THREE.Vector3(node.x + Math.cos(a0) * r, y, node.z + Math.sin(a0) * r);
    const p1 = new THREE.Vector3(node.x + Math.cos(a1) * r, y, node.z + Math.sin(a1) * r);
    g.tri(c, p1, p0, color);
  }
}

export function roadMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.92, metalness: 0,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  });
}

/** 道路網全体のメッシュ */
export function buildRoadMesh(net: RoadNetwork, terrain: Terrain, material: THREE.Material): THREE.Mesh {
  const g = new Geo();
  for (const s of net.segments.values()) segmentGeometry(g, net, s, terrain);
  for (const id of net.nodes.keys()) nodeGeometry(g, net, id);
  const mesh = new THREE.Mesh(g.build(), material);
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  mesh.name = 'roads';
  return mesh;
}

/** 置く前の道路の見本（1 本分）。type ごとの幅で帯を作る */
export function buildRoadGhost(pieces: { curve: Curve; ys: number[]; bridge: boolean[] }[], type: RoadType): THREE.BufferGeometry {
  const g = new Geo();
  const hw = halfWidth(type);
  const color = new THREE.Color('#ffffff');
  for (const pc of pieces) {
    const fs = frames(pc.curve, pc.ys, pc.bridge, 0, 0, 2);
    band(g, fs, -hw, hw, LIFT + 0.3, color);
  }
  return g.build();
}
