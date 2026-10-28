import type { ReactNode } from 'react';
import { ApiProvider } from './api/ApiContext';
import type { ApiClient } from './api/client';
import { CaptureProvider } from './capture/captures';
import { ResultsProvider } from './state/results';
import { SettingsProvider } from './state/settings';

/** Every app-wide provider, in one place so tests wrap screens exactly as the app does. */
export function AppProviders({ client, children }: { client: ApiClient; children: ReactNode }) {
  return (
    <SettingsProvider>
      <ApiProvider client={client}>
        <ResultsProvider>
          <CaptureProvider>{children}</CaptureProvider>
        </ResultsProvider>
      </ApiProvider>
    </SettingsProvider>
  );
}
