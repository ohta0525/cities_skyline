import { advance, type Speed, type YearMinutes } from './clock';
import type { FromWorker, SimState, ToWorker } from './protocol';

/**
 * 暦を進める仕組み。ふだんは Web Worker の中で動くが、
 * ワーカーが使えないとき（ファイルを直接開いたときなど）は画面側でも同じものを動かす。
 */
export class SimEngine {
  private state: SimState = { day: 0 };
  private yearMinutes: YearMinutes = 15;
  private speed: Speed = 1;
  private last = performance.now();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private post: (m: FromWorker) => void) {}

  private loop(): void {
    const now = performance.now();
    const dt = Math.min(1000, now - this.last);
    this.last = now;
    if (this.speed > 0) {
      this.state = { ...this.state, day: advance(this.state.day, dt, this.yearMinutes, this.speed) };
      this.post({ type: 'tick', state: this.state });
    }
  }

  handle(m: ToWorker): void {
    switch (m.type) {
      case 'init':
        this.state = { ...m.state };
        this.yearMinutes = m.yearMinutes;
        this.speed = m.speed;
        this.last = performance.now();
        if (!this.timer) this.timer = setInterval(() => this.loop(), 50);
        this.post({ type: 'tick', state: this.state });
        break;
      case 'speed':
        this.speed = m.speed;
        break;
      case 'yearMinutes':
        this.yearMinutes = m.yearMinutes;
        break;
      case 'snapshot':
        this.post({ type: 'snapshot', requestId: m.requestId, state: this.state });
        break;
    }
  }
}
