import * as THREE from 'three';
import type { City } from '../city/city';
import { curveLength, pointAt as curveAt } from '../city/geometry';
import { halfWidth, sampleProfile } from '../city/roads';
import { heightAt, type Terrain } from '../world/terrain';

function glowTexture(inner: string, outer: string): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d')!;
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, inner);
  g.addColorStop(0.25, outer);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

/** 夜にともる街灯（道路の両側に 36 m ごと） */
export class StreetLights {
  readonly points: THREE.Points;
  private mat = new THREE.PointsMaterial({
    size: 11, map: glowTexture('rgba(255,236,190,1)', 'rgba(255,190,110,.55)'), transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, sizeAttenuation: true, opacity: 0,
  });
  private key = '';

  constructor() {
    this.points = new THREE.Points(new THREE.BufferGeometry(), this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
  }

  sync(c: City, epoch: number): void {
    const key = `${c.versions.roads}:${epoch}`;
    if (key === this.key) return;
    this.key = key;
    const pos: number[] = [];
    for (const seg of c.net.segments.values()) {
      const cv = c.net.curveOf(seg);
      const len = curveLength(cv);
      const hw = halfWidth(seg.type) + 1;
      for (let d = 12; d < len; d += 36) {
        const t = d / len;
        const p = curveAt(cv, t);
        const q = curveAt(cv, Math.min(1, t + 0.01));
        const dx = q.x - p.x, dz = q.z - p.z, l = Math.hypot(dx, dz) || 1;
        const side = (Math.floor(d / 36) % 2 ? 1 : -1) * hw;
        const y = sampleProfile(seg.ys, t) + 6;
        pos.push(p.x - (dz / l) * side, y, p.z + (dx / l) * side);
      }
    }
    this.points.geometry.dispose();
    this.points.geometry = new THREE.BufferGeometry();
    this.points.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  }

  update(night: number): void {
    this.mat.opacity = THREE.MathUtils.smoothstep(night, 0.35, 0.8) * 0.9;
    this.points.visible = this.mat.opacity > 0.01;
  }
}

/** 雪が降る */
export class Snowfall {
  readonly points: THREE.Points;
  private count = 2600;
  private area = 900;
  private drift: Float32Array;

  constructor() {
    const pos = new Float32Array(this.count * 3);
    this.drift = new Float32Array(this.count);
    for (let i = 0; i < this.count; i++) {
      pos.set([(Math.random() - 0.5) * this.area, Math.random() * 400, (Math.random() - 0.5) * this.area], i * 3);
      this.drift[i] = Math.random() * 6.28;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.points = new THREE.Points(g, new THREE.PointsMaterial({ color: '#ffffff', size: 1.6, map: glowTexture('rgba(255,255,255,1)', 'rgba(255,255,255,.8)'), transparent: true, opacity: 0.85, depthWrite: false }));
    this.points.frustumCulled = false;
    this.points.visible = false;
  }

  update(dt: number, center: THREE.Vector3, strength: number, time: number): void {
    this.points.visible = strength > 0.02;
    if (!this.points.visible) return;
    (this.points.material as THREE.PointsMaterial).opacity = 0.3 + strength * 0.6;
    this.points.position.set(center.x, center.y, center.z);
    const p = this.points.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = p.array as Float32Array;
    const n = Math.floor(this.count * Math.min(1, 0.3 + strength));
    for (let i = 0; i < this.count; i++) {
      const k = i * 3;
      if (i >= n) { arr[k + 1] = -999; continue; }
      if (arr[k + 1] < -100) arr[k + 1] = Math.random() * 400;
      arr[k + 1] -= dt * 28;
      arr[k] += Math.sin(time * 0.8 + this.drift[i]) * dt * 6;
      if (arr[k + 1] < -20) arr[k + 1] += 420;
    }
    p.needsUpdate = true;
  }
}

interface Burst { pts: THREE.Points; vel: Float32Array; t: number; life: number }

/** 夏祭りの花火（夜の川の上に上がる） */
export class Fireworks {
  readonly group = new THREE.Group();
  private bursts: Burst[] = [];
  private tex = glowTexture('rgba(255,255,255,1)', 'rgba(255,255,255,.5)');
  private clock = 0;
  private colors = ['#ff5a5a', '#ffd24a', '#6ad0ff', '#b98cff', '#7dff9a', '#ff9ad5', '#ffffff'];

  update(dt: number, active: boolean, t: Terrain, center: THREE.Vector3): void {
    if (active) {
      this.clock += dt;
      if (this.clock > 0.45) {
        this.clock = 0;
        // 見ている場所にいちばん近い川の上（遠すぎれば見ている場所の上）
        let best = t.river[0], bd = Infinity;
        for (let k = 0; k < t.river.length; k += 4) {
          const rp = t.river[k];
          const d = Math.hypot(rp.x - center.x, rp.z - center.z);
          if (d < bd && rp.level > 0.01) { bd = d; best = rp; }
        }
        const at = bd < 320 ? best : { x: center.x + (Math.random() - 0.5) * 200, z: center.z - 150 };
        const x = at.x + (Math.random() - 0.5) * 80, z = at.z + (Math.random() - 0.5) * 80;
        this.spawn(x, Math.max(0, heightAt(t, x, z)) + 90 + Math.random() * 60, z);
      }
    }
    for (const b of [...this.bursts]) {
      b.t += dt;
      const p = b.pts.geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = p.array as Float32Array;
      for (let i = 0; i < arr.length; i += 3) {
        arr[i] += b.vel[i] * dt; arr[i + 1] += b.vel[i + 1] * dt; arr[i + 2] += b.vel[i + 2] * dt;
        b.vel[i + 1] -= 14 * dt;
        b.vel[i] *= 0.985; b.vel[i + 2] *= 0.985;
      }
      p.needsUpdate = true;
      (b.pts.material as THREE.PointsMaterial).opacity = Math.max(0, 1 - b.t / b.life);
      if (b.t > b.life) {
        this.group.remove(b.pts);
        b.pts.geometry.dispose();
        (b.pts.material as THREE.Material).dispose();
        this.bursts.splice(this.bursts.indexOf(b), 1);
      }
    }
  }

