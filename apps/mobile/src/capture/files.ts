/**
 * Temporary photo files: camera captures, image-picker copies and resized
 * uploads all live in the app's cache directory. They are deleted as soon as
 * they are no longer needed (after preparing, after upload, on cancel); the
 * app never writes to the media library.
 */
import { File } from 'expo-file-system';

/**
 * Only plain files inside an app cache directory are ever deleted, so a URI
 * that points at the user's own gallery (content://, DCIM, ...) is left alone.
 */
export function isDisposable(uri: string): boolean {
  return uri.startsWith('file://') && uri.includes('/cache/');
}

/** Best-effort delete: a file that is already gone or locked is skipped. */
export function discardFiles(uris: readonly string[]): void {
  for (const uri of uris) {
    if (!isDisposable(uri)) continue;
    try {
      new File(uri).delete();
    } catch {
      // Already deleted or not accessible; the OS clears the cache eventually.
    }
  }
}
