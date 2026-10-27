/**
 * Whether the first-run disclaimer has been acknowledged. The only thing
 * stored is the boolean `true`; storage failures read as "not acknowledged",
 * so the disclaimer shows again rather than being skipped.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export const DISCLAIMER_KEY = 'medilens.disclaimer.v1';

export interface FlagStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export async function isDisclaimerAcknowledged(
  storage: FlagStorage = AsyncStorage,
): Promise<boolean> {
  try {
    const stored = await storage.getItem(DISCLAIMER_KEY);
    return stored !== null && JSON.parse(stored) === true;
  } catch {
    return false;
  }
}

export async function acknowledgeDisclaimer(storage: FlagStorage = AsyncStorage): Promise<void> {
  try {
    await storage.setItem(DISCLAIMER_KEY, JSON.stringify(true));
  } catch {
    // The user still gets past the disclaimer this session; it shows again next launch.
  }
}
