import { open, type FileHandle } from 'node:fs/promises';

export interface Mp4VideoDimensions {
  width: number;
  height: number;
}

interface Box {
  type: string;
  payload: number;
  end: number;
}

class InvalidMp4Metadata extends Error {}

/**
 * Read only box headers, tkhd and hdlr, skipping mdat even when moov is at
 * EOF. Bounds on headers/bytes avoid large allocations or attacker-controlled
 * traversal. IO failures propagate; malformed/unsupported metadata returns
 * undefined so the caller can choose document delivery before sending.
 */
export async function readMp4VideoDimensions(
  filePath: string,
): Promise<Mp4VideoDimensions | undefined> {
  const file = await open(filePath, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || !Number.isSafeInteger(stat.size)) return undefined;
    const reader = new Mp4MetadataReader(file, stat.size);
    for await (const box of reader.boxes(0, stat.size)) {
      if (box.type !== 'moov') continue;
      for await (const track of reader.boxes(box.payload, box.end)) {
        if (track.type !== 'trak') continue;
        let dimensions: Mp4VideoDimensions | undefined;
        let video = false;
        for await (const child of reader.boxes(track.payload, track.end)) {
          if (child.type === 'tkhd') {
            dimensions = await reader.dimensions(child);
          } else if (child.type === 'mdia') {
            for await (const media of reader.boxes(child.payload, child.end)) {
              if (media.type === 'hdlr' && media.end - media.payload >= 12) {
                const handler = await reader.read(media.payload + 8, 4);
                video = handler.toString('ascii') === 'vide';
              }
            }
          }
        }
        if (video && dimensions) return dimensions;
      }
    }
    return undefined;
  } catch (error) {
    if (error instanceof InvalidMp4Metadata) return undefined;
    throw error;
  } finally {
    await file.close();
  }
}

class Mp4MetadataReader {
  private remainingBytes = 128 * 1024;
  private remainingBoxes = 2048;

  constructor(
    private readonly file: FileHandle,
    private readonly size: number,
  ) {}

  async read(position: number, length: number): Promise<Buffer> {
    if (
      length > this.remainingBytes ||
      position < 0 ||
      position + length > this.size
    ) {
      throw new InvalidMp4Metadata();
    }
    this.remainingBytes -= length;
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await this.file.read(
        buffer,
        offset,
        length - offset,
        position + offset,
      );
      if (!bytesRead) throw new InvalidMp4Metadata();
      offset += bytesRead;
    }
    return buffer;
  }

  async *boxes(start: number, end: number): AsyncGenerator<Box> {
    let position = start;
    while (position < end) {
      if (--this.remainingBoxes < 0 || end - position < 8) {
        throw new InvalidMp4Metadata();
      }
      const header = await this.read(position, 8);
      let size = header.readUInt32BE(0);
      let headerSize = 8;
      if (size === 1) {
        if (end - position < 16) throw new InvalidMp4Metadata();
        const extended = (await this.read(position + 8, 8)).readBigUInt64BE();
        if (extended > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new InvalidMp4Metadata();
        }
        size = Number(extended);
        headerSize = 16;
      } else if (size === 0) {
        size = end - position;
      }
      if (size < headerSize || size > end - position) {
        throw new InvalidMp4Metadata();
      }
      yield {
        type: header.toString('ascii', 4, 8),
        payload: position + headerSize,
        end: position + size,
      };
      position += size;
    }
  }

  async dimensions(box: Box): Promise<Mp4VideoDimensions | undefined> {
    if (box.end - box.payload < 1) return undefined;
    const version = (await this.read(box.payload, 1))[0];
    if (version !== 0 && version !== 1) return undefined;
    const length = version === 0 ? 84 : 96;
    if (box.end - box.payload < length) return undefined;
    const track = await this.read(box.payload, length);
    const matrix = version === 0 ? 40 : 52;
    const dimensions = matrix + 36;
    const width = track.readUInt32BE(dimensions) / 65536;
    const height = track.readUInt32BE(dimensions + 4) / 65536;
    // tkhd stores unrotated 16.16 dimensions. Its affine matrix determines
    // the display bounds (including the common 90/270-degree phone rotation).
    const a = track.readInt32BE(matrix) / 65536;
    const b = track.readInt32BE(matrix + 4) / 65536;
    const c = track.readInt32BE(matrix + 12) / 65536;
    const d = track.readInt32BE(matrix + 16) / 65536;
    if (
      track.readInt32BE(matrix + 8) !== 0 ||
      track.readInt32BE(matrix + 20) !== 0 ||
      track.readInt32BE(matrix + 32) !== 0x40000000 ||
      a * d - b * c === 0
    ) {
      return undefined;
    }
    const displayWidth = Math.round(Math.abs(a) * width + Math.abs(c) * height);
    const displayHeight = Math.round(
      Math.abs(b) * width + Math.abs(d) * height,
    );
    if (
      !width ||
      !height ||
      displayWidth < 1 ||
      displayHeight < 1 ||
      displayWidth > 65535 ||
      displayHeight > 65535
    ) {
      return undefined;
    }
    return { width: displayWidth, height: displayHeight };
  }
}
