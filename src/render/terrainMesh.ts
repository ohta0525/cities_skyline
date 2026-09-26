import * as THREE from 'three';
import { smoothstep } from '../core/noise';
import { CELL, GRID, HALF, type Terrain } from '../world/terrain';

const N = GRID + 1;

const COL = {
  seabedShallow: new THREE.Color('#d2c190'),
  seabedDeep: new THREE.Color('#6f8469'),
  sand: new THREE.Color('#e8d7a2'),
  pebble: new THREE.Color('#c4b89a'),
  grassA: new THREE.Color('#93c25a'),
  grassB: new THREE.Color('#7bb04b'),
  grassC: new THREE.Color('#a9c966'),
  forestFloor: new THREE.Color('#5d8d3e'),
  meadow: new THREE.Color('#a3b070'),
  rock: new THREE.Color('#a0978a'),
  snow: new THREE.Color('#f3f2ec'),
};

/** 格子ごとの小さなばらつき（0〜1） */
function hash(i: number, j: number): number {
  const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

export function slopeAt(t: Terrain, i: number, j: number): number {
  const h = (a: number, b: number) =>
    t.heights[Math.min(GRID, Math.max(0, b)) * N + Math.min(GRID, Math.max(0, a))];
  const dx = (h(i + 1, j) - h(i - 1, j)) / (2 * CELL);
  const dz = (h(i, j + 1) - h(i, j - 1)) / (2 * CELL);
  return Math.sqrt(dx * dx + dz * dz);
}

export function buildTerrainMesh(t: Terrain): THREE.Mesh {
  const pos = new Float32Array(N * N * 3);
  const col = new Float32Array(N * N * 3);
  const c = new THREE.Color();
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = j * N + i;
      const h = t.heights[k];
      pos[k * 3] = i * CELL - HALF;
      pos[k * 3 + 1] = h;
      pos[k * 3 + 2] = j * CELL - HALF;
      terrainColor(t, i, j, h, c);
      col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
    }
  }
  const idx = new Uint32Array(GRID * GRID * 6);
  let n = 0;
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const a = j * N + i, b = (j + 1) * N + i, c2 = j * N + i + 1, d = (j + 1) * N + i + 1;
      idx[n++] = a; idx[n++] = b; idx[n++] = c2;
      idx[n++] = b; idx[n++] = d; idx[n++] = c2;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, flatShading: true });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  mesh.name = 'terrain';
  return mesh;
}

function terrainColor(t: Terrain, i: number, j: number, h: number, out: THREE.Color): void {
  const k = j * N + i;
  const r = hash(i, j);
  if (h < 0) {
    out.copy(COL.seabedShallow).lerp(COL.seabedDeep, smoothstep(0, 18, -h));
    return;
  }
  const z = j * CELL - HALF;
  const nearCoast = z > t.coastZ[i] - 90;
  const rd = t.riverDist[k];
  if (h < 2.6 && nearCoast) {
    out.copy(COL.sand);
  } else {
    // 草地：3 色をゆるく混ぜる
    const g = 0.5 + 0.5 * Math.sin(i * 0.11 + Math.cos(j * 0.07) * 2.3);
    out.copy(COL.grassA).lerp(COL.grassB, g).lerp(COL.grassC, r * 0.35);
    out.lerp(COL.forestFloor, t.forest[k] * 0.8);
    out.lerp(COL.meadow, smoothstep(90, 140, h));
    if (rd < 14) out.lerp(COL.pebble, 1 - smoothstep(8, 14, rd));
  }
  out.lerp(COL.rock, smoothstep(0.55, 0.95, slopeAt(t, i, j)));
  out.lerp(COL.rock, smoothstep(165, 190, h));
  out.lerp(COL.snow, smoothstep(205, 222, h));
  out.multiplyScalar(0.96 + r * 0.08);
}
