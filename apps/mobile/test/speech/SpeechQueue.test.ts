import {
  MAX_SPEECH_RATE,
  MIN_SPEECH_RATE,
  SpeechQueue,
  splitChunk,
  type SpeechEngine,
  type SpeakOptions,
} from '../../src/speech/SpeechQueue';

/** Records every utterance and lets the test fire its callbacks by hand. */
class FakeEngine implements SpeechEngine {
  spoken: { text: string; opts: SpeakOptions }[] = [];
  stopCalls = 0;
  throwOnSpeak: unknown = undefined;

  speak(text: string, opts: SpeakOptions): void {
    if (this.throwOnSpeak !== undefined) throw this.throwOnSpeak;
    this.spoken.push({ text, opts });
  }

  stop(): void {
    this.stopCalls += 1;
  }

  get last() {
    const u = this.spoken[this.spoken.length - 1];
    if (!u) throw new Error('nothing spoken');
    return u;
  }

  texts() {
    return this.spoken.map((u) => u.text);
  }
}

const CHUNKS = ['Chunk zero.', 'Chunk one.', 'Chunk two.'];

function setup(chunks: string[] = CHUNKS) {
  const engine = new FakeEngine();
  const queue = new SpeechQueue(engine);
  queue.load(chunks);
  return { engine, queue };
}

describe('SpeechQueue playback', () => {
  it('starts idle at index 0 after load', () => {
    const { engine, queue } = setup();
    expect(queue.state).toBe('idle');
    expect(queue.index).toBe(0);
    expect(engine.spoken).toHaveLength(0);
  });

  it('play speaks chunk 0 in en-US at the default rate', () => {
    const { engine, queue } = setup();
    queue.play();
    expect(queue.state).toBe('playing');
    expect(engine.texts()).toEqual(['Chunk zero.']);
    expect(engine.last.opts.language).toBe('en-US');
    expect(engine.last.opts.rate).toBe(1);
  });

  it('onDone advances to the next chunk and the last onDone returns to idle', () => {
    const { engine, queue } = setup();
    queue.play();
    engine.last.opts.onDone();
    expect(queue.index).toBe(1);
    expect(queue.state).toBe('playing');
    expect(engine.texts()).toEqual(['Chunk zero.', 'Chunk one.']);
    engine.last.opts.onDone();
    expect(queue.index).toBe(2);
    engine.last.opts.onDone();
    expect(queue.state).toBe('idle');
    expect(queue.index).toBe(0);
    expect(engine.spoken).toHaveLength(3);
  });

  it('play with nothing loaded does nothing', () => {
    const { engine, queue } = setup([]);
    queue.play();
    expect(queue.state).toBe('idle');
    expect(engine.spoken).toHaveLength(0);
  });

  it('play while already playing does not speak twice', () => {
    const { engine, queue } = setup();
    queue.play();
    queue.play();
    expect(engine.spoken).toHaveLength(1);
  });
});

describe('pause, resume, repeat, stop', () => {
  it('pause calls engine.stop and keeps the index', () => {
    const { engine, queue } = setup();
    queue.play();
    engine.last.opts.onDone();
    queue.pause();
    expect(engine.stopCalls).toBe(1);
    expect(queue.state).toBe('paused');
    expect(queue.index).toBe(1);
  });

  it('resume re-speaks the current chunk from its start', () => {
    const { engine, queue } = setup();
    queue.play();
    engine.last.opts.onDone();
    queue.pause();
    queue.resume();
    expect(queue.state).toBe('playing');
    expect(queue.index).toBe(1);
    expect(engine.texts()).toEqual(['Chunk zero.', 'Chunk one.', 'Chunk one.']);
  });

  it('resume when not paused does nothing', () => {
    const { engine, queue } = setup();
    queue.resume();
    expect(queue.state).toBe('idle');
    expect(engine.spoken).toHaveLength(0);
  });

  it('play while paused continues from the current chunk', () => {
    const { engine, queue } = setup();
    queue.play();
    engine.last.opts.onDone();
    queue.pause();
    queue.play();
    expect(queue.index).toBe(1);
    expect(engine.last.text).toBe('Chunk one.');
  });

  it('repeat restarts the current chunk while playing', () => {
    const { engine, queue } = setup();
    queue.play();
    engine.last.opts.onDone();
    queue.repeat();
    expect(engine.stopCalls).toBe(1);
    expect(queue.state).toBe('playing');
    expect(queue.index).toBe(1);
    expect(engine.texts()).toEqual(['Chunk zero.', 'Chunk one.', 'Chunk one.']);
  });

  it('repeat while paused speaks the current chunk', () => {
    const { engine, queue } = setup();
    queue.play();
    queue.pause();
    queue.repeat();
    expect(queue.state).toBe('playing');
    expect(engine.texts()).toEqual(['Chunk zero.', 'Chunk zero.']);
  });

  it('repeat with nothing loaded does nothing', () => {
    const { engine, queue } = setup([]);
    queue.repeat();
    expect(queue.state).toBe('idle');
    expect(engine.spoken).toHaveLength(0);
  });

  it('stop returns to idle at index 0 and stops the engine', () => {
    const { engine, queue } = setup();
    queue.play();
    engine.last.opts.onDone();
    queue.stop();
    expect(engine.stopCalls).toBe(1);
    expect(queue.state).toBe('idle');
    expect(queue.index).toBe(0);
  });
});

