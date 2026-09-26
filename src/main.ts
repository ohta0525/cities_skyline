import './style.css';
import SimWorker from './sim/worker.ts?worker&inline';
import { SimEngine } from './sim/engine';
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
import { VICTORY, type VictoryChoice } from './city/defense';
import { BORDER, EDGE_NAMES, STAGE_NAMES, stageOf } from './city/region';
import { SCENARIOS, type ScenarioId } from './city/scenarios';
import type { Ending } from './city/ending';
import { fmLine } from './city/media';
import { decreeActive } from './city/policies';
import { Sound } from './audio/sound';
import { SaveScreen } from './ui/saves';
import { Tutorial } from './ui/tutorial';
import { migrateOldSave, type SlotMeta } from './save/slots';

const VERSION = '1.1.0';
import { ENV } from './render/env';
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
// ワーカーは本体に埋め込む（1 つの HTML ファイルでも動くように）。
// ワーカーが動かないブラウザ（ファイルを直接開いたときなど）では、画面側で暦を進める
let worker: Worker | null = null;
let local: SimEngine | null = null;
let lastInit: ToWorker | null = null;
let gotTick = false;
try {
  worker = new SimWorker();
  worker.onmessage = (e: MessageEvent<FromWorker>) => { gotTick = true; onSim(e.data); };
  worker.onerror = () => useLocalClock();
} catch {
  worker = null;
}
function useLocalClock(): void {
  if (local) return;
  worker?.terminate();
  worker = null;
  local = new SimEngine(onSim);
  if (lastInit) local.handle(lastInit);
}
const send = (m: ToWorker) => {
  // 切り替えたときに同じ状態から始められるよう、最新の設定を覚えておく
  if (m.type === 'init') {
    lastInit = m;
    if (worker && !gotTick) setTimeout(() => { if (!gotTick) useLocalClock(); }, 1500);
  } else if (lastInit?.type === 'init' && m.type === 'speed') lastInit = { ...lastInit, speed: m.speed };
  else if (lastInit?.type === 'init' && m.type === 'yearMinutes') lastInit = { ...lastInit, yearMinutes: m.yearMinutes };
  if (worker) { worker.postMessage(m); return; }
  if (!local) useLocalClock();
  local!.handle(m);
};
let lastMonth = -1;
function onSim(m: FromWorker): void {
  if (m.type !== 'tick') return;
  sim = m.state;
  city?.advanceTo(sim.day);
  updateClock();
  updateStats();
  // 月が変わるたびに自動保存
  const month = Math.floor(sim.day / MONTH_DAYS);
  if (lastMonth >= 0 && month !== lastMonth && !demoCity && city.ending?.kind !== 'coup') autoSave();
  lastMonth = month;
}

// ---------- 3D ----------
const canvas = $<HTMLCanvasElement>('view');
const world = new World3D(canvas, settings.quality, settings.miniature);
city = new City(generateTerrain(1), 1);
const view = new CityView(world, city);
const tools = new Tools(world, city, view, canvas, { toast });
const hall = new Panels(() => city, { toast, setInfo: (m) => view.setInfo(m), fm: () => fmLog, name: () => cityName });

