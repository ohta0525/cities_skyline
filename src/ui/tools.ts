import * as THREE from 'three';
import type { City } from '../city/city';
import { dist2, type P2 } from '../city/geometry';
import { ROAD_TYPES, type RoadPlan, type RoadType, type Snap } from '../city/roads';
import { ZONES, type ZoneId } from '../city/zones';
import type { CityView } from '../render/cityView';
import { ring } from '../render/overlays';
import { buildRoadGhost } from '../render/roadMesh';
import type { World3D } from '../render/world3d';
import { heightAt } from '../world/terrain';

export type ToolId = 'none' | 'road' | 'zone' | 'district' | 'bulldoze';

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

  private start: Snap | null = null;
  private control: P2 | null = null;
  private plan: RoadPlan | null = null;
  private pointer: { x: number; y: number } | null = null;
  private painting = false;
  private shift = false;
  private rightDown: { x: number; y: number } | null = null;
  private bulldozeTarget: { building?: number; segment?: number } | null = null;

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
    world.scene.add(this.ghost, this.brushRing, this.snapRing);

    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointerleave', () => { this.pointer = null; this.tip.hidden = true; });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Shift') this.shift = true;
      if (e.key === 'Escape') this.cancel();
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
    this.tool = tool;
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
    this.ghost.visible = false;
    this.brushRing.visible = false;
    this.snapRing.visible = false;
    this.tip.hidden = true;
    if (!this.pointer || this.tool === 'none') return;
    const hit = this.world.pick(this.pointer.x, this.pointer.y);

    if (this.tool === 'bulldoze') {
      const b = this.view.pickBuilding(this.pointer.x, this.pointer.y, this.canvas);
      let target: { building?: number; segment?: number } | null = null;
      if (b) target = { building: b };
      else if (hit) {
        const s = this.city.net.segmentAt({ x: hit.point.x, z: hit.point.z });
        if (s) target = { segment: s.seg.id };
      }
      this.bulldozeTarget = target;
      this.view.highlight(target);
      if (target?.building) this.showTip(this.city.buildings.get(target.building) ? 'クリックで建物を取り壊す' : '');
      else if (target?.segment) this.showTip('クリックで道路を撤去');
      return;
    }
    if (!hit) return;
    const p = { x: hit.point.x, z: hit.point.z };

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
    else if (plan.ok) this.showTip(`${ROAD_TYPES[this.roadType].name}　${len}${plan.bridgeLength > 0 ? `（うち橋 ${Math.round(plan.bridgeLength)} m）` : ''}`);
    else this.showTip(plan.reason ?? '置けません', true);
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
    if (!plan.ok) { this.ui.toast(plan.reason ?? 'ここには置けません'); return; }
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

  private bulldoze(): void {
    const t = this.bulldozeTarget;
    if (!t) return;
    if (t.building) this.city.removeBuilding(t.building);
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
    } else if (this.tool === 'bulldoze') {
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = '建物か道路をクリックすると取り壊します';
      el.append(hint);
    }
  }
}
