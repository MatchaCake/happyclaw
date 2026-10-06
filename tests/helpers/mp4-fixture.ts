export function mp4Box(
  type: string,
  payload: Buffer,
  extended = false,
): Buffer {
  const header = Buffer.alloc(extended ? 16 : 8);
  header.writeUInt32BE(extended ? 1 : header.length + payload.length, 0);
  header.write(type, 4, 'ascii');
  if (extended)
    header.writeBigUInt64BE(BigInt(header.length + payload.length), 8);
  return Buffer.concat([header, payload]);
}

/** Minimal ISO BMFF metadata; dimensions are 16.16, matrix is 16.16/2.30. */
export function mp4Track(
  width: number,
  height: number,
  rotation = 0,
  version = 0,
  handler = 'vide',
): Buffer {
  const tkhd = Buffer.alloc(version ? 96 : 84);
  tkhd[0] = version;
  tkhd[3] = 3; // Track enabled and in movie.
  const matrixOffset = version ? 52 : 40;
  const values =
    rotation === 90
      ? [0, 1, -1, 0]
      : rotation === 180
        ? [-1, 0, 0, -1]
        : rotation === 270
          ? [0, -1, 1, 0]
          : [1, 0, 0, 1];
  for (const [index, value] of [
    [0, values[0]],
    [1, values[1]],
    [3, values[2]],
    [4, values[3]],
  ]) {
    tkhd.writeInt32BE(value * 65536, matrixOffset + index * 4);
  }
  tkhd.writeInt32BE(0x40000000, matrixOffset + 32);
  tkhd.writeUInt32BE(width * 65536, matrixOffset + 36);
  tkhd.writeUInt32BE(height * 65536, matrixOffset + 40);
  const hdlr = Buffer.alloc(24);
  hdlr.write(handler, 8, 'ascii');
  return mp4Box(
    'trak',
    Buffer.concat([mp4Box('tkhd', tkhd), mp4Box('mdia', mp4Box('hdlr', hdlr))]),
  );
}

export function mp4Fixture(
  width: number,
  height: number,
  rotation = 0,
): Buffer {
  return Buffer.concat([
    mp4Box('ftyp', Buffer.from('isom\0\0\0\0isom', 'ascii')),
    mp4Box('moov', mp4Track(width, height, rotation)),
  ]);
}
