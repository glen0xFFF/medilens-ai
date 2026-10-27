/**
 * "Read existing photo": picks photos from the phone's gallery into the
 * capture store, up to the free slots. Each pick is resized like a camera
 * shot and the picker's own cache copy is deleted. The gallery itself is
 * only read, never written.
 */
import { launchImageLibraryAsync } from 'expo-image-picker';
import { useCallback } from 'react';
import { MAX_IMAGES } from '../api/client';
import { useCaptures } from './captures';
import { discardFiles } from './files';
import { prepareImage } from './prepare';

export interface PickOutcome {
  added: number;
  /** Something to tell the user (extra photos dropped, or a photo that could not be opened). */
  message: string | null;
}

export const PICK_FAILED = 'That photo could not be opened. Please choose another photo.';

export function usePickPhotos(): () => Promise<PickOutcome> {
  const { add, remaining } = useCaptures();

  return useCallback(async () => {
    const limit = remaining;
    if (limit <= 0) return { added: 0, message: null };
    const picked = await launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      selectionLimit: limit,
      quality: 1,
      exif: false,
    });
    if (picked.canceled || picked.assets.length === 0) return { added: 0, message: null };

    // Some Android pickers ignore selectionLimit; the app enforces it.
    const keep = picked.assets.slice(0, limit);
    const extra = picked.assets.slice(limit);
    discardFiles(extra.map((a) => a.uri));

    let added = 0;
    let failed = false;
    for (const asset of keep) {
      try {
        const prepared = await prepareImage(asset.uri);
        if (add(prepared)) added += 1;
      } catch {
        failed = true;
      } finally {
        discardFiles([asset.uri]);
      }
    }

    let message: string | null = null;
    if (extra.length > 0) {
      message = `Only ${MAX_IMAGES} photos can be read at once. The first ${limit} ${
        limit === 1 ? 'was' : 'were'
      } kept.`;
    }
    if (failed) message = message === null ? PICK_FAILED : `${message} ${PICK_FAILED}`;
    return { added, message };
  }, [add, remaining]);
}
