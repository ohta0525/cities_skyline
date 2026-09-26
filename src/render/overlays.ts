import * as THREE from 'three';
import { DISTRICT_CELL, DN, type Districts } from '../city/districts';
import { ZONES, cellCorners, type Cell } from '../city/zones';
import { HALF, heightAt, type Terrain } from '../world/terrain';

/** 区画・地区の色つきのマス（夜は暗くする） */
export const OVERLAY_MATS: THREE.MeshBasicMaterial[] = [];

function overlayMaterial(opacity: number): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8,
  });
  OVERLAY_MATS.push(m);
  return m;
}

const ZCOL = new Map(ZONES.map((z) => [z.id as number, new THREE.Color(z.color)]));
const EMPTY = new THREE.Color('#ffffff');

/** 区画のマス。zoned：塗ったが建物のないマス、grid：まだ塗っていないマス */
export class ZoneOverlay {
  readonly zoned = new THREE.Mesh(new THREE.BufferGeometry(), overlayMaterial(0.4));
  readonly grid = new THREE.Mesh(new THREE.BufferGeometry(), overlayMaterial(0.28));

  constructor() {
    this.zoned.renderOrder = 3;
    this.grid.renderOrder = 3;
    this.grid.visible = false;
  }

  rebuild(cells: Iterable<Cell>, terrain: Terrain, showBuilt: boolean): void {
    const zp: number[] = [], zc: number[] = [], gp: number[] = [], gc: number[] = [];
    for (const c of cells) {
      if (c.building && !showBuilt) continue;
      const color = c.zone ? ZCOL.get(c.zone)! : EMPTY;
      const [pos, col] = c.zone ? [zp, zc] : [gp, gc];
      const q = cellCorners(c, 0.45).map((p) => new THREE.Vector3(p.x, heightAt(terrain, p.x, p.z) + 0.3, p.z));
      for (const k of [0, 2, 1, 0, 3, 2]) {
        pos.push(q[k].x, q[k].y, q[k].z);
        col.push(color.r, color.g, color.b);
      }
    }
    const set = (mesh: THREE.Mesh, pos: number[], col: number[]) => {
      mesh.geometry.dispose();
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      mesh.geometry = g;
    };
    set(this.zoned, zp, zc);
    set(this.grid, gp, gc);
  }
}

/** 地区の塗り分け。地形に沿わせるため 1 マスを 4×4 に分ける */
export class DistrictOverlay {
  readonly mesh = new THREE.Mesh(new THREE.BufferGeometry(), overlayMaterial(0.38));

  constructor() {
    this.mesh.renderOrder = 4;
    this.mesh.visible = false;
  }

  rebuild(d: Districts, terrain: Terrain): void {
    const pos: number[] = [], col: number[] = [];
    const colors = new Map(d.list.map((x) => [x.id, new THREE.Color(x.color)]));
    const SUB = 4, s = DISTRICT_CELL / SUB;
    const y = (x: number, z: number) => Math.max(0, heightAt(terrain, x, z)) + 1;
    for (let j = 0; j < DN; j++) {
      for (let i = 0; i < DN; i++) {
        const id = d.grid[j * DN + i];
        const c = id && colors.get(id);
        if (!c) continue;
        const x0 = i * DISTRICT_CELL - HALF, z0 = j * DISTRICT_CELL - HALF;
        for (let b = 0; b < SUB; b++) {
          for (let a = 0; a < SUB; a++) {
            const xa = x0 + a * s, xb = xa + s, za = z0 + b * s, zb = za + s;
            const p = [[xa, za], [xb, za], [xb, zb], [xa, zb]].map(([x, z]) => [x, y(x, z), z]);
            for (const k of [0, 2, 1, 0, 3, 2]) {
              pos.push(...p[k]);
              col.push(c.r, c.g, c.b);
            }
          }
        }
      }
    }
    this.mesh.geometry.dispose();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    this.mesh.geometry = g;
  }
}

/** カーソル位置の輪（ブラシの範囲や吸着先） */
export function ring(color: string): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.RingGeometry(0.9, 1, 48).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthTest: false }),
  );
  m.renderOrder = 10;
  m.visible = false;
  return m;
}
