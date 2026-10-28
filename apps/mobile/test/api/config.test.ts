import { DEFAULT_API_BASE_URL, resolveApiBaseUrl } from '../../src/api/config';

describe('resolveApiBaseUrl', () => {
  it('defaults to the local development server', () => {
    expect(DEFAULT_API_BASE_URL).toBe('http://localhost:8787');
    expect(resolveApiBaseUrl(undefined)).toBe('http://localhost:8787');
    expect(resolveApiBaseUrl('   ')).toBe('http://localhost:8787');
  });

  it('uses the configured URL without a trailing slash', () => {
    expect(resolveApiBaseUrl('https://api.example.test/')).toBe('https://api.example.test');
    expect(resolveApiBaseUrl(' http://192.168.1.20:8787 ')).toBe('http://192.168.1.20:8787');
  });
});
