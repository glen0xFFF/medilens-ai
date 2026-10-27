/**
 * Chunked speech playback (spec §4.4 G4, §5.1): play, pause, resume, repeat,
 * stop and rate over an ordered list of spoken chunks. Pure TypeScript over an
 * injected SpeechEngine (expo-speech on the device, a fake in tests).
 *
 * Text-to-speech engines cannot pause mid-utterance reliably on Android, so
 * pause stops the engine and remembers the chunk; resume restarts that chunk.
 *
 * Every utterance gets a generation number. Pause, stop, repeat and load bump
 * the generation, so a late onDone/onStopped/onError from a superseded
 * utterance is ignored instead of advancing or erroring the new playback.
 */

export interface SpeakOptions {
  rate: number;
  language: 'en-US';
  onDone: () => void;
  onStopped: () => void;
  onError: (e: unknown) => void;
}

export interface SpeechEngine {
  speak(text: string, opts: SpeakOptions): void;
  stop(): void;
}

export type SpeechState = 'idle' | 'playing' | 'paused';

export const MIN_SPEECH_RATE = 0.5;
export const MAX_SPEECH_RATE = 1.5;
export const DEFAULT_SPEECH_RATE = 1;

export interface SpeechQueueOptions {
  /** Longest text handed to the engine in one utterance. */
  maxChunkLength?: number;
}

/** Splits text into pieces of at most `max` characters, preferring word boundaries. */
export function splitChunk(text: string, max: number): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed ? [trimmed] : [];
  const pieces: string[] = [];
  let rest = trimmed;
  while (rest.length > max) {
    const space = rest.lastIndexOf(' ', max);
    const cut = space > 0 ? space : max;
    const head = rest.slice(0, cut).trim();
    if (head) pieces.push(head);
    rest = rest.slice(cut).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

export class SpeechQueue {
  private readonly engine: SpeechEngine;
  private readonly maxChunkLength: number;
  private chunks: string[] = [];
  private listeners = new Set<() => void>();
  private generation = 0;
  private _state: SpeechState = 'idle';
  private _index = 0;
  private _rate = DEFAULT_SPEECH_RATE;
  private _lastError: unknown = null;

  constructor(engine: SpeechEngine, options: SpeechQueueOptions = {}) {
    this.engine = engine;
    const max = options.maxChunkLength;
    this.maxChunkLength = max !== undefined && max >= 1 ? Math.floor(max) : Number.POSITIVE_INFINITY;
  }

  get state(): SpeechState {
    return this._state;
  }

  get index(): number {
    return this._index;
  }

  get rate(): number {
    return this._rate;
  }

  get length(): number {
    return this.chunks.length;
  }

  /** The error from the last failed utterance, or null. Cleared by play, resume, repeat and load. */
  get lastError(): unknown {
    return this._lastError;
  }

  /** Replaces the text. Any current speech is stopped first. */
  load(chunks: string[]): void {
    this.halt();
    this.chunks = chunks.flatMap((c) => splitChunk(c, this.maxChunkLength));
    this._state = 'idle';
    this._index = 0;
    this._lastError = null;
    this.emit();
  }

  /** Starts from the current chunk (chunk 0 after load, stop or finishing). */
  play(): void {
    if (this._state === 'playing' || this.chunks.length === 0) return;
    this.speakCurrent();
  }

  pause(): void {
    if (this._state !== 'playing') return;
    this.halt();
    this._state = 'paused';
    this.emit();
  }

  /** Restarts the chunk that was interrupted by pause. */
  resume(): void {
    if (this._state !== 'paused') return;
    this.speakCurrent();
  }

  /** Restarts the current chunk from its beginning. */
  repeat(): void {
    if (this.chunks.length === 0) return;
    this.halt();
    this.speakCurrent();
  }

  stop(): void {
    this.halt();
    this._state = 'idle';
    this._index = 0;
    this.emit();
  }

  /** Clamped to 0.5–1.5; while playing it applies from the next chunk. */
  setRate(rate: number): void {
    if (!Number.isFinite(rate)) return;
    this._rate = Math.min(MAX_SPEECH_RATE, Math.max(MIN_SPEECH_RATE, rate));
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Stops the engine (if it may be speaking) and invalidates pending callbacks. */
  private halt(): void {
    this.generation += 1;
    if (this._state === 'playing') this.engine.stop();
  }

  private speakCurrent(): void {
    const text = this.chunks[this._index];
    if (text === undefined) return;
    this.generation += 1;
    const gen = this.generation;
    const current = () => gen === this.generation;
    this._state = 'playing';
    this._lastError = null;
    this.emit();
    try {
      this.engine.speak(text, {
        rate: this._rate,
        language: 'en-US',
        onDone: () => {
          if (current()) this.advance();
        },
        // An unrequested stop (e.g. the system took the audio) leaves the
        // chunk resumable rather than silently stuck in 'playing'.
        onStopped: () => {
          if (!current()) return;
          this.generation += 1;
          this._state = 'paused';
          this.emit();
        },
        onError: (e) => {
          if (current()) this.fail(e);
        },
      });
    } catch (e) {
      if (current()) this.fail(e);
    }
  }

  private advance(): void {
    if (this._index + 1 < this.chunks.length) {
      this._index += 1;
      this.speakCurrent();
    } else {
      this.generation += 1;
      this._state = 'idle';
      this._index = 0;
      this.emit();
    }
  }

  private fail(e: unknown): void {
    this.generation += 1;
    this._state = 'idle';
    this._lastError = e;
    this.emit();
  }

  private emit(): void {
    for (const cb of [...this.listeners]) {
      try {
        cb();
      } catch {
        // A broken listener must not stop the label being read aloud.
      }
    }
  }
}
