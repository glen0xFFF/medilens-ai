/**
 * User settings (spec §4.4, §6 screen 11), kept on the device with
 * AsyncStorage. Only these preferences are stored: never photos, label text
 * or results. Storage failures are swallowed so a broken store can never stop
 * the app from reading a label; the app then runs on defaults.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export const SETTINGS_KEY = 'medilens.settings.v1';

export const TEXT_SCALES = [1, 1.25, 1.5] as const;
export type TextScale = (typeof TEXT_SCALES)[number];

export const MIN_SPEECH_RATE = 0.5;
export const MAX_SPEECH_RATE = 1.5;

export interface Settings {
  speechRate: number;
  highContrast: boolean;
  textScale: TextScale;
  autoSpeak: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  speechRate: 1,
  highContrast: false,
  textScale: 1,
  autoSpeak: true,
};

/** The slice of AsyncStorage settings use, injectable for tests. */
export interface SettingsStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export function clampSpeechRate(rate: number): number {
  return Math.min(MAX_SPEECH_RATE, Math.max(MIN_SPEECH_RATE, rate));
}

/** Any stored value back to valid settings; each bad field falls back to its default. */
export function sanitizeSettings(raw: unknown): Settings {
  const r: Record<string, unknown> =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const rate = r.speechRate;
  const scale = TEXT_SCALES.find((s) => s === r.textScale);
  return {
    speechRate:
      typeof rate === 'number' && Number.isFinite(rate)
        ? clampSpeechRate(rate)
        : DEFAULT_SETTINGS.speechRate,
    highContrast:
      typeof r.highContrast === 'boolean' ? r.highContrast : DEFAULT_SETTINGS.highContrast,
    textScale: scale ?? DEFAULT_SETTINGS.textScale,
    autoSpeak: typeof r.autoSpeak === 'boolean' ? r.autoSpeak : DEFAULT_SETTINGS.autoSpeak,
  };
}

export async function loadSettings(storage: SettingsStorage = AsyncStorage): Promise<Settings> {
  try {
    const stored = await storage.getItem(SETTINGS_KEY);
    if (stored === null) return DEFAULT_SETTINGS;
    return sanitizeSettings(JSON.parse(stored));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(
  settings: Settings,
  storage: SettingsStorage = AsyncStorage,
): Promise<void> {
  try {
    await storage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Keep running on the in-memory settings; nothing else depends on the write.
  }
}

export interface SettingsContextValue extends Settings {
  /** True once stored settings have been read (or found missing). */
  loaded: boolean;
  setSpeechRate(rate: number): void;
  setHighContrast(on: boolean): void;
  setTextScale(scale: TextScale): void;
  setAutoSpeak(on: boolean): void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({
  children,
  storage = AsyncStorage,
}: {
  children: ReactNode;
  storage?: SettingsStorage;
}) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const latest = useRef<Settings>(DEFAULT_SETTINGS);
  const hydrated = useRef(false);
  // Changes made before the stored settings arrive (final review Minor 23).
  // They win over the stored values they touch and leave the others alone, and
  // nothing is saved until the stored settings are known, so an early change
  // can never overwrite them with defaults.
  const early = useRef<Partial<Settings>>({});

  useEffect(() => {
    let active = true;
    void loadSettings(storage).then((stored) => {
      if (!active) return;
      hydrated.current = true;
      const patch = early.current;
      early.current = {};
      const changed = Object.keys(patch).length > 0;
      const next = changed ? sanitizeSettings({ ...stored, ...patch }) : stored;
      latest.current = next;
      setSettings(next);
      setLoaded(true);
      if (changed) void saveSettings(next, storage);
    });
    return () => {
      active = false;
    };
  }, [storage]);

  const update = useCallback(
    (patch: Partial<Settings>) => {
      const next = sanitizeSettings({ ...latest.current, ...patch });
      latest.current = next;
      setSettings(next);
      if (hydrated.current) void saveSettings(next, storage);
      else early.current = { ...early.current, ...patch };
    },
    [storage],
  );

  const value = useMemo<SettingsContextValue>(
    () => ({
      ...settings,
      loaded,
      setSpeechRate: (speechRate) => update({ speechRate }),
      setHighContrast: (highContrast) => update({ highContrast }),
      setTextScale: (textScale) => update({ textScale }),
      setAutoSpeak: (autoSpeak) => update({ autoSpeak }),
    }),
    [settings, loaded, update],
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  const value = useContext(SettingsContext);
  if (value === null) throw new Error('useSettings must be used inside <SettingsProvider>.');
  return value;
}
