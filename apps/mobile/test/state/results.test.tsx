import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import {
  DISCLAIMER_KEY,
  acknowledgeDisclaimer,
  isDisclaimerAcknowledged,
} from '../../src/state/disclaimer';
import { ResultsProvider, useResults } from '../../src/state/results';
import { RESULTS } from '../helpers/fixtures';

describe('results store', () => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ResultsProvider>{children}</ResultsProvider>
  );

  it('keeps results in memory by id', async () => {
    const { result } = await renderHook(() => useResults(), { wrapper });
    expect(result.current.getResult(RESULTS.s1.id)).toBeUndefined();
    await act(async () => result.current.saveResult(RESULTS.s1));
    expect(result.current.getResult(RESULTS.s1.id)).toBe(RESULTS.s1);
  });

  it('never writes a result to AsyncStorage', async () => {
    // The official AsyncStorage jest mock's methods are already jest.fn()s.
    const setItem = AsyncStorage.setItem as jest.Mock;
    const before = setItem.mock.calls.length;
    const { result } = await renderHook(() => useResults(), { wrapper });
    await act(async () => result.current.saveResult(RESULTS.s4));
    expect(setItem.mock.calls.length).toBe(before);
  });

  it('throws outside the provider', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(renderHook(() => useResults())).rejects.toThrow(/ResultsProvider/);
    (console.error as jest.Mock).mockRestore();
  });
});

describe('disclaimer flag', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('uses the medilens.disclaimer.v1 key', () => {
    expect(DISCLAIMER_KEY).toBe('medilens.disclaimer.v1');
  });

  it('is false until acknowledged, then stores only a boolean', async () => {
    expect(await isDisclaimerAcknowledged()).toBe(false);
    await acknowledgeDisclaimer();
    expect(await AsyncStorage.getItem(DISCLAIMER_KEY)).toBe('true');
    expect(await isDisclaimerAcknowledged()).toBe(true);
  });

  it('treats anything but true as not acknowledged', async () => {
    await AsyncStorage.setItem(DISCLAIMER_KEY, '"yes"');
    expect(await isDisclaimerAcknowledged()).toBe(false);
    await AsyncStorage.setItem(DISCLAIMER_KEY, '{not json');
    expect(await isDisclaimerAcknowledged()).toBe(false);
  });

  it('reports false when storage fails', async () => {
    const broken = {
      getItem: () => Promise.reject(new Error('disk')),
      setItem: () => Promise.reject(new Error('disk')),
    };
    expect(await isDisclaimerAcknowledged(broken)).toBe(false);
    await expect(acknowledgeDisclaimer(broken)).resolves.toBeUndefined();
  });
});
