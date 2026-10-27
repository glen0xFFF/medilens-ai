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

jest.mock('expo-camera', () => ({
  CameraView: 'CameraView',
  useCameraPermissions: jest.fn(() => [
    { granted: false, canAskAgain: true, status: 'undetermined' },
    jest.fn(() => Promise.resolve({ granted: false, canAskAgain: true, status: 'denied' })),
  ]),
}));
