/**
 * A photo as a multipart file part that expo/fetch can send.
 *
 * Expo SDK 58 replaces globalThis.fetch with expo/fetch, which encodes a
 * FormData body with convertFormDataAsync
 * (node_modules/expo/src/winter/fetch/convertFormData.ts). That encoder takes
 * a string, a Blob, or an object with bytes(); React Native's proprietary
 * {uri, name, type} part makes it throw "Unsupported FormDataPart
 * implementation" before the request leaves the phone. It writes the part's
 * `name` as the multipart filename and its `type` as the Content-Type.
 *
 * The part reads the file with expo-file-system's File, but carries the
 * filename and type the client chose: File.name would be the cache basename
 * and File.type whatever the native side guesses. It is a plain object, not a
 * Blob, so Expo's FormData.append keeps it as given.
 */
import { File } from 'expo-file-system';

export interface UploadPart {
  /** The multipart filename, e.g. photo-1.jpg. */
  readonly name: string;
  /** The part's Content-Type, e.g. image/jpeg. */
  readonly type: string;
  /** The file's contents, read when the request body is encoded. */
  bytes(): Promise<Uint8Array>;
}

/** Builds the part for the file at `uri`; injectable so tests need no file system. */
export type ToUploadPart = (uri: string, name: string, type: string) => UploadPart;

export const fileUploadPart: ToUploadPart = (uri, name, type) => {
  const file = new File(uri);
  return { name, type, bytes: () => file.bytes() };
};
