import { act, renderHook } from '@testing-library/react-native';
import * as Speech from 'expo-speech';
import { useSpeech } from '../../src/speech/useSpeech';

const speak = Speech.speak as jest.Mock;
const stop = Speech.stop as jest.Mock;

function lastSpeakOptions(): Speech.SpeechOptions {
  const call = speak.mock.calls[speak.mock.calls.length - 1];
  if (!call) throw new Error('speak not called');
  return call[1] as Speech.SpeechOptions;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('useSpeech', () => {
  it('speaks through expo-speech in en-US at the given rate', async () => {
    const { result } = await renderHook(() => useSpeech({ rate: 1.25 }));
    await act(async () => {
      result.current.load(['Hello.', 'World.']);
      result.current.play();
    });
    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak.mock.calls[0][0]).toBe('Hello.');
    const opts = lastSpeakOptions();
    expect(opts.language).toBe('en-US');
    expect(opts.rate).toBe(1.25);
    expect(result.current.state).toBe('playing');
    expect(result.current.index).toBe(0);
  });

  it('re-renders as expo-speech reports chunks done', async () => {
    const { result } = await renderHook(() => useSpeech());
    await act(async () => {
      result.current.load(['Hello.', 'World.']);
      result.current.play();
    });
    await act(async () => {
      lastSpeakOptions().onDone?.();
    });
    expect(result.current.index).toBe(1);
    expect(speak.mock.calls[1][0]).toBe('World.');
    await act(async () => {
      lastSpeakOptions().onDone?.();
    });
    expect(result.current.state).toBe('idle');
  });

  it('pause calls Speech.stop and exposes paused state', async () => {
    const { result } = await renderHook(() => useSpeech());
    await act(async () => {
      result.current.load(['Hello.']);
      result.current.play();
    });
    await act(async () => result.current.pause());
    expect(stop).toHaveBeenCalled();
    expect(result.current.state).toBe('paused');
  });

  it('exposes lastError from expo-speech onError', async () => {
    const { result } = await renderHook(() => useSpeech());
    await act(async () => {
      result.current.load(['Hello.']);
      result.current.play();
    });
    const err = new Error('tts');
    await act(async () => {
      lastSpeakOptions().onError?.(err);
    });
    expect(result.current.state).toBe('idle');
    expect(result.current.lastError).toBe(err);
  });

  it('applies a new rate prop from the next chunk', async () => {
    const { result, rerender } = await renderHook(
      ({ rate }: { rate: number }) => useSpeech({ rate }),
      { initialProps: { rate: 1 } },
    );
    await act(async () => {
      result.current.load(['Hello.', 'World.']);
      result.current.play();
    });
    await rerender({ rate: 0.5 });
    await act(async () => {
      lastSpeakOptions().onDone?.();
    });
    expect(lastSpeakOptions().rate).toBe(0.5);
  });

  it('stops speech on unmount', async () => {
    const { result, unmount } = await renderHook(() => useSpeech());
    await act(async () => {
      result.current.load(['Hello.']);
      result.current.play();
    });
    stop.mockClear();
    await unmount();
    expect(stop).toHaveBeenCalled();
  });

  it('keeps the same control functions across renders', async () => {
    const { result, rerender } = await renderHook(() => useSpeech());
    const first = result.current.play;
    await rerender({});
    expect(result.current.play).toBe(first);
  });
});