  private spawn(x: number, y: number, z: number): void {
    const n = 140;
    const pos = new Float32Array(n * 3), vel = new Float32Array(n * 3);
    const speed = 30 + Math.random() * 20;
    for (let i = 0; i < n; i++) {
      const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, r = Math.sqrt(1 - u * u);
      pos.set([x, y, z], i * 3);
      vel.set([r * Math.cos(th) * speed, u * speed, r * Math.sin(th) * speed], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const color = this.colors[Math.floor(Math.random() * this.colors.length)];
    const pts = new THREE.Points(g, new THREE.PointsMaterial({ color, size: 24, map: this.tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    pts.frustumCulled = false;
    this.group.add(pts);
    this.bursts.push({ pts, vel, t: 0, life: 2.2 });
  }
}

/** デモや暴動の人だかり（プラカードを持った人たち） */
export class Crowd {
  readonly group = new THREE.Group();
  private people: THREE.InstancedMesh;
  private signs: THREE.InstancedMesh;
  private slots: { x: number; z: number; ph: number }[] = [];
  private dummy = new THREE.Object3D();
  private key = '';
  private terrain?: Terrain;

  constructor() {
    const body = new THREE.CylinderGeometry(0.35, 0.45, 1.3, 6);
    body.translate(0, 0.65, 0);
    const head = new THREE.SphereGeometry(0.32, 6, 5);
    head.translate(0, 1.55, 0);
    this.people = new THREE.InstancedMesh(mergeTwo(body, head), new THREE.MeshStandardMaterial({ roughness: 0.8 }), 180);
    const sign = new THREE.BoxGeometry(1.2, 0.8, 0.08);
    sign.translate(0, 2.6, 0);
    const pole = new THREE.BoxGeometry(0.08, 1.2, 0.08);
    pole.translate(0, 1.8, 0);
    this.signs = new THREE.InstancedMesh(mergeTwo(sign, pole), new THREE.MeshStandardMaterial({ color: '#f4f1e8', roughness: 0.7 }), 60);
    for (const m of [this.people, this.signs]) { m.count = 0; m.frustumCulled = false; m.castShadow = true; this.group.add(m); }
    const palette = ['#2f3b4c', '#6b6f75', '#c9c3b5', '#8a3a33', '#34507a', '#4d6a3e', '#d6b35a'];
    for (let i = 0; i < 180; i++) this.people.setColorAt(i, new THREE.Color(palette[i % palette.length]));
  }

  sync(c: City): void {
    const h = c.society.hotspot;
    const stage = c.society.unrest >= 65 ? 3 : c.society.unrest >= 45 ? 2 : 0;
    const key = h && stage ? `${Math.round(h.x)}:${Math.round(h.z)}:${stage}` : '';
    this.terrain = c.terrain;
    if (key === this.key) return;
    this.key = key;
    this.slots = [];
    if (h && stage) {
      const n = stage >= 3 ? 170 : 110;
      for (let i = 0; i < n; i++) {
        const r = Math.sqrt(Math.random()) * (stage >= 3 ? 38 : 26), a = Math.random() * Math.PI * 2;
        this.slots.push({ x: h.x + Math.cos(a) * r, z: h.z + Math.sin(a) * r, ph: Math.random() * 6.28 });
      }
    }
    this.people.count = this.slots.length;
    this.signs.count = Math.min(60, Math.floor(this.slots.length / 3));
    this.people.instanceColor!.needsUpdate = true;
  }

  update(time: number): void {
    if (!this.slots.length || !this.terrain) return;
    const t = this.terrain;
    this.slots.forEach((s, i) => {
      const bob = Math.abs(Math.sin(time * 3 + s.ph)) * 0.3;
      const x = s.x + Math.sin(time * 0.5 + s.ph) * 0.8, z = s.z + Math.cos(time * 0.4 + s.ph) * 0.8;
      this.dummy.position.set(x, Math.max(0, heightAt(t, x, z)) + bob, z);
      this.dummy.rotation.set(0, s.ph, 0);
      this.dummy.scale.setScalar(1.5);
      this.dummy.updateMatrix();
      this.people.setMatrixAt(i, this.dummy.matrix);
      if (i % 3 === 0 && i / 3 < this.signs.count) this.signs.setMatrixAt(i / 3, this.dummy.matrix);
    });
    this.people.instanceMatrix.needsUpdate = true;
    this.signs.instanceMatrix.needsUpdate = true;
  }
}

function mergeTwo(a: THREE.BufferGeometry, b: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  const A = a.toNonIndexed(), Bg = b.toNonIndexed();
  const pos = new Float32Array([...(A.getAttribute('position').array as Float32Array), ...(Bg.getAttribute('position').array as Float32Array)]);
  const nor = new Float32Array([...(A.getAttribute('normal').array as Float32Array), ...(Bg.getAttribute('normal').array as Float32Array)]);
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return out;
}
