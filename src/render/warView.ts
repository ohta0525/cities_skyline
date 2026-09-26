import * as THREE from 'three';
import type { City } from '../city/city';
import { BORDER, stageOf, type Edge } from '../city/region';
import { heightAt, HALF, type Terrain } from '../world/terrain';

const MAX_UNITS = 40;
const MAX_BLASTS = 24;

/** 小さな戦車（車体・砲塔・砲身）。+z が前 */
function tankGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const hull = new THREE.BoxGeometry(3.2, 1.3, 5.4);
  hull.translate(0, 0.9, 0);
  const tracks = new THREE.BoxGeometry(3.6, 0.8, 5.8);
  tracks.translate(0, 0.4, 0);
  const turret = new THREE.BoxGeometry(2.1, 0.9, 2.4);
  turret.translate(0, 2, -0.3);
  const barrel = new THREE.CylinderGeometry(0.18, 0.18, 3.4, 6);
  barrel.rotateX(Math.PI / 2);
  barrel.translate(0, 2.05, 2.3);
  parts.push(tracks, hull, turret, barrel);
  const g = mergeGeometries(parts);
  parts.forEach((p) => p.dispose());
  return g;
}

function mergeGeometries(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [], nor: number[] = [];
  for (const g0 of list) {
    const g = g0.index ? g0.toNonIndexed() : g0;
    pos.push(...(g.getAttribute('position').array as Float32Array));
    nor.push(...(g.getAttribute('normal').array as Float32Array));
    if (g !== g0) g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return out;
}

function glowTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d')!;
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,245,200,1)');
  g.addColorStop(0.3, 'rgba(255,160,60,.9)');
  g.addColorStop(1, 'rgba(255,80,20,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

interface UnitSlot { x: number; z: number; tx: number; tz: number; heading: number; ph: number }

/** 境界の線（辺ごとの「沿う方向」と「市の内側」） */
function frame(edge: Edge) {
  if (edge === 'west') return { at: (d: number, s: number) => ({ x: -BORDER + d, z: s }), inward: 0 };
  if (edge === 'east') return { at: (d: number, s: number) => ({ x: BORDER - d, z: s }), inward: Math.PI };
  return { at: (d: number, s: number) => ({ x: s, z: -BORDER + d }), inward: Math.PI / 2 };
}

/**
 * 紛争の様子：前線（赤く光る帯）、両軍の戦車、爆発。
 * 平時は駐屯地に部隊の車両が並ぶ。緊張が「小競り合い」なら境界で時々爆発が起きる。
 */
export class WarView {
  readonly group = new THREE.Group();
  private geo = tankGeometry();
  private ours = new THREE.InstancedMesh(this.geo, new THREE.MeshStandardMaterial({ color: '#5b6b48', roughness: 0.8 }), MAX_UNITS);
  private theirs = new THREE.InstancedMesh(this.geo, new THREE.MeshStandardMaterial({ color: '#7a4a44', roughness: 0.8 }), MAX_UNITS);
  private parked = new THREE.InstancedMesh(this.geo, new THREE.MeshStandardMaterial({ color: '#5b6b48', roughness: 0.8 }), MAX_UNITS);
  private frontMat = new THREE.MeshBasicMaterial({ color: '#ff4a3a', transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  private frontMesh?: THREE.Mesh;
  private blastMat = new THREE.SpriteMaterial({ map: glowTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
  private smokeMat = new THREE.MeshStandardMaterial({ color: '#57524c', transparent: true, opacity: 0.5, depthWrite: false, roughness: 1 });
  private puff = new THREE.IcosahedronGeometry(1, 1);
  private blasts: { s: THREE.Sprite; smoke: THREE.Mesh; t: number; life: number }[] = [];
  private oursSlots: UnitSlot[] = [];
  private theirSlots: UnitSlot[] = [];
  private key = '';
  private city?: City;
  private frontLine: { x: number; z: number }[] = [];
  private skirmish: { edge: Edge } | null = null;
  private dummy = new THREE.Object3D();
  private spawnClock = 0;

  constructor() {
    this.group.name = 'war';
    for (const m of [this.ours, this.theirs, this.parked]) {
      m.castShadow = true;
      m.receiveShadow = true;
      m.count = 0;
      m.frustumCulled = false;
      this.group.add(m);
    }
    for (let k = 0; k < MAX_BLASTS; k++) {
      const s = new THREE.Sprite(this.blastMat);
      s.visible = false;
      const smoke = new THREE.Mesh(this.puff, this.smokeMat);
      smoke.visible = false;
      this.group.add(s, smoke);
      this.blasts.push({ s, smoke, t: 1, life: 1 });
    }
  }

  /** 街の状態に合わせて並べ直す（変化があったときだけ） */
  sync(c: City): void {
    const w = c.defense.war;
    const garrisons = [...c.facilities.values()].filter((f) => f.kind === 'garrison');
    const tense = c.region.neighbors.find((n) => !n.merged && stageOf(n.tension) === 4 && c.defense.war?.edge !== n.edge);
    const key = `${c.versions.war}:${c.versions.facilities}:${c.versions.territory}:${w ? `${w.edge}:${Math.round(w.front)}:${Math.round(c.neighbor(w.edge)?.military ?? 0)}` : ''}:${tense?.edge ?? ''}:${c.defense.units.length}`;
    if (key === this.key && this.city === c) return;
    this.key = key;
    this.city = c;
    const t = c.terrain;
    this.skirmish = tense ? { edge: tense.edge } : null;
    // 平時：駐屯地に並ぶ車両（紛争中は前線に出ている）
    const atHome = w ? 0 : c.defense.units.length;
    let p = 0;
    for (const f of garrisons) {
      const room = Math.min(6, atHome - p);
      for (let k = 0; k < room; k++, p++) {
        // 描画と同じ向き（CityView.place）で、敷地の右側の車両置き場に 2 列に並べる
        const flip = -f.az * f.nx + f.ax * f.nz < 0 ? -1 : 1;
        const lx = (7 + (k % 2) * 6) * flip, lz = 6 + Math.floor(k / 2) * 8.5;
        const x = f.x + f.ax * lx + f.nx * lz, z = f.z + f.az * lx + f.nz * lz;
        this.dummy.position.set(x, f.y + 0.1, z);
        this.dummy.rotation.set(0, Math.atan2(-f.nx, -f.nz), 0);
        this.dummy.scale.setScalar(0.85);
        this.dummy.updateMatrix();
        this.parked.setMatrixAt(p, this.dummy.matrix);
      }
    }
    this.parked.count = p;
    this.parked.instanceMatrix.needsUpdate = true;
    this.parked.computeBoundingSphere();
    // 前線
    if (this.frontMesh) { this.group.remove(this.frontMesh); this.frontMesh.geometry.dispose(); this.frontMesh = undefined; }
    this.oursSlots = [];
    this.theirSlots = [];
    this.frontLine = [];
    if (w) {
      const n = c.neighbor(w.edge)!;
      const fr = frame(w.edge);
      // 前線の位置：負けているほど市の内側へ、勝っているほど相手の土地へ
      const depth = w.front < 0 ? -w.front * 3 : -w.front * 1.6;
      const span = w.edge === 'north' ? BORDER - 40 : 560;
      for (let s = -span; s <= span; s += 16) {
        const q = fr.at(depth + Math.sin(s * 0.013) * 14, s);
        if (Math.abs(q.x) > HALF - 20 || Math.abs(q.z) > HALF - 20) continue;
        if (heightAt(t, q.x, q.z) < 0.5) continue;
        this.frontLine.push(q);
      }
      this.frontMesh = this.ribbon(t, this.frontLine);
      if (this.frontMesh) this.group.add(this.frontMesh);
      const mine = Math.min(MAX_UNITS, Math.max(1, c.defense.units.length * 2));
      const foe = Math.min(MAX_UNITS, Math.max(1, Math.round(n.military / 12)));
      const place = (count: number, side: 1 | -1, out: UnitSlot[]) => {
        for (let k = 0; k < count && this.frontLine.length; k++) {
          const base = this.frontLine[Math.floor(((k + 0.5) / count) * this.frontLine.length)];
          const back = 30 + ((k * 37) % 70);
          const dirIn = fr.inward;
          const x = base.x + Math.cos(dirIn) * back * side, z = base.z + Math.sin(dirIn) * back * side;
          out.push({ x, z, tx: base.x + Math.cos(dirIn) * 14 * side, tz: base.z + Math.sin(dirIn) * 14 * side, heading: Math.atan2(-Math.cos(dirIn) * side, -Math.sin(dirIn) * side), ph: k * 1.7 });
        }
      };
      place(mine, 1, this.oursSlots);
      place(foe, -1, this.theirSlots);
    }
    this.ours.count = this.oursSlots.length;
    this.theirs.count = this.theirSlots.length;
  }

  private ribbon(t: Terrain, pts: { x: number; z: number }[]): THREE.Mesh | undefined {
    if (pts.length < 2) return undefined;
    const pos: number[] = [];
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1], b = pts[k];
      if (Math.hypot(b.x - a.x, b.z - a.z) > 40) continue;
      const ya = Math.max(0, heightAt(t, a.x, a.z)) + 0.6, yb = Math.max(0, heightAt(t, b.x, b.z)) + 0.6;
      const H = 9;
      pos.push(a.x, ya, a.z, b.x, yb, b.z, b.x, yb + H, b.z, a.x, ya, a.z, b.x, yb + H, b.z, a.x, ya + H, a.z);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const m = new THREE.Mesh(g, this.frontMat);
    m.renderOrder = 5;
    return m;
  }

  update(time: number, dt: number): void {
    const c = this.city;
    if (!c) return;
    const t = c.terrain;
    const draw = (mesh: THREE.InstancedMesh, slots: UnitSlot[]) => {
      slots.forEach((u, i) => {
        // 前線に向かってじりじり進み、また下がる
        const k = 0.5 + 0.5 * Math.sin(time * 0.35 + u.ph);
        const x = u.x + (u.tx - u.x) * k * 0.7, z = u.z + (u.tz - u.z) * k * 0.7;
        this.dummy.position.set(x, Math.max(0, heightAt(t, x, z)) + 0.05, z);
        this.dummy.rotation.set(0, u.heading, 0);
        this.dummy.scale.setScalar(1.6);
        this.dummy.updateMatrix();
        mesh.setMatrixAt(i, this.dummy.matrix);
      });
      if (slots.length) mesh.instanceMatrix.needsUpdate = true;
    };
    draw(this.ours, this.oursSlots);
    draw(this.theirs, this.theirSlots);
    this.frontMat.opacity = 0.35 + 0.2 * Math.sin(time * 3);
    // 爆発
    const rate = this.frontLine.length ? 7 : this.skirmish ? 0.6 : 0;
    this.spawnClock += dt * rate;
    while (this.spawnClock > 1) {
      this.spawnClock -= 1;
      let p: { x: number; z: number } | null = null;
      if (this.frontLine.length) {
        const b = this.frontLine[Math.floor(Math.random() * this.frontLine.length)];
        p = { x: b.x + (Math.random() - 0.5) * 60, z: b.z + (Math.random() - 0.5) * 60 };
      } else if (this.skirmish) {
        p = frame(this.skirmish.edge).at((Math.random() - 0.3) * 80, (Math.random() - 0.5) * 900);
      }
      const slot = this.blasts.find((b) => b.t >= b.life);
      if (p && slot) {
        const y = Math.max(0, heightAt(t, p.x, p.z));
        slot.s.position.set(p.x, y + 4, p.z);
        slot.smoke.position.set(p.x, y + 3, p.z);
        slot.t = 0;
        slot.life = 1.6 + Math.random();
      }
    }
    for (const b of this.blasts) {
      if (b.t >= b.life) { b.s.visible = false; b.smoke.visible = false; continue; }
      b.t += dt || 0.016;
      const k = b.t / b.life;
      b.s.visible = k < 0.35;
      b.s.scale.setScalar(10 + k * 40);
      b.smoke.visible = true;
      b.smoke.scale.setScalar(3 + k * 12);
      b.smoke.position.y += (dt || 0.016) * 6;
    }
    this.smokeMat.opacity = 0.45;
  }
}
