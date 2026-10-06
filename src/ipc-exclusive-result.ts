import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const DIR_FLAGS =
  fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;

/**
 * IPC result temps for list_tasks / install_skill / uninstall_skill / Discord
 * used to be `${result}.tmp`. requestId is caller-chosen, and the container
 * has a writable bind of the ipc tasks directory, so that name can be a
 * planted symlink. O_EXCL on a fresh name does not help when the tasks
 * directory itself (or a parent under it) is a symlink: path.resolve does
 * not dereference, and open follows the directory. Walk from the tasks root
 * with O_DIRECTORY|O_NOFOLLOW, then create an unpredictable temp with wx.
 */
export class IpcResultWriteError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'IpcResultWriteError';
  }
}

function assertSafeComponent(name: string): void {
  if (
    name.length === 0 ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0')
  ) {
    throw new IpcResultWriteError('Unsafe IPC result path component');
  }
}

function refusalFor(err: unknown): IpcResultWriteError | null {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ELOOP' || code === 'ENOTDIR' || code === 'EPERM') {
    return new IpcResultWriteError(
      'Refusing IPC result write through a symlinked directory',
      err,
    );
  }
  return null;
}

function openNoFollowDir(location: string): number {
  try {
    return fs.openSync(location, DIR_FLAGS);
  } catch (err) {
    const refusal = refusalFor(err);
    if (refusal) throw refusal;
    throw err;
  }
}

/** Directory fd for the result parent, proven not to cross a symlink. */
function openRealResultParent(
  tasksRoot: string,
  resultFilePath: string,
): number {
  const root = path.resolve(tasksRoot);
  const parent = path.dirname(path.resolve(resultFilePath));
  if (parent !== root && !parent.startsWith(`${root}${path.sep}`)) {
    throw new IpcResultWriteError('IPC result path escapes tasks root');
  }
  const relative = path.relative(root, parent);
  const parts = relative === '' ? [] : relative.split(path.sep);
  let fd = openNoFollowDir(root);
  try {
    for (const part of parts) {
      assertSafeComponent(part);
      // /proc/self/fd/<parent>/<name> is openat. O_NOFOLLOW applies to the
      // final component, which the permission watcher also leaves in place.
      const next = openNoFollowDir(`/proc/self/fd/${fd}/${part}`);
      fs.closeSync(fd);
      fd = next;
    }
    return fd;
  } catch (err) {
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
    throw err;
  }
}

export function writeExclusiveIpcResult(
  tasksRoot: string,
  resultFilePath: string,
  contents: string,
): void {
  const destName = path.basename(path.resolve(resultFilePath));
  assertSafeComponent(destName);
  const parentFd = openRealResultParent(tasksRoot, resultFilePath);
  const tmpName = `.${destName}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const tmpPath = `/proc/self/fd/${parentFd}/${tmpName}`;
  try {
    fs.writeFileSync(tmpPath, contents, { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmpPath, `/proc/self/fd/${parentFd}/${destName}`);
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* already renamed or never created */
    }
    fs.closeSync(parentFd);
  }
}
