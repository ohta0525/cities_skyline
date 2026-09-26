import './style.css';
import { randomSeed } from './core/rng';
import { loadSettings, saveSettings, type Quality, type Settings } from './core/settings';
import { World3D } from './render/world3d';
import { DEFAULT_CAMERA } from './render/camera';
import { SAVE_VERSION, deserialize, emptyCity, loadSave, serialize, storeSave, type SaveData } from './save/save';
import { City } from './city/city';
import { KINDS } from './city/buildings';
import { CATEGORY_NAMES, FACILITIES } from './city/facilities';
import { shakeAmplitude } from './render/effects';
import type { QuakeReport } from './city/disasters';
import type { DisasterReport } from './city/city';
import { ALERT_COLORS, ALERT_NAMES, alertLevel } from './city/water';
import { zoneDef } from './city/zones';
import { CityView } from './render/cityView';
import { Tools } from './ui/tools';
import { Panels } from './ui/panels';
import { formatYen } from './city/economy';
import { RANKS, eraOf, yearOf } from './city/eras';
import { AI_MAYORS, FACTIONS, PLEDGES, type PledgeId } from './city/politics';
import type { ElectionResult } from './city/politics';
import * as THREE from 'three';
import { MONTH_DAYS, YEAR_DAYS, dateOf, formatDate, seasonOf, type Speed, type YearMinutes } from './sim/clock';
import type { FromWorker, SimState, ToWorker } from './sim/protocol';
import { generateTerrain, heightAt, landKind, type Terrain } from './world/terrain';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------- 状態 ----------
const settings: Settings = loadSettings();
let speed: Speed = 1;
let sim: SimState = { day: 0 };
let cityName = '新市';
let terrain: Terrain;
let city: City;

// ---------- シミュレーション（別スレッド） ----------
const worker = new Worker(new URL('./sim/worker.ts', import.meta.url), { type: 'module' });
const send = (m: ToWorker) => worker.postMessage(m);
let lastMonth = -1;
worker.onmessage = (e: MessageEvent<FromWorker>) => {
  if (e.data.type !== 'tick') return;
  sim = e.data.state;
  city?.advanceTo(sim.day);
  updateClock();
  updateStats();
  // 月が変わるたびに自動保存
  const month = Math.floor(sim.day / MONTH_DAYS);
  if (lastMonth >= 0 && month !== lastMonth) storeSave('auto', snapshot());
  lastMonth = month;
};

// ---------- 3D ----------
const canvas = $<HTMLCanvasElement>('view');
const world = new World3D(canvas, settings.quality, settings.miniature);
city = new City(generateTerrain(1), 1);
const view = new CityView(world, city);
const tools = new Tools(world, city, view, canvas, { toast });
const hall = new Panels(() => city, { toast, setInfo: (m) => view.setInfo(m) });

function startCity(save: SaveData): void {
  cityName = save.cityName;
  $<HTMLInputElement>('cityName').value = cityName;
  // 道路の造成で地形が変わっているので、毎回生成し直してから街を載せる
  terrain = generateTerrain(save.terrain.seed, save.terrain.preset);
  city = new City(terrain, save.terrain.seed);
  city.load(save.city, save.sim.day);
  city.disastersEnabled = settings.disasters;
  world.setTerrain(terrain);
  view.setCity(city);
  tools.setCity(city);
  world.setCityName(`瑞穂連邦　${cityName}　／　河川平野と海岸`);
  world.controls.setState(save.camera);
  sim = { ...save.sim };
  lastMonth = Math.floor(sim.day / MONTH_DAYS);
  send({ type: 'init', state: sim, yearMinutes: settings.yearMinutes, speed });
  updateClock();
  updateStats();
}

function freshCity(): SaveData {
  return {
    version: SAVE_VERSION,
    savedAt: new Date().toISOString(),
    cityName: '新市',
    terrain: { seed: randomSeed(), preset: 'river-coast' },
    sim: { day: 0 },
    camera: { ...DEFAULT_CAMERA },
    city: emptyCity(),
  };
}

function snapshot(): SaveData {
  return {
    version: SAVE_VERSION,
    savedAt: new Date().toISOString(),
    cityName,
    terrain: { seed: terrain.seed, preset: terrain.preset },
    sim: { ...sim },
    camera: world.controls.getState(),
    city: city.toJSON(),
  };
}

