import fs from 'node:fs';
import path from 'node:path';

import { logger } from './logger.js';

export interface StreamingBufferDeps {
  getActiveTexts: () => ReadonlyMap<string, string>;
  persistInterrupted: (
    jid: string,
    text: string,
    reason: 'crash_recovery',
  ) => void;
}

export class StreamingBuffer {
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly directory: string,
    private readonly deps: StreamingBufferDeps,
    private readonly flushIntervalMs = 5000,
  ) {}

  private encodeJid(jid: string): string {
    return Buffer.from(jid).toString('base64url');
  }

  private decodeJid(filename: string): string {
    const name = filename.endsWith('.txt') ? filename.slice(0, -4) : filename;
    return Buffer.from(name, 'base64url').toString();
  }

  flush(): void {
    try {
      const activeTexts = this.deps.getActiveTexts();
      if (activeTexts.size === 0) {
        this.clean();
        return;
      }
      fs.mkdirSync(this.directory, { recursive: true });
      const activeFiles = new Set<string>();
      for (const [jid, text] of activeTexts) {
        const filename = `${this.encodeJid(jid)}.txt`;
        activeFiles.add(filename);
        const filePath = path.join(this.directory, filename);
        const temporaryPath = `${filePath}.tmp`;
        fs.writeFileSync(temporaryPath, text);
        fs.renameSync(temporaryPath, filePath);
      }
      for (const filename of fs.readdirSync(this.directory)) {
        if (filename.endsWith('.txt') && !activeFiles.has(filename)) {
          fs.unlinkSync(path.join(this.directory, filename));
        }
      }
    } catch (error) {
      logger.debug({ error }, 'Error flushing streaming buffer');
    }
  }

  recover(): void {
    try {
      if (!fs.existsSync(this.directory)) return;
      const files = fs
        .readdirSync(this.directory)
        .filter((filename) => filename.endsWith('.txt'));
      if (files.length === 0) return;
      logger.info(
        { count: files.length },
        'Recovering interrupted streaming messages from buffer files',
      );
      for (const filename of files) {
        try {
          const jid = this.decodeJid(filename);
          const text = fs.readFileSync(
            path.join(this.directory, filename),
            'utf8',
          );
          if (text.trim()) {
            this.deps.persistInterrupted(jid, text, 'crash_recovery');
            logger.info(
              { jid, textLen: text.length },
              'Recovered interrupted streaming message',
            );
          }
          fs.unlinkSync(path.join(this.directory, filename));
        } catch (error) {
          logger.warn(
            { error, filename },
            'Error recovering streaming buffer file',
          );
        }
      }
    } catch (error) {
      logger.warn({ error }, 'Error recovering streaming buffer');
    }
  }

  clean(): void {
    try {
      if (!fs.existsSync(this.directory)) return;
      for (const filename of fs.readdirSync(this.directory)) {
        try {
          fs.unlinkSync(path.join(this.directory, filename));
        } catch {
          // A concurrent flush may already have replaced or removed the file.
        }
      }
    } catch {
      // Cleanup is best-effort; recovery will retry on the next startup.
    }
  }

  unlinkJid(jid: string): void {
    try {
      fs.unlinkSync(path.join(this.directory, `${this.encodeJid(jid)}.txt`));
    } catch {
      // Missing or already replaced. A kept file is retried by recover().
    }
  }

  saveInterrupted(
    activeTexts: ReadonlyMap<string, string>,
    persist: (jid: string, text: string) => void,
    onWhitespace?: (jid: string) => void,
  ): void {
    let failed = false;
    for (const [jid, text] of activeTexts) {
      try {
        if (!text.trim()) {
          onWhitespace?.(jid);
          this.unlinkJid(jid);
          continue;
        }
        persist(jid, text);
        this.unlinkJid(jid);
      } catch (error) {
        failed = true;
        logger.warn(
          { error, jid },
          'Error saving interrupted streaming messages',
        );
      }
    }
    if (!failed) this.clean();
  }

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.flush(), this.flushIntervalMs);
  }

  stop(): void {
    if (!this.interval) return;
    clearInterval(this.interval);
    this.interval = null;
  }
}
