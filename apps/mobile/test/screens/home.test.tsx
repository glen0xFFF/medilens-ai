import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import { AccessibilityInfo } from 'react-native';
import { ApiError } from '../../src/api/client';
import { SETTINGS_KEY } from '../../src/state/settings';
import { SCENARIOS } from '../helpers/fixtures';
import { appRoutes, expectPressablesLabelled, mockClient } from '../helpers/render';

let announce: jest.SpyInstance;

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
});

afterEach(() => {
  announce.mockRestore();
  jest.useRealTimers();
});

describe('welcome and home', () => {
  it('shows the first-run disclaimer until it is acknowledged', async () => {
    const view = await renderRouter(appRoutes(mockClient()), { initialUrl: '/' });
    expect(await screen.findByText(/not a diagnostic tool/i)).toBeTruthy();
    expect(screen.getByText(/does not identify loose pills/i)).toBeTruthy();
    expect(screen.getByText(/always confirm with a pharmacist or doctor/i)).toBeTruthy();
    expect(screen.getByText(/photos are not stored/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Demo mode' })).toBeNull();
    expectPressablesLabelled(view);

    await fireEvent.press(screen.getByRole('button', { name: 'I understand' }));
    expect(await AsyncStorage.getItem('medilens.disclaimer.v1')).toBe('true');
    expect(await screen.findByRole('button', { name: 'Demo mode' })).toBeTruthy();
  });

  it('goes straight to home for a returning user', async () => {
    await AsyncStorage.setItem('medilens.disclaimer.v1', 'true');
    const view = await renderRouter(appRoutes(mockClient()), { initialUrl: '/' });
    for (const name of ['Scan medicine', 'Demo mode', 'Safety and limitations', 'Settings']) {
      expect(await screen.findByRole('button', { name })).toBeTruthy();
    }
    expect(screen.queryByRole('button', { name: 'I understand' })).toBeNull();
    expectPressablesLabelled(view);
    await fireEvent.press(screen.getByRole('button', { name: 'Demo mode' }));
    expect(screen).toHavePathname('/demo');
  });
});

// Final review Minor 17: a demo-mode server answers every scan with the s1 fixture.
const DEMO_NOTICE = 'Server is in demo mode: scans return a made-up example.';
// Final review Minor 21: live mode sends the photos to the Meta Model API.
const META_PHOTOS = /live mode.*photos.*Meta Model API/i;

describe('server mode notice on home', () => {
  beforeEach(async () => {
    await AsyncStorage.setItem('medilens.disclaimer.v1', 'true');
  });

  it('says scans return a made-up example when the server is in demo mode', async () => {
    const client = mockClient();
    await renderRouter(appRoutes(client), { initialUrl: '/' });
    expect(await screen.findByText(DEMO_NOTICE)).toBeTruthy();
    expect(client.health).toHaveBeenCalled();
  });

  it('shows no notice when the server is live', async () => {
    const client = mockClient({
      health: jest.fn(() =>
        Promise.resolve({ status: 'ok', version: '0.1.0', providerMode: 'live' as const }),
      ),
    });
    await renderRouter(appRoutes(client), { initialUrl: '/' });
    await screen.findByRole('button', { name: 'Scan medicine' });
    await waitFor(() => expect(client.health).toHaveBeenCalled());
    expect(screen.queryByText(DEMO_NOTICE)).toBeNull();
  });

  it('shows no notice when the server cannot be reached', async () => {
    const client = mockClient({
      health: jest.fn(() => Promise.reject(new ApiError('NETWORK', 'No connection.'))),
    });
    await renderRouter(appRoutes(client), { initialUrl: '/' });
    await screen.findByRole('button', { name: 'Scan medicine' });
    await waitFor(() => expect(client.health).toHaveBeenCalled());
    expect(screen.queryByText(DEMO_NOTICE)).toBeNull();
  });
});

describe('privacy wording names the Meta Model API', () => {
  it('the first-run disclaimer says live mode sends photos to the Meta Model API', async () => {
    await renderRouter(appRoutes(mockClient()), { initialUrl: '/' });
    expect(await screen.findByText(META_PHOTOS)).toBeTruthy();
  });

  it.each(['/settings', '/safety'])('%s says so too', async (url) => {
    await renderRouter(appRoutes(mockClient()), { initialUrl: url });
    expect(await screen.findByText(META_PHOTOS)).toBeTruthy();
  });
});

describe('demo screen', () => {
  it('lists the server scenarios under a DEMO DATA banner', async () => {
    const view = await renderRouter(appRoutes(mockClient()), { initialUrl: '/demo' });
    for (const s of SCENARIOS) {
      expect(await screen.findByRole('button', { name: s.title })).toBeTruthy();
    }
    expect(screen.getAllByText('DEMO DATA').length).toBeGreaterThan(0);
    expectPressablesLabelled(view);
  });

  it('shows the server message when a scenario fails to load', async () => {
    const client = mockClient({
      scenario: jest.fn(() => Promise.reject(new ApiError('NETWORK', 'No connection.'))),
    });
    await renderRouter(appRoutes(client), { initialUrl: '/demo' });
    await fireEvent.press(await screen.findByRole('button', { name: SCENARIOS[0]!.title }));
    expect(await screen.findByText('No connection.')).toBeTruthy();
    expect(screen).toHavePathname('/demo');
  });
});

describe('settings screen', () => {
  it('shows the server provider mode and toggles preferences', async () => {
    const view = await renderRouter(appRoutes(mockClient()), { initialUrl: '/settings' });
    expect(await screen.findByText('Server mode: demo')).toBeTruthy();
    expect(screen.getByText(/photos are not stored/i)).toBeTruthy();
    expectPressablesLabelled(view);

    await fireEvent.press(screen.getByRole('button', { name: 'High contrast: Off' }));
    expect(await screen.findByRole('button', { name: 'High contrast: On' })).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Text size Extra large' }));
    expect(
      screen.getByRole('button', { name: 'Text size Extra large' }).props.accessibilityState,
    ).toMatchObject({ selected: true });
    await fireEvent.press(screen.getByRole('button', { name: 'Read results aloud: On' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Faster speech' }));
    expect(screen.getByText('Speech rate: 1.25')).toBeTruthy();

    const stored = JSON.parse((await AsyncStorage.getItem(SETTINGS_KEY)) ?? '{}');
    expect(stored).toEqual({
      speechRate: 1.25,
      highContrast: true,
      textScale: 1.5,
      autoSpeak: false,
    });
  });

  it('says when the server cannot be reached', async () => {
    const client = mockClient({
      health: jest.fn(() => Promise.reject(new ApiError('NETWORK', 'No connection.'))),
    });
    await renderRouter(appRoutes(client), { initialUrl: '/settings' });
    expect(await screen.findByText('Server mode: not reachable')).toBeTruthy();
  });
});

describe('safety screen', () => {
  it('explains what the app does not do', async () => {
    const view = await renderRouter(appRoutes(mockClient()), { initialUrl: '/safety' });
    expect(await screen.findByText(/not a diagnostic tool/i)).toBeTruthy();
    expect(screen.getByText(/does not identify loose pills/i)).toBeTruthy();
    expect(screen.getByText(/registration certificate/i)).toBeTruthy();
    expect(screen.queryByText(/fake|counterfeit/i)).toBeNull();
    expectPressablesLabelled(view);
  });
});
