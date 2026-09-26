/**
 * 音はすべて Web Audio で合成する（音源ファイルなし）。
 * 環境音：風、雨、セミ（夏の昼）、虫の声（秋の夜）、鳥（春の朝）、風鈴（夏）
 * 夕方 5 時のチャイム（防災無線の「夕焼け小焼け」）、警報音、和風の lo-fi BGM
 */

export interface SoundScene {
  /** 0〜1（0.5 が正午） */
  time: number;
  season: '春' | '夏' | '秋' | '冬';
  /** 0〜1 */
  rain: number;
  /** 一時停止中 */
  paused: boolean;
  /** カメラの近さ 0（遠い）〜1（近い） */
  near: number;
}

const YO = [0, 2, 5, 7, 9]; // 陽音階（ヨナ抜き）

export class Sound {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private ambBus!: GainNode;
  private bgmBus!: GainNode;
  private noise!: AudioBuffer;
  private wind?: { g: GainNode; f: BiquadFilterNode };
  private rain?: { g: GainNode };
  private cicada?: { g: GainNode };
  private nextChirp = 0;
  private nextBgm = 0;
  private bgmStep = 0;
  private lastTime = 0.5;
  volume = 0.6;
  bgm = true;
  ambient = true;

  /** 最初のクリックなどで呼ぶ（ブラウザは操作前に音を出せない） */
  start(): void {
    if (this.ctx) { void this.ctx.resume(); return; }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(ctx.destination);
    this.ambBus = ctx.createGain();
    this.ambBus.connect(this.master);
    this.bgmBus = ctx.createGain();
    this.bgmBus.gain.value = 0.35;
    this.bgmBus.connect(this.master);
    // 白色雑音（2 秒のループ）
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    let b = 0;
    for (let i = 0; i < d.length; i++) { b = 0.97 * b + 0.03 * (Math.random() * 2 - 1); d[i] = b * 6; }
    this.wind = this.loop(260, 'lowpass', 0);
    this.rain = this.loop(2400, 'bandpass', 0);
    this.cicada = this.cicadaLoop();
  }

  get running(): boolean { return !!this.ctx && this.ctx.state === 'running'; }

  setVolume(v: number): void {
    this.volume = v;
    if (this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.1);
  }

  private loop(freq: number, type: BiquadFilterType, gain: number): { g: GainNode; f: BiquadFilterNode } {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(f).connect(g).connect(this.ambBus);
    src.start();
    return { g, f };
  }

  /** セミ：高い帯域の雑音を速く震わせる */
  private cicadaLoop(): { g: GainNode } {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 5200;
    f.Q.value = 6;
    const am = ctx.createGain();
    am.gain.value = 0.5;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 28;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.5;
    lfo.connect(lfoGain).connect(am.gain);
    lfo.start();
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(f).connect(am).connect(g).connect(this.ambBus);
    src.start();
    return { g };
  }

