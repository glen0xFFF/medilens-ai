/**
 * Startup bind handling. Express 5 registers the listen callback as a
 * once-listener on the server's 'error' event too, so a bind failure
 * (EADDRINUSE, EACCES) arrives in that callback as its argument. It must be
 * logged as fatal and end the process with a non-zero code, never reported
 * as 'listening'.
 */
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import { startListening } from '../../src/http/listen';
import { makeApp } from './helpers';

type LogEntry = Record<string, unknown>;

const parse = (lines: string[]): LogEntry[] => lines.map((l) => JSON.parse(l) as LogEntry);

const opened: Server[] = [];

afterEach(async () => {
  await Promise.all(
    opened.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

/** Binds a plain HTTP server the same way the app does (all interfaces) and returns its port. */
async function occupyPort(): Promise<number> {
  const blocker = createServer();
  opened.push(blocker);
  blocker.listen(0);
  await once(blocker, 'listening');
  return (blocker.address() as AddressInfo).port;
}

describe('startListening', () => {
  test('a port already in use is logged as fatal and exits with code 1, never "listening"', async () => {
    const port = await occupyPort();
    const { app, deps, lines } = makeApp();
    const exits: number[] = [];

    const server = startListening(app, {
      port,
      providerMode: 'demo',
      logger: deps.logger,
      exit: (code) => void exits.push(code),
    });
    opened.push(server);
    // Express's own once('error') listener was registered first, so it has run by the time this resolves.
    const [bindError] = (await once(server, 'error')) as [NodeJS.ErrnoException];
    expect(bindError.code).toBe('EADDRINUSE');

    const entries = parse(lines);
    expect(entries.map((e) => e.msg)).toEqual(['listen failed']);
    expect(entries[0]).toMatchObject({ level: 60, code: 'EADDRINUSE', errorName: 'Error' });
    expect(exits).toEqual([1]);
    expect(server.listening).toBe(false);
  });

  test('a free port logs "listening" once and never exits', async () => {
    const { app, deps, lines } = makeApp();
    const exits: number[] = [];

    const server = startListening(app, {
      port: 0,
      providerMode: 'demo',
      logger: deps.logger,
      exit: (code) => void exits.push(code),
    });
    opened.push(server);
    await once(server, 'listening');

    expect(exits).toEqual([]);
    const entries = parse(lines);
    expect(entries.filter((e) => e.msg === 'listen failed')).toEqual([]);
    const listening = entries.filter((e) => e.msg === 'listening');
    expect(listening).toHaveLength(1);
    expect(listening[0]).toMatchObject({ level: 30, providerMode: 'demo' });
  });
});
