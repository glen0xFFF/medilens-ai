/**
 * Builds the Go API once (`go build ./services/api` into a temp dir),
 * starts it on a free loopback port in mock + fixture mode, and waits for
 * GET /readyz. No live Node process is involved (ruling R3): the Node side
 * of the comparison is the recorded fixtures/parity/scenarios.jsonl.
 *
 * The child gets the caller's environment minus every MediLens variable,
 * then exactly the ones set here, and an ENV_FILE that does not exist, so
 * a developer's .env or shell can never switch it to a live provider.
 *
 * The binary is built to one fixed path (node_modules/.cache, git-ignored):
 * the API listens on every interface, and Windows asks once per program
 * path whether to let a new program do that.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Every variable the Go API reads (internal/config). */
const MEDILENS_VARIABLES = new Set([
  'MODEL_PROVIDER',
  'MODEL_API_KEY',
  'REFERENCE_PROVIDER',
  'DAILY_SPEND_CAP_USD',
  'PUBLIC_REPO_URL',
  'PORT',
  'CORS_ORIGIN',
  'TRUSTED_PROXIES',
  'ENV_FILE',
]);

export interface GoApi {
  baseUrl: string;
  /** What the process wrote to stdout and stderr (the JSON log). */
  output(): string;
  stop(): Promise<void>;
}

/** A port the OS reports free on 127.0.0.1 (released before the API binds it). */
async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  server.close();
  await once(server, 'close');
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    // Windows variable names are case-insensitive
    if (!MEDILENS_VARIABLES.has(key.toUpperCase())) env[key] = value;
  }
  return { ...env, ...extra };
}

async function waitReady(baseUrl: string, child: ChildProcess, output: () => string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`the Go API exited with ${child.exitCode}:\n${output()}`);
    }
    try {
      const res = await fetch(`${baseUrl}/readyz`, { signal: AbortSignal.timeout(1_000) });
      if (res.status === 200) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the Go API was not ready within 30 s:\n${output()}`);
}

/**
 * Builds and starts the API. `env` adds variables on top of mock + fixture
 * mode; it cannot remove them.
 */
export async function startGoApi(env: Record<string, string> = {}): Promise<GoApi> {
  const dir = join(repoRoot, 'node_modules', '.cache', 'medilens-go-contract');
  await mkdir(dir, { recursive: true });
  const exe = join(dir, process.platform === 'win32' ? 'api.exe' : 'api');
  await execFileAsync('go', ['build', '-o', exe, './services/api'], {
    cwd: repoRoot,
    env: { ...process.env, CGO_ENABLED: '0' },
    timeout: 280_000,
  });

  const port = await freePort();
  const child = spawn(exe, [], {
    cwd: dir,
    env: childEnv({
      ...env,
      MODEL_PROVIDER: 'mock',
      REFERENCE_PROVIDER: 'fixture',
      PORT: String(port),
      ENV_FILE: join(dir, 'absent.env'),
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout?.setEncoding('utf8').on('data', (s: string) => (log += s));
  child.stderr?.setEncoding('utf8').on('data', (s: string) => (log += s));
  const output = () => log;

  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  };

  // the API binds 0.0.0.0:PORT; the test talks to it over loopback
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitReady(baseUrl, child, output);
  } catch (err) {
    await stop();
    throw err;
  }
  return { baseUrl, output, stop };
}

export interface SseFrame {
  id: string | undefined;
  event: string | undefined;
  data: string | undefined;
}

/**
 * Parses a text/event-stream body into its frames (comments such as
 * `: heartbeat` are dropped). A field's value loses one leading space, as
 * the SSE spec says.
 */
export function parseSse(text: string): SseFrame[] {
  const frames: SseFrame[] = [];
  for (const block of text.replace(/\r\n?/g, '\n').split('\n\n')) {
    const frame: SseFrame = { id: undefined, event: undefined, data: undefined };
    let fields = 0;
    for (const line of block.split('\n')) {
      if (line === '' || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const name = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      fields++;
      if (name === 'id') frame.id = value;
      else if (name === 'event') frame.event = value;
      else if (name === 'data')
        frame.data = frame.data === undefined ? value : `${frame.data}\n${value}`;
      else throw new Error(`unexpected SSE field ${JSON.stringify(name)}`);
    }
    if (fields > 0) frames.push(frame);
  }
  return frames;
}
