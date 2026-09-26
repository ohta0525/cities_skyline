import * as THREE from 'three';
import type { Building } from '../city/buildings';
import type { City } from '../city/city';
import { bbox, closestOnCurve } from '../city/geometry';
import { halfWidth, sampleProfile } from '../city/roads';
import { buildBuildingGeometry, buildingMaterial } from './buildingMesh';
import { DistrictOverlay, ZoneOverlay } from './overlays';
import { buildRoadGhost, buildRoadMesh, roadMaterial } from './roadMesh';
import { buildFacilityGeometry, buildRubbleGeometry } from './facilityMesh';
import { FireFx, iconTexture } from './effects';
import { HAZARD_MODES, TINTS, buildHazardOverlay, type InfoMode, type Tint } from './infoView';
import { FACILITIES, type FacilityCategory } from '../city/facilities';
import { Vehicles, buildTransitStatic, pathY } from './transitView';
import { Rain, buildDefenses, buildFloodWater } from './waterView';

export type Pickable = { kind: 'building' | 'facility'; id: number };
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
  private seen = { roads: -1, cells: -1, buildings: -1, districts: -1, epoch: -1, facilities: -1, fires: -1, services: -1 };
  private highlightMesh = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial({ color: '#ff5a4a', transparent: true, opacity: 0.55, depthTest: false }),
  );
  private raycaster = new THREE.Raycaster();
  private ghostGeo?: THREE.BufferGeometry;
  /** 区画の道具を使っている間は、建物のあるマスや未指定のマスも見せる */
  showAllCells = false;
  private facilities = new Map<number, THREE.Mesh>();
  private facilityGroup = new THREE.Group();
  private rubbleGroup = new THREE.Group();
  private tarpGeo = new THREE.BoxGeometry(1, 0.15, 1);
  private tarpMat = new THREE.MeshStandardMaterial({ color: '#2f6fd6', roughness: 0.6 });
  readonly fire = new FireFx();
  private icons = new THREE.Group();
  private iconMats = {
    power: new THREE.SpriteMaterial({ map: iconTexture('電', '#e0513e'), depthTest: false }),
    water: new THREE.SpriteMaterial({ map: iconTexture('水', '#2f7fc1'), depthTest: false }),
  };
  private infoMode: InfoMode = 'none';
  private transitStatic = new THREE.Group();
  readonly vehicles: Vehicles;
  private overlay = new THREE.Group();
  private seenTransit = '';
  private seenTraffic = -1;
  private defensesMesh?: THREE.Mesh;
  private defenseMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
  private floodMesh?: THREE.Mesh;
  private seenWater = '';
  readonly rain = new Rain();
  /** 0〜1。嵐のときの空の暗さ */
  weather = 0;
  private infoSeen = '';
  private hazard?: THREE.Mesh;
  private rings = new THREE.Group();
  private tintMats = Object.fromEntries(
    (Object.keys(TINTS) as Tint[]).map((k) => [k, new THREE.MeshStandardMaterial({ color: TINTS[k], roughness: 0.8 })]),
  ) as Record<Tint, THREE.MeshStandardMaterial>;

  constructor(private world: World3D, private city: City) {
    this.group.name = 'city';
    this.group.add(this.buildingGroup, this.facilityGroup, this.rubbleGroup, this.fire.group, this.icons, this.rings, this.zones.zoned, this.zones.grid, this.districts.mesh, this.highlightMesh);
    this.icons.renderOrder = 20;
    this.vehicles = new Vehicles(this.buildingMat);
    this.group.add(this.transitStatic, this.vehicles.group, this.overlay, this.rain.lines);
    this.highlightMesh.renderOrder = 11;
    this.highlightMesh.visible = false;
    world.scene.add(this.group);
  }

  setCity(city: City): void {
    this.city = city;
    this.seen = { roads: -1, cells: -1, buildings: -1, districts: -1, epoch: -1, facilities: -1, fires: -1, services: -1 };
    for (const m of this.buildings.values()) { this.buildingGroup.remove(m); m.geometry.dispose(); }
    this.buildings.clear();
    for (const m of this.facilities.values()) { this.facilityGroup.remove(m); m.geometry.dispose(); }
    this.facilities.clear();
    this.infoSeen = '';
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
    const buildingsChanged = v.buildings !== this.seen.buildings || epochChanged;
    if (buildingsChanged) {
      this.syncBuildings(epochChanged);
      this.syncTarps(day);
    }
    if (v.facilities !== this.seen.facilities || epochChanged) {
      this.syncFacilities(epochChanged);
      this.seen.facilities = v.facilities;
    }
    if (v.fires !== this.seen.fires || epochChanged) {
      this.syncRubble();
      this.seen.fires = v.fires;
    }
    if (v.services !== this.seen.services || buildingsChanged) {
      this.syncIcons();
      this.seen.services = v.services;
    }
    this.syncFire();
    const tKey = `${v.transit}:${v.roads}:${v.traffic}:${this.world.terrainEpoch}`;
    if (tKey !== this.seenTransit) {
      for (const g of [...this.transitStatic.children]) {
        g.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
        this.transitStatic.remove(g);
      }
      this.transitStatic.add(buildTransitStatic(c, this.buildingMat));
      this.vehicles.syncTransit(c);
      this.seenTransit = tKey;
    }
    // 堤防・防潮堤・浸水
    const wKey = `${v.water}:${this.world.terrainEpoch}:${Math.floor(day)}`;
    if (wKey !== this.seenWater) {
      if (this.defensesMesh) { this.group.remove(this.defensesMesh); this.defensesMesh.geometry.dispose(); }
      this.defensesMesh = buildDefenses(c, this.defenseMat);
      this.group.add(this.defensesMesh);
      if (this.floodMesh) { this.group.remove(this.floodMesh); this.floodMesh.geometry.dispose(); this.floodMesh = undefined; }
      const f = c.flood;
      if (f && day < f.until) {
        const fade = Math.max(0.15, 1 - (day - f.day) / (f.until - f.day));
        const m = buildFloodWater(c, fade);
        if (m) { this.floodMesh = m; this.group.add(m); }
      }
      this.seenWater = wKey;
    }
    // 嵐の近くは空が暗く、雨が降る
    const st = c.activeStorm();
    this.weather = st && day >= st.hit - 1 && day <= st.end ? (st.kind === 'typhoon' ? 0.8 : 0.6) * (day >= st.hit ? 1 : 0.6) : 0;
    if (v.traffic !== this.seenTraffic) {
      this.vehicles.syncCars(c);
      this.seenTraffic = v.traffic;
    }
    const infoKey = `${this.infoMode}:${v.services}:${v.buildings}:${v.facilities}:${this.world.terrainEpoch}:${this.infoMode === 'traffic' || this.infoMode === 'transit' ? `${v.traffic}:${v.transit}:${v.roads}` : ''}`;
    if (infoKey !== this.infoSeen) { this.applyInfo(); this.infoSeen = infoKey; }
    if (v.cells !== this.seen.cells || buildingsChanged) {
      this.zones.rebuild(c.cells.values(), c.terrain, false);
      this.seen.cells = v.cells;
    }
    this.seen.buildings = v.buildings;
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

  update(time: number, dt = 0): void {
    this.fire.update(time);
    this.vehicles.update(dt);
    this.rain.update(Math.min(0.1, dt || 0.016), this.world.controls.target, this.weather);
  }

  private place(m: THREE.Mesh, o: { ax: number; az: number; nx: number; nz: number; x: number; y: number; z: number }): void {
    const X = new THREE.Vector3(o.ax, 0, o.az);
    const Z = new THREE.Vector3(o.nx, 0, o.nz);
    if (new THREE.Vector3().crossVectors(X, new THREE.Vector3(0, 1, 0)).dot(Z) < 0) X.negate();
    m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, new THREE.Vector3(0, 1, 0), Z));
    m.position.set(o.x, o.y, o.z);
  }

  private syncFacilities(all: boolean): void {
    const c = this.city;
    for (const [id, m] of this.facilities) {
      if (!c.facilities.has(id) || all) { this.facilityGroup.remove(m); m.geometry.dispose(); this.facilities.delete(id); }
    }
    for (const f of c.facilities.values()) {
      if (this.facilities.has(f.id)) continue;
      const m = new THREE.Mesh(buildFacilityGeometry(f), this.buildingMat);
      this.place(m, f);
      m.castShadow = true;
      m.receiveShadow = true;
      m.userData.facilityId = f.id;
      this.facilityGroup.add(m);
      this.facilities.set(f.id, m);
      const W = f.w * 8, D = f.d * 8, R = Math.hypot(W, D) / 2 + 2;
      const cx = f.x + f.nx * D / 2, cz = f.z + f.nz * D / 2;
      this.world.clearTrees({ minX: cx - R, maxX: cx + R, minZ: cz - R, maxZ: cz + R }, (x, z) => {
        const dx = x - f.x, dz = z - f.z;
        return Math.abs(dx * f.ax + dz * f.az) < W / 2 + 1 && dx * f.nx + dz * f.nz > -1 && dx * f.nx + dz * f.nz < D + 1;
      });
    }
  }

  private syncRubble(): void {
    for (const m of [...this.rubbleGroup.children] as THREE.Mesh[]) { this.rubbleGroup.remove(m); m.geometry.dispose(); }
    for (const r of this.city.rubble) {
      const m = new THREE.Mesh(buildRubbleGeometry(r), this.buildingMat);
      this.place(m, r);
      m.castShadow = true;
      m.receiveShadow = true;
      this.rubbleGroup.add(m);
    }
  }

  /** 被災した建物の屋根にブルーシート */
  private syncTarps(day: number): void {
    for (const [id, m] of this.buildings) {
      const b = this.city.buildings.get(id);
      const want = !!b && !!b.damagedUntil && b.damagedUntil > day;
      const tarp = m.children.find((x) => x.userData.tarp);
      if (want && !tarp) {
        const bb = m.geometry.boundingBox!;
        const t = new THREE.Mesh(this.tarpGeo, this.tarpMat);
        t.userData.tarp = true;
        t.scale.set((bb.max.x - bb.min.x) * 0.55, 1, (bb.max.z - bb.min.z) * 0.4);
        t.position.set((bb.max.x + bb.min.x) / 2, bb.max.y + 0.1, (bb.max.z + bb.min.z) / 2 + 1);
        t.rotation.y = 0.2;
        m.add(t);
      } else if (!want && tarp) m.remove(tarp);
    }
  }

  private syncFire(): void {
    const list = [];
    for (const f of this.city.fires) {
      const m = this.buildings.get(f.building);
      if (!m) continue;
      const bb = m.geometry.boundingBox!;
      const center = new THREE.Vector3((bb.max.x + bb.min.x) / 2, bb.max.y * m.scale.y, (bb.max.z + bb.min.z) / 2).applyMatrix4(m.matrixWorld);
      list.push({ id: f.building, x: center.x, y: center.y, z: center.z, size: Math.min(14, Math.max(4, (bb.max.x - bb.min.x) * 0.6)), intensity: f.intensity });
    }
    this.fire.sync(list);
  }

  private syncIcons(): void {
    for (const s of [...this.icons.children]) this.icons.remove(s);
    const per = this.city.services?.per;
    if (!per) return;
    let n = 0;
    for (const [id, m] of this.buildings) {
      const sv = per.get(id);
      if (!sv || (sv.power && sv.water)) continue;
      if (n++ > 800) break;
      const sp = new THREE.Sprite(sv.power ? this.iconMats.water : this.iconMats.power);
      const bb = m.geometry.boundingBox!;
      const top = new THREE.Vector3((bb.max.x + bb.min.x) / 2, bb.max.y + 4, (bb.max.z + bb.min.z) / 2).applyMatrix4(m.matrixWorld);
      sp.position.copy(top);
      sp.scale.setScalar(5);
      sp.renderOrder = 20;
      this.icons.add(sp);
    }
  }

  // ---------- 情報表示（インフラ・サービス・ハザード） ----------
  setInfo(mode: InfoMode): void {
    this.infoMode = mode;
    this.infoSeen = '';
  }

  private applyInfo(): void {
    const mode = this.infoMode;
    const per = this.city.services?.per;
    // 建物の色分け
    const tint = (id: number): Tint | null => {
      const s = per?.get(id);
      if (mode === 'traffic' || mode === 'transit') return null;
      if (!s) return mode === 'none' || HAZARD_MODES.includes(mode) ? null : 'none';
      switch (mode) {
        case 'power': return s.power ? 'good' : 'bad';
        case 'water': return s.water ? 'good' : 'bad';
        case 'sewage': return s.sewage ? 'good' : 'bad';
        case 'garbage': return s.garbage ? 'good' : 'bad';
        case 'fire': case 'police': case 'health': case 'education': {
          const v = s[mode];
          return v > 0.4 ? 'good' : v > 0 ? 'ok' : 'bad';
        }
        case 'happiness': return s.happiness >= 65 ? 'good' : s.happiness >= 50 ? 'ok' : s.happiness >= 35 ? 'warn' : 'bad';
        default: return null;
      }
    };
    for (const [id, m] of this.buildings) {
      const t = tint(id);
      m.material = t ? this.tintMats[t] : this.buildingMat;
    }
    this.icons.visible = mode === 'none' || mode === 'power' || mode === 'water';
    // サービスの届く範囲
    for (const r of [...this.rings.children] as THREE.Mesh[]) { this.rings.remove(r); r.geometry.dispose(); }
    const cat: FacilityCategory | null = mode === 'fire' || mode === 'police' || mode === 'health' || mode === 'education' ? mode : null;
    if (cat) {
      for (const f of this.city.facilities.values()) {
        const def = FACILITIES[f.kind];
        if (def.cat !== cat || !def.radius) continue;
        const ring = new THREE.Mesh(
          new THREE.CircleGeometry(def.radius, 64).rotateX(-Math.PI / 2),
          new THREE.MeshBasicMaterial({ color: '#7fc4ff', transparent: true, opacity: 0.14, depthWrite: false, depthTest: false }),
        );
        ring.position.set(f.x + f.nx * f.d * 4, f.y + 3, f.z + f.nz * f.d * 4);
        ring.renderOrder = 6;
        this.rings.add(ring);
      }
    }
    // 交通量と路線
    for (const m of [...this.overlay.children] as THREE.Mesh[]) { this.overlay.remove(m); m.geometry.dispose(); }
    if (mode === 'traffic') this.overlay.add(this.trafficOverlay());
    if (mode === 'transit') this.overlay.add(this.transitOverlay());
    // ハザードマップ
    if (this.hazard) { this.group.remove(this.hazard); this.hazard.geometry.dispose(); this.hazard = undefined; }
    if (HAZARD_MODES.includes(mode)) {
      this.hazard = buildHazardOverlay(this.city.terrain, mode);
      this.group.add(this.hazard);
    }
  }

  /** 道路を混み具合で色分けする */
  private trafficOverlay(): THREE.Mesh {
    const pos: number[] = [], col: number[] = [];
    const c = new THREE.Color();
    const ramp = (x: number) => (x < 0.5 ? c.set('#4cc26a') : x < 0.8 ? c.set('#e8d23e') : x < 1 ? c.set('#f08a2e') : c.set('#e0413a'));
    for (const s of this.city.net.segments.values()) {
      const vc = this.city.traffic.vc.get(s.id) ?? 0;
      const vol = this.city.traffic.volume.get(s.id) ?? 0;
      ramp(vol < 1 ? 0 : vc);
      const cv = this.city.net.curveOf(s);
      const n = 16;
      const w = Math.max(1.5, halfWidth(s.type) * 0.8);
      for (let k = 0; k < n; k++) {
        const pts = [k / n, (k + 1) / n].map((t) => {
          const p = { x: 0, z: 0 };
          const u = 1 - t;
          p.x = u * u * cv.p0.x + 2 * u * t * cv.c.x + t * t * cv.p2.x;
          p.z = u * u * cv.p0.z + 2 * u * t * cv.c.z + t * t * cv.p2.z;
          return { ...p, t };
        });
        const dx = pts[1].x - pts[0].x, dz = pts[1].z - pts[0].z, l = Math.hypot(dx, dz) || 1;
        const nx = -dz / l * w, nz = dx / l * w;
        const y0 = sampleProfile(s.ys, pts[0].t) + 1.2, y1 = sampleProfile(s.ys, pts[1].t) + 1.2;
        const q = [[pts[0].x + nx, y0, pts[0].z + nz], [pts[1].x + nx, y1, pts[1].z + nz], [pts[1].x - nx, y1, pts[1].z - nz], [pts[0].x - nx, y0, pts[0].z - nz]];
        for (const i of [0, 1, 2, 0, 2, 3]) { pos.push(...q[i]); col.push(c.r, c.g, c.b); }
      }
    }
    return this.flatMesh(pos, col, 0.85);
  }

  /** 路線を色つきの線で示す */
  private transitOverlay(): THREE.Mesh {
    const pos: number[] = [], col: number[] = [];
    const c = new THREE.Color();
    const t = this.city.transit;
    for (const l of t.lines.values()) {
      c.set(l.color);
      const half = Math.floor(l.path.length / 2) + 1;
      const w = l.mode === 'bus' ? 1.6 : 2.4;
      for (let i = 0; i < Math.min(half, l.path.length - 1); i++) {
        const a = l.path[i], b = l.path[i + 1];
        const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz);
        if (len < 0.1) continue;
        const nx = -dz / len * w, nz = dx / len * w;
        const y = (l.mode === 'rail' ? 12 : 4) + (l.mode === 'subway' ? 2 : pathY(this.city, a));
        const q = [[a.x + nx, y, a.z + nz], [b.x + nx, y, b.z + nz], [b.x - nx, y, b.z - nz], [a.x - nx, y, a.z - nz]];
        for (const k of [0, 1, 2, 0, 2, 3]) { pos.push(...q[k]); col.push(c.r, c.g, c.b); }
      }
    }
    for (const st of t.stops.values()) {
      c.set('#ffffff');
      const y = (st.mode === 'rail' ? 12.2 : 4.2) + (st.mode === 'subway' ? 2 : pathY(this.city, st));
      const r = st.mode === 'bus' || st.mode === 'tram' ? 4 : 9;
      for (let k = 0; k < 16; k++) {
        const a0 = (k / 16) * Math.PI * 2, a1 = ((k + 1) / 16) * Math.PI * 2;
        pos.push(st.x, y, st.z, st.x + Math.cos(a0) * r, y, st.z + Math.sin(a0) * r, st.x + Math.cos(a1) * r, y, st.z + Math.sin(a1) * r);
        col.push(c.r, c.g, c.b, c.r, c.g, c.b, c.r, c.g, c.b);
      }
    }
    return this.flatMesh(pos, col, 0.95);
  }

  private flatMesh(pos: number[], col: number[], opacity: number): THREE.Mesh {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
    m.renderOrder = 9;
    return m;
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

  /** 画面座標の下にある建物か施設 */
  pick(clientX: number, clientY: number, canvas: HTMLCanvasElement): Pickable | null {
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.world.camera);
    const hit = this.raycaster.intersectObjects([...this.buildingGroup.children, ...this.facilityGroup.children], false)[0];
    if (!hit) return null;
    const u = hit.object.userData;
    return u.facilityId ? { kind: 'facility', id: u.facilityId } : u.buildingId ? { kind: 'building', id: u.buildingId } : null;
  }

  /** 撤去の対象を赤く示す */
  highlight(target: { building?: number; facility?: number; segment?: number } | null): void {
    const h = this.highlightMesh;
    h.visible = false;
    this.ghostGeo?.dispose();
    this.ghostGeo = undefined;
    if (!target) return;
    if (target.building || target.facility) {
      const m = target.building ? this.buildings.get(target.building) : this.facilities.get(target.facility!);
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