  private tone(freq: number, at: number, dur: number, gain: number, type: OscillatorType = 'sine', bus?: AudioNode, attack = 0.01): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(gain, at + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g).connect(bus ?? this.ambBus);
    o.start(at);
    o.stop(at + dur + 0.05);
  }

  /** 毎フレーム呼ぶ */
  update(s: SoundScene): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    const amb = this.ambient && !s.paused ? 1 : 0;
    const dayK = Math.max(0, Math.sin((s.time - 0.25) * Math.PI * 2));
    const night = 1 - Math.min(1, dayK * 3);
    this.ambBus.gain.setTargetAtTime(amb * (0.5 + s.near * 0.5), now, 0.3);
    this.wind!.g.gain.setTargetAtTime(0.05 + (s.season === '冬' ? 0.08 : 0) + s.rain * 0.12, now, 0.5);
    this.wind!.f.frequency.setTargetAtTime(220 + s.rain * 500, now, 0.5);
    this.rain!.g.gain.setTargetAtTime(s.rain * 0.14, now, 0.4);
    this.cicada!.g.gain.setTargetAtTime(s.season === '夏' && s.rain < 0.3 ? 0.05 * dayK : 0, now, 0.8);
    // 鳥（春の朝）、虫の声（秋の夜）、風鈴（夏）
    if (now > this.nextChirp && amb) {
      this.nextChirp = now + 0.6 + Math.random() * 2.2;
      if (s.season === '春' && dayK > 0.2 && s.rain < 0.3) {
        const f = 2600 + Math.random() * 1400;
        for (let k = 0; k < 3; k++) this.tone(f + k * 180, now + k * 0.09, 0.08, 0.03, 'sine');
      } else if (s.season === '秋' && night > 0.5) {
        const f = 4200 + Math.random() * 500;
        for (let k = 0; k < 5; k++) this.tone(f, now + k * 0.07, 0.06, 0.018, 'sine');
      } else if (s.season === '夏' && Math.random() < 0.35) {
        const f = 2400 + Math.random() * 600;
        this.tone(f, now, 1.6, 0.025, 'sine');
        this.tone(f * 2.76, now, 0.9, 0.01, 'sine');
      }
    }
    // 夕方 5 時のチャイム
    const five = 17 / 24;
    if (this.lastTime < five && s.time >= five && !s.paused) this.chime();
    this.lastTime = s.time;
    // BGM
    this.bgmBus.gain.setTargetAtTime(this.bgm && !s.paused ? 0.35 : 0, now, 0.4);
    if (this.bgm && now > this.nextBgm - 0.1) this.bgmTick(this.nextBgm < now ? now : this.nextBgm, night);
  }

  /** 夕焼け小焼け（防災無線ふう：少し遅れて響く） */
  chime(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t0 = ctx.currentTime + 0.1;
    // ゆうやけこやけで ひがくれて
    const melody: [number, number][] = [[67, 1], [67, 1], [69, 1], [69, 1], [67, 1], [67, 1], [64, 2], [60, 1], [60, 1], [62, 1], [64, 1], [62, 3]];
    const beat = 0.42;
    let t = t0;
    const echo = ctx.createDelay();
    echo.delayTime.value = 0.23;
    const eg = ctx.createGain();
    eg.gain.value = 0.35;
    const bus = ctx.createGain();
    bus.gain.value = 1;
    bus.connect(this.master);
    bus.connect(echo).connect(eg).connect(this.master);
    for (const [n, len] of melody) {
      const f = 440 * Math.pow(2, (n - 69) / 12);
      this.tone(f, t, len * beat * 1.1, 0.06, 'triangle', bus, 0.03);
      this.tone(f * 2, t, len * beat * 0.6, 0.015, 'sine', bus, 0.03);
      t += len * beat;
    }
  }

  /** 警報（二つの音を交互に） */
  alarm(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t0 = ctx.currentTime + 0.05;
    for (let k = 0; k < 6; k++) this.tone(k % 2 ? 660 : 880, t0 + k * 0.35, 0.33, 0.05, 'square', this.master, 0.01);
  }

  /** 決定音 */
  blip(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.tone(880, ctx.currentTime, 0.12, 0.03, 'sine', this.master);
  }

  /** 和風の lo-fi：ヨナ抜き音階のゆったりしたフレーズと、やわらかい拍 */
  private bgmTick(at: number, night: number): void {
    const beat = 60 / 72;
    const chords = [[57, 60, 64], [53, 57, 60], [55, 59, 62], [52, 55, 59]];
    const bar = Math.floor(this.bgmStep / 4) % chords.length;
    const pos = this.bgmStep % 4;
    const base = night > 0.5 ? 62 : 67;
    if (pos === 0) for (const n of chords[bar]) this.tone(440 * Math.pow(2, (n - 69) / 12), at, beat * 3.8, 0.018, 'triangle', this.bgmBus, 0.2);
    if (Math.random() < 0.7) {
      const deg = YO[Math.floor(Math.random() * YO.length)] + (Math.random() < 0.3 ? 12 : 0);
      this.tone(440 * Math.pow(2, (base + deg - 69) / 12), at + (Math.random() < 0.3 ? beat / 2 : 0), beat * 1.5, 0.028, 'sine', this.bgmBus, 0.01);
    }
    // やわらかいキックとハイハット
    if (pos === 0 || pos === 2) this.tone(60, at, 0.25, 0.08, 'sine', this.bgmBus, 0.005);
    if (Math.random() < 0.8) this.hat(at + beat / 2);
    this.bgmStep++;
    this.nextBgm = at + beat;
  }

  private hat(at: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 6000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.02, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
    src.connect(f).connect(g).connect(this.bgmBus);
    src.start(at, Math.random());
    src.stop(at + 0.06);
  }
}
