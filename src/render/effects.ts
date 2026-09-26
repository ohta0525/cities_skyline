import * as THREE from 'three';

/** 燃えている建物の炎と煙 */
export class FireFx {
  readonly group = new THREE.Group();
  private items = new Map<number, THREE.Group>();
  private flameMat = new THREE.MeshBasicMaterial({ color: '#ff7a1a', transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
  private coreMat = new THREE.MeshBasicMaterial({ color: '#ffd24a', transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
  private smokeMat = new THREE.MeshStandardMaterial({ color: '#4d4a47', transparent: true, opacity: 0.45, depthWrite: false, roughness: 1 });
  private cone = new THREE.ConeGeometry(1, 3, 7);
  private puff = new THREE.IcosahedronGeometry(1, 1);

  constructor() {
    this.group.name = 'fires';
  }

  /** 燃えている建物の一覧に合わせる。top は屋根の高さ、size は建物の大きさ */
  sync(list: { id: number; x: number; y: number; z: number; size: number; intensity: number }[]): void {
    const keep = new Set(list.map((f) => f.id));
    for (const [id, g] of this.items) if (!keep.has(id)) { this.group.remove(g); this.items.delete(id); }
    for (const f of list) {
      let g = this.items.get(f.id);
      if (!g) {
        g = new THREE.Group();
        const n = 4;
        for (let k = 0; k < n; k++) {
          const flame = new THREE.Mesh(this.cone, k % 2 ? this.coreMat : this.flameMat);
          flame.userData = { ox: (Math.random() - 0.5) * f.size * 0.6, oz: (Math.random() - 0.5) * f.size * 0.6, ph: Math.random() * 6, flame: true };
          g.add(flame);
        }
        for (let k = 0; k < 7; k++) {
          const s = new THREE.Mesh(this.puff, this.smokeMat);
          s.userData = { ph: k / 7, ox: (Math.random() - 0.5) * 3, oz: (Math.random() - 0.5) * 3 };
          g.add(s);
        }
        this.group.add(g);
        this.items.set(f.id, g);
      }
      g.position.set(f.x, f.y, f.z);
      g.userData.size = f.size;
      g.userData.intensity = f.intensity;
    }
  }

  update(time: number): void {
    for (const g of this.items.values()) {
      const size = g.userData.size as number, it = Math.max(0.35, g.userData.intensity as number);
      for (const m of g.children) {
        const u = m.userData;
        if (u.flame) {
          const s = (0.7 + 0.3 * Math.sin(time * 9 + u.ph)) * size * 0.28 * it;
          m.scale.set(s, s * (1.2 + 0.4 * Math.sin(time * 13 + u.ph)), s);
          m.position.set(u.ox, s * 1.4, u.oz);
        } else {
          const p = (time * 0.12 + u.ph) % 1;
          const s = size * (0.25 + p * 0.9) * it;
          m.scale.setScalar(s);
          m.position.set(u.ox + p * 6, 4 + p * size * 3.5, u.oz + p * 3);
        }
      }
    }
    this.smokeMat.opacity = 0.42;
  }
}

/** 建物の上に出す警告のしるし（電気・水が来ていない） */
export function iconTexture(text: string, bg: string): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = bg;
  ctx.beginPath(); ctx.arc(32, 32, 28, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 4; ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 32px "M PLUS 1p", "Hiragino Sans", sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, 32, 34);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** 揺れの演出で使う、震度ごとの揺れ幅（m） */
export function shakeAmplitude(shindo: string): number {
  return ({ '0': 0, '1': 0.2, '2': 0.4, '3': 0.8, '4': 1.5, '5弱': 2.5, '5強': 3.5, '6弱': 5, '6強': 6.5, '7': 8 } as Record<string, number>)[shindo] ?? 2;
}
