/**
 * Regression: the photo upload must survive Expo's own fetch.
 *
 * Expo SDK 58 replaces globalThis.fetch with expo/fetch, which encodes a
 * FormData body with convertFormDataAsync. That encoder accepts only a
 * string, a Blob, or an object with bytes(); a React Native {uri, name, type}
 * part makes it throw "Unsupported FormDataPart implementation" before the
 * request leaves the phone, which the client reported as NETWORK ("I couldn't
 * reach the MediLens server"). These tests build the request through the
 * client and run Expo's real encoder over the body it would send.
 */
import { convertFormDataAsync } from 'expo/src/winter/fetch/convertFormData';
import { ApiError, createApiClient, type UploadPart } from '../../src/api/client';

// On a device, expo/src/winter/runtime.native.ts patches React Native's
// FormData (jest.setup installs RN's as the global) with Expo's append and
// entries(); convertFormDataAsync reads the parts through those.
const { installFormDataPatch } = jest.requireActual('expo/src/winter/FormData');
installFormDataPatch(FormData);

const BASE = 'http://example.test:8787';
const BOUNDARY = '----ExpoFetchFormBoundary0000000000000000';
const CACHE = 'file:///data/user/0/app/cache/ImageManipulator';

/** Sends one analyze request and returns the body handed to fetch; the request itself fails. */
async function capturedBody(
  images: { uri: string; type: string }[],
  toUploadPart?: (uri: string, name: string, type: string) => UploadPart,
): Promise<FormData> {
  let body: unknown;
  const fetchImpl = jest.fn((_url: string, init?: RequestInit) => {
    body = init?.body;
    return Promise.reject(new Error('not sent in this test'));
  });
  const client = createApiClient(BASE, fetchImpl, toUploadPart);
  await expect(client.analyze(images)).rejects.toBeInstanceOf(ApiError);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  return body as FormData;
}

async function encode(form: FormData): Promise<string> {
  const { body } = await convertFormDataAsync(form, BOUNDARY);
  return new TextDecoder().decode(body);
}

describe('analyze upload through expo/fetch FormData encoding', () => {
  it('encodes each photo as an "images" file part with filename photo-N.jpg, image/jpeg and the file bytes', async () => {
    const form = await capturedBody([
      { uri: `${CACHE}/prepared-1.jpg`, type: 'image/jpeg' },
      { uri: `${CACHE}/prepared-2.jpg`, type: 'image/jpeg' },
    ]);

    const text = await encode(form);

    // jest.setup's expo-file-system File mock reads a file as `bytes of <uri>`.
    expect(text).toBe(
      [
        `--${BOUNDARY}`,
        'content-disposition: form-data; name="images"; filename="photo-1.jpg"',
        'content-type: image/jpeg',
        '',
        `bytes of ${CACHE}/prepared-1.jpg`,
        `--${BOUNDARY}`,
        'content-disposition: form-data; name="images"; filename="photo-2.jpg"',
        'content-type: image/jpeg',
        '',
        `bytes of ${CACHE}/prepared-2.jpg`,
        `--${BOUNDARY}--`,
        '',
      ].join('\r\n'),
    );
  });

  it('names a PNG photo photo-1.png with content-type image/png', async () => {
    const text = await encode(await capturedBody([{ uri: `${CACHE}/x.png`, type: 'image/png' }]));
    expect(text).toContain('content-disposition: form-data; name="images"; filename="photo-1.png"');
    expect(text).toContain('content-type: image/png');
  });

  it('builds each part with the injected factory, given the uri, filename and type', async () => {
    const toUploadPart = jest.fn((uri: string, name: string, type: string) => ({
      name,
      type,
      bytes: () => Promise.resolve(new TextEncoder().encode(`fake ${uri}`)),
    }));
    const text = await encode(
      await capturedBody([{ uri: `${CACHE}/a.jpg`, type: 'image/jpeg' }], toUploadPart),
    );
    expect(toUploadPart).toHaveBeenCalledWith(`${CACHE}/a.jpg`, 'photo-1.jpg', 'image/jpeg');
    expect(text).toContain(`fake ${CACHE}/a.jpg`);
  });

  it('negative control: the old React Native {uri, name, type} part makes the encoder throw', async () => {
    const form = new FormData();
    form.append('images', {
      uri: `${CACHE}/prepared-1.jpg`,
      name: 'photo-1.jpg',
      type: 'image/jpeg',
    } as unknown as Blob);
    await expect(convertFormDataAsync(form, BOUNDARY)).rejects.toThrow(
      'Unsupported FormDataPart implementation',
    );
  });
});
