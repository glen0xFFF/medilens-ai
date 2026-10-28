import { useEffect, useState } from 'react';
import { useApi } from './ApiContext';
import type { Health } from './client';

/**
 * The server's provider mode from GET /health: 'live', 'demo', or null while
 * it is being checked or when the server cannot be reached.
 */
export function useServerMode(): Health['providerMode'] | null {
  const client = useApi();
  const [mode, setMode] = useState<Health['providerMode'] | null>(null);

  useEffect(() => {
    let active = true;
    client.health().then(
      (h) => {
        if (active) setMode(h.providerMode);
      },
      () => {
        if (active) setMode(null);
      },
    );
    return () => {
      active = false;
    };
  }, [client]);

  return mode;
}