describe('stale engine callbacks are ignored', () => {
  it('onDone and onStopped from an utterance cut by pause do not advance', () => {
    const { engine, queue } = setup();
    queue.play();
    const first = engine.last.opts;
    queue.pause();
    first.onStopped();
    first.onDone();
    expect(queue.state).toBe('paused');
    expect(queue.index).toBe(0);
    expect(engine.spoken).toHaveLength(1);
  });

  it('onDone from an utterance cut by repeat does not skip a chunk', () => {
    const { engine, queue } = setup();
    queue.play();
    const first = engine.last.opts;
    queue.repeat();
    first.onDone();
    expect(queue.index).toBe(0);
    expect(engine.spoken).toHaveLength(2);
    engine.last.opts.onDone();
    expect(queue.index).toBe(1);
  });

  it('onDone from an utterance cut by stop does not restart playback', () => {
    const { engine, queue } = setup();
    queue.play();
    const first = engine.last.opts;
    queue.stop();
    first.onDone();
    expect(queue.state).toBe('idle');
    expect(queue.index).toBe(0);
    expect(engine.spoken).toHaveLength(1);
  });

  it('onDone from the previous text after load does not touch the new text', () => {
    const { engine, queue } = setup();
    queue.play();
    const first = engine.last.opts;
    queue.load(['New zero.', 'New one.']);
    first.onDone();
    expect(queue.state).toBe('idle');
    expect(queue.index).toBe(0);
    expect(engine.spoken).toHaveLength(1);
  });

  it('an onError from a superseded utterance is ignored', () => {
    const { engine, queue } = setup();
    queue.play();
    const first = engine.last.opts;
    queue.repeat();
    first.onError(new Error('old'));
    expect(queue.state).toBe('playing');
    expect(queue.lastError).toBeNull();
  });

  it('a second onDone for the same utterance advances only once', () => {
    const { engine, queue } = setup();
    queue.play();
    const first = engine.last.opts;
    first.onDone();
    first.onDone();
    expect(queue.index).toBe(1);
    expect(engine.spoken).toHaveLength(2);
  });
});

describe('unrequested stop', () => {
  it('an onStopped the queue did not ask for leaves the chunk paused and resumable', () => {
    const { engine, queue } = setup();
    queue.play();
    engine.last.opts.onDone();
    engine.last.opts.onStopped();
    expect(queue.state).toBe('paused');
    expect(queue.index).toBe(1);
    queue.resume();
    expect(engine.last.text).toBe('Chunk one.');
  });
});

describe('errors', () => {
  it('onError goes idle, keeps the index and exposes lastError', () => {
    const { engine, queue } = setup();
    queue.play();
    engine.last.opts.onDone();
    const err = new Error('tts failed');
    engine.last.opts.onError(err);
    expect(queue.state).toBe('idle');
    expect(queue.index).toBe(1);
    expect(queue.lastError).toBe(err);
  });

  it('play after an error resumes from the kept index and clears lastError', () => {
    const { engine, queue } = setup();
    queue.play();
    engine.last.opts.onDone();
    engine.last.opts.onError(new Error('tts failed'));
    queue.play();
    expect(queue.lastError).toBeNull();
    expect(queue.state).toBe('playing');
    expect(engine.last.text).toBe('Chunk one.');
  });

  it('a synchronous throw from engine.speak is treated as onError', () => {
    const { engine, queue } = setup();
    const err = new Error('no engine');
    engine.throwOnSpeak = err;
    queue.play();
    expect(queue.state).toBe('idle');
    expect(queue.index).toBe(0);
    expect(queue.lastError).toBe(err);
  });
});

