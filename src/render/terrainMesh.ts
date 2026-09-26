import * as THREE from 'three';
import { ENV, ENV_DECL } from './env';
import { smoothstep } from '../core/noise';
import { CELL, GRID, HALF, type Terrain } from '../world/terrain';

const N = GRID + 1;
/** 市の境界（city/region.ts の BORDER と同じ） */
const BORDER_M = 620;

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
  // 隣町の土地は少しくすませ、市の境界に白い点線を描く
  const territory = { uBorder: { value: BORDER_M }, uOther: { value: new THREE.Vector3(1, 1, 1) } };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, territory, ENV);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTerrWorld;\nvarying float vTerrUp;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvTerrWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvTerrUp = normal.y;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vTerrWorld;\nvarying float vTerrUp;\nuniform float uBorder;\nuniform vec3 uOther;\n${ENV_DECL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          // 季節：夏は濃い緑、秋は枯れ色、冬は平らなところに雪
          vec3 c = diffuseColor.rgb;
          float grass = step(c.r, c.g) * step(0.6, vTerrWorld.y);
          c = mix(c, c * vec3(0.82, 0.97, 0.78), grass * uSummer * 0.7);
          c = mix(c, vec3(0.62, 0.6, 0.3) * (0.85 + 0.3 * c.g), grass * uAutumn * 0.3);
          float snow = uSnow * smoothstep(0.72, 0.9, vTerrUp) * step(0.4, vTerrWorld.y);
          c = mix(c, vec3(0.93, 0.95, 0.97), snow * 0.9);
          diffuseColor.rgb = c;
        }
        {
          float x = vTerrWorld.x, z = vTerrWorld.z, B = uBorder;
          float other = 0.0;
          if (x < -B) other = uOther.x;
          else if (x > B) other = uOther.y;
          else if (z < -B) other = uOther.z;
          if (other > 0.5) {
            float l = dot(diffuseColor.rgb, vec3(0.3, 0.55, 0.15));
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(l) * vec3(1.0, 0.97, 0.92), 0.5) * 0.88;
          }
          // 境界線（隣町が残っている辺だけ）
          float d = 1e5; float along = 0.0;
          if (uOther.x > 0.5 && z > -1100.0) { float e = abs(x + B); if (e < d) { d = e; along = z; } }
          if (uOther.y > 0.5 && z > -1100.0) { float e = abs(x - B); if (e < d) { d = e; along = z; } }
          if (uOther.z > 0.5 && abs(x) < B) { float e = abs(z + B); if (e < d) { d = e; along = x; } }
          float dash = step(0.45, fract(along / 18.0));
          float line = (1.0 - smoothstep(1.6, 2.6, d)) * dash;
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.98, 0.97, 0.93), line * 0.9);
        }`);
  };
  mat.userData.territory = territory;
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

/** 地形を書き換えた範囲だけ、頂点の高さと色を更新する */
export function updateTerrainRegion(mesh: THREE.Mesh, t: Terrain, r: { i0: number; i1: number; j0: number; j1: number }): void {
  const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
  const col = mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
  const c = new THREE.Color();
  for (let j = Math.max(0, r.j0 - 1); j <= Math.min(GRID, r.j1 + 1); j++) {
    for (let i = Math.max(0, r.i0 - 1); i <= Math.min(GRID, r.i1 + 1); i++) {
      const k = j * N + i;
      const h = t.heights[k];
      pos.setY(k, h);
      terrainColor(t, i, j, h, c);
      col.setXYZ(k, c.r, c.g, c.b);
    }
  }
  pos.needsUpdate = true;
  col.needsUpdate = true;
  mesh.geometry.computeBoundingSphere();
}

/** どの辺の土地がまだ隣町のものか（true = 隣町） */
export function setTerritory(mesh: THREE.Mesh, other: { west: boolean; east: boolean; north: boolean }): void {
  const t = (mesh.material as THREE.MeshStandardMaterial).userData.territory as { uOther: { value: THREE.Vector3 } } | undefined;
  t?.uOther.value.set(other.west ? 1 : 0, other.east ? 1 : 0, other.north ? 1 : 0);
}
