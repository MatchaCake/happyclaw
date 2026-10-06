import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { readMp4VideoDimensions } from '../src/mp4-video-dimensions.js';
import { mp4Box, mp4Fixture, mp4Track } from './helpers/mp4-fixture.js';

let directory: string;
let sequence = 0;
beforeAll(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mp4-dimensions-'));
});
afterAll(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});
async function dimensions(data: Buffer) {
  const name = path.join(directory, `${sequence++}.mp4`);
  await fs.writeFile(name, data);
  return readMp4VideoDimensions(name);
}

describe('bounded MP4 video display dimensions', () => {
  test.each([
    [1920, 1080, 0, 1920, 1080],
    [1080, 1920, 0, 1080, 1920],
    [1920, 1080, 90, 1080, 1920],
    [1920, 1080, 180, 1920, 1080],
    [1920, 1080, 270, 1080, 1920],
  ])(
    'reads %ix%i rotated %i degrees',
    async (width, height, rotation, outputWidth, outputHeight) => {
      expect(await dimensions(mp4Fixture(width, height, rotation))).toEqual({
        width: outputWidth,
        height: outputHeight,
      });
    },
  );

  test('handles version 1 and extended boxes, ignoring an earlier audio track', async () => {
    const data = mp4Box(
      'moov',
      Buffer.concat([
        mp4Track(100, 100, 0, 0, 'soun'),
        mp4Track(3840, 2160, 90, 1),
      ]),
      true,
    );
    expect(await dimensions(data)).toEqual({ width: 2160, height: 3840 });
  });

  test('skips a sparse 1 GiB mdat without reading or allocating its payload', async () => {
    const name = path.join(directory, 'sparse.mp4');
    const file = await fs.open(name, 'w');
    try {
      const mdat = Buffer.alloc(8);
      mdat.writeUInt32BE(1024 * 1024 * 1024, 0);
      mdat.write('mdat', 4, 'ascii');
      await file.write(mdat, 0, mdat.length, 0);
      const tail = mp4Box('moov', mp4Track(1920, 1080));
      await file.write(tail, 0, tail.length, 1024 * 1024 * 1024);
    } finally {
      await file.close();
    }
    expect(await readMp4VideoDimensions(name)).toEqual({
      width: 1920,
      height: 1080,
    });
  });

  test.each([
    Buffer.from('broken'),
    mp4Box('moov', mp4Box('tkhd', Buffer.alloc(1))),
    Buffer.from('000000046d6f6f76', 'hex'),
    Buffer.from('000000016d6f6f76ffffffffffffffff', 'hex'),
    mp4Fixture(0, 1080),
    mp4Box('moov', mp4Track(1920, 1080, 0, 2)),
    Buffer.concat(
      Array.from({ length: 2049 }, () => mp4Box('free', Buffer.alloc(0))),
    ),
  ])(
    'returns no dimensions for malformed or unsupported metadata %#',
    async (data) => {
      expect(await dimensions(data)).toBeUndefined();
    },
  );

  test('rejects a box whose declared payload exceeds the file', async () => {
    const data = mp4Fixture(1920, 1080);
    data.writeUInt32BE(data.length + 1, 0);
    expect(await dimensions(data)).toBeUndefined();
  });
});
