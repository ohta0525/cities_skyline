import * as THREE from 'three';
import type { Building } from '../city/buildings';
import type { City } from '../city/city';
import { bbox, closestOnCurve } from '../city/geometry';
import { halfWidth } from '../city/roads';
import { buildBuildingGeometry, buildingMaterial } from './buildingMesh';
import { DistrictOverlay, ZoneOverlay } from './overlays';
import { buildRoadGhost, buildRoadMesh, roadMaterial } from './roadMesh';
import type { World3D } from './world3d';

const GROW_DAYS = 3;

/** 街の状態（City）を 3D に映す。City の versions が変わったところだけ作り直す */
export class CityView {
  readonly group = new THREE.Group();
  private roadMat = roadMaterial();
  private buildingMat = buildingMaterial();
  private roadMesh?: THREE.Mesh;
  private buildings = new Map<number, THREE.Mesh>();
  private buildingGroup = new THREE.Group();
  readonly zones = new ZoneOverlay();
  readonly districts = new DistrictOverlay();
  private seen = { roads: -1, cells: -1, buildings: -1, districts: -1, epoch: -1 };
  private highlightMesh = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial({ color: '#ff5a4a', transparent: true, opacity: 0.55, depthTest: false }),
  );
  private raycaster = new THREE.Raycaster();
  private ghostGeo?: THREE.BufferGeometry;
  /** 区画の道具を使っている間は、建物のあるマスや未指定のマスも見せる */
  showAllCells = false;

  constructor(private world: World3D, private city: City) {
    this.group.name = 'city';
    this.group.add(this.buildingGroup, this.zones.zoned, this.zones.grid, this.districts.mesh, this.highlightMesh);
    this.highlightMesh.renderOrder = 11;
    this.highlightMesh.visible = false;
    world.scene.add(this.group);
  }

  setCity(city: City): void {
    this.city = city;
    this.seen = { roads: -1, cells: -1, buildings: -1, districts: -1, epoch: -1 };
    for (const m of this.buildings.values()) { this.buildingGroup.remove(m); m.geometry.dispose(); }
    this.buildings.clear();
  }

  /** 毎フレーム呼ぶ */
  sync(day: number): void {
    const c = this.city, v = c.versions;
    const epochChanged = this.world.terrainEpoch !== this.seen.epoch;
    if (!epochChanged) {
      for (const r of c.terrainChanges) this.world.updateTerrain(r);
    }
    c.terrainChanges.length = 0;

    if (v.roads !== this.seen.roads || epochChanged) {
      if (this.roadMesh) { this.group.remove(this.roadMesh); this.roadMesh.geometry.dispose(); }
      this.roadMesh = buildRoadMesh(c.net, c.terrain, this.roadMat);
      this.group.add(this.roadMesh);
      this.clearTreesAlongRoads();
      this.seen.roads = v.roads;
    }
    if (v.buildings !== this.seen.buildings || epochChanged) {
      this.syncBuildings(epochChanged);
      this.seen.buildings = v.buildings;
    }
    if (v.cells !== this.seen.cells || v.buildings !== this.seen.buildings || epochChanged) {
      this.zones.rebuild(c.cells.values(), c.terrain, false);
      this.seen.cells = v.cells;
    }
    if (v.districts !== this.seen.districts || epochChanged) {
      this.districts.rebuild(c.districts, c.terrain);
      this.seen.districts = v.districts;
    }
    this.seen.epoch = this.world.terrainEpoch;
    this.zones.grid.visible = this.showAllCells;

    // 建ったばかりの建物は下から伸びる
    for (const [id, m] of this.buildings) {
      const b = c.buildings.get(id);
      if (!b) continue;
      const k = Math.min(1, Math.max(0.02, (day - b.day) / GROW_DAYS));
      if (m.scale.y !== k) m.scale.y = k;
    }
  }

  private syncBuildings(all: boolean): void {
    const c = this.city;
    for (const [id, m] of this.buildings) {
      if (!c.buildings.has(id)) {
        this.buildingGroup.remove(m);
        m.geometry.dispose();
        this.buildings.delete(id);
      }
    }
    for (const b of c.buildings.values()) {
      if (this.buildings.has(b.id) && !all) continue;
      if (this.buildings.has(b.id)) {
        const old = this.buildings.get(b.id)!;
        this.buildingGroup.remove(old);
        old.geometry.dispose();
      }
      const m = new THREE.Mesh(buildBuildingGeometry(b), this.buildingMat);
      // x 軸 = 道路沿い、z 軸 = 奥。右手系になるよう x の向きを決める
      const X = new THREE.Vector3(b.ax, 0, b.az);
      const Z = new THREE.Vector3(b.nx, 0, b.nz);
      if (new THREE.Vector3().crossVectors(X, new THREE.Vector3(0, 1, 0)).dot(Z) < 0) X.negate();
      m.matrixAutoUpdate = true;
      m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, new THREE.Vector3(0, 1, 0), Z));
      m.position.set(b.x, b.y, b.z);
      m.castShadow = true;
      m.receiveShadow = true;
      m.userData.buildingId = b.id;
      this.buildingGroup.add(m);
      this.buildings.set(b.id, m);
      this.clearTreesInLot(b);
    }
  }

  private clearTreesAlongRoads(): void {
    for (const s of this.city.net.segments.values()) {
      const cv = this.city.net.curveOf(s);
      const r = halfWidth(s.type) + 3;
      this.world.clearTrees(bbox(cv, r), (x, z) => closestOnCurve(cv, { x, z }).d < r);
    }
  }

  private clearTreesInLot(b: Building): void {
    const W = b.w * 8, D = b.d * 8;
    const cx = b.x + b.nx * D / 2, cz = b.z + b.nz * D / 2;
    const R = Math.hypot(W, D) / 2 + 2;
    this.world.clearTrees({ minX: cx - R, maxX: cx + R, minZ: cz - R, maxZ: cz + R }, (x, z) => {
      const dx = x - b.x, dz = z - b.z;
      const along = dx * b.ax + dz * b.az, depth = dx * b.nx + dz * b.nz;
      return Math.abs(along) < W / 2 + 1 && depth > -1 && depth < D + 1;
    });
  }

  /** 画面座標の下にある建物 */
  pickBuilding(clientX: number, clientY: number, canvas: HTMLCanvasElement): number | null {
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.world.camera);
    const hit = this.raycaster.intersectObjects(this.buildingGroup.children, false)[0];
    return hit ? (hit.object.userData.buildingId as number) : null;
  }

  /** 撤去の対象を赤く示す */
  highlight(target: { building?: number; segment?: number } | null): void {
    const h = this.highlightMesh;
    h.visible = false;
    this.ghostGeo?.dispose();
    this.ghostGeo = undefined;
    if (!target) return;
    if (target.building) {
      const m = this.buildings.get(target.building);
      if (!m) return;
      h.geometry = m.geometry;
      h.position.copy(m.position);
      h.quaternion.copy(m.quaternion);
      h.scale.set(1.02, 1.02 * m.scale.y, 1.02);
      h.visible = true;
    } else if (target.segment) {
      const s = this.city.net.segments.get(target.segment);
      if (!s) return;
      this.ghostGeo = buildRoadGhost([{ curve: this.city.net.curveOf(s), ys: s.ys, bridge: s.bridge }], s.type);
      h.geometry = this.ghostGeo;
      h.position.set(0, 0, 0);
      h.quaternion.identity();
      h.scale.set(1, 1, 1);
      h.visible = true;
    }
  }
}
