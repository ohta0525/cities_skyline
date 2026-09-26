import * as THREE from 'three';
import { BASE_Y, CELL, GRID, HALF, MAP_SIZE, gridHeight, type Terrain } from '../world/terrain';

/**
 * ジオラマの「箱」：地形の側面（地層の断面）、海の側面、木の台座、机。
 */

const N = GRID + 1;
export const PLINTH_H = 30;
const PLINTH_PAD = 14;

interface EdgePoint { x: number; z: number; h: number; s: number }

/** 4 辺それぞれの格子点。s は辺に沿った距離 */
function edges(t: Terrain): { pts: EdgePoint[]; out: THREE.Vector3 }[] {
  const mk = (f: (k: number) => [number, number]) => {
    const pts: EdgePoint[] = [];
    for (let k = 0; k < N; k++) {
      const [i, j] = f(k);
      pts.push({ x: i * CELL - HALF, z: j * CELL - HALF, h: gridHeight(t, i, j), s: k * CELL });
    }
    return pts;
  };
  return [
    { pts: mk((k) => [k, 0]), out: new THREE.Vector3(0, 0, -1) },
    { pts: mk((k) => [k, GRID]), out: new THREE.Vector3(0, 0, 1) },
    { pts: mk((k) => [0, k]), out: new THREE.Vector3(-1, 0, 0) },
    { pts: mk((k) => [GRID, k]), out: new THREE.Vector3(1, 0, 0) },
  ];
}

/** 上端と下端の 2 行からなる帯状のメッシュを作る */
function strip(pts: EdgePoint[], out: THREE.Vector3, top: (p: EdgePoint) => number, bottom: (p: EdgePoint) => number, offset: number) {
  const pos: number[] = [], nrm: number[] = [], aTop: number[] = [], aS: number[] = [], idx: number[] = [];
  for (const p of pts) {
    for (const y of [top(p), bottom(p)]) {
      pos.push(p.x + out.x * offset, y, p.z + out.z * offset);
      nrm.push(out.x, out.y, out.z);
      aTop.push(p.h);
      aS.push(p.s + (out.x !== 0 ? 5000 : 0) + (out.x + out.z > 0 ? 2500 : 0));
    }
  }
  // 巻き順が外向きになるように判定する
  const t0 = new THREE.Vector3(pos[0], pos[1], pos[2]);
  const b0 = new THREE.Vector3(pos[3], pos[4], pos[5]);
  const t1 = new THREE.Vector3(pos[6], pos[7], pos[8]);
  const cross = new THREE.Vector3().subVectors(b0, t0).cross(new THREE.Vector3().subVectors(t1, t0));
  const flip = cross.dot(out) < 0;
  for (let k = 0; k < pts.length - 1; k++) {
    const t = k * 2, b = t + 1, t2 = t + 2, b2 = t + 3;
    if (flip) idx.push(t, t2, b, t2, b2, b);
    else idx.push(t, b, t2, t2, b, b2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('aTop', new THREE.Float32BufferAttribute(aTop, 1));
  geo.setAttribute('aS', new THREE.Float32BufferAttribute(aS, 1));
  geo.setIndex(idx);
  return geo;
}

/** 地層の断面を描くマテリアル。色は世界座標の高さで決める */
function strataMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 });
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aTop;\nattribute float aS;\nvarying float vY;\nvarying float vTop;\nvarying float vS;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvY = position.y;\nvTop = aTop;\nvS = aS;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vY;\nvarying float vTop;\nvarying float vS;')
      .replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        `float w = sin(vS * 0.011) * 2.6 + sin(vS * 0.037 + 1.3) * 1.1;
        float y = vY + w;
        vec3 c;
        if (y > -6.0) c = vec3(0.54, 0.39, 0.26);
        else if (y > -15.0) c = vec3(0.69, 0.54, 0.35);
        else if (y > -18.0) c = vec3(0.60, 0.47, 0.33);
        else if (y > -33.0) c = vec3(0.50, 0.42, 0.35);
        else if (y > -47.0) c = vec3(0.42, 0.40, 0.38);
        else c = vec3(0.33, 0.31, 0.30);
        if (vY > vTop - 1.4) c = vTop < 2.0 ? vec3(0.88, 0.80, 0.58) : vec3(0.42, 0.62, 0.26);
        else if (vY > vTop - 5.0) c = mix(c, vec3(0.40, 0.29, 0.20), 0.8);
        c *= (0.93 + 0.07 * sin(y * 2.7)) * 1.2;
        vec4 diffuseColor = vec4( pow(c, vec3(2.2)), opacity );`,
      );
  };
  return mat;
}

export function buildDiorama(t: Terrain, waterMat: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  g.name = 'diorama';
  const soil = strataMaterial();
  for (const e of edges(t)) {
    const side = new THREE.Mesh(strip(e.pts, e.out, (p) => p.h, () => BASE_Y, 0), soil);
    side.receiveShadow = true;
    g.add(side);
    if (e.pts.some((p) => p.h < 0)) {
      const water = new THREE.Mesh(strip(e.pts, e.out, () => 0, (p) => Math.min(0, p.h), 0.25), waterMat);
      water.renderOrder = 2;
      g.add(water);
    }
  }

  const plinth = new THREE.Mesh(
    new THREE.BoxGeometry(MAP_SIZE + PLINTH_PAD * 2, PLINTH_H, MAP_SIZE + PLINTH_PAD * 2),
    new THREE.MeshStandardMaterial({ color: '#5b3f2c', roughness: 0.55, metalness: 0 }),
  );
  plinth.position.y = BASE_Y - PLINTH_H / 2;
  plinth.castShadow = true;
  plinth.receiveShadow = true;
  g.add(plinth);

  const table = new THREE.Mesh(
    new THREE.PlaneGeometry(40000, 40000),
    new THREE.MeshStandardMaterial({ color: '#cfd3c8', roughness: 1 }),
  );
  table.rotation.x = -Math.PI / 2;
  table.position.y = BASE_Y - PLINTH_H;
  table.receiveShadow = true;
  g.add(table);
  return g;
}

/** 台座の正面（南側）に付ける真鍮の銘板 */
export function buildNameplate(text: string): THREE.Mesh {
  const cv = document.createElement('canvas');
  cv.width = 2048; cv.height = 128;
  const ctx = cv.getContext('2d')!;
  const grd = ctx.createLinearGradient(0, 0, 0, 128);
  grd.addColorStop(0, '#e2c98e'); grd.addColorStop(0.5, '#c9a661'); grd.addColorStop(1, '#a98848');
  ctx.fillStyle = grd; ctx.fillRect(0, 0, 2048, 128);
  ctx.strokeStyle = '#6f5528'; ctx.lineWidth = 6; ctx.strokeRect(8, 8, 2032, 112);
  ctx.fillStyle = '#3b2c12';
  ctx.font = '700 64px "M PLUS 1p", "Hiragino Sans", sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, 1024, 68);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(640, 40),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.35, metalness: 0.6 }),
  );
  mesh.position.set(0, BASE_Y - PLINTH_H / 2, HALF + PLINTH_PAD + 0.3);
  mesh.name = 'nameplate';
  return mesh;
}
