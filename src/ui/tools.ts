import * as THREE from 'three';
import type { City } from '../city/city';
import { dist2, type P2 } from '../city/geometry';
import { ROAD_TYPES, type RoadPlan, type RoadType, type Snap } from '../city/roads';
import { ZONES, type ZoneId } from '../city/zones';
import { formatYen } from '../city/economy';
import { CATEGORY_NAMES, FACILITIES, facilitiesIn, type FacilityCategory, type FacilityKind } from '../city/facilities';
import { MODES, trackCost, trackProfile, type TrackLevel, type TransitMode } from '../city/transit';
import { NODE_CONTROL_COST, NODE_CONTROL_NAMES } from '../city/city';
import type { NodeControl } from '../city/roads';
import type { CityView } from '../render/cityView';
import { ring } from '../render/overlays';
import { buildRoadGhost } from '../render/roadMesh';
import type { World3D } from '../render/world3d';
import { heightAt } from '../world/terrain';

export type ToolId = 'none' | 'road' | 'zone' | 'district' | 'facility' | 'traffic' | 'transit' | 'bulldoze';

const BRUSHES = [{ r: 12, label: '小' }, { r: 28, label: '中' }, { r: 56, label: '大' }];

interface Ui {
  toast: (msg: string) => void;
}

/** 道具の状態と、キャンバス上のマウス操作 */
export class Tools {
  tool: ToolId = 'none';
  roadType: RoadType = 'local';
  roadMode: 'straight' | 'curve' = 'straight';
  snapOn = true;
  zone: ZoneId = 1;
  brush = 28;
  districtId = 0;
  districtErase = false;
  facilityCat: FacilityCategory = 'power';
  facilityKind: FacilityKind = 'solar';
  trafficMode: 'oneway' | 'node' | 'elevate' = 'oneway';
  nodeControl: NodeControl = 'turnlane';
  transitMode: TransitMode = 'bus';
  trackLevel: TrackLevel = 'ground';
  privateRail = false;
  /** 作りかけの路線の停留所・駅 */
  pending: number[] = [];
  private hoverTarget: { seg?: number; node?: number; track?: number; stop?: number } | null = null;

