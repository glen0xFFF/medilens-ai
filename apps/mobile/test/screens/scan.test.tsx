import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCameraPermissions } from 'expo-camera';
import { launchImageLibraryAsync } from 'expo-image-picker';
import { router } from 'expo-router';
import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import { StrictMode } from 'react';
import { AccessibilityInfo, Linking } from 'react-native';
import { ApiError, type ApiErrorCode } from '../../src/api/client';
import { RESULTS } from '../helpers/fixtures';
import {
  appRoutes,
  expectPressablesLabelled,
  mockClient,
  type MockClient,
} from '../helpers/render';

const camera = jest.requireMock('expo-camera').__camera as {
  mountError: string | null;
  shots: number;
  takePictureAsync: jest.Mock;
};
const manipulator = jest.requireMock('expo-image-manipulator').__manipulator as {
  width: number;
  saved: number;
};
const deleted = jest.requireMock('expo-file-system').__deleted as jest.Mock;
const permissions = useCameraPermissions as jest.Mock;
const pickImages = launchImageLibraryAsync as jest.Mock;

const shot = (n: number) => `file:///data/user/0/app/cache/Camera/shot-${n}.jpg`;
const prepared = (n: number) => `file:///data/user/0/app/cache/ImageManipulator/prepared-${n}.jpg`;

let announce: jest.SpyInstance;
let requestPermission: jest.Mock;

function setPermission(p: { granted: boolean; canAskAgain: boolean; status: string } | null) {
  permissions.mockReturnValue([p, requestPermission]);
}
const GRANTED = { granted: true, canAskAgain: true, status: 'granted' };

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  await AsyncStorage.setItem('medilens.disclaimer.v1', 'true');
  camera.mountError = null;
  camera.shots = 0;
  manipulator.width = 4000;
  manipulator.saved = 0;
  requestPermission = jest.fn(() =>
    Promise.resolve({ granted: false, canAskAgain: false, status: 'denied' }),
  );
  setPermission(GRANTED);
  announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
});

afterEach(() => {
  announce.mockRestore();
  jest.useRealTimers();
});

async function openAt(url: string, client: MockClient = mockClient()) {
  return renderRouter(appRoutes(client), { initialUrl: url });
}

async function takePhotos(n: number) {
  for (let i = 1; i <= n; i += 1) {
    await fireEvent.press(await screen.findByRole('button', { name: 'Take photo' }));
    expect(await screen.findByText(`${i} of 3 photos taken`)).toBeTruthy();
  }
}

describe('scan screen: camera permission states', () => {
  it('asks for camera access while permission is undetermined', async () => {
    setPermission({ granted: false, canAskAgain: true, status: 'undetermined' });
    const view = await openAt('/scan');
    const allow = await screen.findByRole('button', { name: 'Allow camera access' });
    expect(screen.queryByTestId('camera-view')).toBeNull();
    expectPressablesLabelled(view);
    await fireEvent.press(allow);
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it('shows "Camera access is off" with Open settings when access was denied for good', async () => {
    setPermission({ granted: false, canAskAgain: false, status: 'denied' });
    const openSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
    const view = await openAt('/scan');
    expect(await screen.findByText('Camera access is off')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Allow camera access' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Read existing photo' })).toBeTruthy();
    expect(screen.queryByTestId('camera-view')).toBeNull();
    expectPressablesLabelled(view);
    await fireEvent.press(screen.getByRole('button', { name: 'Open settings' }));
    expect(openSettings).toHaveBeenCalledTimes(1);
    openSettings.mockRestore();
  });

  it('offers the gallery when the camera cannot start', async () => {
    camera.mountError = 'Camera is not available';
    const view = await openAt('/scan');
    expect(await screen.findByText('Camera not available')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Read existing photo' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Take photo' })).toBeNull();
    expectPressablesLabelled(view);
    expect(announce).toHaveBeenCalledWith(expect.stringMatching(/camera could not be started/i));
  });
});

