/**
 * The repo-root .env (git-ignored), read by the server and by the live smoke
 * and eval scripts alike (final review Minor 30), so the key the README and
 * the hackathon checklist tell the owner to put there is found by all three.
 */
import { fileURLToPath } from 'node:url';

/** apps/server/src -> repository root. */
export const ROOT_ENV_FILE = fileURLToPath(new URL('../../../.env', import.meta.url));

/**
 * Loads `file` into process.env when it exists; a variable already set in the
 * environment keeps its value. False, and nothing loaded, when there is no
 * file: the process environment alone is then used.
 */
export function loadRootEnv(file: string = ROOT_ENV_FILE): boolean {
  try {
    process.loadEnvFile(file);
    return true;
  } catch {
    return false;
  }
}