  private start: Snap | null = null;
  private control: P2 | null = null;
  private plan: RoadPlan | null = null;
  private pointer: { x: number; y: number } | null = null;
  private painting = false;
  private shift = false;
  private rightDown: { x: number; y: number } | null = null;
  private bulldozeTarget: { building?: number; facility?: number; segment?: number } | null = null;
  private facilityGhost = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ color: '#4fc3ff', transparent: true, opacity: 0.4, depthTest: false }),
  );

  private ghost = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial({ color: '#4fc3ff', transparent: true, opacity: 0.55, depthTest: false }),
  );
  private brushRing = ring('#ffffff');
  private snapRing = ring('#f2b134');
  private tip = document.getElementById('tip')!;
  private subbar = document.getElementById('subbar')!;

  constructor(private world: World3D, private city: City, private view: CityView, private canvas: HTMLCanvasElement, private ui: Ui) {
    this.ghost.renderOrder = 12;
    this.ghost.visible = false;
    this.facilityGhost.renderOrder = 12;
    this.facilityGhost.visible = false;
    world.scene.add(this.ghost, this.brushRing, this.snapRing, this.facilityGhost);

    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointerleave', () => { this.pointer = null; this.tip.hidden = true; });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Shift') this.shift = true;
      if (e.key === 'Escape') this.cancel();
      if (e.key === 'Enter' && this.tool === 'transit' && !(e.target instanceof HTMLInputElement)) this.finishLine();
    });
    window.addEventListener('keyup', (e) => { if (e.key === 'Shift') this.shift = false; });

    document.querySelectorAll<HTMLButtonElement>('.tools button[data-tool]').forEach((b) => {
      b.onclick = () => this.select(this.tool === b.dataset.tool ? 'none' : (b.dataset.tool as ToolId));
    });
    this.renderSubbar();
  }

  setCity(city: City): void {
    this.city = city;
    this.cancel(true);
  }

  select(tool: ToolId): void {
    const blocked = tool !== 'none' && this.city.blockedReason();
    if (blocked) { this.ui.toast(blocked); tool = 'none'; }
    this.tool = tool;
    this.pending = [];
    this.start = null;
    this.control = null;
    this.plan = null;
    document.querySelectorAll<HTMLButtonElement>('.tools button[data-tool]').forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.tool === tool)),
    );
    this.view.showAllCells = tool === 'zone' || tool === 'road';
    this.view.districts.mesh.visible = tool === 'district';
    this.view.highlight(null);
    this.renderSubbar();
    this.refresh();
  }

  /** Esc：置きかけの道路をやめる。何もなければ道具を外す */
  private cancel(force = false): void {
    if (!force && this.tool === 'transit' && this.pending.length) {
      this.pending = [];
      this.renderSubbar();
      this.refresh();
      return;
    }
    if (!force && this.tool === 'road' && this.start) {
      this.start = null; this.control = null; this.plan = null;
      this.refresh();
      return;
    }
    this.select('none');
  }

  // ---------- マウス ----------
  private onDown = (e: PointerEvent) => {
    if (e.button === 2) { this.rightDown = { x: e.clientX, y: e.clientY }; return; }
    if (e.button !== 0) return;
    this.pointer = { x: e.clientX, y: e.clientY };
    const hit = this.world.pick(e.clientX, e.clientY);
    if (this.tool === 'road' && hit) this.clickRoad(hit.point);
    else if ((this.tool === 'zone' || this.tool === 'district') && hit) { this.painting = true; this.paint(hit.point); }
    else if (this.tool === 'bulldoze') this.bulldoze();
    else if (this.tool === 'facility' && hit) this.placeFacility(hit.point);
    else if (this.tool === 'traffic') this.clickTraffic();
    else if (this.tool === 'transit' && hit) this.clickTransit(hit.point);
  };

  private onMove = (e: PointerEvent) => {
    this.pointer = { x: e.clientX, y: e.clientY };
    this.refresh();
  };

  private onUp = (e: PointerEvent) => {
    if (e.button === 0) this.painting = false;
    if (e.button === 2 && this.rightDown) {
      // 右クリック（ドラッグせずに離した）で置きかけの道路をやめる
      if (Math.hypot(e.clientX - this.rightDown.x, e.clientY - this.rightDown.y) < 4 && this.start) {
        this.start = null; this.control = null; this.plan = null;
        this.refresh();
      }
      this.rightDown = null;
    }
  };

  /** カーソルの位置に合わせて、見本や吸着の表示を更新する */
  refresh(): void {
    (this.snapRing.material as THREE.MeshBasicMaterial).color.set('#f2b134');
    this.ghost.visible = false;
    this.facilityGhost.visible = false;
    this.brushRing.visible = false;
    this.snapRing.visible = false;
    this.tip.hidden = true;
    if (!this.pointer || this.tool === 'none') return;
    const hit = this.world.pick(this.pointer.x, this.pointer.y);

    if (this.tool === 'bulldoze') {
      const b = this.view.pick(this.pointer.x, this.pointer.y, this.canvas);
      let target: { building?: number; facility?: number; segment?: number } | null = null;
      const stop = hit ? [...this.city.transit.stops.values()].find((st) => Math.hypot(st.x - hit.point.x, st.z - hit.point.z) < 12) : undefined;
      if (stop) {
        this.bulldozeTarget = { stop: stop.id } as never;
        this.view.highlight(null);
        this.markAt(stop, stop.y ?? hit!.point.y, 8, '#ff5a4a');
        this.showTip(`クリックで${stop.name}（${MODES[stop.mode].stopName}）を撤去`);
        return;
      }
      if (b?.kind === 'building') target = { building: b.id };
      else if (b?.kind === 'facility') target = { facility: b.id };
      else if (hit) {
        const s = this.city.net.segmentAt({ x: hit.point.x, z: hit.point.z });
        if (s) target = { segment: s.seg.id };
      }
      this.bulldozeTarget = target;
      this.view.highlight(target);
      if (target?.building) this.showTip(this.city.buildings.get(target.building) ? 'クリックで建物を取り壊す' : '');
      else if (target?.facility) {
        const f = this.city.facilities.get(target.facility);
        if (f) this.showTip(`クリックで${FACILITIES[f.kind].name}を撤去（建設費の半分が戻る）`);
      }
      else if (target?.segment) this.showTip('クリックで道路を撤去');
      return;
    }
    if (!hit) return;
    const p = { x: hit.point.x, z: hit.point.z };

    if (this.tool === 'traffic') { this.hoverTraffic(p, hit.point.y); return; }
    if (this.tool === 'transit') { this.hoverTransit(p, hit.point.y); return; }

    if (this.tool === 'facility') {
      const plan = this.city.planFacility(p, this.facilityKind);
      const def = FACILITIES[this.facilityKind];
      const W = def.w * 8, D = def.d * 8, H = 8;
      const g = this.facilityGhost;
      g.scale.set(W - 1, H, D - 1);
      const X = new THREE.Vector3(plan.ax, 0, plan.az), Z = new THREE.Vector3(plan.nx, 0, plan.nz);
      if (new THREE.Vector3().crossVectors(X, new THREE.Vector3(0, 1, 0)).dot(Z) < 0) X.negate();
      g.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, new THREE.Vector3(0, 1, 0), Z));
      g.position.set(plan.x, plan.y + H / 2, plan.z).addScaledVector(Z, D / 2);
      g.visible = plan.cells.length > 0;
      (g.material as THREE.MeshBasicMaterial).color.set(plan.ok ? '#4fc3ff' : '#ff5a4a');
      this.showTip(plan.ok ? `${def.name}　${formatYen(def.cost)}（維持費 月 ${formatYen(def.upkeep)}）` : plan.reason ?? '置けません', !plan.ok);
      return;
    }

    if (this.tool === 'zone' || this.tool === 'district') {
      this.brushRing.visible = true;
      this.brushRing.position.set(p.x, hit.point.y + 1, p.z);
      this.brushRing.scale.setScalar(this.brush);
      (this.brushRing.material as THREE.MeshBasicMaterial).color.set(this.brushColor());
      if (this.painting) this.paint(hit.point);
      return;
    }

    // 道路
    const snapping = this.snapOn && !this.shift;
    let end = this.city.snap(p, snapping);
    if (this.start && end.kind === 'free' && snapping) end = { kind: 'free', p: this.guide(this.start, end.p) };
    const marker = end;
    if (marker.kind !== 'free') {
      this.snapRing.visible = true;
      this.snapRing.position.set(marker.p.x, heightAt(this.city.terrain, marker.p.x, marker.p.z) + 1.5, marker.p.z);
      this.snapRing.scale.setScalar(ROAD_TYPES[this.roadType].width / 2 + 1.5);
    }
    if (!this.start) {
      this.showTip(`${ROAD_TYPES[this.roadType].name}：クリックで始点を置く`);
      return;
    }
    const waitingControl = this.roadMode === 'curve' && !this.control;
    this.plan = this.city.planRoad(this.start, end, waitingControl ? null : this.control, this.roadType);
    const plan = this.plan;
    const pieces = plan.ok ? plan.pieces : [{ curve: plan.curve, ys: this.flatYs(plan), bridge: [false, false] }];
    this.ghost.geometry.dispose();
    this.ghost.geometry = buildRoadGhost(pieces, this.roadType);
    (this.ghost.material as THREE.MeshBasicMaterial).color.set(plan.ok ? '#4fc3ff' : '#ff5a4a');
    this.ghost.visible = true;
    const len = `${Math.round(plan.length)} m`;
    if (waitingControl) this.showTip(`${len}　クリックで曲がる位置を決める`);
    else {
      const problem = this.city.checkRoad(plan);
      const cost = plan.ok ? `　${formatYen(this.city.roadCost(plan))}` : '';
      if (problem) this.showTip(`${problem}${plan.ok ? cost : ''}`, true);
      else this.showTip(`${ROAD_TYPES[this.roadType].name}　${len}${plan.bridgeLength > 0 ? `（うち橋 ${Math.round(plan.bridgeLength)} m）` : ''}${cost}`);
      if (problem && plan.ok) (this.ghost.material as THREE.MeshBasicMaterial).color.set('#ff5a4a');
    }
  }

  /** 置けないときの見本用に、地形に沿った高さを作る */
  private flatYs(plan: RoadPlan): number[] {
    const ys: number[] = [];
    for (let k = 0; k <= 8; k++) {
      const t = k / 8, u = 1 - t, cv = plan.curve;
      const x = u * u * cv.p0.x + 2 * u * t * cv.c.x + t * t * cv.p2.x;
      const z = u * u * cv.p0.z + 2 * u * t * cv.c.z + t * t * cv.p2.z;
      ys.push(Math.max(0, heightAt(this.city.terrain, x, z)));
    }
    return ys;
  }

  /** 長さを 8 m 単位に、向きを既存の道路と直角・平行にそろえる */
  private guide(start: Snap, p: P2): P2 {
    let dx = p.x - start.p.x, dz = p.z - start.p.z;
    let len = Math.hypot(dx, dz);
    if (len < 1) return p;
    dx /= len; dz /= len;
    const ref = this.city.net.directionAt(start);
    if (ref) {
      const a = Math.atan2(dz, dx) - Math.atan2(ref.z, ref.x);
      const q = Math.round(a / (Math.PI / 2)) * (Math.PI / 2);
      if (Math.abs(a - q) < 0.09) {
        const ang = Math.atan2(ref.z, ref.x) + q;
        dx = Math.cos(ang); dz = Math.sin(ang);
      }
    }
    if (this.roadMode === 'straight' || this.control) len = Math.max(8, Math.round(len / 8) * 8);
    return { x: start.p.x + dx * len, z: start.p.z + dz * len };
  }

  private clickRoad(point: THREE.Vector3): void {
    const p = { x: point.x, z: point.z };
    const snapping = this.snapOn && !this.shift;
    if (!this.start) {
      this.start = this.city.snap(p, snapping);
      this.refresh();
      return;
    }
    if (this.roadMode === 'curve' && !this.control) {
      if (dist2(p, this.start.p) < 8) return;
      this.control = p;
      this.refresh();
      return;
    }
    this.refresh();
    const plan = this.plan;
    if (!plan) return;
    const problem = this.city.checkRoad(plan);
    if (problem) { this.ui.toast(problem); return; }
    this.city.buildRoad(plan);
    // 続けて引けるよう、終点を次の始点にする
    this.start = this.city.snap(plan.curve.p2, true);
    this.control = null;
    this.plan = null;
    this.refresh();
  }

  private paint(point: THREE.Vector3): void {
    const p = { x: point.x, z: point.z };
    if (this.tool === 'zone') {
      this.city.paintZone(p, this.brush, this.zone);
      return;
    }
    if (this.districtErase) { this.city.paintDistrict(p, this.brush, 0); return; }
    if (!this.districtId || !this.city.districts.get(this.districtId)) {
      this.districtId = this.city.newDistrict().id;
      this.renderSubbar();
    }
    this.city.paintDistrict(p, this.brush, this.districtId);
  }


  private markAt(p: { x: number; z: number }, y: number, r: number, color: string): void {
    this.snapRing.visible = true;
    this.snapRing.position.set(p.x, y + 1.5, p.z);
    this.snapRing.scale.setScalar(r);
    (this.snapRing.material as THREE.MeshBasicMaterial).color.set(color);
  }

  // ---------- 交通 ----------
  private hoverTraffic(p: { x: number; z: number }, y: number): void {
    this.hoverTarget = null;
    if (this.trafficMode === 'oneway') {
      const s = this.city.net.segmentAt(p);
      if (!s) { this.showTip('道路をクリックすると一方通行を切り替えます'); return; }
      this.hoverTarget = { seg: s.seg.id };
      this.view.highlight({ segment: s.seg.id });
      const now = s.seg.oneway === 1 ? '一方通行（→）' : s.seg.oneway === -1 ? '一方通行（←）' : '両方向';
      this.showTip(`今：${now}。クリックで切り替え`);
      return;
    }
    this.view.highlight(null);
    if (this.trafficMode === 'node') {
      let best: { id: number; d: number } | null = null;
      for (const n of this.city.net.nodes.values()) {
        const d = Math.hypot(n.x - p.x, n.z - p.z);
        if (d < 16 && this.city.net.segmentsAt(n.id).length >= 3 && (!best || d < best.d)) best = { id: n.id, d };
      }
      if (!best) { this.showTip('3 本以上の道路が交わる交差点をクリック'); return; }
      const n = this.city.net.nodes.get(best.id)!;
      this.hoverTarget = { node: n.id };
      this.markAt(n, n.y, 14, '#f2b134');
      const cost = Math.round(NODE_CONTROL_COST[this.nodeControl] * this.city.buildDiscount());
      this.showTip(`今：${NODE_CONTROL_NAMES[n.control ?? 'auto']}。クリックで${NODE_CONTROL_NAMES[this.nodeControl]}に（${formatYen(cost)}）`);
      return;
    }
    let best: { track: number; x: number; z: number; d: number } | null = null;
    for (const c of this.city.crossings) {
      const d = Math.hypot(c.x - p.x, c.z - p.z);
      if (d < 30 && (!best || d < best.d)) best = { track: c.track, x: c.x, z: c.z, d };
    }
    if (!best) { this.showTip('踏切（地上の線路と道路が交わる場所）をクリック'); return; }
    this.hoverTarget = { track: best.track };
    this.markAt(best, y, 12, '#f2b134');
    this.showTip(`クリックでこの区間の線路を高架にする（${formatYen(this.city.elevateCost(best.track))}）`);
  }

  private clickTraffic(): void {
    const t = this.hoverTarget;
    if (!t) return;
    let r: string | null = null;
    if (t.seg) r = this.city.cycleOneway(t.seg);
    else if (t.node) r = this.city.setNodeControl(t.node, this.nodeControl);
    else if (t.track) r = this.city.elevateTrack(t.track);
    if (r) this.ui.toast(r);
    this.refresh();
  }

  // ---------- 公共交通 ----------
  private hoverTransit(p: { x: number; z: number }, y: number): void {
    const mode = this.transitMode;
    const plan = this.city.planStop(mode, p, this.trackLevel, this.privateRail);
    this.markAt(plan.p, y, mode === 'bus' || mode === 'tram' ? 5 : 12, plan.ok ? '#4fc3ff' : '#ff5a4a');
    const count = this.pending.length;
    let tip = plan.reuse ? `${this.city.transit.stops.get(plan.reuse)!.name} を路線に加える` : plan.ok ? `${MODES[mode].stopName}を置く（${formatYen(plan.cost)}）` : plan.reason ?? '';
    // 鉄道・地下鉄：前の駅からの線路の見本
    const prev = count ? this.city.transit.stops.get(this.pending[count - 1]) : undefined;
    if (prev && (mode === 'rail' || mode === 'subway') && plan.ok) {
      const level: TrackLevel = mode === 'subway' ? 'under' : this.trackLevel;
      const cv = { p0: { x: prev.x, z: prev.z }, c: { x: (prev.x + plan.p.x) / 2, z: (prev.z + plan.p.z) / 2 }, p2: plan.p };
      const prof = trackProfile(this.city.terrain, cv, level);
      const cost = Math.round(trackCost(mode, level, prof.length) * this.city.buildDiscount() * (this.privateRail ? 0.3 : 1));
      this.ghost.geometry.dispose();
      const ys = prof.ys.length ? prof.ys.map((v) => (level === 'under' ? heightAt(this.city.terrain, prev.x, prev.z) + 1 : v)) : [y, y];
      this.ghost.geometry = buildRoadGhost([{ curve: cv, ys, bridge: prof.bridge.length ? prof.bridge : [false, false] }], 'local');
      (this.ghost.material as THREE.MeshBasicMaterial).color.set(prof.ok ? '#4fc3ff' : '#ff5a4a');
      this.ghost.visible = true;
      tip = prof.ok ? `線路 ${Math.round(prof.length)} m（${formatYen(cost)}）＋ ${tip}` : prof.reason ?? '';
    }
    this.showTip(`${tip}${count ? `　／　${count} か所選択中（Enter で完成）` : ''}`, !plan.ok);
  }

  private clickTransit(point: THREE.Vector3): void {
    const mode = this.transitMode;
    const id = this.city.addStop(mode, { x: point.x, z: point.z }, this.trackLevel, this.privateRail);
    if (typeof id === 'string') { this.ui.toast(id); return; }
    if (this.pending.at(-1) === id) return;
    const prev = this.pending.at(-1);
    if (prev !== undefined && (mode === 'rail' || mode === 'subway')) {
      const r = this.city.connectStops(prev, id, this.trackLevel, this.privateRail);
      if (r) { this.ui.toast(r); return; }
    }
    this.pending.push(id);
    this.renderSubbar();
    this.refresh();
  }

  finishLine(): void {
    if (this.pending.length < 2) { this.ui.toast('停留所（駅）を 2 か所以上選んでください'); return; }
    const r = this.city.createLine(this.transitMode, this.pending, this.privateRail && this.transitMode === 'rail' ? 'private' : 'city');
    if (typeof r === 'string') { this.ui.toast(r); return; }
    this.ui.toast(`${r.name}が開業しました`);
    this.pending = [];
    this.renderSubbar();
    this.refresh();
  }

  private placeFacility(point: THREE.Vector3): void {
    const plan = this.city.planFacility({ x: point.x, z: point.z }, this.facilityKind);
    if (!plan.ok) { this.ui.toast(plan.reason ?? 'ここには置けません'); return; }
    this.city.placeFacility(plan);
    this.ui.toast(`${FACILITIES[plan.kind].name}を建てました`);
    this.refresh();
  }

  private bulldoze(): void {
    const t = this.bulldozeTarget;
    if (!t) return;
    const st = (t as { stop?: number }).stop;
    if (st) this.city.removeStop(st);
    else if (t.building) this.city.removeBuilding(t.building);
    else if (t.facility) this.city.removeFacility(t.facility);
    else if (t.segment) this.city.removeRoad(t.segment);
    this.bulldozeTarget = null;
    this.view.highlight(null);
    setTimeout(() => this.refresh(), 0);
  }

  private brushColor(): string {
    if (this.tool === 'district') return this.districtErase ? '#ff8a7a' : this.city.districts.get(this.districtId)?.color ?? '#ffffff';
    return this.zone ? ZONES.find((z) => z.id === this.zone)!.color : '#ff8a7a';
  }

  private showTip(text: string, error = false): void {
    if (!this.pointer || !text) return;
    this.tip.hidden = false;
    this.tip.textContent = text;
    this.tip.classList.toggle('error', error);
    this.tip.style.transform = `translate(${this.pointer.x + 16}px, ${this.pointer.y + 18}px)`;
  }

  // ---------- 道具ごとの設定バー ----------
  renderSubbar(): void {
    const el = this.subbar;
    el.replaceChildren();
    el.hidden = this.tool === 'none';
    const group = (label: string) => {
      const g = document.createElement('div');
      g.className = 'group';
      const l = document.createElement('span');
      l.className = 'label';
      l.textContent = label;
      g.append(l);
      el.append(g);
      return g;
    };
    const btn = (parent: HTMLElement, text: string, pressed: boolean, onClick: () => void, swatch?: string) => {
      const b = document.createElement('button');
      b.setAttribute('aria-pressed', String(pressed));
      if (swatch) {
        const s = document.createElement('i');
        s.className = 'sw';
        s.style.background = swatch;
        b.append(s);
      }
      b.append(text);
      b.onclick = onClick;
      parent.append(b);
      return b;
    };
    const brushes = () => {
      const g = group('ブラシ');
      for (const br of BRUSHES) btn(g, br.label, this.brush === br.r, () => { this.brush = br.r; this.renderSubbar(); });
    };

    if (this.tool === 'road') {
      const g1 = group('種類');
      for (const t of ['alley', 'local', 'avenue'] as RoadType[]) {
        const def = ROAD_TYPES[t];
        btn(g1, `${def.name}（${def.width} m）`, this.roadType === t, () => { this.roadType = t; this.renderSubbar(); this.refresh(); });
      }
      const g2 = group('引き方');
      btn(g2, '直線', this.roadMode === 'straight', () => { this.roadMode = 'straight'; this.control = null; this.renderSubbar(); this.refresh(); });
      btn(g2, '曲線', this.roadMode === 'curve', () => { this.roadMode = 'curve'; this.control = null; this.renderSubbar(); this.refresh(); });
      const g3 = group('吸着');
      btn(g3, this.snapOn ? 'オン' : 'オフ', this.snapOn, () => { this.snapOn = !this.snapOn; this.renderSubbar(); });
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = 'Shift で一時的に吸着なし ／ 右クリックでやめる';
      el.append(hint);
    } else if (this.tool === 'zone') {
      const g = group('用途地域');
      for (const z of ZONES) btn(g, z.name, this.zone === z.id, () => { this.zone = z.id; this.renderSubbar(); }, z.color);
      btn(g, '解除', this.zone === 0, () => { this.zone = 0; this.renderSubbar(); });
      brushes();
    } else if (this.tool === 'district') {
      const g = group('地区');
      for (const d of this.city.districts.list) {
        btn(g, d.name, !this.districtErase && this.districtId === d.id, () => {
          this.districtId = d.id; this.districtErase = false; this.renderSubbar();
        }, d.color);
      }
      btn(g, '＋ 新しい地区', false, () => {
        this.districtId = this.city.newDistrict().id;
        this.districtErase = false;
        this.renderSubbar();
      });
      btn(g, '消しゴム', this.districtErase, () => { this.districtErase = true; this.renderSubbar(); });
      const cur = this.city.districts.get(this.districtId);
      if (cur && !this.districtErase) {
        const g2 = group('名前');
        const input = document.createElement('input');
        input.id = 'districtName';
        input.value = cur.name;
        input.maxLength = 12;
        input.onchange = () => { this.city.renameDistrict(cur.id, input.value); this.renderSubbar(); };
        input.onkeydown = (e) => { if (e.key === 'Enter') input.blur(); e.stopPropagation(); };
        g2.append(input);
        btn(g2, '削除', false, () => { this.city.removeDistrict(cur.id); this.districtId = 0; this.renderSubbar(); });
      }
      brushes();
    } else if (this.tool === 'facility') {
      const g1 = group('分類');
      for (const cat of Object.keys(CATEGORY_NAMES) as FacilityCategory[]) {
        btn(g1, CATEGORY_NAMES[cat], this.facilityCat === cat, () => {
          this.facilityCat = cat;
          this.facilityKind = facilitiesIn(cat)[0];
          this.renderSubbar();
        });
      }
      const g2 = group('施設');
      for (const k of facilitiesIn(this.facilityCat)) {
        const def = FACILITIES[k];
        const b = btn(g2, `${def.name}（${formatYen(def.cost)}）`, this.facilityKind === k, () => { this.facilityKind = k; this.renderSubbar(); this.refresh(); });
        b.title = def.note;
        if (def.unlockYear && this.city.year < def.unlockYear) b.disabled = true;
      }
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = FACILITIES[this.facilityKind].note;
      el.append(hint);
    } else if (this.tool === 'traffic') {
      const g1 = group('道具');
      const modes: [typeof this.trafficMode, string][] = [['oneway', '一方通行'], ['node', '交差点'], ['elevate', '踏切の高架化']];
      for (const [m, label] of modes) btn(g1, label, this.trafficMode === m, () => { this.trafficMode = m; this.renderSubbar(); this.refresh(); });
      if (this.trafficMode === 'node') {
        const g2 = group('交差点の制御');
        for (const c of ['auto', 'turnlane', 'grade'] as NodeControl[]) {
          btn(g2, `${NODE_CONTROL_NAMES[c]}${NODE_CONTROL_COST[c] ? `（${formatYen(NODE_CONTROL_COST[c])}）` : ''}`, this.nodeControl === c, () => { this.nodeControl = c; this.renderSubbar(); });
        }
      }
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = { oneway: '一方通行にすると、その向きの車線が増えて流れやすくなります', node: '右折レーンで信号待ちが減り、立体交差では止まらずに通れます', elevate: '列車の多い踏切は「開かずの踏切」になり、渋滞の元になります' }[this.trafficMode];
      el.append(hint);
    } else if (this.tool === 'transit') {
      const g1 = group('種類');
      for (const m of ['bus', 'tram', 'rail', 'subway'] as TransitMode[]) {
        btn(g1, MODES[m].name, this.transitMode === m, () => { this.transitMode = m; this.pending = []; this.renderSubbar(); this.refresh(); });
      }
      if (this.transitMode === 'rail') {
        const g2 = group('線路');
        btn(g2, `地上（${MODES.rail.trackCost}万円/m）`, this.trackLevel === 'ground', () => { this.trackLevel = 'ground'; this.renderSubbar(); });
        btn(g2, `高架（${MODES.rail.elevatedCost}万円/m）`, this.trackLevel === 'elevated', () => { this.trackLevel = 'elevated'; this.renderSubbar(); });
        if (this.city.connections.rel.rail >= 40) {
          btn(g2, this.privateRail ? '私鉄に任せる：はい' : '私鉄に任せる：いいえ', this.privateRail, () => { this.privateRail = !this.privateRail; this.renderSubbar(); });
        }
      }
      const g3 = group(`選択中 ${this.pending.length} か所`);
      btn(g3, '路線を完成（Enter）', false, () => this.finishLine()).disabled = this.pending.length < 2;
      btn(g3, 'やり直す', false, () => { this.pending = []; this.renderSubbar(); });
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = this.transitMode === 'bus' || this.transitMode === 'tram'
        ? `道路の上を順にクリックして${MODES[this.transitMode].stopName}を置きます。車両は道路を通って往復します`
        : '駅を順にクリックすると、駅と駅が線路でつながります';
      el.append(hint);
    } else if (this.tool === 'bulldoze') {
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = '建物・施設・道路をクリックすると取り壊します';
      el.append(hint);
    }
  }
}
