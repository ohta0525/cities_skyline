/// <reference lib="webworker" />
import { SimEngine } from './engine';
import type { FromWorker, ToWorker } from './protocol';

// シミュレーションの暦は、描画と別スレッドで進める
const engine = new SimEngine((m: FromWorker) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m));
self.onmessage = (e: MessageEvent<ToWorker>) => engine.handle(e.data);
