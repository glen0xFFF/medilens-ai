import type { Capabilities } from '@medilens/contracts';
import { useEffect, useState } from 'react';
import { useApi } from './ApiContext';

/** 'demo' when the server runs the mock model (every scan is a made-up example), else 'live'. */
export type ServerMode = 'demo' | 'live';

export function serverModeOf(capabilities: Capabilities): ServerMode {
  return capabilities.modelProvider === 'mock' ? 'demo' : 'live';
}

/**
 * The server's mode from GET /api/v1/config/capabilities (Go port spec §7):
 * 'demo', 'live', or null while it is being checked or when the server
 * cannot be reached.
 */
export function useServerMode(): ServerMode | null {
  const client = useApi();
  const [mode, setMode] = useState<ServerMode | null>(null);

  useEffect(() => {
    let active = true;
    client.capabilities().then(
      (c) => {
        if (active) setMode(serverModeOf(c));
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
