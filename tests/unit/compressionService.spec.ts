import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { compressAndFilterImage } from '../../src/services/compressionService';
import { PhotoFilter } from '../../src/types';

describe('Image Compression & Canvas Filters Spec', () => {
  let originalImage: typeof Image;

  beforeEach(() => {
    originalImage = window.Image;
  });

  afterEach(() => {
    window.Image = originalImage;
  });

  it('compresses and scales landscape and portrait images with various filters', async () => {
    const mockContext: Partial<CanvasRenderingContext2D> = {
      filter: 'none',
      drawImage: vi.fn(),
      createRadialGradient: vi.fn().mockReturnValue({
        addColorStop: vi.fn(),
      } as unknown as CanvasGradient),
      fillStyle: '',
      fillRect: vi.fn(),
    };

    const mockCanvas: Partial<HTMLCanvasElement> = {
      width: 100,
      height: 100,
      getContext: vi.fn().mockReturnValue(mockContext as CanvasRenderingContext2D),
      toDataURL: vi.fn().mockReturnValue('data:image/jpeg;base64,COMPRESSED_DATA'),
    };

    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'canvas') return mockCanvas as HTMLCanvasElement;
      return document.createElement(tag);
    });

    const filters: PhotoFilter[] = ['original', 'vintage_warmth', 'golden_glow', 'black_white', 'film_grain'];

    for (const filter of filters) {
      // Landscape image (width > height)
      class MockLandscapeImage {
        width = 2400;
        height = 1600;
        crossOrigin = '';
        private _src = '';
        set src(val: string) {
          this._src = val;
          setTimeout(() => {
            this.onload?.call(this as unknown as GlobalEventHandlers, new Event('load'));
          }, 5);
        }
        get src(): string {
          return this._src;
        }
        onload: ((this: GlobalEventHandlers, ev: Event) => unknown) | null = null;
        onerror: OnErrorEventHandler = null;
      }
      window.Image = MockLandscapeImage as unknown as typeof Image;

      const landscapeResult = await compressAndFilterImage('data:image/jpeg;base64,LANDSCAPE', {
        maxWidth: 1920,
        maxHeight: 1920,
        quality: 0.8,
        filter,
      });

      expect(landscapeResult.dataUrl).toBe('data:image/jpeg;base64,COMPRESSED_DATA');
      expect(landscapeResult.width).toBe(1920);

      // Portrait image (height > width)
      class MockPortraitImage {
        width = 1200;
        height = 2400;
        crossOrigin = '';
        private _src = '';
        set src(val: string) {
          this._src = val;
          setTimeout(() => {
            this.onload?.call(this as unknown as GlobalEventHandlers, new Event('load'));
          }, 5);
        }
        get src(): string {
          return this._src;
        }
        onload: ((this: GlobalEventHandlers, ev: Event) => unknown) | null = null;
        onerror: OnErrorEventHandler = null;
      }
      window.Image = MockPortraitImage as unknown as typeof Image;

      const portraitResult = await compressAndFilterImage('data:image/jpeg;base64,PORTRAIT', {
        maxWidth: 1920,
        maxHeight: 1920,
        quality: 0.8,
        filter,
      });

      expect(portraitResult.height).toBe(1920);
    }
  });

  it('rejects on image load error', async () => {
    class MockErrorImage {
      private _src = '';
      set src(val: string) {
        this._src = val;
        setTimeout(() => {
          if (this.onerror) this.onerror(new Event('error') as unknown as string);
        }, 5);
      }
      get src(): string {
        return this._src;
      }
      onload: ((this: GlobalEventHandlers, ev: Event) => unknown) | null = null;
      onerror: OnErrorEventHandler = null;
    }
    window.Image = MockErrorImage as unknown as typeof Image;

    await expect(compressAndFilterImage('bad-image-data')).rejects.toThrow('Failed to load image');
  });
});
