/**
 * Shrinks a captured or picked photo before upload: at most 2048 px wide,
 * re-encoded as JPEG 0.85. Narrower photos keep their size (never upscaled).
 * The result is a new file in the app cache; the caller owns deleting it.
 */
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

export const MAX_WIDTH = 2048;
export const JPEG_COMPRESS = 0.85;

export interface PreparedImage {
  uri: string;
  type: 'image/jpeg';
}

export async function prepareImage(uri: string): Promise<PreparedImage> {
  const context = ImageManipulator.manipulate(uri);
  const refs: { release(): void }[] = [];
  try {
    let image = await context.renderAsync();
    refs.push(image);
    if (image.width > MAX_WIDTH) {
      context.resize({ width: MAX_WIDTH });
      image = await context.renderAsync();
      refs.push(image);
    }
    const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: JPEG_COMPRESS });
    return { uri: saved.uri, type: 'image/jpeg' };
  } finally {
    for (const shared of [...refs, context]) {
      try {
        shared.release();
      } catch {
        // Native memory is reclaimed by the garbage collector anyway.
      }
    }
  }
}
