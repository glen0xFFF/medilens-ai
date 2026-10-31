/**
 * Native modules have no implementation under Jest; each is replaced with a
 * mock here so tests never touch a device API.
 */
// On a device, FormData is React Native's (patched by Expo), which accepts
// {uri, name, type} file parts. Jest otherwise exposes Node's FormData, which
// would stringify them, so tests use React Native's implementation.
globalThis.FormData = require('react-native/Libraries/Network/FormData').default;

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

jest.mock('expo-speech', () => ({
  speak: jest.fn(),
  stop: jest.fn(() => Promise.resolve()),
  pause: jest.fn(() => Promise.resolve()),
  resume: jest.fn(() => Promise.resolve()),
  isSpeakingAsync: jest.fn(() => Promise.resolve(false)),
  getAvailableVoicesAsync: jest.fn(() => Promise.resolve([])),
  maxSpeechInputLength: 4000,
}));

/**
 * expo-camera: a CameraView stand-in that reports ready on mount (or a mount
 * error when `__camera.mountError` is set) and exposes takePictureAsync
 * through its ref, plus the permission hook. Tests steer it via
 * `jest.requireMock('expo-camera').__camera`.
 */
jest.mock('expo-camera', () => {
  const React = require('react');
  const { View } = require('react-native');
  const camera: { mountError: string | null; shots: number; takePictureAsync: jest.Mock } = {
    mountError: null,
    shots: 0,
    takePictureAsync: jest.fn(() => {
      camera.shots += 1;
      return Promise.resolve({
        uri: `file:///data/user/0/app/cache/Camera/shot-${camera.shots}.jpg`,
        width: 4000,
        height: 3000,
        format: 'jpg',
      });
    }),
  };
  function CameraView(props: Record<string, unknown> & { ref?: unknown }) {
    const { ref, onCameraReady, onMountError, ...rest } = props as {
      ref?: unknown;
      onCameraReady?: () => void;
      onMountError?: (e: { message: string }) => void;
    };
    React.useImperativeHandle(ref, () => ({ takePictureAsync: camera.takePictureAsync }));
    React.useEffect(() => {
      if (camera.mountError !== null) onMountError?.({ message: camera.mountError });
      else onCameraReady?.();
    }, []);
    return React.createElement(View, { testID: 'camera-view', ...rest });
  }
  return {
    CameraView,
    useCameraPermissions: jest.fn(() => [
      { granted: false, canAskAgain: true, status: 'undetermined' },
      jest.fn(() => Promise.resolve({ granted: false, canAskAgain: true, status: 'denied' })),
    ]),
    __camera: camera,
  };
});

/**
 * expo-image-manipulator: the contextual API. Every source renders at
 * `__manipulator.width` px wide (default 4000) and `__manipulator.height` px
 * tall (default null: 3/4 of the width) unless resized; a resize by one side
 * keeps the aspect ratio, as the real module does. saveAsync writes a new
 * cache file name.
 */
jest.mock('expo-image-manipulator', () => {
  const state: { width: number; height: number | null; saved: number } = {
    width: 4000,
    height: null,
    saved: 0,
  };
  const manipulate = jest.fn((uri: string) => {
    let width = state.width;
    let height = state.height ?? Math.round(width * 0.75);
    const context: Record<string, unknown> = {
      uri,
      resize: jest.fn((size: { width?: number | null; height?: number | null }) => {
        const w = typeof size.width === 'number' ? size.width : null;
        const h = typeof size.height === 'number' ? size.height : null;
        if (w !== null && h !== null) {
          width = w;
          height = h;
        } else if (w !== null) {
          height = Math.round((height * w) / width);
          width = w;
        } else if (h !== null) {
          width = Math.round((width * h) / height);
          height = h;
        }
        return context;
      }),
      renderAsync: jest.fn(() =>
        Promise.resolve({
          width,
          height,
          release: jest.fn(),
          saveAsync: jest.fn(() => {
            state.saved += 1;
            return Promise.resolve({
              uri: `file:///data/user/0/app/cache/ImageManipulator/prepared-${state.saved}.jpg`,
              width,
              height,
            });
          }),
        }),
      ),
      release: jest.fn(),
    };
    return context;
  });
  return {
    ImageManipulator: { manipulate },
    SaveFormat: { JPEG: 'jpeg', PNG: 'png', WEBP: 'webp' },
    __manipulator: state,
  };
});

/**
 * expo-file-system: File(uri).delete() is recorded by `__deleted`;
 * File(uri).bytes() reads the text `bytes of <uri>`.
 */
jest.mock('expo-file-system', () => {
  const deleted = jest.fn();
  class File {
    uri: string;
    constructor(path: string) {
      this.uri = path;
    }
    delete() {
      deleted(this.uri);
    }
    bytes(): Promise<Uint8Array> {
      return Promise.resolve(new (require('util').TextEncoder)().encode(`bytes of ${this.uri}`));
    }
  }
  return { File, __deleted: deleted };
});

jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: jest.fn(() => Promise.resolve({ canceled: true, assets: null })),
}));
