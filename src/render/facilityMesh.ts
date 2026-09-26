import * as THREE from 'three';
import { mulberry32 } from '../core/rng';
import type { Rubble } from '../city/disasters';
import type { Facility, FacilityKind } from '../city/facilities';
import { B, WIN, lotPad, range } from './buildingMesh';

const CON = '#bab6ad';
const tree = (g: B, x: number, z: number, s = 1, color = '#4f8f3f') => {
  g.cylinder(x, z, 0.18 * s, 0.06, 1.4 * s, '#6b4a31', 5);
  g.cylinder(x, z, 1.1 * s, 1.4 * s, 3.4 * s, color, 7, '#5c9c47');
};

function stack(g: B, x: number, z: number, h: number, r: number, bands: [string, string]): void {
  const n = 8;
  for (let k = 0; k < n; k++) g.cylinder(x, z, r * (1 - k * 0.03), (h * k) / n, (h * (k + 1)) / n, k >= n - 2 ? bands[1] : bands[0], 12);
}

const MAKERS: Record<FacilityKind, (g: B, r: () => number, W: number, D: number) => void> = {
  thermal: (g, _r, W, D) => {
    lotPad(g, W, D, '#9d998f');
    g.box(-W / 2 + 2, 4, 0, 12, 4, 18, '#9fb0bc', WIN.factory);
    g.box(-W / 2 + 2, 4, 12, 13, 4, 18, '#7d8b95');
    g.box(5, W / 2 - 2, 0, 24, 6, 16, '#c9c6bf', WIN.factory);
    stack(g, 4, D - 6, 44, 1.8, ['#f1efe9', '#d2433a']);
    stack(g, 8.5, D - 6, 44, 1.8, ['#f1efe9', '#d2433a']);
    g.box(-W / 2 + 2, 2, 0.06, 1.2, 20, D - 2, '#2f2d2b');
  },
  solar: (g, _r, W, D) => {
    lotPad(g, W, D, '#b3ae9e');
    for (let z = 3; z < D - 3; z += 3.2) {
      for (let x = -W / 2 + 1.5; x < W / 2 - 3; x += 4.4) {
        g.quad(new THREE.Vector3(x, 0.6, z), new THREE.Vector3(x + 4, 0.6, z), new THREE.Vector3(x + 4, 1.8, z + 2), new THREE.Vector3(x, 1.8, z + 2), '#274a78', new THREE.Vector3(0, 1, -0.5));
      }
    }
    g.box(W / 2 - 2.5, W / 2 - 0.8, 0, 2.2, 1, 3, '#dcdad2');
  },
  nuclear: (g, _r, W, D) => {
    lotPad(g, W, D, '#b9b6ae');
    const cx = -5, cz = D / 2 + 2;
    g.cylinder(cx, cz, 9, 0, 20, '#eceae4', 20);
    for (let k = 0; k < 5; k++) {
      const a0 = (k / 5) * (Math.PI / 2), a1 = ((k + 1) / 5) * (Math.PI / 2);
      g.cylinder(cx, cz, 9 * Math.cos(a1), 20 + 9 * Math.sin(a0), 20 + 9 * Math.sin(a1), '#eceae4', 20);
    }
    g.box(4, W / 2 - 2, 0, 16, 5, D - 5, '#b8c3cb', WIN.factory);
    g.cylinder(W / 2 - 4, 4, 1.4, 0, 60, '#dcdcd6', 10);
    g.box(-W / 2 + 1, W / 2 - 1, 0, 2.5, 0.4, 0.8, '#8a8f93');
  },
  waterworks: (g, _r, W, D) => {
    lotPad(g, W, D, CON);
    for (const [x0, x1] of [[-W / 2 + 1, -0.5], [0.5, W / 2 - 1]]) {
      for (const [z0, z1] of [[7, 13.5], [14.5, D - 1]]) {
        g.box(x0, x1, 0, 1.2, z0, z1, '#a9a59c', 0, '#4f93b8');
      }
    }
    g.box(-W / 2 + 1, W / 2 - 1, 0, 6, 1, 6, '#e6e2d8', WIN.apartment);
  },
  sewage: (g, _r, W, D) => {
    lotPad(g, W, D, CON);
    g.cylinder(-3, 11, 4.5, 0, 1.6, '#a9a59c', 18, '#5d6a52');
    g.cylinder(3.5, 18, 4, 0, 1.6, '#a9a59c', 18, '#6b7458');
    g.box(-W / 2 + 1, W / 2 - 1, 0, 6, 1, 5.5, '#dcd8cc', WIN.apartment);
  },
  incinerator: (g, _r, W, D) => {
    lotPad(g, W, D, CON);
    g.box(-W / 2 + 1, W / 2 - 1, 0, 14, 5, D - 2, '#d8d5cc', WIN.factory);
    g.box(-W / 2 + 1, W / 2 - 1, 14, 15, 5, D - 2, '#8e969c');
    stack(g, W / 2 - 3.5, D - 5, 58, 1.6, ['#e9e7e1', '#9aa1a6']);
    g.box(-3, 3, 0, 5, 3.5, 5.2, '#6b7277');
  },
  fireStation: (g, _r, W, D) => {
    lotPad(g, W, D, '#9d9a92');
    g.box(-W / 2 + 1, W / 2 - 3, 0, 7.5, 5, D - 1, '#efece6', WIN.apartment);
    for (let k = 0; k < 3; k++) g.box(-W / 2 + 1.6 + k * 3.8, -W / 2 + 4.6 + k * 3.8, 0, 3.8, 4.9, 5.05, '#c9332b');
    g.box(-W / 2 + 1, W / 2 - 3, 7.5, 8.2, 5, 5.3, '#c9332b');
    // ホースを干す望楼
    g.box(W / 2 - 3, W / 2 - 1, 0, 17, D - 5, D - 2, '#dedad2');
    g.box(W / 2 - 3.4, W / 2 - 0.6, 17, 17.4, D - 5.4, D - 1.6, '#c9332b');
  },
  fireBrigade: (g, _r, W, D) => {
    lotPad(g, W, D, '#b3afa5');
    g.box(-3, 1.5, 0, 3.2, 1.5, 6.5, '#d8d2c4');
    g.box(-2.6, 1.1, 0, 2.6, 1.45, 1.55, '#c9332b');
    g.gable(-3, 1.5, 1.5, 6.5, 3.2, 1.2, '#4a4f58', '#d8d2c4', 'z', 0.3);
    // 火の見やぐら
    const x = 2.6, z = 5;
    for (const [dx, dz] of [[-0.9, -0.9], [0.9, -0.9], [0.9, 0.9], [-0.9, 0.9]]) g.box(x + dx - 0.1, x + dx + 0.1, 0, 12, z + dz - 0.1, z + dz + 0.1, '#7a4b35');
    for (let y = 2; y < 12; y += 2.5) g.box(x - 1, x + 1, y, y + 0.12, z - 1, z + 1, '#7a4b35');
    g.box(x - 1.3, x + 1.3, 12, 12.2, z - 1.3, z + 1.3, '#6b4a31');
    g.hip(x - 1.1, x + 1.1, z - 1.1, z + 1.1, 13.4, 1, '#4a4f58', 0.2);
    g.cylinder(x, z, 0.3, 12.3, 13, '#c9a44b', 8);
  },
  koban: (g, _r, W, D) => {
    lotPad(g, W, D, '#b3afa5');
    g.box(-2.8, 2.8, 0, 3.2, 1.5, 6.5, '#ece7da', WIN.shop);
    g.gable(-2.8, 2.8, 1.5, 6.5, 3.2, 1.4, '#3f4a52', '#ece7da', 'x', 0.35);
    g.box(-0.35, 0.35, 3.4, 4.1, 1.1, 1.4, '#e23b2e');
    g.box(-1.6, 1.6, 2.5, 2.9, 1.2, 1.5, '#2f5fa8');
  },
  policeStation: (g, _r, W, D) => {
    lotPad(g, W, D, '#b3afa5');
    g.box(-W / 2 + 1, W / 2 - 1, 0, 10.5, 4, D - 1, '#d9dcdc', WIN.apartment);
    g.box(-W / 2 + 1, W / 2 - 1, 3, 3.6, 3.85, D - 0.95, '#2f5fa8');
    g.box(-2, 2, 0, 3, 2, 4, '#9aa3a8');
    g.cylinder(W / 2 - 2, 2, 0.1, 0, 9, '#c8cccf', 6);
  },
  clinic: (g, _r, W, D) => {
    lotPad(g, W, D, '#b3afa5');
    g.box(-3.3, 3.3, 0, 6, 3, D - 2, '#f3f1ec', WIN.shop);
    g.box(-0.9, 0.9, 6.3, 6.9, 3.2, 3.5, '#2e9b54');
    g.box(-0.3, 0.3, 5.7, 7.5, 3.2, 3.5, '#2e9b54');
  },
  hospital: (g, _r, W, D) => {
    lotPad(g, W, D, '#c4c0b6');
    g.box(-W / 2 + 1.5, W / 2 - 1.5, 0, 21, 8, 16, '#f3f1ec', WIN.apartment);
    g.box(-W / 2 + 1.5, -W / 2 + 9, 0, 14, 16, D - 1.5, '#ecebe5', WIN.apartment);
    g.box(-3, 3, 21, 21.3, 9.5, 14.5, '#9aa3a8');
    g.box(-1.6, -1.2, 21.3, 21.35, 10.5, 13.5, '#f1efe7');
    g.box(1.2, 1.6, 21.3, 21.35, 10.5, 13.5, '#f1efe7');
    g.box(-1.2, 1.2, 21.3, 21.35, 11.8, 12.2, '#f1efe7');
    g.box(-1, 1, 15, 17, 7.8, 8, '#d2433a');
    g.box(-3, 3, 3, 3.3, 3, 8, '#9aa3a8');
  },
  elementary: (g, _r, W, D) => {
    lotPad(g, W, D, '#c2a57d');
    g.box(-W / 2 + 1, W / 2 - 1, 0, 10, D - 9, D - 1, '#f0ede4', WIN.apartment);
    g.box(-1.2, 1.2, 10, 12.5, D - 9.2, D - 8.2, '#f0ede4');
    g.cylinder(0, D - 9.25, 0.9, 10.7, 10.75, '#f7f5ef', 12);
    g.box(-W / 2 + 1.5, -1, 0.06, 1.1, 3, 11, '#4f93b8');
    for (let k = 0; k < 3; k++) tree(g, W / 2 - 1.5, 2 + k * 4, 0.8);
  },
  highschool: (g, _r, W, D) => {
    lotPad(g, W, D, '#c2a57d');
    g.box(-W / 2 + 1, W / 2 - 1, 0, 13, D - 8, D - 1, '#e9e6de', WIN.apartment);
    g.box(-W / 2 + 1, -W / 2 + 10, 0, 9, 1, 9, '#b8c2c8');
    g.gable(-W / 2 + 1, -W / 2 + 10, 1, 9, 9, 1.5, '#5c6770', '#b8c2c8', 'z', 0.3);
    g.box(0, W / 2 - 1.5, 0.06, 0.1, 2, 13, '#d6c29a');
  },
  park: (g, r, W, D) => {
    lotPad(g, W, D, '#86b85c');
    g.box(-0.6, 0.6, 0.06, 0.1, 0.2, D - 1, '#d9cfb3');
    for (let k = 0; k < 4; k++) tree(g, range(r, -3, 3), range(r, 1.5, D - 1.5), 0.8 + r() * 0.4, k % 2 ? '#e7a3b8' : '#4f8f3f');
    g.box(1.5, 3, 0.06, 0.6, 3, 3.5, '#8a6a48');
  },
  shrine: (g, r, W, D) => {
    lotPad(g, W, D, '#cfc5a8');
    // 鳥居
    const red = '#d0452f';
    g.cylinder(-1.8, 1.2, 0.22, 0, 4.2, red, 8);
    g.cylinder(1.8, 1.2, 0.22, 0, 4.2, red, 8);
    g.box(-2.6, 2.6, 4.2, 4.6, 0.95, 1.45, '#2b2622');
    g.box(-2.2, 2.2, 3.4, 3.6, 1.05, 1.35, red);
    g.box(-0.6, 0.6, 0.06, 0.12, 1.5, D - 6, '#e6dcc2');
    // 本殿と鎮守の森
    g.box(-2.3, 2.3, 0.4, 3.2, D - 6, D - 2, '#8a5a3a');
    g.gable(-2.3, 2.3, D - 6, D - 2, 3.2, 2, '#3b3f3a', '#8a5a3a', 'z', 0.7);
    for (let k = 0; k < 6; k++) tree(g, (k % 2 ? 1 : -1) * range(r, 2.6, 3.6), range(r, 3, D - 1), 1 + r() * 0.3, '#2f6b3a');
  },
};

export function buildFacilityGeometry(f: Pick<Facility, 'kind' | 'w' | 'd' | 'seed'>): THREE.BufferGeometry {
  const g = new B();
  MAKERS[f.kind](g, mulberry32(f.seed), f.w * 8, f.d * 8);
  return g.build();
}

/** がれきの山 */
export function buildRubbleGeometry(r: Pick<Rubble, 'w' | 'd' | 'seed'>): THREE.BufferGeometry {
  const g = new B();
  const rand = mulberry32(r.seed ^ 0x5bd1e995);
  const W = r.w * 8, D = r.d * 8;
  lotPad(g, W, D, '#8f8a80');
  const colors = ['#6b645c', '#8a7f72', '#4a4540', '#9b8f7e', '#5b4636'];
  const n = Math.round(W * D / 6);
  for (let k = 0; k < n; k++) {
    const x = range(rand, -W / 2 + 1.5, W / 2 - 2.5), z = range(rand, 2, D - 2.5);
    const s = range(rand, 0.6, 2.2);
    g.box(x, x + s, 0, range(rand, 0.3, 1.8), z, z + s * range(rand, 0.6, 1.6), colors[k % colors.length]);
  }
  return g.build();
}