describe('scan screen: server mode notice (final review Minor 17)', () => {
  const DEMO_NOTICE = 'Server is in demo mode: scans return a made-up example.';
  const live = () =>
    mockClient({
      health: jest.fn(() =>
        Promise.resolve({ status: 'ok', version: '0.1.0', providerMode: 'live' as const }),
      ),
    });

  it('warns on the camera screen when the server is in demo mode', async () => {
    await openAt('/scan');
    expect(await screen.findByTestId('camera-view')).toBeTruthy();
    expect(await screen.findByText(DEMO_NOTICE)).toBeTruthy();
  });

  it('warns while camera access is being asked for', async () => {
    setPermission({ granted: false, canAskAgain: true, status: 'undetermined' });
    await openAt('/scan');
    expect(await screen.findByText(DEMO_NOTICE)).toBeTruthy();
  });

  it('shows no notice when the server is live', async () => {
    const client = live();
    await openAt('/scan', client);
    expect(await screen.findByTestId('camera-view')).toBeTruthy();
    await waitFor(() => expect(client.health).toHaveBeenCalled());
    expect(screen.queryByText(DEMO_NOTICE)).toBeNull();
  });
});

describe('scan screen: capture', () => {
  it('shows the camera with a torch toggle when access is granted', async () => {
    const view = await openAt('/scan');
    expect(await screen.findByTestId('camera-view')).toBeTruthy();
    expect(screen.getByTestId('camera-view').props.enableTorch).toBe(false);
    expectPressablesLabelled(view);
    await fireEvent.press(screen.getByRole('button', { name: 'Torch: Off' }));
    expect(await screen.findByRole('button', { name: 'Torch: On' })).toBeTruthy();
    expect(screen.getByTestId('camera-view').props.enableTorch).toBe(true);
  });

  it('takes up to 3 photos, prepares each and deletes the raw capture', async () => {
    await openAt('/scan');
    await takePhotos(3);
    expect(camera.takePictureAsync).toHaveBeenCalledTimes(3);
    expect(camera.takePictureAsync).toHaveBeenCalledWith({ quality: 0.9 });
    const take = screen.getByRole('button', { name: 'Take photo' });
    expect(take.props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.press(take);
    expect(camera.takePictureAsync).toHaveBeenCalledTimes(3);
    expect(deleted.mock.calls).toEqual([[shot(1)], [shot(2)], [shot(3)]]);
    expect(announce).toHaveBeenCalledWith('Photo 3 of 3 taken. Review photos to continue.');
  });

  it('Cancel deletes the prepared photos and returns home', async () => {
    await openAt('/scan');
    await takePhotos(1);
    deleted.mockClear();
    await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen).toHavePathname('/');
    expect(deleted.mock.calls).toEqual([[prepared(1)]]);
  });
});

