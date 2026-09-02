// Fully synthesised audio: wind and tyre noise beds driven by speed/surface,
// freewheel + chain click schedulers, suspension thumps, crash impacts, boost
// whoosh, checkpoint chimes, countdown, start horn. No samples anywhere.
export class AudioEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private noiseBuf!: AudioBuffer;

  private windGain?: GainNode;
  private windFilter?: BiquadFilterNode;
  private tireGain?: GainNode;
  private tireFilter?: BiquadFilterNode;
  private tireRate?: AudioBufferSourceNode;

  private freewheelAcc = 0;
  private chainAcc = 0;
  enabled = false;

  /** must be called from a user gesture */
  init(): void {
    if (this.ctx) { this.ctx.resume(); return; }
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctx();
    const ctx = this.ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0.55;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 5;
    this.master.connect(comp);
    comp.connect(ctx.destination);

    // shared noise buffer (2 s white)
    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    // ---- wind bed ----
    const windSrc = ctx.createBufferSource();
    windSrc.buffer = this.noiseBuf;
    windSrc.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 700;
    this.windFilter.Q.value = 0.6;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    windSrc.connect(this.windFilter).connect(this.windGain).connect(this.master);
    windSrc.start();

    // ---- tyre bed ----
    this.tireRate = ctx.createBufferSource();
    this.tireRate.buffer = this.noiseBuf;
    this.tireRate.loop = true;
    this.tireRate.playbackRate.value = 0.7;
    this.tireFilter = ctx.createBiquadFilter();
    this.tireFilter.type = 'bandpass';
    this.tireFilter.frequency.value = 320;
    this.tireFilter.Q.value = 1.1;
    this.tireGain = ctx.createGain();
    this.tireGain.gain.value = 0;
    this.tireRate.connect(this.tireFilter).connect(this.tireGain).connect(this.master);
    this.tireRate.start();

    this.enabled = true;
  }

  /** per-frame state from the player bike */
  update(speedMs: number, surface: number, pedaling: boolean, coasting: boolean, boosting: boolean, dt: number): void {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    const v = Math.min(1, speedMs / 26);

    // wind rises with speed
    this.windGain!.gain.setTargetAtTime(v * v * 0.34, t, 0.12);
    this.windFilter!.frequency.setTargetAtTime(500 + v * 900, t, 0.2);

    // tyre tone by surface: rock bright crunch, dirt mid, grass soft high
    const surfFreq = [340, 300, 720, 820, 260, 380, 240][surface] ?? 320;
    this.tireFilter!.frequency.setTargetAtTime(surfFreq + v * 220, t, 0.15);
    this.tireGain!.gain.setTargetAtTime(v * 0.16, t, 0.1);

    // freewheel clicks while coasting
    if (coasting && speedMs > 2) {
      this.freewheelAcc += dt * (4 + speedMs * 0.85);
      while (this.freewheelAcc > 1) {
        this.freewheelAcc -= 1;
        this.click(2100 + Math.random() * 500, 0.05, 0.016);
      }
    }
    // chain ticks when pedaling
    if (pedaling && speedMs > 0.5) {
      this.chainAcc += dt * (2.5 + speedMs * 0.55);
      while (this.chainAcc > 1) {
        this.chainAcc -= 1;
        this.click(1400 + Math.random() * 300, 0.035, 0.013);
      }
    }
    void boosting;
  }

  private click(freq: number, vol: number, dur: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    o.connect(g).connect(this.master);
    o.start();
    o.stop(ctx.currentTime + dur + 0.01);
  }

  thump(intensity: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 130 + intensity * 30;
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.min(0.9, intensity * 0.09), ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
    src.connect(f).connect(g).connect(this.master);
    src.start(ctx.currentTime, Math.random());
    src.stop(ctx.currentTime + 0.22);
  }

  crash(): void {
    if (!this.ctx) return;
    this.thump(10);
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(1800, ctx.currentTime);
    f.frequency.exponentialRampToValueAtTime(160, ctx.currentTime + 0.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.6);
    src.connect(f).connect(g).connect(this.master);
    src.start();
    src.stop(ctx.currentTime + 0.65);
  }

  whoosh(): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 2;
    f.frequency.setValueAtTime(400, ctx.currentTime);
    f.frequency.exponentialRampToValueAtTime(2600, ctx.currentTime + 0.35);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.28, ctx.currentTime + 0.12);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.45);
    src.connect(f).connect(g).connect(this.master);
    src.start();
    src.stop(ctx.currentTime + 0.5);
  }

  ding(step = 0): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const notes = [880, 1108, 1318];
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = notes[step % notes.length];
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.18, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.3);
    o.connect(g).connect(this.master);
    o.start();
    o.stop(ctx.currentTime + 0.32);
  }

  trickArp(): void {
    this.ding(0);
    setTimeout(() => this.ding(1), 70);
    setTimeout(() => this.ding(2), 140);
  }

  beep(high: boolean): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = high ? 1320 : 660;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.25, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + (high ? 0.5 : 0.18));
    o.connect(g).connect(this.master);
    o.start();
    o.stop(ctx.currentTime + 0.55);
  }

  horn(): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    for (const f of [220, 330, 440]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.001, ctx.currentTime);
      g.gain.linearRampToValueAtTime(0.14, ctx.currentTime + 0.08);
      g.gain.setValueAtTime(0.14, ctx.currentTime + 0.65);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.95);
      o.connect(g).connect(this.master);
      o.start();
      o.stop(ctx.currentTime + 1);
    }
  }
}
