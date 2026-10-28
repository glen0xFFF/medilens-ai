/**
 * The API client is provided through context so screens never build their
 * own, and tests inject a mocked client instead of patching fetch.
 */
import { createContext, useContext, type ReactNode } from 'react';
import type { ApiClient } from './client';

const ApiContext = createContext<ApiClient | null>(null);

export function ApiProvider({ client, children }: { client: ApiClient; children: ReactNode }) {
  return <ApiContext.Provider value={client}>{children}</ApiContext.Provider>;
}

export function useApi(): ApiClient {
  const client = useContext(ApiContext);
  if (client === null) throw new Error('useApi must be used inside <ApiProvider>.');
  return client;
}