describe('preview screen', () => {
  it('shows thumbnails with retake and remove for each photo', async () => {
    const view = await openAt('/scan');
    await takePhotos(2);
    await fireEvent.press(screen.getByRole('button', { name: 'Review photos' }));
    expect(screen).toHavePathname('/preview');
    expect(await screen.findByLabelText('Photo 1 of 2')).toBeTruthy();
    expect(screen.getByLabelText('Photo 2 of 2')).toBeTruthy();
    for (const name of ['Retake photo 1', 'Remove photo 1', 'Retake photo 2', 'Remove photo 2']) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
    expect(screen.getByRole('button', { name: 'Add another photo' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Analyze' })).toBeTruthy();
    expectPressablesLabelled(view);

    deleted.mockClear();
    await fireEvent.press(screen.getByRole('button', { name: 'Remove photo 1' }));
    expect(await screen.findByLabelText('Photo 1 of 1')).toBeTruthy();
    expect(deleted.mock.calls).toEqual([[prepared(1)]]);
  });

  it('retakes one photo in place', async () => {
    await openAt('/scan');
    await takePhotos(2);
    await fireEvent.press(screen.getByRole('button', { name: 'Review photos' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Retake photo 1' }));
    expect(screen).toHavePathname('/scan');
    deleted.mockClear();
    await fireEvent.press(await screen.findByRole('button', { name: 'Take photo' }));
    expect(await screen.findByLabelText('Photo 1 of 2')).toBeTruthy();
    expect(screen).toHavePathname('/preview');
    expect(screen.getByLabelText('Photo 1 of 2').props.source).toEqual({ uri: prepared(3) });
    // The raw retake capture and the replaced prepared photo are both gone.
    expect(deleted.mock.calls).toEqual([[shot(3)], [prepared(1)]]);
  });

  it('hides Add another photo when 3 photos are held', async () => {
    await openAt('/scan');
    await takePhotos(3);
    await fireEvent.press(screen.getByRole('button', { name: 'Review photos' }));
    expect(await screen.findByLabelText('Photo 3 of 3')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add another photo' })).toBeNull();
  });
});

describe('analyzing screen', () => {
  async function analyze(client: MockClient, photos = 2) {
    const view = await openAt('/scan', client);
    await takePhotos(photos);
    await fireEvent.press(screen.getByRole('button', { name: 'Review photos' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Analyze' }));
    return view;
  }

  it('uploads the prepared photos, announces progress and opens the result', async () => {
    let resolve: (r: typeof RESULTS.s1) => void = () => {};
    const client = mockClient({
      analyze: jest.fn(() => new Promise((r) => (resolve = r))),
    });
    await analyze(client);
    expect(screen).toHavePathname('/analyzing');
    expect(
      await screen.findByText(
        'Sending 2 photos and reading the label. This can take up to a minute.',
      ),
    ).toBeTruthy();
    expect(announce).toHaveBeenCalledWith(
      'Sending 2 photos and reading the label. This can take up to a minute.',
    );
    expect(client.analyze).toHaveBeenCalledTimes(1);
    expect(client.analyze).toHaveBeenCalledWith(
      [
        { uri: prepared(1), type: 'image/jpeg' },
        { uri: prepared(2), type: 'image/jpeg' },
      ],
      // The screen can stop the upload when the user leaves (final review Minor 22).
      { signal: expect.any(AbortSignal) },
    );
    deleted.mockClear();
    await act(async () => resolve(RESULTS.s1));
    expect(await screen.findByText('Matches FDA registry')).toBeTruthy();
    expect(screen).toHavePathname(`/result/${RESULTS.s1.id}`);
    // Upload done: the prepared photos are deleted and nothing else re-reads them.
    expect(deleted.mock.calls).toEqual([[prepared(1)], [prepared(2)]]);
    expect(client.result).not.toHaveBeenCalled();
  });

  // Final review Minor 22: a double tap must not upload (and spend) twice.
  it('a double tap on Analyze sends the photos once', async () => {
    const client = mockClient({ analyze: jest.fn(() => new Promise(() => {})) });
    await openAt('/scan', client);
    await takePhotos(1);
    await fireEvent.press(screen.getByRole('button', { name: 'Review photos' }));
    const button = await screen.findByRole('button', { name: 'Analyze' });
    await fireEvent.press(button);
    await fireEvent.press(button);
    expect(
      await screen.findByText(
        'Sending 1 photo and reading the label. This can take up to a minute.',
      ),
    ).toBeTruthy();
    expect(client.analyze).toHaveBeenCalledTimes(1);
  });

  it('Back during an upload aborts it and keeps the photos', async () => {
    let signal: AbortSignal | undefined;
    const client = mockClient({
      analyze: jest.fn((_images: unknown, options?: { signal?: AbortSignal }) => {
        signal = options?.signal;
        return new Promise(() => {});
      }),
    });
    await analyze(client, 1);
    await screen.findByText('Sending 1 photo and reading the label. This can take up to a minute.');
    expect(signal?.aborted).toBe(false);
    deleted.mockClear();
    await act(async () => router.back());
    expect(screen).toHavePathname('/preview');
    expect(signal?.aborted).toBe(true);
    expect(await screen.findByLabelText('Photo 1 of 1')).toBeTruthy();
    expect(deleted).not.toHaveBeenCalled();
  });

  it('still uploads under StrictMode, which mounts, unmounts and remounts each screen', async () => {
    // react-native-screens calls findNodeHandle, which React reports under StrictMode only.
    const consoleError = console.error;
    const quiet = jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      const text = args.map(String).join(' ');
      if (text.includes('is deprecated in StrictMode') && text.includes('findNodeHandle')) return;
      consoleError(...args);
    });
    try {
      await uploadUnderStrictMode();
    } finally {
      quiet.mockRestore();
    }
  });

  async function uploadUnderStrictMode() {
    let resolve: (r: typeof RESULTS.s1) => void = () => {};
    const client = mockClient({ analyze: jest.fn(() => new Promise((r) => (resolve = r))) });
    const routes = appRoutes(client);
    const Layout = routes._layout;
    await renderRouter(
      {
        ...routes,
        _layout: () => (
          <StrictMode>
            <Layout />
          </StrictMode>
        ),
      },
      { initialUrl: '/scan' },
    );
    await takePhotos(1);
    await fireEvent.press(screen.getByRole('button', { name: 'Review photos' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Analyze' }));
    await screen.findByText('Sending 1 photo and reading the label. This can take up to a minute.');
    const calls = client.analyze.mock.calls as [unknown, { signal: AbortSignal }][];
    expect(calls.filter(([, options]) => !options.signal.aborted)).toHaveLength(1);
    await act(async () => resolve(RESULTS.s1));
    expect(await screen.findByText('Matches FDA registry')).toBeTruthy();
    expect(screen.queryByText('The label was not read')).toBeNull();
  }

  it('says live mode sends the photos to the Meta Model API (final review Minor 21)', async () => {
    const client = mockClient({ analyze: jest.fn(() => new Promise(() => {})) });
    await analyze(client, 1);
    expect(await screen.findByText(/live mode.*photos.*Meta Model API/i)).toBeTruthy();
  });

  it('re-announces that it is still working during a long upload', async () => {
    jest.useFakeTimers();
    const client = mockClient({ analyze: jest.fn(() => new Promise(() => {})) });
    await analyze(client, 1);
    expect(
      await screen.findByText(
        'Sending 1 photo and reading the label. This can take up to a minute.',
      ),
    ).toBeTruthy();
    expect(announce).not.toHaveBeenCalledWith('Still reading the label. Please wait.');
    await act(async () => {
      jest.advanceTimersByTime(15_000);
    });
    expect(announce).toHaveBeenCalledWith('Still reading the label. Please wait.');
    expect(screen.getByText('Still reading the label. Please wait.')).toBeTruthy();
  });

  const cases: [ApiErrorCode, RegExp][] = [
    ['IMAGE_TOO_LARGE', /too large/i],
    ['INVALID_IMAGE', /could not be opened/i],
    ['RATE_LIMITED', /wait a minute/i],
    ['NETWORK', /couldn't reach the MediLens server/i],
    ['TIMEOUT', /took too long/i],
    ['OCR_FAILED', /couldn't read the label/i],
  ];

  it.each(cases)('maps %s to a plain message and keeps the photos', async (code, message) => {
    const client = mockClient({
      analyze: jest.fn(() => Promise.reject(new ApiError(code, `server text for ${code}`))),
    });
    const view = await analyze(client, 1);
    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.queryByText(`server text for ${code}`)).toBeNull();
    expect(announce).toHaveBeenCalledWith(expect.stringMatching(message));
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Back to photos' })).toBeTruthy();
    expectPressablesLabelled(view);
    expect(deleted).not.toHaveBeenCalledWith(prepared(1));
  });

  it('says live reading is paused and offers the demo when the budget is used up', async () => {
    const client = mockClient({
      analyze: jest.fn(() =>
        Promise.reject(new ApiError('LIVE_BUDGET_EXHAUSTED', 'Daily budget reached.')),
      ),
    });
    await analyze(client, 1);
    expect(
      await screen.findByText('Live reading is paused for today. You can still try the demo.'),
    ).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Open demo mode' }));
    expect(screen).toHavePathname('/demo');
  });

  it('shows the server message verbatim for other errors', async () => {
    const client = mockClient({
      analyze: jest.fn(() =>
        Promise.reject(new ApiError('VALIDATION_FAILED', 'Please choose 1 to 3 photos.')),
      ),
    });
    await analyze(client, 1);
    expect(await screen.findByText('Please choose 1 to 3 photos.')).toBeTruthy();
  });

  it('Try again sends the same photos again', async () => {
    const analyzeMock = jest
      .fn()
      .mockRejectedValueOnce(new ApiError('NETWORK', 'offline'))
      .mockResolvedValueOnce(RESULTS.s1);
    await analyze(mockClient({ analyze: analyzeMock }), 1);
    await fireEvent.press(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Matches FDA registry')).toBeTruthy();
    expect(analyzeMock).toHaveBeenCalledTimes(2);
    expect(analyzeMock.mock.calls[1][0]).toEqual([{ uri: prepared(1), type: 'image/jpeg' }]);
  });

  it('asks for a photo when there is nothing to send', async () => {
    const client = mockClient();
    await openAt('/analyzing', client);
    expect(await screen.findByText('There are no photos to read.')).toBeTruthy();
    expect(client.analyze).not.toHaveBeenCalled();
  });
});

describe('gallery fallback', () => {
  const picked = (n: number) => ({
    uri: `file:///data/user/0/app/cache/ImagePicker/pick-${n}.jpg`,
    width: 3000,
    height: 4000,
  });

  it('home "Read existing photo" picks up to 3 photos and opens the preview', async () => {
    pickImages.mockResolvedValueOnce({ canceled: false, assets: [picked(1), picked(2)] });
    await openAt('/');
    await fireEvent.press(await screen.findByRole('button', { name: 'Read existing photo' }));
    expect(await screen.findByLabelText('Photo 2 of 2')).toBeTruthy();
    expect(screen).toHavePathname('/preview');
    expect(pickImages).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        selectionLimit: 3,
      }),
    );
    // The picker's cache copies are deleted once prepared.
    expect(deleted.mock.calls).toEqual([[picked(1).uri], [picked(2).uri]]);
  });

  it('keeps only the first 3 when more are picked and says so', async () => {
    pickImages.mockResolvedValueOnce({
      canceled: false,
      assets: [picked(1), picked(2), picked(3), picked(4)],
    });
    await openAt('/');
    await fireEvent.press(await screen.findByRole('button', { name: 'Read existing photo' }));
    expect(await screen.findByLabelText('Photo 3 of 3')).toBeTruthy();
    expect(screen.queryByLabelText('Photo 1 of 4')).toBeNull();
    expect(announce).toHaveBeenCalledWith(
      'Only 3 photos can be read at once. The first 3 were kept.',
    );
    // The extra photo is never decoded, only its picker copy deleted.
    expect(
      jest.requireMock('expo-image-manipulator').ImageManipulator.manipulate,
    ).toHaveBeenCalledTimes(3);
    expect(deleted).toHaveBeenCalledWith(picked(4).uri);
  });

  it('stays on home when the picker is cancelled', async () => {
    await openAt('/');
    await fireEvent.press(await screen.findByRole('button', { name: 'Read existing photo' }));
    expect(screen).toHavePathname('/');
  });

  it('scan screen gallery button asks only for the remaining slots', async () => {
    pickImages.mockResolvedValueOnce({ canceled: false, assets: [picked(1)] });
    await openAt('/scan');
    await takePhotos(2);
    // A granted camera still offers the gallery.
    await fireEvent.press(screen.getByRole('button', { name: 'Read existing photo' }));
    expect(pickImages).toHaveBeenCalledWith(expect.objectContaining({ selectionLimit: 1 }));
    expect(await screen.findByLabelText('Photo 3 of 3')).toBeTruthy();
  });
});