// ---------- 画面上部 ----------
function updateClock(): void {
  const d = dateOf(sim.day);
  $('date').textContent = formatDate(d);
  const s = seasonOf(d.month);
  const el = $('season');
  el.textContent = s;
  el.dataset.s = s;
}

function updateStats(): void {
  const st = city.stats;
  $('pop').textContent = st.population.toLocaleString();
  const money = $('money');
  money.textContent = formatYen(city.econ.money);
  money.className = `v${city.econ.money < 0 ? ' neg' : ''}`;
  const last = city.econ.reports.at(-1);
  const net = $('net');
  net.textContent = last ? `${last.net >= 0 ? '+' : ''}${formatYen(last.net)}` : '—';
  net.className = `v ${last && last.net < 0 ? 'neg' : 'pos'}`;
  const ap = $('approval');
  ap.textContent = `${city.politics.approval.toFixed(0)}％`;
  ap.className = `v ${city.politics.approval < 50 ? 'neg' : ''}`;
  $('rank').textContent = RANKS[city.meta.rank].name;
  $('era').textContent = eraOf(yearOf(sim.day)).name;
  for (const [id, v] of [['dRes', st.demand.res], ['dCom', st.demand.com], ['dInd', st.demand.ind]] as const) {
    const el = $(id);
    el.style.height = `${Math.abs(v) / 2}%`;
    el.style.bottom = v >= 0 ? '50%' : `${50 - Math.abs(v) / 2}%`;
    el.style.opacity = v >= 0 ? '1' : '0.45';
  }
}

function setSpeed(s: Speed): void {
  speed = s;
  send({ type: 'speed', speed: s });
  document.querySelectorAll<HTMLButtonElement>('.speed button').forEach((b) =>
    b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === s)),
  );
}
let resumeSpeed: Speed = 1;
document.querySelectorAll<HTMLButtonElement>('.speed button').forEach((b) => {
  b.onclick = () => setSpeed(Number(b.dataset.speed) as Speed);
});

const nameInput = $<HTMLInputElement>('cityName');
nameInput.addEventListener('change', () => {
  cityName = nameInput.value.trim() || '新市';
  nameInput.value = cityName;
  world.setCityName(`瑞穂連邦　${cityName}　／　河川平野と海岸`);
});
nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameInput.blur(); });

window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).tagName === 'INPUT') return;
  if (e.code === 'Space') {
    e.preventDefault();
    if (speed === 0) setSpeed(resumeSpeed);
    else { resumeSpeed = speed; setSpeed(0); }
  }
  if (e.code === 'Digit1') setSpeed(1);
  if (e.code === 'Digit2') setSpeed(2);
  if (e.code === 'Digit3') setSpeed(4);
  if (e.code === 'Escape') closePanels();
});

