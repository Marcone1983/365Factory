/**
 * Procedural audio.
 *
 * Sound effects are synthesised with the Web Audio API rather than shipped as
 * files: no download cost, no licensing question, and every product gets a
 * distinct sonic identity from its seed. A three-bus mixer (master, sfx, music)
 * gives the settings screen real volume control.
 */

export type SfxName = 'ui_click' | 'ui_back' | 'pickup' | 'success' | 'failure' | 'hit' | 'jump' | 'step' | 'alert';

export interface AudioSettings {
  master: number;
  sfx: number;
  music: number;
  muted: boolean;
}

interface SfxRecipe {
  readonly type: OscillatorType;
  readonly startFrequency: number;
  readonly endFrequency: number;
  readonly duration: number;
  readonly gain: number;
  readonly noise?: number;
}

const RECIPES: Record<SfxName, SfxRecipe> = {
  ui_click: { type: 'square', startFrequency: 880, endFrequency: 660, duration: 0.06, gain: 0.16 },
  ui_back: { type: 'square', startFrequency: 540, endFrequency: 360, duration: 0.08, gain: 0.15 },
  pickup: { type: 'triangle', startFrequency: 620, endFrequency: 1180, duration: 0.16, gain: 0.22 },
  success: { type: 'triangle', startFrequency: 520, endFrequency: 1560, duration: 0.36, gain: 0.24 },
  failure: { type: 'sawtooth', startFrequency: 320, endFrequency: 90, duration: 0.42, gain: 0.22 },
  hit: { type: 'sawtooth', startFrequency: 240, endFrequency: 70, duration: 0.14, gain: 0.26, noise: 0.5 },
  jump: { type: 'sine', startFrequency: 380, endFrequency: 720, duration: 0.14, gain: 0.18 },
  step: { type: 'sine', startFrequency: 160, endFrequency: 110, duration: 0.07, gain: 0.09, noise: 0.7 },
  alert: { type: 'square', startFrequency: 760, endFrequency: 760, duration: 0.22, gain: 0.2 },
};

export class AudioEngine {
  private context: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private musicTimer: number | null = null;
  private noiseBuffer: AudioBuffer | null = null;

  readonly settings: AudioSettings = { master: 0.8, sfx: 1, music: 0.55, muted: false };

  constructor(private readonly seed: number) {}

  /** Must be called from a user gesture; browsers block autoplay otherwise. */
  resume(): void {
    if (!this.context) this.initialise();
    void this.context?.resume();
  }

  private initialise(): void {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    this.context = new Ctor();
    this.masterGain = this.context.createGain();
    this.sfxGain = this.context.createGain();
    this.musicGain = this.context.createGain();
    this.sfxGain.connect(this.masterGain);
    this.musicGain.connect(this.masterGain);
    this.masterGain.connect(this.context.destination);
    this.applySettings();

    const length = Math.floor(this.context.sampleRate * 0.4);
    this.noiseBuffer = this.context.createBuffer(1, length, this.context.sampleRate);
    const channel = this.noiseBuffer.getChannelData(0);
    let state = this.seed || 1;
    for (let i = 0; i < length; i += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      channel[i] = (state / 2147483648 - 1) * 0.6;
    }
  }

  applySettings(): void {
    if (!this.masterGain || !this.sfxGain || !this.musicGain) return;
    this.masterGain.gain.value = this.settings.muted ? 0 : this.settings.master;
    this.sfxGain.gain.value = this.settings.sfx;
    this.musicGain.gain.value = this.settings.music;
  }

  play(name: SfxName, detune = 0): void {
    if (!this.context) this.initialise();
    if (!this.context || !this.sfxGain || this.settings.muted) return;
    const recipe = RECIPES[name];
    const now = this.context.currentTime;

    const oscillator = this.context.createOscillator();
    oscillator.type = recipe.type;
    oscillator.frequency.setValueAtTime(recipe.startFrequency * (1 + detune), now);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, recipe.endFrequency * (1 + detune)), now + recipe.duration);

    const gain = this.context.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(recipe.gain, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + recipe.duration);

    oscillator.connect(gain).connect(this.sfxGain);
    oscillator.start(now);
    oscillator.stop(now + recipe.duration + 0.02);

    if (recipe.noise && this.noiseBuffer) {
      const source = this.context.createBufferSource();
      source.buffer = this.noiseBuffer;
      const noiseGain = this.context.createGain();
      noiseGain.gain.setValueAtTime(recipe.gain * recipe.noise, now);
      noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + recipe.duration);
      const filter = this.context.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = recipe.startFrequency;
      source.connect(filter).connect(noiseGain).connect(this.sfxGain);
      source.start(now);
      source.stop(now + recipe.duration);
    }
  }

  /**
   * Generative ambient music: a seeded pentatonic pad that advances on a slow
   * scheduler. It costs nothing to ship and never loops audibly.
   */
  startMusic(rootHz = 146.83): void {
    if (!this.context) this.initialise();
    if (!this.context || !this.musicGain || this.musicTimer !== null) return;
    const scale = [0, 2, 4, 7, 9, 12, 14];
    let step = this.seed % scale.length;

    const schedule = (): void => {
      if (!this.context || !this.musicGain) return;
      const now = this.context.currentTime;
      step = (step + 1 + (this.seed % 3)) % scale.length;
      const semitone = scale[step] as number;
      const frequency = rootHz * 2 ** (semitone / 12);
      for (const [index, multiplier] of [1, 1.5, 2].entries()) {
        const oscillator = this.context.createOscillator();
        oscillator.type = index === 0 ? 'sine' : 'triangle';
        oscillator.frequency.value = frequency * multiplier;
        const gain = this.context.createGain();
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.linearRampToValueAtTime(0.08 / (index + 1), now + 1.2);
        gain.gain.linearRampToValueAtTime(0.0001, now + 3.6);
        oscillator.connect(gain).connect(this.musicGain);
        oscillator.start(now);
        oscillator.stop(now + 3.8);
      }
    };

    schedule();
    this.musicTimer = window.setInterval(schedule, 3200);
  }

  stopMusic(): void {
    if (this.musicTimer !== null) {
      window.clearInterval(this.musicTimer);
      this.musicTimer = null;
    }
  }

  dispose(): void {
    this.stopMusic();
    void this.context?.close();
    this.context = null;
  }
}
