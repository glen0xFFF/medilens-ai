/**
 * The photos for the scan in progress (1–3 prepared JPEGs), in memory only.
 * Every photo that leaves the store (removed, replaced, rejected as a fourth,
 * or cleared after upload or cancel) has its cache file deleted.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { MAX_IMAGES } from '../api/client';
import { discardFiles } from './files';
import type { PreparedImage } from './prepare';

export interface CaptureStore {
  images: readonly PreparedImage[];
  /** Free slots left (0 when 3 photos are held). */
  remaining: number;
  /** Adds a photo; when the store is full the photo is deleted and false returned. */
  add(image: PreparedImage): boolean;
  replace(index: number, image: PreparedImage): void;
  remove(index: number): void;
  /** Drops every photo and deletes its file (after upload, or when the flow is cancelled). */
  clear(): void;
}

const CaptureContext = createContext<CaptureStore | null>(null);

export function CaptureProvider({ children }: { children: ReactNode }) {
  // The ref is the source of truth so several calls in one tick see each other.
  const held = useRef<PreparedImage[]>([]);
  const [images, setImages] = useState<readonly PreparedImage[]>([]);

  const commit = useCallback((next: PreparedImage[]) => {
    held.current = next;
    setImages(next);
  }, []);

  const add = useCallback(
    (image: PreparedImage) => {
      if (held.current.length >= MAX_IMAGES) {
        discardFiles([image.uri]);
        return false;
      }
      commit([...held.current, image]);
      return true;
    },
    [commit],
  );

  const replace = useCallback(
    (index: number, image: PreparedImage) => {
      const old = held.current[index];
      if (old === undefined) {
        add(image);
        return;
      }
      commit(held.current.map((img, i) => (i === index ? image : img)));
      discardFiles([old.uri]);
    },
    [add, commit],
  );

  const remove = useCallback(
    (index: number) => {
      const old = held.current[index];
      if (old === undefined) return;
      commit(held.current.filter((_, i) => i !== index));
      discardFiles([old.uri]);
    },
    [commit],
  );

  const clear = useCallback(() => {
    const old = held.current;
    if (old.length === 0) return;
    commit([]);
    discardFiles(old.map((img) => img.uri));
  }, [commit]);

  const value = useMemo<CaptureStore>(
    () => ({ images, remaining: MAX_IMAGES - images.length, add, replace, remove, clear }),
    [images, add, replace, remove, clear],
  );

  return <CaptureContext.Provider value={value}>{children}</CaptureContext.Provider>;
}

export function useCaptures(): CaptureStore {
  const value = useContext(CaptureContext);
  if (value === null) throw new Error('useCaptures must be used inside <CaptureProvider>.');
  return value;
}
