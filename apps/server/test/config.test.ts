import { describe, expect, test } from 'vitest';
import { DEFAULT_REPO_URL, loadConfig, userAgent } from '../src/config';

describe('loadConfig', () => {
  test('defaults: port 8787, demo mode, $5 daily cap, no key, no repo URL, no CORS origin, no proxy', () => {
    expect(loadConfig({})).toEqual({
      port: 8787,
      providerMode: 'demo',
      dailySpendCapUsd: 5,
      modelApiKey: undefined,
      publicRepoUrl: undefined,
      corsOrigin: undefined,
      trustProxy: false,
    });
  });

  test('the empty values of .env.example mean "use the default"', () => {
    const cfg = loadConfig({
      PORT: '',
      PROVIDER_MODE: '',
      MODEL_API_KEY: '',
      DAILY_SPEND_CAP_USD: '',
      PUBLIC_REPO_URL: '',
      CORS_ORIGIN: '',
    });
    expect(cfg).toMatchObject({ port: 8787, providerMode: 'demo', dailySpendCapUsd: 5 });
    expect(cfg.modelApiKey).toBeUndefined();
    expect(cfg.publicRepoUrl).toBeUndefined();
    expect(cfg.corsOrigin).toBeUndefined();
  });

  test('reads every variable', () => {
    expect(
      loadConfig({
        PORT: '9000',
        PROVIDER_MODE: 'live',
        MODEL_API_KEY: 'test-key',
        DAILY_SPEND_CAP_USD: '2.5',
        PUBLIC_REPO_URL: 'https://github.com/example/medilens-ai',
        CORS_ORIGIN: 'http://localhost:8081',
        TRUST_PROXY: '1',
      }),
    ).toEqual({
      port: 9000,
      providerMode: 'live',
      dailySpendCapUsd: 2.5,
      modelApiKey: 'test-key',
      publicRepoUrl: 'https://github.com/example/medilens-ai',
      corsOrigin: 'http://localhost:8081',
      trustProxy: 1,
    });
  });

  test('live mode without MODEL_API_KEY throws', () => {
    expect(() => loadConfig({ PROVIDER_MODE: 'live' })).toThrow(/MODEL_API_KEY/);
    expect(() => loadConfig({ PROVIDER_MODE: 'live', MODEL_API_KEY: '' })).toThrow(/MODEL_API_KEY/);
    expect(() => loadConfig({ PROVIDER_MODE: 'live', MODEL_API_KEY: '   ' })).toThrow(
      /MODEL_API_KEY/,
    );
  });

  test('demo mode needs no key', () => {
    expect(loadConfig({ PROVIDER_MODE: 'demo' }).providerMode).toBe('demo');
  });

  test.each([
    [{ PROVIDER_MODE: 'production' }, /PROVIDER_MODE/],
    [{ PORT: 'abc' }, /PORT/],
    [{ PORT: '70000' }, /PORT/],
    [{ DAILY_SPEND_CAP_USD: '-1' }, /DAILY_SPEND_CAP_USD/],
    [{ DAILY_SPEND_CAP_USD: 'lots' }, /DAILY_SPEND_CAP_USD/],
    [{ PUBLIC_REPO_URL: 'javascript:alert(1)' }, /PUBLIC_REPO_URL/],
    [{ PUBLIC_REPO_URL: 'not a url' }, /PUBLIC_REPO_URL/],
    [{ CORS_ORIGIN: 'file:///etc/passwd' }, /CORS_ORIGIN/],
  ])('rejects invalid %o', (env, name) => {
    expect(() => loadConfig(env)).toThrow(name);
  });

  test('a config error never echoes the key value', () => {
    let message = '';
    try {
      loadConfig({ PROVIDER_MODE: 'prod', MODEL_API_KEY: 'sk-secret-value-123' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/PROVIDER_MODE/);
    expect(message).not.toContain('sk-secret-value-123');
  });
});

describe('userAgent', () => {
  test('defaults to the project URL', () => {
    expect(DEFAULT_REPO_URL).toBe('https://github.com/medilens-ai');
    expect(userAgent(loadConfig({}))).toBe('MediLensAI/0.1 (+https://github.com/medilens-ai)');
  });

  test('uses PUBLIC_REPO_URL when set', () => {
    const cfg = loadConfig({ PUBLIC_REPO_URL: 'https://github.com/example/medilens-ai' });
    expect(userAgent(cfg)).toBe('MediLensAI/0.1 (+https://github.com/example/medilens-ai)');
  });
});

describe('final review I4: TRUST_PROXY', () => {
  test('defaults to false outside production', () => {
    expect(loadConfig({}).trustProxy).toBe(false);
    expect(loadConfig({ NODE_ENV: 'development' }).trustProxy).toBe(false);
  });

  test('defaults to one hop when NODE_ENV=production', () => {
    expect(loadConfig({ NODE_ENV: 'production' }).trustProxy).toBe(1);
  });

  test('a hop count is used as given; 0 and "false" mean no proxy is trusted', () => {
    expect(loadConfig({ TRUST_PROXY: '2' }).trustProxy).toBe(2);
    expect(loadConfig({ NODE_ENV: 'production', TRUST_PROXY: '0' }).trustProxy).toBe(false);
    expect(loadConfig({ NODE_ENV: 'production', TRUST_PROXY: 'false' }).trustProxy).toBe(false);
    expect(loadConfig({ NODE_ENV: 'production', TRUST_PROXY: '' }).trustProxy).toBe(1);
  });

  // "true" trusts every hop, so any client could pick its own rate-limit key
  test.each(['true', 'yes', '-1', '1.5', 'loopback'])('rejects TRUST_PROXY=%s', (v) => {
    expect(() => loadConfig({ TRUST_PROXY: v })).toThrow(/TRUST_PROXY/);
  });
});

describe('final review Minor 16: CORS_ORIGIN is kept as an origin', () => {
  test('a trailing slash or a path is dropped', () => {
    expect(loadConfig({ CORS_ORIGIN: 'https://app.example.org/' }).corsOrigin).toBe(
      'https://app.example.org',
    );
    expect(loadConfig({ CORS_ORIGIN: 'http://localhost:8081/app' }).corsOrigin).toBe(
      'http://localhost:8081',
    );
  });
});
