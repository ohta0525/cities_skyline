import * as THREE from 'three';
import { ENV, ENV_DECL } from './env';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../core/rng';
import { HALF, forestAt, heightAt, riverDistAt, type Terrain } from '../world/terrain';

function paint(geo: THREE.BufferGeometry, color: string): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const c = new THREE.Color(color);
  const n = g.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  g.deleteAttribute('uv');
  return g;
}

/** 杉・檜のような針葉樹 */
function coniferGeometry(): THREE.BufferGeometry {
  const trunk = paint(new THREE.CylinderGeometry(0.35, 0.5, 3, 5).translate(0, 1.5, 0), '#6b4a31');
  const low = paint(new THREE.ConeGeometry(2.4, 6, 7).translate(0, 5, 0), '#ffffff');
  const high = paint(new THREE.ConeGeometry(1.7, 5, 7).translate(0, 8.2, 0), '#ffffff');
  return mergeGeometries([trunk, low, high])!;
}

/** 丸い広葉樹 */
function broadleafGeometry(): THREE.BufferGeometry {
  const trunk = paint(new THREE.CylinderGeometry(0.35, 0.5, 3.2, 5).translate(0, 1.6, 0), '#6b4a31');
  const crown = paint(new THREE.IcosahedronGeometry(3, 0).scale(1, 0.85, 1).translate(0, 5.4, 0), '#ffffff');
  return mergeGeometries([trunk, crown])!;
}

const CONIFER_COLORS = ['#2f6b3a', '#3a7a3f', '#2b5f37', '#44804a'];
const BROAD_COLORS = ['#5f9e3f', '#6fae45', '#7cb84f', '#4f8f3a', '#8fbf55'];

export function buildTrees(t: Terrain, density: number): THREE.Group {
  const rand = mulberry32(t.seed ^ 0x9e3779b9);
  const conifers: THREE.Matrix4[] = [], broads: THREE.Matrix4[] = [];
  const cc: THREE.Color[] = [], bc: THREE.Color[] = [];
  const step = 9 / Math.sqrt(density);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  for (let z = -HALF + 4; z < HALF - 4; z += step) {
    for (let x = -HALF + 4; x < HALF - 4; x += step) {
      const px = x + (rand() - 0.5) * step * 0.9;
      const pz = z + (rand() - 0.5) * step * 0.9;
      const f = forestAt(t, px, pz);
      const h = heightAt(t, px, pz);
      const chance = f * 0.9 + 0.012;
      if (rand() > chance || h < 1.6 || h > 200) continue;
      if (riverDistAt(t, px, pz) < 16) continue;
      const slope = Math.hypot(heightAt(t, px + 3, pz) - heightAt(t, px - 3, pz), heightAt(t, px, pz + 3) - heightAt(t, px, pz - 3)) / 6;
      if (slope > 1.1) continue;
      const conifer = rand() < (h > 60 ? 0.8 : 0.25);
      const sc = (conifer ? 0.9 : 0.8) + rand() * 0.6;
      q.setFromAxisAngle(up, rand() * Math.PI * 2);
      s.set(sc, sc * (0.9 + rand() * 0.3), sc);
      p.set(px, h - 0.3, pz);
      m.compose(p, q, s);
      const palette = conifer ? CONIFER_COLORS : BROAD_COLORS;
      const color = new THREE.Color(palette[Math.floor(rand() * palette.length)]);
      (conifer ? conifers : broads).push(m.clone());
      (conifer ? cc : bc).push(color);
    }
  }
  const mat = seasonalTreeMaterial(false);
  const matConifer = seasonalTreeMaterial(true);
  const g = new THREE.Group();
  g.name = 'trees';
  for (const [geo, list, colors, m] of [
    [coniferGeometry(), conifers, cc, matConifer],
    [broadleafGeometry(), broads, bc, mat],
  ] as const) {
    if (!list.length) continue;
    const inst = new THREE.InstancedMesh(geo, m, list.length);
    const xz = new Float32Array(list.length * 2);
    list.forEach((mm, i) => {
      inst.setMatrixAt(i, mm);
      inst.setColorAt(i, colors[i]);
      xz[i * 2] = mm.elements[12]; xz[i * 2 + 1] = mm.elements[14];
    });
    inst.userData.xz = xz;
    inst.castShadow = true;
    inst.receiveShadow = true;
    inst.computeBoundingSphere();
    g.add(inst);
  }
  g.userData.count = conifers.length + broads.length;
  return g;
}

const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

/** 季節で色の変わる木（広葉樹は桜と紅葉、どちらも雪をかぶる） */
function seasonalTreeMaterial(conifer: boolean): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, ENV);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vSeed;\nvarying float vUp;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vUp = normal.y;
        #ifdef USE_INSTANCING
          vSeed = fract(sin(dot(instanceMatrix[3].xz, vec2(12.9898, 78.233))) * 43758.5453);
        #else
          vSeed = 0.5;
        #endif`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying float vSeed;\nvarying float vUp;\n${ENV_DECL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec3 c = diffuseColor.rgb;
          float leaf = step(c.r * 1.05, c.g);
          ${conifer ? '' : `
          vec3 sakura = mix(vec3(0.98, 0.72, 0.8), vec3(1.0, 0.86, 0.9), fract(vSeed * 7.0));
          c = mix(c, sakura, leaf * uBlossom * step(0.45, vSeed));
          vec3 momiji = vSeed < 0.33 ? vec3(0.78, 0.2, 0.1) : vSeed < 0.7 ? vec3(0.9, 0.5, 0.12) : vec3(0.88, 0.72, 0.2);
          c = mix(c, momiji * (0.8 + 0.3 * fract(vSeed * 13.0)), leaf * uAutumn * 0.9);`}
          c = mix(c, c * vec3(0.8, 0.95, 0.75), leaf * uSummer * 0.6);
          c = mix(c, vec3(0.94, 0.96, 0.98), uSnow * smoothstep(0.2, 0.7, vUp) * 0.85);
          diffuseColor.rgb = c;
        }`);
  };
  return mat;
}

/** 範囲の中で test が真になる木を消す（道路や建物の場所） */
export function clearTrees(group: THREE.Group, box: { minX: number; maxX: number; minZ: number; maxZ: number }, test: (x: number, z: number) => boolean): void {
  for (const child of group.children) {
    const inst = child as THREE.InstancedMesh;
    const xz = inst.userData.xz as Float32Array | undefined;
    if (!xz) continue;
    let changed = false;
    for (let i = 0; i < inst.count; i++) {
      const x = xz[i * 2], z = xz[i * 2 + 1];
      if (x < box.minX || x > box.maxX || z < box.minZ || z > box.maxZ) continue;
      if (!test(x, z)) continue;
      inst.setMatrixAt(i, HIDDEN);
      xz[i * 2] = 1e9;
      changed = true;
    }
    if (changed) inst.instanceMatrix.needsUpdate = true;
  }
}
