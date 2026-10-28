/**
 * React binding for SpeechQueue over expo-speech. One queue per mounted
 * component; speech stops when the component unmounts so a closed screen
 * never keeps talking.
 */
import * as Speech from 'expo-speech';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_SPEECH_RATE, SpeechQueue, type SpeechEngine, type SpeechState } from './SpeechQueue';

export const expoSpeechEngine: SpeechEngine = {
  speak(text, opts) {
    Speech.speak(text, {
      language: opts.language,
      rate: opts.rate,
      onDone: opts.onDone,
      onStopped: opts.onStopped,
      onError: opts.onError,
    });
  },
  stop() {
    Speech.stop().catch(() => {
      // Nothing useful to do if the engine cannot stop; the queue has
      // already invalidated the utterance's callbacks.
    });
  },
};

function engineMaxLength(): number | undefined {
  const max = Speech.maxSpeechInputLength;
  return typeof max === 'number' && max > 0 ? max : undefined;
}

export interface UseSpeechOptions {
  /** Speech rate; clamped to 0.5–1.5 and applied from the next chunk. */
  rate?: number;
}

export interface SpeechControls {
  state: SpeechState;
  index: number;
  length: number;
  lastError: unknown;
  load(chunks: string[]): void;
  play(): void;
  pause(): void;
  resume(): void;
  repeat(): void;
  stop(): void;
}

interface Snapshot {
  state: SpeechState;
  index: number;
  length: number;
  lastError: unknown;
}

function snapshot(q: SpeechQueue): Snapshot {
  return { state: q.state, index: q.index, length: q.length, lastError: q.lastError };
}

export function useSpeech(options: UseSpeechOptions = {}): SpeechControls {
  const queueRef = useRef<SpeechQueue | null>(null);
  if (queueRef.current === null) {
    queueRef.current = new SpeechQueue(expoSpeechEngine, { maxChunkLength: engineMaxLength() });
  }
  const queue = queueRef.current;
  const [snap, setSnap] = useState<Snapshot>(() => snapshot(queue));

  useEffect(() => {
    const off = queue.onChange(() => setSnap(snapshot(queue)));
    setSnap(snapshot(queue));
    return () => {
      off();
      queue.stop();
    };
  }, [queue]);

  const rate = options.rate ?? DEFAULT_SPEECH_RATE;
  useEffect(() => {
    queue.setRate(rate);
  }, [queue, rate]);

  const load = useCallback((chunks: string[]) => queue.load(chunks), [queue]);
  const play = useCallback(() => queue.play(), [queue]);
  const pause = useCallback(() => queue.pause(), [queue]);
  const resume = useCallback(() => queue.resume(), [queue]);
  const repeat = useCallback(() => queue.repeat(), [queue]);
  const stop = useCallback(() => queue.stop(), [queue]);

  return useMemo(
    () => ({ ...snap, load, play, pause, resume, repeat, stop }),
    [snap, load, play, pause, resume, repeat, stop],
  );
}
