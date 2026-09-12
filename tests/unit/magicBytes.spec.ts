import { describe, it, expect } from 'vitest';
import { validateMagicBytes, isValidUuid } from '../../server/lib/validation';

describe('Magic Bytes & UUID Validation', () => {
  it('validates JPEG headers (FF D8 FF)', () => {
    const jpegBuf = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46]);
    expect(validateMagicBytes(jpegBuf)).toBe(true);
  });

  it('validates PNG headers (89 50 4E 47)', () => {
    const pngBuf = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    expect(validateMagicBytes(pngBuf)).toBe(true);
  });

  it('validates GIF headers (GIF89a / GIF87a)', () => {
    const gifBuf = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    expect(validateMagicBytes(gifBuf)).toBe(true);
  });

  it('validates WebP headers (RIFF....WEBP)', () => {
    const webpBuf = Buffer.from('RIFF1234WEBPVP8 ');
    expect(validateMagicBytes(webpBuf)).toBe(true);
  });

  it('validates WebM and Matroska audio headers', () => {
    const webmBuf = Buffer.from([0x1A, 0x45, 0xDF, 0xA3, 0x9F, 0x42, 0x86]);
    expect(validateMagicBytes(webmBuf)).toBe(true);
  });

  it('validates OGG container headers', () => {
    const oggBuf = Buffer.from('OggS\x00\x02\x00\x00\x00\x00');
    expect(validateMagicBytes(oggBuf)).toBe(true);
  });

  it('validates MP4/M4A ftyp headers', () => {
    const mp4Buf = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6D, 0x70, 0x34, 0x32]);
    expect(validateMagicBytes(mp4Buf)).toBe(true);
  });

  it('validates MP3 ID3 and frame sync headers', () => {
    const mp3Id3 = Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00');
    const mp3Frame = Buffer.from([0xFF, 0xFB, 0x90, 0x64]);
    expect(validateMagicBytes(mp3Id3)).toBe(true);
    expect(validateMagicBytes(mp3Frame)).toBe(true);
  });

  it('rejects executable binaries, scripts, and truncated buffers', () => {
    expect(validateMagicBytes(Buffer.from([0x4D, 0x5A, 0x90, 0x00]))).toBe(false);
    expect(validateMagicBytes(Buffer.from([0x7F, 0x45, 0x4C, 0x46]))).toBe(false);
    expect(validateMagicBytes(Buffer.from('<!DOCTYPE html><html>'))).toBe(false);
    expect(validateMagicBytes(Buffer.from([0xFF, 0xD8]))).toBe(false);
    expect(validateMagicBytes(null as unknown as Buffer)).toBe(false);
  });

  it('validates UUIDv4 format strictly', () => {
    expect(isValidUuid('10eebc99-9c0b-4ef8-bb6d-6bb9bd380a01')).toBe(true);
    expect(isValidUuid('10EEBC99-9C0B-4EF8-BB6D-6BB9BD380A01')).toBe(true);
    expect(isValidUuid('not-a-uuid')).toBe(false);
    expect(isValidUuid('')).toBe(false);
    expect(isValidUuid(undefined)).toBe(false);
    expect(isValidUuid('10eebc99-9c0b-4ef8-bb6d-6bb9bd380a01; DROP TABLE users;--')).toBe(false);
  });
});
