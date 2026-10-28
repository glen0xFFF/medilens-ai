/**
 * Where the MediLens server lives. EXPO_PUBLIC_API_BASE_URL is inlined into
 * the bundle at build time; it is a URL, not a secret. On a phone,
 * "localhost" is the phone itself, so development on a device needs the
 * computer's LAN address in .env.
 */
export const DEFAULT_API_BASE_URL = 'http://localhost:8787';

export function resolveApiBaseUrl(configured: string | undefined): string {
  const url = configured?.trim().replace(/\/+$/, '');
  return url ? url : DEFAULT_API_BASE_URL;
}

// Static `process.env.EXPO_PUBLIC_*` access is what Expo inlines; do not destructure.
export const API_BASE_URL = resolveApiBaseUrl(process.env.EXPO_PUBLIC_API_BASE_URL);
