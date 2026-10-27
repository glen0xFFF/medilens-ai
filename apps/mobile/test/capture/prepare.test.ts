import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { JPEG_COMPRESS, MAX_WIDTH, prepareImage } from '../../src/capture/prepare';

const manipulator = jest.requireMock('expo-image-manipulator').__manipulator as {
  width: number;
  saved: number;
};
const manipulate = ImageManipulator.manipulate as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  manipulator.width = 4000;
  manipulator.saved = 0;
});

function lastContext() {
  return manipulate.mock.results.at(-1)!.value as {
    resize: jest.Mock;
    renderAsync: jest.Mock;
    release: jest.Mock;
  };
}

async function savedWith() {
  const renders = lastContext().renderAsync.mock.results;
  const image = (await renders.at(-1)!.value) as { saveAsync: jest.Mock };
  return image.saveAsync.mock.calls[0]![0];
}

describe('prepareImage', () => {
  it('uses a 2048 px width and JPEG quality 0.85', () => {
    expect(MAX_WIDTH).toBe(2048);
    expect(JPEG_COMPRESS).toBe(0.85);
  });

  it('downscales a wide photo to 2048 px and saves it as JPEG 0.85', async () => {
    const prepared = await prepareImage('file:///data/user/0/app/cache/Camera/a.jpg');
    expect(manipulate).toHaveBeenCalledWith('file:///data/user/0/app/cache/Camera/a.jpg');
    expect(lastContext().resize).toHaveBeenCalledWith({ width: 2048 });
    expect(await savedWith()).toEqual({ format: SaveFormat.JPEG, compress: 0.85 });
    expect(prepared).toEqual({
      uri: 'file:///data/user/0/app/cache/ImageManipulator/prepared-1.jpg',
      type: 'image/jpeg',
    });
  });

  it('never upscales a photo narrower than 2048 px', async () => {
    manipulator.width = 1500;
    const prepared = await prepareImage('file:///data/user/0/app/cache/ImagePicker/b.png');
    expect(lastContext().resize).not.toHaveBeenCalled();
    expect(await savedWith()).toEqual({ format: SaveFormat.JPEG, compress: 0.85 });
    expect(prepared.type).toBe('image/jpeg');
  });

  it('leaves a photo exactly 2048 px wide at its size', async () => {
    manipulator.width = 2048;
    await prepareImage('file:///data/user/0/app/cache/Camera/c.jpg');
    expect(lastContext().resize).not.toHaveBeenCalled();
  });

  it('releases the native manipulator context', async () => {
    await prepareImage('file:///data/user/0/app/cache/Camera/d.jpg');
    expect(lastContext().release).toHaveBeenCalled();
  });

  it('releases the context and rejects when the photo cannot be decoded', async () => {
    manipulate.mockImplementationOnce(() => ({
      resize: jest.fn(),
      renderAsync: jest.fn(() => Promise.reject(new Error('decode failed'))),
      release: jest.fn(),
    }));
    await expect(prepareImage('file:///broken.jpg')).rejects.toThrow('decode failed');
    expect(lastContext().release).toHaveBeenCalled();
  });
});
