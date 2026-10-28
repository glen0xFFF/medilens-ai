import { act, renderHook } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { CaptureProvider, useCaptures } from '../../src/capture/captures';
import { discardFiles, isDisposable } from '../../src/capture/files';

const deleted = jest.requireMock('expo-file-system').__deleted as jest.Mock;

const cache = (name: string) => `file:///data/user/0/app/cache/ImageManipulator/${name}.jpg`;
const img = (name: string) => ({ uri: cache(name), type: 'image/jpeg' as const });

beforeEach(() => {
  jest.clearAllMocks();
});

describe('discardFiles', () => {
  it('deletes app cache files only', () => {
    expect(isDisposable(cache('a'))).toBe(true);
    expect(isDisposable('file:///storage/emulated/0/DCIM/Camera/IMG_1.jpg')).toBe(false);
    expect(isDisposable('content://media/external/images/media/12')).toBe(false);
    expect(isDisposable('https://example.com/cache/a.jpg')).toBe(false);

    discardFiles([
      cache('a'),
      'file:///storage/emulated/0/DCIM/Camera/IMG_1.jpg',
      'content://media/external/images/media/12',
    ]);
    expect(deleted.mock.calls).toEqual([[cache('a')]]);
  });

  it('keeps going when a delete throws', () => {
    deleted.mockImplementationOnce(() => {
      throw new Error('already gone');
    });
    expect(() => discardFiles([cache('a'), cache('b')])).not.toThrow();
    expect(deleted.mock.calls).toEqual([[cache('a')], [cache('b')]]);
  });
});

function wrapper({ children }: { children: ReactNode }) {
  return <CaptureProvider>{children}</CaptureProvider>;
}

describe('capture store', () => {
  it('holds at most 3 photos and discards a fourth', async () => {
    const { result } = await renderHook(() => useCaptures(), { wrapper });
    const added: boolean[] = [];
    await act(async () => {
      for (const name of ['a', 'b', 'c', 'd']) added.push(result.current.add(img(name)));
    });
    expect(added).toEqual([true, true, true, false]);
    expect(result.current.images.map((i) => i.uri)).toEqual([cache('a'), cache('b'), cache('c')]);
    expect(result.current.remaining).toBe(0);
    expect(deleted.mock.calls).toEqual([[cache('d')]]);
  });

  it('deletes the file when a photo is removed or replaced', async () => {
    const { result } = await renderHook(() => useCaptures(), { wrapper });
    await act(async () => {
      result.current.add(img('a'));
      result.current.add(img('b'));
    });
    await act(async () => result.current.replace(0, img('a2')));
    expect(deleted.mock.calls).toEqual([[cache('a')]]);
    await act(async () => result.current.remove(1));
    expect(deleted.mock.calls).toEqual([[cache('a')], [cache('b')]]);
    expect(result.current.images.map((i) => i.uri)).toEqual([cache('a2')]);
    expect(result.current.remaining).toBe(2);
  });

  it('clear deletes every held photo', async () => {
    const { result } = await renderHook(() => useCaptures(), { wrapper });
    await act(async () => {
      result.current.add(img('a'));
      result.current.add(img('b'));
    });
    await act(async () => result.current.clear());
    expect(deleted.mock.calls).toEqual([[cache('a')], [cache('b')]]);
    expect(result.current.images).toEqual([]);
  });

  it('throws outside its provider', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(renderHook(() => useCaptures())).rejects.toThrow(/CaptureProvider/);
  });
});
