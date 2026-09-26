import * as THREE from 'three';
import { smoothstep } from '../core/noise';
import { HALF, MAP_SIZE, SEA_LEVEL, heightAt, type Terrain } from '../world/terrain';

const SHALLOW = new THREE.Color('#86d3cc');
const MID = new THREE.Color('#3f9cb4');
const DEEP = new THREE.Color('#1f5d86');
const FOAM = new THREE.Color('#eef7f2');
const RIVER = new THREE.Color('#5aaac0');

export interface WaterUniforms { time: { value: number } }

/** 水のマテリアル。頂点を少し揺らして波を表現する */
export function createWaterMaterial(): { material: THREE.MeshStandardMaterial; uniforms: WaterUniforms } {
  const uniforms: WaterUniforms = { time: { value: 0 } };
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true, transparent: true, opacity: 0.86, roughness: 0.18, metalness: 0.05, depthWrite: false,
  });
  material.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uniforms.time;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        transformed.y += sin(position.x * 0.045 + uTime * 0.9) * 0.18 + cos(position.z * 0.05 + uTime * 0.7) * 0.14;`,
      );
  };
  return { material, uniforms };
}

export function buildSea(t: Terrain, material: THREE.Material): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(MAP_SIZE, MAP_SIZE, 192, 192);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let k = 0; k < pos.count; k++) {
    const x = pos.getX(k), z = pos.getZ(k);
    const depth = SEA_LEVEL - heightAt(t, Math.max(-HALF, Math.min(HALF, x)), Math.max(-HALF, Math.min(HALF, z)));
    c.copy(SHALLOW).lerp(MID, smoothstep(0.5, 6, depth)).lerp(DEEP, smoothstep(6, 22, depth));
    c.lerp(FOAM, 1 - smoothstep(0.1, 0.9, depth));
    col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mesh = new THREE.Mesh(geo, material);
  mesh.position.y = SEA_LEVEL;
  mesh.renderOrder = 2;
  mesh.receiveShadow = true;
  mesh.name = 'sea';
  return mesh;
}

/** 川の水面。中心線に沿った帯 */
export function buildRiver(t: Terrain, material: THREE.Material): THREE.Mesh | null {
  const pts = t.river.filter((p) => p.level > SEA_LEVEL + 0.01);
  if (pts.length < 2) return null;
  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  for (let k = 0; k < pts.length; k++) {
    const p = pts[k];
    const a = pts[Math.max(0, k - 1)], b = pts[Math.min(pts.length - 1, k + 1)];
    let dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;
    const half = p.width / 2 + 2;
    const y = p.level + 0.35;
    pos.push(p.x - dz * half, y, p.z + dx * half, p.x + dz * half, y, p.z - dx * half);
    col.push(RIVER.r, RIVER.g, RIVER.b, RIVER.r, RIVER.g, RIVER.b);
    if (k > 0) {
      const i = k * 2;
      idx.push(i - 2, i, i - 1, i, i + 1, i - 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, material);
  mesh.renderOrder = 2;
  mesh.receiveShadow = true;
  mesh.name = 'river';
  return mesh;
}