// ---------- 保存と読み込み ----------
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(msg: string): void {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

$('btnSave').onclick = () => {
  toast(storeSave('manual', snapshot()) ? '保存しました' : '保存できませんでした。ブラウザの保存領域が使えない状態です');
};
$('btnLoad').onclick = () => {
  const s = loadSave('manual');
  if (!s) { toast('保存したデータがありません。先に「保存」を押してください'); return; }
  startCity(s);
  toast(`${formatDate(dateOf(s.sim.day))} のデータを読み込みました`);
};
$('btnExport').onclick = () => {
  const blob = new Blob([serialize(snapshot())], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${cityName}-${Math.floor(sim.day / YEAR_DAYS) + 1}年目.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$<HTMLInputElement>('fileImport').onchange = async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  const data = deserialize(await file.text());
  if (!data) { toast('このファイルは読み込めません。書き出したセーブデータ（.json）を選んでください'); return; }
  startCity(data);
  toast(`「${data.cityName}」を読み込みました`);
};

// ---------- パネル ----------
const panels: [string, string][] = [['btnSettings', 'settings'], ['btnHelp', 'help']];
function closePanels(): void {
  for (const [b, p] of panels) { $(p).hidden = true; $(b).setAttribute('aria-expanded', 'false'); }
}
for (const [b, p] of panels) {
  $(b).onclick = () => {
    const open = $(p).hidden;
    closePanels();
    $(p).hidden = !open;
    $(b).setAttribute('aria-expanded', String(open));
    if (p === 'help' && !settings.helpSeen) { settings.helpSeen = true; saveSettings(settings); }
  };
}

function ymNote(ym: YearMinutes): string {
  const hours = (ym * 100) / 60;
  return `100 年で約 ${hours < 10 ? hours.toFixed(1) : Math.round(hours)} 時間`;
}
$<HTMLInputElement>(`ym${settings.yearMinutes}`).checked = true;
$('ymNote').textContent = ymNote(settings.yearMinutes);
document.querySelectorAll<HTMLInputElement>('input[name="yearMinutes"]').forEach((r) => {
  r.onchange = () => {
    settings.yearMinutes = Number(r.value) as YearMinutes;
    saveSettings(settings);
    send({ type: 'yearMinutes', yearMinutes: settings.yearMinutes });
    $('ymNote').textContent = ymNote(settings.yearMinutes);
  };
});
const qId: Record<Quality, string> = { high: 'qHigh', medium: 'qMedium', low: 'qLow' };
$<HTMLInputElement>(qId[settings.quality]).checked = true;
document.querySelectorAll<HTMLInputElement>('input[name="quality"]').forEach((r) => {
  r.onchange = () => {
    settings.quality = r.value as Quality;
    saveSettings(settings);
    world.setQuality(settings.quality);
  };
});
const mini = $<HTMLInputElement>('miniature');
mini.value = String(settings.miniature);
mini.oninput = () => {
  settings.miniature = Number(mini.value);
  world.setMiniature(settings.miniature);
  saveSettings(settings);
};

$<HTMLInputElement>(settings.disasters ? 'disOn' : 'disOff').checked = true;
document.querySelectorAll<HTMLInputElement>('input[name="disasters"]').forEach((r) => {
  r.onchange = () => {
    settings.disasters = r.value === 'on';
    saveSettings(settings);
    city.disastersEnabled = settings.disasters;
  };
});
$('quakeMid').onclick = () => { closePanels(); city.earthquake(6.3, world.controls.target.clone()); };
$('quakeBig').onclick = () => { closePanels(); city.earthquake(7.2, { x: world.controls.target.x + 800, z: world.controls.target.z + 300 }); };
$('stormTest').onclick = () => { closePanels(); city.spawnStorm('typhoon', 0.85); toast('強い台風が発生しました。上の警報を見て避難指示を判断してください'); };
$('rainTest').onclick = () => { closePanels(); city.spawnStorm('rain', 0.7); toast('大雨の予報が出ました'); };
$('tsunamiTest').onclick = () => { closePanels(); city.earthquake(8.1, { x: 0, z: 4000 }); };

const btnNew = $<HTMLButtonElement>('btnNew');
let armTimer: ReturnType<typeof setTimeout> | undefined;
const disarm = () => { clearTimeout(armTimer); armTimer = undefined; btnNew.classList.remove('armed'); btnNew.textContent = '新しい街を始める'; };
btnNew.onclick = () => {
  if (!armTimer) {
    btnNew.classList.add('armed');
    btnNew.textContent = 'もう一度押すと始めます';
    armTimer = setTimeout(disarm, 3500);
    return;
  }
  disarm();
  const s = freshCity();
  startCity(s);
  storeSave('auto', s);
  closePanels();
  toast('新しい地形で街を始めました');
};

// ---------- 地形の情報（カーソルの下） ----------
let pointer: { x: number; y: number } | null = null;
canvas.addEventListener('pointermove', (e) => { pointer = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener('pointerleave', () => { pointer = null; });
let probeAcc = 0;
function updateProbe(dt: number): void {
  probeAcc += dt;
  if (probeAcc < 0.08) return;
  probeAcc = 0;
  const el = $('probe');
  if (!pointer) return;
  const picked = view.pick(pointer.x, pointer.y, canvas);
  const fac = picked?.kind === 'facility' ? city.facilities.get(picked.id) : undefined;
  if (fac) {
    const def = FACILITIES[fac.kind];
    const down = fac.downUntil > city.day ? '<span class="kind">停止中</span>' : '';
    el.innerHTML = `${def.name}<span class="kind">${CATEGORY_NAMES[def.cat]}</span>${down}　維持費 月 ${formatYen(def.upkeep)}${def.radius ? `　範囲 ${def.radius} m` : ''}`;
    return;
  }
  const b = picked?.kind === 'building' ? city.buildings.get(picked.id) : undefined;
  if (b) {
    const def = KINDS[b.kind];
    const floors = b.floors > 1 ? `　${b.floors}階建て` : '';
    const people = [b.residents ? `住民 <b>${b.residents}</b> 人` : '', b.jobs ? `雇用 <b>${b.jobs}</b> 人` : ''].filter(Boolean).join('　');
    const district = city.districts.at(b)?.name;
    const sv = city.services?.per.get(b.id);
    const lacks = sv ? (['power', 'water', 'sewage', 'garbage'] as const).filter((k) => !sv[k]).map((k) => ({ power: '電気', water: '水道', sewage: '下水', garbage: 'ゴミ収集' })[k]) : [];
    const tags = [
      b.seismic === 'old' ? '旧耐震' : '新耐震',
      b.fireproof ? '防火構造' : '',
      b.damagedUntil && b.damagedUntil > city.day ? '被災・修理待ち' : '',
      city.fires.some((f) => f.building === b.id) ? '火災' : '',
      lacks.length ? `${lacks.join('・')}なし` : '',
      sv ? `満足度 ${Math.round(sv.happiness)}` : '',
    ].filter(Boolean).map((t) => `<span class="kind">${t}</span>`).join('');
    el.innerHTML = `${def.name}${floors}<span class="kind">${zoneDef(b.zone)!.name}</span>　${people}${district ? `<span class="kind">${district}</span>` : ''}${tags}`;
    return;
  }
  const hit = world.pick(pointer.x, pointer.y);
  if (!hit) return;
  const h = heightAt(terrain, hit.point.x, hit.point.z);
  const kind = landKind(terrain, hit.point.x, hit.point.z);
  const label = h < 0 ? `水深 <b>${(-h).toFixed(1)}</b> m` : `標高 <b>${h.toFixed(1)}</b> m`;
  const district = city.districts.at({ x: hit.point.x, z: hit.point.z })?.name;
  el.innerHTML = `${label}<span class="kind">${kind}</span>${district ? `<span class="kind">${district}</span>` : ''}`;
}

// ---------- お知らせのダイアログ（選挙など） ----------
let modalResume: Speed | null = null;
function showModal(title: string, body: (Node | string)[], buttons: { label: string; primary?: boolean; onClick?: () => void }[]): void {
  if (modalResume === null) modalResume = speed;
  setSpeed(0);
  $('modalTitle').textContent = title;
  $('modalBody').replaceChildren(...body);
  $('modalButtons').replaceChildren(...buttons.map((b) => {
    const el = document.createElement('button');
    el.textContent = b.label;
    if (b.primary) el.className = 'primary';
    el.onclick = () => { closeModal(); b.onClick?.(); };
    return el;
  }));
  $('modal').hidden = false;
  ($('modalButtons').lastElementChild as HTMLElement | null)?.focus();
}
function closeModal(): void {
  $('modal').hidden = true;
  if (modalResume !== null) { setSpeed(modalResume || 1); modalResume = null; }
}
const para = (text: string, cls = '') => Object.assign(document.createElement('p'), { textContent: text, className: cls });

let pledgeShown = false;
function checkPolitics(): void {
  const ev = city.events.shift();
  if (ev?.type === 'election') showElection(ev.result);
  if (ev?.type === 'quake') showQuake(ev.report);
  if (ev?.type === 'disaster') showDisaster(ev.report);
  updateAlert();
  const p = city.politics;
  if (p.pledgeChoiceOpen && !pledgeShown && $('modal').hidden) {
    pledgeShown = true;
    const who = p.mayor === 'player'
      ? (p.challenger ? `対立候補：${AI_MAYORS[p.challenger].name}（${AI_MAYORS[p.challenger].title}）` : '')
      : `現職：${AI_MAYORS[p.mayor].name}（${AI_MAYORS[p.mayor].title}）`;
    const choices = (Object.keys(PLEDGES) as PledgeId[]).map((id) => {
      const pl = PLEDGES[id];
      const b = document.createElement('button');
      b.className = 'pledge';
      b.innerHTML = `<b>${pl.name}</b>${pl.promise}<br><span class="note">支持が上がる派閥：${pl.boost.map((f) => FACTIONS.find((x) => x.id === f)!.name).join('・')}</span>`;
      b.onclick = () => { city.choosePledge(id); closeModal(); toast(`公約「${pl.name}」を掲げました`); };
      return b;
    });
    showModal('市長選挙まであと 3 か月', [para(`4 月に市長選挙があります。${who}`), para('公約を 1 つ選んでください。守れば次の選挙で評価され、破れば批判されます。', 'note'), ...choices],
      [{ label: 'あとで決める（政治パネルからも選べます）' }]);
  }
  if (!p.pledgeChoiceOpen) pledgeShown = false;
}

function updateAlert(): void {
  const st = city.activeStorm();
  const el = $('alert');
  el.hidden = !st;
  if (!st) return;
  const lv = alertLevel(st, city.day);
  const chip = $('alertLevel');
  chip.textContent = String(lv);
  chip.style.background = ALERT_COLORS[lv];
  chip.style.color = lv <= 2 ? '#1b1b1b' : '#fff';
  $('alertTitle').textContent = `${st.name}　警戒レベル ${lv}：${ALERT_NAMES[lv]}`;
  const f = st.forecast;
  const days = st.hit - city.day;
  const when = days > 0 ? `${days} 日後に最も強まる見込み` : '最も強まっています';
  const surge = f.surge[1] > 0.2 ? `、高潮 ${f.surge[0].toFixed(1)}〜${f.surge[1].toFixed(1)} m` : '';
  $('alertDetail').textContent = `${when}。予報：川の水位 ${f.rise[0].toFixed(1)}〜${f.rise[1].toFixed(1)} m 上昇${surge}`;
  const btn = $('btnEvac');
  btn.textContent = st.evacuated ? '避難指示を解除' : '避難指示を出す';
  btn.classList.toggle('on', st.evacuated);
}
$('btnEvac').onclick = () => {
  const st = city.activeStorm();
  const r = city.evacuate(!st?.evacuated);
  if (r) toast(r);
};

function showDisaster(r: DisasterReport): void {
  const t = document.createElement('table');
  t.className = 'ledger';
  const rows: [string, string][] = r.kind === 'nuclear'
    ? [['避難した人', `${r.displaced.toLocaleString()} 人`]]
    : [
        ['堤防を越えた川の区間', `${r.breaches}`], ['床上浸水', `${r.above} 棟`], ['床下浸水', `${r.below} 棟`], ['全壊・流失', `${r.collapsed} 棟`],
        ['土砂災害', `${r.landslides} 棟`], ['風の被害', `${r.damaged} 棟`], ['逃げ遅れて救助された人', `${r.stranded.toLocaleString()} 人`],
        ['住まいを失った人', `${r.displaced.toLocaleString()} 人`], ['国などからの支援', formatYen(r.aid)],
      ];
  t.innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
  const lesson = r.stranded > 0
    ? '避難指示が遅れた（または出さなかった）ため、逃げ遅れた人がいました。次は予報を見て早めに判断しましょう。'
    : r.evacuated ? '早めの避難で、逃げ遅れた人はいませんでした。' : '';
  showModal(r.title, [t, para(r.note || lesson, 'note'), para('「防災」パネルで、仮設住宅や防衛隊の災害派遣、区画整理・高台移転などの復興を進められます。', 'note')],
    [{ label: '防災パネルを開く', onClick: () => hall.toggle('disaster', true) }, { label: '閉じる', primary: true }]);
}

function showQuake(q: QuakeReport): void {
  world.shake(shakeAmplitude(q.maxShindo), 5);
  const serious = q.collapsed + q.damaged + q.fires > 0;
  // 津波の報告が続くときは、そちらのダイアログを優先する
  if (city.events.some((e) => e.type === 'disaster')) { toast(`地震（M${q.magnitude}、最大震度 ${q.maxShindo}）。津波が発生しました`); return; }
  if (!serious) { toast(`地震がありました（M${q.magnitude}、最大震度 ${q.maxShindo}）。被害はありません`); return; }
  const t = document.createElement('table');
  t.className = 'ledger';
  const rows: [string, string][] = [
    ['全壊（がれきに）', `${q.collapsed} 棟`], ['損傷（修理待ち）', `${q.damaged} 棟`], ['火災', `${q.fires} 件`],
    ['液状化した場所の建物', `${q.liquefied} 棟`], ['止まった発電所', `${q.plantsStopped} か所`],
    ['避難している人', `${q.evacuees.toLocaleString()} 人`], ['けが人', `${q.injured.toLocaleString()} 人`],
  ];
  t.innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
  setTimeout(() => showModal(`地震発生：マグニチュード ${q.magnitude}、最大震度 ${q.maxShindo}`, [
    para('被害の状況がまとまりました。'), t,
    para('がれきは 45 日ほどで片付き、損傷した建物は修理されます。「政策」から非常事態宣言を出すと、復旧が速くなります。消防署が近くにない地域では火が広がりやすくなります。', 'note'),
  ], [{ label: '政策を開く', onClick: () => hall.toggle('policy', true) }, { label: '閉じる', primary: true }]), 3500);
}

function showElection(r: ElectionResult): void {
  const rows = FACTIONS.map((f) => `<tr><td>${f.name}</td><td>${r.byFaction[f.id].toFixed(0)}％</td></tr>`).join('');
  const table = document.createElement('table');
  table.className = 'ledger';
  table.innerHTML = `<tr><th>派閥</th><th>あなたへの投票</th></tr>${rows}`;
  const res = para(`${r.player.toFixed(1)}％ 対 ${r.opponent.toFixed(1)}％`, 'result');
  const msg = r.won
    ? (city.politics.elections.length > 1 && city.politics.elections.at(-2)!.won === false ? '返り咲きました。ふたたび市長として街をつくれます。' : '再選されました。次の 4 年も市長です。')
    : `落選しました。${r.opponentName}が市長になります。4 年間は街を直接つくれません。政治パネルから野党として活動し、次の選挙で返り咲きを狙ってください。`;
  showModal(`${r.year} 年目 市長選挙の結果：${r.won ? '当選' : '落選'}`, [res, para(msg), table], [{ label: '閉じる', primary: true }]);
  if (!r.won) tools.select('none');
}

// ---------- 地区の名前ラベル ----------
const labelsEl = $('labels');
const labelEls = new Map<number, HTMLSpanElement>();
let labelsVersion = -1;
let centroids = new Map<number, { x: number; z: number }>();
const tmp = new THREE.Vector3();
function updateLabels(): void {
  if (city.versions.districts !== labelsVersion) {
    labelsVersion = city.versions.districts;
    centroids = city.districts.centroids();
    for (const [id, el] of labelEls) if (!centroids.has(id)) { el.remove(); labelEls.delete(id); }
    for (const d of city.districts.list) {
      if (!centroids.has(d.id)) continue;
      let el = labelEls.get(d.id);
      if (!el) { el = document.createElement('span'); labelsEl.append(el); labelEls.set(d.id, el); }
      el.textContent = d.name;
    }
  }
  const w = canvas.clientWidth, h = canvas.clientHeight;
  for (const [id, el] of labelEls) {
    const c = centroids.get(id)!;
    tmp.set(c.x, Math.max(0, heightAt(terrain, c.x, c.z)) + 25, c.z).project(world.camera);
    const visible = tmp.z < 1 && Math.abs(tmp.x) < 1.1 && Math.abs(tmp.y) < 1.1;
    el.hidden = !visible;
    if (visible) el.style.transform = `translate(${((tmp.x + 1) / 2) * w}px, ${((1 - tmp.y) / 2) * h}px) translate(-50%, -50%)`;
  }
}

// ---------- ループ ----------
window.addEventListener('resize', () => world.resize());
let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  view.sync(sim.day);
  view.update(now / 1000, speed === 0 ? 0 : dt * Math.min(speed, 3));
  world.setWeather(view.weather);
  hall.update();
  checkPolitics();
  world.render(dt);
  updateProbe(dt);
  updateLabels();
  $('needle').setAttribute('transform', `rotate(${(world.heading() * 180) / Math.PI} 20 20)`);
  requestAnimationFrame(frame);
}

window.addEventListener('beforeunload', () => { if (terrain) storeSave('auto', snapshot()); });

// 起動：前回の自動保存があれば続きから
requestAnimationFrame(() => {
  const resume = loadSave('auto');
  startCity(resume ?? freshCity());
  setSpeed(1);
  $('loading').hidden = true;
  if (!settings.helpSeen) $('btnHelp').click();
  requestAnimationFrame(frame);
});

// 開発時だけ、ブラウザのコンソールから触れるようにする
if (import.meta.env.DEV) Object.assign(window, { __world: world, __app: { get city() { return city; }, tools, view } });