describe('rate', () => {
  it('clamps the rate to 0.5 to 1.5', () => {
    expect(MIN_SPEECH_RATE).toBe(0.5);
    expect(MAX_SPEECH_RATE).toBe(1.5);
    const { queue } = setup();
    queue.setRate(3);
    expect(queue.rate).toBe(1.5);
    queue.setRate(0.1);
    expect(queue.rate).toBe(0.5);
    queue.setRate(1.25);
    expect(queue.rate).toBe(1.25);
  });

  it('ignores a non-finite rate', () => {
    const { queue } = setup();
    queue.setRate(1.2);
    queue.setRate(Number.NaN);
    expect(queue.rate).toBe(1.2);
    queue.setRate(Number.POSITIVE_INFINITY);
    expect(queue.rate).toBe(1.2);
  });

  it('a rate change while playing applies from the next chunk', () => {
    const { engine, queue } = setup();
    queue.play();
    queue.setRate(1.5);
    expect(engine.spoken).toHaveLength(1);
    expect(engine.last.opts.rate).toBe(1);
    engine.last.opts.onDone();
    expect(engine.last.opts.rate).toBe(1.5);
  });
});

describe('load', () => {
  it('load while playing stops first and resets to idle at index 0', () => {
    const { engine, queue } = setup();
    queue.play();
    engine.last.opts.onDone();
    queue.load(['New zero.']);
    expect(engine.stopCalls).toBe(1);
    expect(queue.state).toBe('idle');
    expect(queue.index).toBe(0);
    queue.play();
    expect(engine.last.text).toBe('New zero.');
  });

  it('load clears a previous error', () => {
    const { engine, queue } = setup();
    queue.play();
    engine.last.opts.onError(new Error('x'));
    queue.load(['New zero.']);
    expect(queue.lastError).toBeNull();
  });

  it('drops blank chunks', () => {
    const { engine, queue } = setup(['One.', '   ', '', 'Two.']);
    queue.play();
    engine.last.opts.onDone();
    expect(engine.texts()).toEqual(['One.', 'Two.']);
    expect(queue.length).toBe(2);
  });

  it('splits chunks longer than the engine limit at word boundaries', () => {
    const engine = new FakeEngine();
    const queue = new SpeechQueue(engine, { maxChunkLength: 12 });
    queue.load(['alpha beta gamma delta']);
    expect(queue.length).toBe(2);
    queue.play();
    engine.last.opts.onDone();
    expect(engine.texts()).toEqual(['alpha beta', 'gamma delta']);
  });

  it('does not mutate the caller array', () => {
    const chunks = ['A.', 'B.'];
    const { queue } = setup(chunks);
    queue.load(['C.']);
    expect(chunks).toEqual(['A.', 'B.']);
  });
});

describe('splitChunk', () => {
  it('returns short text unchanged', () => {
    expect(splitChunk('Short text.', 100)).toEqual(['Short text.']);
  });

  it('never returns a piece longer than the limit, even for one long word', () => {
    const pieces = splitChunk('abcdefghij klm', 4);
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(4);
    expect(pieces.join('')).toBe('abcdefghijklm');
  });
});

describe('onChange', () => {
  it('notifies on state and index changes and can unsubscribe', () => {
    const { engine, queue } = setup();
    const cb = jest.fn();
    const off = queue.onChange(cb);
    queue.play();
    expect(cb).toHaveBeenCalled();
    const calls = cb.mock.calls.length;
    engine.last.opts.onDone();
    expect(cb.mock.calls.length).toBeGreaterThan(calls);
    off();
    const after = cb.mock.calls.length;
    queue.stop();
    expect(cb.mock.calls.length).toBe(after);
  });

  it('a throwing listener does not break playback or other listeners', () => {
    const { engine, queue } = setup();
    const good = jest.fn();
    queue.onChange(() => {
      throw new Error('listener bug');
    });
    queue.onChange(good);
    queue.play();
    expect(good).toHaveBeenCalled();
    expect(engine.spoken).toHaveLength(1);
  });
});
