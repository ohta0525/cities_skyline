/// <reference lib="webworker" />
import { advance, type Speed, type YearMinutes } from './clock';
import type { FromWorker, SimState, ToWorker } from './protocol';

// シミュレーションは描画と別スレッドで進める。今は暦だけ。
let state: SimState = { day: 0 };
let yearMinutes: YearMinutes = 15;
let speed: Speed = 1;
let last = performance.now();
let timer: ReturnType<typeof setInterval> | undefined;

const post = (m: FromWorker) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);

function loop() {
  const now = performance.now();
  const dt = Math.min(1000, now - last);
  last = now;
  if (speed > 0) {
    state = { ...state, day: advance(state.day, dt, yearMinutes, speed) };
    post({ type: 'tick', state });
  }
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  switch (m.type) {
    case 'init':
      state = { ...m.state };
      yearMinutes = m.yearMinutes;
      speed = m.speed;
      last = performance.now();
      if (!timer) timer = setInterval(loop, 50);
      post({ type: 'tick', state });
      break;
    case 'speed':
      speed = m.speed;
      break;
    case 'yearMinutes':
      yearMinutes = m.yearMinutes;
      break;
    case 'snapshot':
      post({ type: 'snapshot', requestId: m.requestId, state });
      break;
  }
};
