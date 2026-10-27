/**
 * Analysis results for this app session, in memory only (id -> result). They
 * are never written to AsyncStorage or the file system; closing the app drops
 * them. The server keeps its own copy for 15 minutes so a screen opened by id
 * can still fetch it.
 */
import type { AnalysisResult } from '@medilens/contracts';
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
import { useApi } from '../api/ApiContext';
import { messageFor } from '../ui/text';

export interface ResultsStore {
  getResult(id: string): AnalysisResult | undefined;
  saveResult(result: AnalysisResult): void;
}

const ResultsContext = createContext<ResultsStore | null>(null);

export function ResultsProvider({ children }: { children: ReactNode }) {
  const results = useRef(new Map<string, AnalysisResult>());
  const [version, setVersion] = useState(0);

  const saveResult = useCallback((result: AnalysisResult) => {
    results.current.set(result.id, result);
    setVersion((v) => v + 1);
  }, []);

  // A new store object after each save re-renders everything reading it.
  const value = useMemo<ResultsStore>(() => {
    const map = new Map(results.current);
    return { getResult: (id) => map.get(id), saveResult };
  }, [saveResult, version]);

  return <ResultsContext.Provider value={value}>{children}</ResultsContext.Provider>;
}

export function useResults(): ResultsStore {
  const value = useContext(ResultsContext);
  if (value === null) throw new Error('useResults must be used inside <ResultsProvider>.');
  return value;
}

export interface ResultState {
  result: AnalysisResult | undefined;
  error: string | null;
}

/** A result by id: from memory when this session has it, otherwise fetched from the server. */
export function useResult(id: string | undefined): ResultState {
  const { getResult, saveResult } = useResults();
  const client = useApi();
  const stored = id === undefined ? undefined : getResult(id);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (id === undefined || stored !== undefined) return;
    let active = true;
    setError(null);
    client.result(id).then(
      (r) => {
        if (active) saveResult(r);
      },
      (e: unknown) => {
        if (active) setError(messageFor(e));
      },
    );
    return () => {
      active = false;
    };
  }, [id, stored, client, saveResult]);

  return { result: stored, error };
}
