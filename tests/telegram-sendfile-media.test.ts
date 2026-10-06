import { mp4Fixture } from './helpers/mp4-fixture.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const api = vi.hoisted(() => ({
  sendDocument: vi.fn(async () => ({})),
  sendVideo: vi.fn(async () => ({})),
  sendAudio: vi.fn(async () => ({})),
  sendVoice: vi.fn(async () => ({})),
  getMe: vi.fn(async () => ({ id: 1, username: 'sendfile_bot' })),
  config: { use: vi.fn() },
  stop: null as (() => void) | null,
}));

vi.mock('grammy', () => ({
  Bot: class {
    api = {
      config: api.config,
      getMe: api.getMe,
      sendDocument: api.sendDocument,
      sendVideo: api.sendVideo,
      sendAudio: api.sendAudio,
      sendVoice: api.sendVoice,
    };
    on() {
      return this;
    }
    start(options: { onStart?: () => void }) {
      options.onStart?.();
      return new Promise<void>((resolve) => {
        api.stop = resolve;
      });
    }
    stop() {
      api.stop?.();
      api.stop = null;
    }
  },
  InputFile: class {
    constructor(
      public filePath: string,
      public fileName: string,
    ) {}
  },
}));

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { createTelegramConnection } = await import('../src/telegram.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-sendfile-'));

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function touch(name: string): string {
  const filePath = path.join(root, name);
  fs.writeFileSync(filePath, 'x');
  return filePath;
}

function videoFile(width: number, height: number, rotation = 0): string {
  const filePath = path.join(root, 'clip.mp4');
  fs.writeFileSync(filePath, mp4Fixture(width, height, rotation));
  return filePath;
}

describe('Telegram sendFile media routing (live connection)', () => {
  let connection: ReturnType<typeof createTelegramConnection> | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    api.stop = null;
  });

  afterEach(async () => {
    if (connection) {
      await connection.disconnect();
      connection = null;
    }
  });

  async function connect() {
    connection = createTelegramConnection({ botToken: 'test-token' });
    const ok = await connection.connect({
      onNewChat: vi.fn(),
      isChatAuthorized: () => true,
    });
    expect(ok).toBe(true);
    return connection;
  }

  test.each([
    [1920, 1080, 0, 1920, 1080],
    [1080, 1920, 0, 1080, 1920],
    [1920, 1080, 90, 1080, 1920],
    [1920, 1080, 270, 1080, 1920],
  ])(
    'sends MP4 %ix%i rotated %i as native video in the requested topic',
    async (width, height, rotation, outputWidth, outputHeight) => {
      const conn = await connect();
      await conn.sendFile(
        '424242#thread:17',
        videoFile(width, height, rotation),
        'clip.mp4',
      );
      expect(api.sendVideo).toHaveBeenCalledOnce();
      expect(api.sendVideo).toHaveBeenCalledWith(424242, expect.anything(), {
        width: outputWidth,
        height: outputHeight,
        message_thread_id: 17,
      });
      expect(api.sendDocument).not.toHaveBeenCalled();
    },
  );

  test('chooses document before sending when MP4 metadata is unavailable', async () => {
    const conn = await connect();
    await conn.sendFile('424242#thread:17', touch('clip.mp4'), 'clip.mp4');
    expect(api.sendDocument).toHaveBeenCalledOnce();
    expect(api.sendDocument).toHaveBeenCalledWith(424242, expect.anything(), {
      message_thread_id: 17,
    });
    expect(api.sendVideo).not.toHaveBeenCalled();
  });

  test('can explicitly send the original MP4 as a document', async () => {
    const conn = await connect();
    await conn.sendFile('424242', videoFile(1920, 1080), 'clip.mp4', {
      asDocument: true,
    });
    expect(api.sendDocument).toHaveBeenCalledOnce();
    expect(api.sendVideo).not.toHaveBeenCalled();
  });

  test('never falls back to a duplicate document when the video send fails', async () => {
    const conn = await connect();
    api.sendVideo.mockRejectedValueOnce(
      new Error('connection reset after acceptance'),
    );
    await expect(
      conn.sendFile('424242', videoFile(1920, 1080), 'clip.mp4'),
    ).rejects.toThrow();
    expect(api.sendVideo).toHaveBeenCalledOnce();
    expect(api.sendDocument).not.toHaveBeenCalled();
  });

  test('sendFile(voice.ogg) uses sendVoice, not sendAudio', async () => {
    const conn = await connect();
    await conn.sendFile('424242', touch('voice.ogg'), 'voice.ogg');
    expect(api.sendVoice).toHaveBeenCalledOnce();
    expect(api.sendAudio).not.toHaveBeenCalled();
    expect(api.sendDocument).not.toHaveBeenCalled();
    expect(api.sendVideo).not.toHaveBeenCalled();
  });

  test('sendFile(song.m4a) uses audio while MOV/WebM/WAV stay documents', async () => {
    const conn = await connect();
    await conn.sendFile('424242', touch('song.m4a'), 'song.m4a');
    expect(api.sendAudio).toHaveBeenCalledOnce();
    for (const name of ['clip.mov', 'clip.webm', 'sample.wav']) {
      await conn.sendFile('424242', touch(name), name);
    }
    expect(api.sendDocument).toHaveBeenCalledTimes(3);
    expect(api.sendVideo).not.toHaveBeenCalled();
  });

  test('sendFile(notes.pdf) stays sendDocument', async () => {
    const conn = await connect();
    await conn.sendFile('424242', touch('notes.pdf'), 'notes.pdf');
    expect(api.sendDocument).toHaveBeenCalledOnce();
    expect(api.sendVideo).not.toHaveBeenCalled();
    expect(api.sendAudio).not.toHaveBeenCalled();
  });
});
