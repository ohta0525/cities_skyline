import './style.css';
import { randomSeed } from './core/rng';
import { loadSettings, saveSettings, type Quality, type Settings } from './core/settings';
import { World3D } from './render/world3d';
import { DEFAULT_CAMERA } from './render/camera';
import { SAVE_VERSION, deserialize, loadSave, serialize, storeSave, type SaveData } from './save/save';
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

// ---------- シミュレーション（別スレッド） ----------
const worker = new Worker(new URL('./sim/worker.ts', import.meta.url), { type: 'module' });
const send = (m: ToWorker) => worker.postMessage(m);
let lastMonth = -1;
worker.onmessage = (e: MessageEvent<FromWorker>) => {
  if (e.data.type !== 'tick') return;
  sim = e.data.state;
  updateClock();
  // 月が変わるたびに自動保存
  const month = Math.floor(sim.day / MONTH_DAYS);
  if (lastMonth >= 0 && month !== lastMonth) storeSave('auto', snapshot());
  lastMonth = month;
};

// ---------- 3D ----------
const canvas = $<HTMLCanvasElement>('view');
const world = new World3D(canvas, settings.quality, settings.miniature);

function startCity(save: SaveData): void {
  cityName = save.cityName;
  $<HTMLInputElement>('cityName').value = cityName;
  if (!terrain || terrain.seed !== save.terrain.seed) {
    terrain = generateTerrain(save.terrain.seed, save.terrain.preset);
    world.setTerrain(terrain);
  }
  world.setCityName(`瑞穂連邦　${cityName}　／　河川平野と海岸`);
  world.controls.setState(save.camera);
  sim = { ...save.sim };
  lastMonth = Math.floor(sim.day / MONTH_DAYS);
  send({ type: 'init', state: sim, yearMinutes: settings.yearMinutes, speed });
  updateClock();
}

function freshCity(): SaveData {
  return {
    version: SAVE_VERSION,
    savedAt: new Date().toISOString(),
    cityName: '新市',
    terrain: { seed: randomSeed(), preset: 'river-coast' },
    sim: { day: 0 },
    camera: { ...DEFAULT_CAMERA },
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
  const hit = pointer && world.pick(pointer.x, pointer.y);
  if (!hit) return;
  const h = heightAt(terrain, hit.point.x, hit.point.z);
  const kind = landKind(terrain, hit.point.x, hit.point.z);
  const label = h < 0 ? `水深 <b>${(-h).toFixed(1)}</b> m` : `標高 <b>${h.toFixed(1)}</b> m`;
  el.innerHTML = `${label}<span class="kind">${kind}</span>`;
}

// ---------- ループ ----------
window.addEventListener('resize', () => world.resize());
let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  world.render(dt);
  updateProbe(dt);
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
if (import.meta.env.DEV) Object.assign(window, { __world: world });
