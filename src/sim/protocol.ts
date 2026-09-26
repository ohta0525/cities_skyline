import type { Speed, YearMinutes } from './clock';

/** シミュレーションの状態。セーブデータにそのまま入る */
export interface SimState {
  day: number;
}

export type ToWorker =
  | { type: 'init'; state: SimState; yearMinutes: YearMinutes; speed: Speed }
  | { type: 'speed'; speed: Speed }
  | { type: 'yearMinutes'; yearMinutes: YearMinutes }
  | { type: 'snapshot'; requestId: number };

export type FromWorker =
  | { type: 'tick'; state: SimState }
  | { type: 'snapshot'; requestId: number; state: SimState };
