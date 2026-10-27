/**
 * Shrinks a captured or picked photo before upload: its long edge (width or
 * height) at most 2048 px, re-encoded as JPEG 0.85. Smaller photos keep their
 * size (never upscaled). The result is a new file in the app cache; the caller
 * owns deleting it.
 */
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

/** The longest side sent to the server (final review Minor 26: width or height). */
export const MAX_EDGE = 2048;
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
    if (Math.max(image.width, image.height) > MAX_EDGE) {
      // Resizing one side keeps the aspect ratio.
      context.resize(image.width >= image.height ? { width: MAX_EDGE } : { height: MAX_EDGE });
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