function startCity(save: SaveData, scenario?: ScenarioId): void {
  cityName = save.cityName;
  $<HTMLInputElement>('cityName').value = cityName;
  // 道路の造成で地形が変わっているので、毎回生成し直してから街を載せる
  terrain = generateTerrain(save.terrain.seed, save.terrain.preset);
  city = new City(terrain, save.terrain.seed);
  city.load(save.city, save.sim.day);
  city.disastersEnabled = settings.disasters;
  city.warEnabled = settings.war;
  if (scenario) city.setupScenario(scenario);
  fmLog.length = 0;
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
  const sc = city.scenario;
  $('goal').hidden = sc.id === 'sandbox';
  $('goalName').textContent = sc.id === 'campaign' ? '目標：100 年続く街' : SCENARIOS[sc.id].name.replace('シナリオ：', '');
  $('goalText').textContent = sc.id === 'campaign' ? city.scenarioProgress() : `${SCENARIOS[sc.id].goal}（${city.scenarioProgress()}）`;
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
  if (e.code === 'Escape') { if (saves.isOpen) saves.close(); else closePanels(); }
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyS') { e.preventDefault(); if (!atTitle) openSaves('save'); }
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

// ---------- セーブデータの画面 ----------
/** 自動保存（縮小画像もいっしょに残す） */
function autoSave(): void {
  storeSave('auto', snapshot());
  try { localStorage.setItem('mizuho-city/autothumb', world.captureThumb()); } catch { /* 画像がなくても遊べる */ }
}
function slotMeta(): Omit<SlotMeta, 'id' | 'thumb'> {
  return {
    cityName, savedAt: new Date().toISOString(), day: sim.day, population: city.stats.population, money: city.econ.money,
    scenario: SCENARIOS[city.scenario.id].name.replace('シナリオ：', '').replace('（100 年）', ''),
  };
}
let saveResume: Speed | null = null;
const saves = new SaveScreen({
  snapshot: () => (atTitle || demoCity ? null : snapshot()),
  meta: slotMeta,
  thumb: () => world.captureThumb(),
  load: (data, label) => {
    hideTitle();
    if (tutorial.active) tutorial.stop(false);
    startCity(data);
    saveResume = null;
    setSpeed(1);
    toast(`${label}の「${data.cityName}」（${formatDate(dateOf(data.sim.day))}）を読み込みました`);
  },
  toast,
  onClose: () => { if (saveResume !== null && !atTitle) setSpeed(saveResume); saveResume = null; },
});
function openSaves(mode: 'save' | 'load'): void {
  if (!atTitle && saveResume === null) { saveResume = speed; setSpeed(0); }
  void saves.open(mode);
}
$('btnSave').onclick = () => openSaves('save');
$('btnLoad').onclick = () => openSaves('load');
$('btnTitle').onclick = () => {
  if (city.ending?.kind !== 'coup') autoSave();
  showTitle();
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
$<HTMLInputElement>(settings.war ? 'warOn' : 'warOff').checked = true;
document.querySelectorAll<HTMLInputElement>('input[name="war"]').forEach((r) => {
  r.onchange = () => {
    settings.war = r.value === 'on';
    saveSettings(settings);
    city.warEnabled = settings.war;
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
  closePanels();
  chooseMode();
};

/** 遊び方を選んで、新しい街を始める */
function chooseMode(first = false): void {
  const box = document.createElement('div');
  box.className = 'modes';
  for (const id of Object.keys(SCENARIOS) as ScenarioId[]) {
    const b = document.createElement('button');
    b.innerHTML = `<b>${SCENARIOS[id].name}</b><span>${SCENARIOS[id].intro}</span>`;
    b.onclick = () => {
      closeModal();
      hideTitle();
      if (tutorial.active) tutorial.stop(false);
      const s = freshCity();
      startCity(s, id);
      setSpeed(1);
      storeSave('auto', snapshot());
      toast(`${SCENARIOS[id].name}を始めました`);
      if (first && !settings.helpSeen) $('btnHelp').click();
    };
    box.append(b);
  }
  showModal(first ? '瑞穂の街へようこそ' : '新しい街を始める', [para(first ? '遊び方を選んでください。あとから設定の「新しい街を始める」で選び直せます。' : '遊び方を選んでください。'), box], first ? [] : [{ label: 'やめる' }]);
}

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
  if (modalResume !== null) { setSpeed(atTitle ? 0 : modalResume || 1); modalResume = null; }
}
const para = (text: string, cls = '') => Object.assign(document.createElement('p'), { textContent: text, className: cls });

let pledgeShown = false;
function checkPolitics(): void {
  // ダイアログが開いている間は、次の出来事を待たせる
  const ev = $('modal').hidden ? city.events.shift() : undefined;
  if (ev?.type === 'election') showElection(ev.result);
  if (ev?.type === 'quake') showQuake(ev.report);
  if (ev?.type === 'disaster') showDisaster(ev.report);
  if (ev?.type === 'war') { showWar(ev); if (ev.kind === 'declared') sound.alarm(); }
  if (ev?.type === 'society') { sound.alarm(); showModal(ev.title, [para(ev.text)], [{ label: '政治パネルを開く', onClick: () => hall.toggle('politics', true) }, { label: '閉じる', primary: true }]); }
  if (ev?.type === 'festival') showFestival();
  if (ev?.type === 'scenario') showModal(ev.won ? 'シナリオ達成！' : 'シナリオ失敗', [para(ev.text), para('このまま街づくりを続けられます。設定の「新しい街を始める」から別のシナリオも選べます。', 'note')], [{ label: '続ける', primary: true }]);
  if (ev?.type === 'ending') showEnding(ev.ending);
  updateAlert();
  updateWarBar();
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

let alarmedStorm = '';
function updateAlert(): void {
  const st = city.activeStorm();
  const el = $('alert');
  el.hidden = !st;
  if (!st) return;
  const lv = alertLevel(st, city.day);
  if (lv >= 4 && alarmedStorm !== st.name) { alarmedStorm = st.name; sound.alarm(); }
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

// ---------- 祭りとエンディング ----------
function showFestival(): void {
  showModal('夏祭りと花火大会', [
    para('今年も夏祭りの季節です。8 月に夏祭りと花火大会を開きますか？'),
    para('費用 2,000万円。1 か月のあいだ満足度が上がり、保守・伝統派が喜び、観光客でお店がうるおいます。夜には川の上に花火が上がります。', 'note'),
  ], [
    { label: '今年は見送る', onClick: () => city.holdSummerFestival(false) },
    { label: '開く（2,000万円）', primary: true, onClick: () => { const r = city.holdSummerFestival(true); if (r) toast(r); } },
  ]);
}

function showEnding(e: Ending): void {
  const t = document.createElement('table');
  t.className = 'ledger';
  t.innerHTML = `<tr><th>項目</th><th>点</th></tr>${e.parts.map((p) => `<tr><td>${p.label}<br><span class="note">${p.note}</span></td><td>${p.score}／${p.max}</td></tr>`).join('')}`;
  const head = document.createElement('div');
  head.innerHTML = `<p class="score">${e.total}<span style="font-size:16px"> 点</span></p><p class="ending-title">${e.title}</p>`;
  const buttons = e.kind === 'coup'
    ? [{ label: '1 か月前に戻る', onClick: () => { const s = loadSave('auto'); if (s) { startCity(s); toast('1 か月前の自動保存から再開しました'); } else chooseMode(); } }, { label: '新しい街を始める', primary: true, onClick: () => chooseMode() }]
    : [{ label: '新しい街を始める', onClick: () => chooseMode() }, { label: 'このまま続ける', primary: true }];
  showModal(e.kind === 'coup' ? 'クーデター：市政の終わり' : '復興暦 100 年：街の評価', [head, para(e.summary), t], buttons);
}

// ---------- 紛争と合併 ----------
function updateWarBar(): void {
  const w = city.defense.war;
  const el = $('warbar');
  el.hidden = !w;
  $('alert').style.top = w ? '176px' : '';
  if (!w) return;
  $('warTitle').textContent = `${w.name}と紛争中`;
  const months = Math.floor((city.day - w.startDay) / 30);
  $('warDetail').textContent = w.pendingVictory ? '勝ちました。防衛パネルで結末を選んでください' : `${months} か月目・${w.front >= 0 ? '優勢' : '劣勢'}（${Math.round(w.front)}）・失った部隊 ${w.ourLosses}・被害 ${w.damaged} 棟`;
  const fr = $('warFront');
  fr.style.width = `${Math.abs(w.front) / 2}%`;
  fr.style.left = w.front >= 0 ? '50%' : `${50 - Math.abs(w.front) / 2}%`;
  fr.style.background = w.front >= 0 ? '#3ea865' : '#d9573f';
}
$('btnWar').onclick = () => hall.toggle('defense', true);

function showWar(ev: { kind: 'declared' | 'won' | 'lost' | 'peace' | 'merged' | 'refused'; name: string; text: string }): void {
  const titles = { declared: `紛争：${ev.name}`, won: `${ev.name}との紛争に勝利`, lost: `${ev.name}との紛争に敗北`, peace: `${ev.name}と講和`, merged: `合併：${ev.name}`, refused: '合併案は否決されました' };
  if (ev.kind === 'won' && city.defense.war?.pendingVictory) {
    const n = city.neighbor(city.defense.war.edge)!;
    const buttons = (Object.keys(VICTORY) as VictoryChoice[]).map((id) => ({ label: VICTORY[id].name, primary: id === 'reparations', onClick: () => { const r = city.settleVictory(id); if (r) toast(r); } }));
    showModal(titles.won, [para(ev.text), ...(Object.keys(VICTORY) as VictoryChoice[]).map((id) => para(`${VICTORY[id].name}：${VICTORY[id].note(n)}`, 'note'))], buttons);
    return;
  }
  if (ev.kind === 'won') { toast(ev.text); return; }
  const extra = ev.kind === 'declared' ? [para('「防衛」パネルで部隊を増やし、戦況を見ながら講和を申し入れられます。画面上の帯に戦況が出ます。', 'note')] : [];
  showModal(titles[ev.kind], [para(ev.text), ...extra], ev.kind === 'declared'
    ? [{ label: '防衛パネルを開く', onClick: () => hall.toggle('defense', true) }, { label: '閉じる', primary: true }]
    : [{ label: '閉じる', primary: true }]);
}

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
  updateNeighborLabels(w, h);
  for (const [id, el] of labelEls) {
    const c = centroids.get(id)!;
    tmp.set(c.x, Math.max(0, heightAt(terrain, c.x, c.z)) + 25, c.z).project(world.camera);
    const visible = tmp.z < 1 && Math.abs(tmp.x) < 1.1 && Math.abs(tmp.y) < 1.1;
    el.hidden = !visible;
    if (visible) el.style.transform = `translate(${((tmp.x + 1) / 2) * w}px, ${((1 - tmp.y) / 2) * h}px) translate(-50%, -50%)`;
  }
}

// 隣町の名前（その町の土地の上に出す）
const neighborEls = new Map<string, HTMLSpanElement>();
function updateNeighborLabels(w: number, h: number): void {
  for (const n of city.region.neighbors) {
    let el = neighborEls.get(n.edge);
    if (!el) { el = document.createElement('span'); el.className = 'neighbor-label'; labelsEl.append(el); neighborEls.set(n.edge, el); }
    if (n.merged) { el.hidden = true; continue; }
    const stage = stageOf(n.tension);
    const war = city.defense.war?.edge === n.edge;
    const text = `${n.name}${war ? '（紛争中）' : stage >= 1 ? `（${STAGE_NAMES[stage]}）` : ''}`;
    if (el.textContent !== text) el.textContent = text;
    el.dataset.stage = String(war ? 5 : stage);
    el.title = `${EDGE_NAMES[n.edge]}の隣町`;
    const p = n.edge === 'west' ? { x: -BORDER - 200, z: 0 } : n.edge === 'east' ? { x: BORDER + 200, z: 0 } : { x: 0, z: -BORDER - 200 };
    tmp.set(p.x, Math.max(0, heightAt(terrain, p.x, p.z)) + 60, p.z).project(world.camera);
    const visible = tmp.z < 1 && Math.abs(tmp.x) < 1.1 && Math.abs(tmp.y) < 1.1;
    el.hidden = !visible;
    if (visible) el.style.transform = `translate(${((tmp.x + 1) / 2) * w}px, ${((1 - tmp.y) / 2) * h}px) translate(-50%, -50%)`;
  }
}

// ---------- 昼夜・音・FM ----------
const sound = new Sound();
sound.volume = settings.volume;
sound.bgm = settings.bgm;
sound.ambient = settings.ambient;
const wake = () => sound.start();
window.addEventListener('pointerdown', wake);
window.addEventListener('keydown', wake);
/** 見た目の時刻 0〜1（朝 7 時から） */
let dayTime = 0.3;
const DAY_SECONDS = 240;
function updateDayTime(dt: number): void {
  if (settings.dayNight && speed > 0) dayTime = (dayTime + (dt * Math.min(speed, 2)) / DAY_SECONDS) % 1;
  const t = settings.dayNight ? dayTime : 0.5;
  world.setDayTime(t);
  const mins = Math.floor(t * 24 * 60);
  const text = `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  const tod = $('tod');
  if (tod.textContent !== text) tod.textContent = text;
  const d = dateOf(city.day);
  view.fireworksOn = decreeActive(city.policies, 'festival', city.day) && d.month === 8;
  sound.update({ time: t, season: seasonOf(d.month), rain: view.weather, paused: speed === 0, near: 1 - Math.min(1, world.controls.distance / 3000) });
}
const fmLog: { day: number; text: string }[] = [];
let fmClock = 0;
function updateFm(dt: number): void {
  fmClock -= dt;
  if (fmClock > 0) return;
  fmClock = 18;
  const text = fmLine(city, Math.random);
  if (fmLog.at(-1)?.text === text) return;
  fmLog.push({ day: city.day, text });
  if (fmLog.length > 30) fmLog.shift();
  $('fmText').textContent = text;
}
$('fm').onclick = () => hall.toggle('news', true);

$<HTMLInputElement>(settings.dayNight ? 'dnOn' : 'dnOff').checked = true;
document.querySelectorAll<HTMLInputElement>('input[name="dayNight"]').forEach((r) => {
  r.onchange = () => { settings.dayNight = r.value === 'on'; saveSettings(settings); };
});
const vol = $<HTMLInputElement>('volume');
vol.value = String(settings.volume);
vol.oninput = () => { settings.volume = Number(vol.value); sound.setVolume(settings.volume); saveSettings(settings); };
$<HTMLInputElement>('bgmOn').checked = settings.bgm;
$<HTMLInputElement>('bgmOn').onchange = (e) => { settings.bgm = (e.target as HTMLInputElement).checked; sound.bgm = settings.bgm; saveSettings(settings); };
$<HTMLInputElement>('ambOn').checked = settings.ambient;
$<HTMLInputElement>('ambOn').onchange = (e) => { settings.ambient = (e.target as HTMLInputElement).checked; sound.ambient = settings.ambient; saveSettings(settings); };

// ---------- タイトル画面 ----------
let atTitle = false;
/** セーブのない初回に、タイトルの背景用に作った街（保存しない） */
let demoCity = false;
function showTitle(): void {
  atTitle = true;
  if (tutorial.active) tutorial.stop(false);
  closeModal();
  closePanels();
  hall.open && hall.toggle(hall.open);
  tools.select('none');
  setSpeed(0);
  document.body.classList.add('at-title');
  $('title').hidden = false;
  const auto = demoCity ? null : loadSave('auto');
  const cont = $<HTMLButtonElement>('tContinue');
  cont.disabled = !auto;
  cont.classList.toggle('t-primary', !!auto);
  $('tContinueInfo').textContent = auto ? `${auto.cityName}・${formatDate(dateOf(auto.sim.day))}` : 'まだ街がありません';
  $('tTutorial').classList.toggle('t-primary', !settings.tutorialDone && !auto);
  $('tVersion').textContent = `v${VERSION}`;
  const st = world.controls.getState();
  world.controls.setState({ ...st, distance: Math.max(900, Math.min(1600, st.distance)), pitch: 0.5 });
}
function hideTitle(): void {
  if (!atTitle) return;
  atTitle = false;
  demoCity = false;
  document.body.classList.remove('at-title');
  $('title').hidden = true;
}
$('tContinue').onclick = () => {
  const auto = loadSave('auto');
  if (!auto) return;
  hideTitle();
  startCity(auto);
  setSpeed(1);
};
$('tNew').onclick = () => chooseMode();
$('tLoad').onclick = () => openSaves('load');
$('tSettings').onclick = () => $('btnSettings').click();
$('tHelp').onclick = () => $('btnHelp').click();
$('tTutorial').onclick = () => startTutorial();

/** タイトルの背景：ゆっくり回る */
function titleOrbit(dt: number): void {
  if (!atTitle) return;
  const st = world.controls.getState();
  world.controls.setState({ ...st, yaw: st.yaw + dt * 0.035 });
}

// ---------- チュートリアル ----------
const tutorial = new Tutorial(
  () => ({ city, camera: world.controls.getState(), panel: hall.open, infoMode: hall.infoMode, speed, tool: tools.tool }),
  (completed) => {
    city.disastersEnabled = settings.disasters;
    city.warEnabled = settings.war;
    if (completed) {
      settings.tutorialDone = true;
      saveSettings(settings);
      showModal('チュートリアル完了', [para('基本の操作はこれで終わりです。この街はそのまま育てられます（自動保存されます）。'), para('災害と紛争はチュートリアルの間だけ止めていました。いまは設定どおりに戻っています。', 'note')], [{ label: '街づくりを続ける', primary: true }]);
    }
  },
);
function startTutorial(): void {
  hideTitle();
  const s = freshCity();
  startCity(s, 'campaign');
  cityName = 'はじめ市';
  $<HTMLInputElement>('cityName').value = cityName;
  city.disastersEnabled = false;
  city.warEnabled = false;
  world.controls.setState({ ...DEFAULT_CAMERA, distance: 1400, pitch: 0.7 });
  setSpeed(0);
  tutorial.begin();
}

// ---------- ループ ----------
window.addEventListener('resize', () => world.resize());
let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  view.sync(sim.day);
  view.update(now / 1000, speed === 0 ? 0 : dt * Math.min(speed, 3));
  updateDayTime(dt);
  updateFm(dt);
  titleOrbit(dt);
  tutorial.update();
  world.setWeather(view.weather);
  hall.update();
  checkPolitics();
  world.render(dt);
  updateProbe(dt);
  updateLabels();
  $('needle').setAttribute('transform', `rotate(${(world.heading() * 180) / Math.PI} 20 20)`);
  requestAnimationFrame(frame);
}

window.addEventListener('beforeunload', () => { if (terrain && !demoCity && city.ending?.kind !== 'coup') storeSave('auto', snapshot()); });

// 起動：前回の自動保存があれば続きから
requestAnimationFrame(() => {
  const resume = loadSave('auto');
  if (resume) startCity(resume);
  else {
    // 初めての人には、背景用の小さな町を見せる（保存はしない）
    startCity(freshCity());
    city.seedTown((q) => Math.hypot(q.x, q.z - 150) < 320 && city.ownsLand(q), [[1, 0.5], [2, 0.15], [3, 0.2], [4, 0.1], [5, 0.05]], 1_600, 25, 24);
    demoCity = true;
  }
  $('loading').hidden = true;
  showTitle();
  void migrateOldSave((s) => ({ cityName: s.cityName, savedAt: s.savedAt, day: s.sim.day, population: 0, money: s.city.economy?.money ?? 0, scenario: '' }));
  requestAnimationFrame(frame);
});

// 開発時だけ、ブラウザのコンソールから触れるようにする
if (import.meta.env.DEV) Object.assign(window, { __world: world, __app: { get city() { return city; }, tools, view, sound, env: ENV, showEnding, setDayTime: (t: number) => { dayTime = t; } } });
