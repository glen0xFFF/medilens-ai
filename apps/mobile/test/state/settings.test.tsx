import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  SettingsProvider,
  loadSettings,
  sanitizeSettings,
  saveSettings,
  useSettings,
  type SettingsStorage,
} from '../../src/state/settings';

const wrapper = ({ children }: { children: ReactNode }) => (
  <SettingsProvider>{children}</SettingsProvider>
);

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
});

describe('settings defaults and sanitising', () => {
  it('uses the agreed defaults and storage key', () => {
    expect(SETTINGS_KEY).toBe('medilens.settings.v1');
    expect(DEFAULT_SETTINGS).toEqual({
      speechRate: 1,
      highContrast: false,
      textScale: 1,
      autoSpeak: true,
    });
  });

  it('clamps speech rate to 0.5 to 1.5', () => {
    expect(sanitizeSettings({ speechRate: 3 }).speechRate).toBe(1.5);
    expect(sanitizeSettings({ speechRate: 0.1 }).speechRate).toBe(0.5);
    expect(sanitizeSettings({ speechRate: 1.25 }).speechRate).toBe(1.25);
    expect(sanitizeSettings({ speechRate: Number.NaN }).speechRate).toBe(1);
    expect(sanitizeSettings({ speechRate: '1.2' }).speechRate).toBe(1);
  });

  it('accepts only text scales 1, 1.25 and 1.5', () => {
    expect(sanitizeSettings({ textScale: 1.25 }).textScale).toBe(1.25);
    expect(sanitizeSettings({ textScale: 1.5 }).textScale).toBe(1.5);
    expect(sanitizeSettings({ textScale: 2 }).textScale).toBe(1);
  });

  it('falls back per field for wrong types and for non-objects', () => {
    expect(sanitizeSettings({ highContrast: 'yes', autoSpeak: 0 })).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings([1, 2])).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings({ highContrast: true, autoSpeak: false })).toEqual({
      ...DEFAULT_SETTINGS,
      highContrast: true,
      autoSpeak: false,
    });
  });
});

describe('loadSettings / saveSettings', () => {
  it('returns defaults when nothing is stored', async () => {
    await expect(loadSettings()).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it('returns defaults for corrupt JSON', async () => {
    await AsyncStorage.setItem(SETTINGS_KEY, '{not json');
    await expect(loadSettings()).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it('returns defaults when storage throws on read', async () => {
    const broken: SettingsStorage = {
      getItem: () => Promise.reject(new Error('disk')),
      setItem: () => Promise.reject(new Error('disk')),
    };
    await expect(loadSettings(broken)).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it('round-trips through AsyncStorage under the versioned key', async () => {
    const custom = {
      speechRate: 1.25,
      highContrast: true,
      textScale: 1.5 as const,
      autoSpeak: false,
    };
    await saveSettings(custom);
    expect(JSON.parse((await AsyncStorage.getItem(SETTINGS_KEY))!)).toEqual(custom);
    await expect(loadSettings()).resolves.toEqual(custom);
  });

  it('swallows a failed write', async () => {
    const broken: SettingsStorage = {
      getItem: () => Promise.resolve(null),
      setItem: () => Promise.reject(new Error('disk full')),
    };
    await expect(saveSettings(DEFAULT_SETTINGS, broken)).resolves.toBeUndefined();
  });
});

describe('SettingsProvider / useSettings', () => {
  it('hydrates stored settings', async () => {
    await AsyncStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ speechRate: 0.75, highContrast: true, textScale: 1.25, autoSpeak: false }),
    );
    const { result } = await renderHook(() => useSettings(), { wrapper });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.speechRate).toBe(0.75);
    expect(result.current.highContrast).toBe(true);
    expect(result.current.textScale).toBe(1.25);
    expect(result.current.autoSpeak).toBe(false);
  });

  it('updates and persists each setting, clamping speech rate', async () => {
    const { result } = await renderHook(() => useSettings(), { wrapper });
    await waitFor(() => expect(result.current.loaded).toBe(true));

    await act(async () => {
      result.current.setSpeechRate(9);
      result.current.setHighContrast(true);
      result.current.setTextScale(1.5);
      result.current.setAutoSpeak(false);
    });

    expect(result.current.speechRate).toBe(1.5);
    expect(result.current.highContrast).toBe(true);
    expect(result.current.textScale).toBe(1.5);
    expect(result.current.autoSpeak).toBe(false);
    await waitFor(async () =>
      expect(JSON.parse((await AsyncStorage.getItem(SETTINGS_KEY))!)).toEqual({
        speechRate: 1.5,
        highContrast: true,
        textScale: 1.5,
        autoSpeak: false,
      }),
    );
  });

  it('keeps a change made before stored settings finish loading', async () => {
    let release: (v: string | null) => void = () => undefined;
    const slow: SettingsStorage = {
      getItem: () => new Promise((resolve) => (release = resolve)),
      setItem: () => Promise.resolve(),
    };
    const { result } = await renderHook(() => useSettings(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <SettingsProvider storage={slow}>{children}</SettingsProvider>
      ),
    });
    await act(async () => result.current.setHighContrast(true));
    await act(async () => release(JSON.stringify({ highContrast: false, speechRate: 0.5 })));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.highContrast).toBe(true);
  });

  // Final review Minor 23: an early change must not overwrite the other stored settings.
  it('merges a change made before loading with the stored settings, and saves only the merge', async () => {
    let release: (v: string | null) => void = () => undefined;
    const writes: unknown[] = [];
    const slow: SettingsStorage = {
      getItem: () => new Promise((resolve) => (release = resolve)),
      setItem: (_key, value) => {
        writes.push(JSON.parse(value));
        return Promise.resolve();
      },
    };
    const { result } = await renderHook(() => useSettings(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <SettingsProvider storage={slow}>{children}</SettingsProvider>
      ),
    });
    await act(async () => result.current.setHighContrast(true));
    const stored = { speechRate: 0.5, highContrast: false, textScale: 1.5, autoSpeak: false };
    await act(async () => release(JSON.stringify(stored)));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    const merged = { ...stored, highContrast: true };
    expect(result.current).toMatchObject(merged);
    expect(writes).toEqual([merged]);
  });

  it('applies every change made before loading, in order', async () => {
    let release: (v: string | null) => void = () => undefined;
    const writes: unknown[] = [];
    const slow: SettingsStorage = {
      getItem: () => new Promise((resolve) => (release = resolve)),
      setItem: (_key, value) => {
        writes.push(JSON.parse(value));
        return Promise.resolve();
      },
    };
    const { result } = await renderHook(() => useSettings(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <SettingsProvider storage={slow}>{children}</SettingsProvider>
      ),
    });
    await act(async () => result.current.setSpeechRate(1.25));
    await act(async () => result.current.setSpeechRate(1.5));
    await act(async () => result.current.setAutoSpeak(false));
    await act(async () => release(null));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    const merged = { ...DEFAULT_SETTINGS, speechRate: 1.5, autoSpeak: false };
    expect(result.current).toMatchObject(merged);
    expect(writes).toEqual([merged]);
  });

  it('throws a clear error outside the provider', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(renderHook(() => useSettings())).rejects.toThrow(/SettingsProvider/);
    spy.mockRestore();
  });
});
