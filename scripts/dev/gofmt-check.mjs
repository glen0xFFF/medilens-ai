/**
 * `gofmt -l .` must print nothing (Go port spec §8). gofmt itself exits 0
 * either way, so this fails the npm script when it lists any file.
 */
import { execFileSync } from 'node:child_process';

let out;
try {
  out = execFileSync('gofmt', ['-l', '.'], { encoding: 'utf8' });
} catch (err) {
  console.error(`gofmt failed: ${err.message}`);
  process.exit(1);
}
if (out.trim() !== '') {
  console.error('gofmt -l . lists files that are not gofmt-formatted:');
  console.error(out.trimEnd());
  process.exit(1);
}
console.log('gofmt -l .: no files');
