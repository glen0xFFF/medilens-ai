/**
 * Runs a Go command with extra environment variables, the same on Windows
 * (cmd.exe has no `KEY=value cmd`) and POSIX shells. Used by the root npm
 * scripts:
 *
 *   node scripts/dev/go.mjs [KEY=value ...] -- <go arguments>
 *
 * Variables given here win over the shell and over .env (the Go services
 * let the environment win over .env). The exit code and signals are passed
 * through.
 */
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const split = args.indexOf('--');
if (split === -1 || split === args.length - 1) {
  console.error('Usage: node scripts/dev/go.mjs [KEY=value ...] -- <go arguments>');
  process.exit(1);
}
const env = { ...process.env };
for (const pair of args.slice(0, split)) {
  const eq = pair.indexOf('=');
  if (eq < 1) {
    console.error(`Not KEY=value: ${pair}`);
    process.exit(1);
  }
  env[pair.slice(0, eq)] = pair.slice(eq + 1);
}

const child = spawn('go', args.slice(split + 1), { stdio: 'inherit', env });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('error', (err) => {
  console.error(`Could not start go: ${err.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  process.exit(code ?? (signal === null ? 1 : 128));
});
