import { spawnSync } from 'node:child_process';
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

/** Directory fd for the Linux result parent, pinned before any write. */
function openRealResultParent(rootFd: number, parts: string[]): number {
  let fd = rootFd;
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

// Node exposes no openat/renameat API on macOS, and /dev/fd/N/child is not
// openat. Python's standard library calls the native *at syscalls instead.
// Pass the already pinned root as fd 3, never reopen a caller-controlled path.
const DARWIN_ROOTED_WRITER = String.raw`
import errno, json, os, sys

request = json.load(sys.stdin)
fd = 3
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
if not all(op in os.supports_dir_fd for op in (os.open, os.rename, os.unlink)):
    sys.stderr.write("Native dir_fd IPC writes are unavailable")
    sys.exit(1)
if not all(hasattr(os, key) for key in ("O_DIRECTORY", "O_NOFOLLOW")):
    sys.stderr.write("Native no-follow directory opens are unavailable")
    sys.exit(1)

tmp_created = False
try:
    for part in request["parts"]:
        next_fd = os.open(part, flags, dir_fd=fd)
        os.close(fd)
        fd = next_fd
    tmp_fd = os.open(request["tmp"], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=fd)
    tmp_created = True
    with os.fdopen(tmp_fd, "wb") as output:
        output.write(request["contents"].encode("utf-8"))
    os.rename(request["tmp"], request["dest"], src_dir_fd=fd, dst_dir_fd=fd)
    tmp_created = False
except OSError as error:
    if error.errno in (errno.ELOOP, errno.ENOTDIR, errno.EPERM):
        sys.stderr.write("Refusing IPC result write through a symlinked directory")
    else:
        sys.stderr.write("Native IPC result write failed (errno %s)" % error.errno)
    sys.exit(1)
finally:
    if tmp_created:
        try:
            os.unlink(request["tmp"], dir_fd=fd)
        except FileNotFoundError:
            pass
    os.close(fd)
`;

export function writeExclusiveIpcResult(
  tasksRoot: string,
  resultFilePath: string,
  contents: string,
): void {
  const root = path.resolve(tasksRoot);
  const destination = path.resolve(resultFilePath);
  const parent = path.dirname(destination);
  if (parent !== root && !parent.startsWith(`${root}${path.sep}`)) {
    throw new IpcResultWriteError('IPC result path escapes tasks root');
  }
  const relative = path.relative(root, parent);
  const parts = relative === '' ? [] : relative.split(path.sep);
  for (const part of parts) assertSafeComponent(part);
  const destName = path.basename(destination);
  assertSafeComponent(destName);
  const tmpName = `.${destName}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const rootFd = openNoFollowDir(root);

  if (process.platform === 'darwin') {
    try {
      const result = spawnSync(
        '/usr/bin/python3',
        ['-I', '-S', '-c', DARWIN_ROOTED_WRITER],
        {
          input: JSON.stringify({
            parts,
            dest: destName,
            tmp: tmpName,
            contents,
          }),
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe', rootFd],
          timeout: 5000,
          maxBuffer: 64 * 1024,
        },
      );
      if (result.error || result.status !== 0) {
        throw new IpcResultWriteError(
          result.stderr?.trim() ||
            'Native macOS IPC result writer is unavailable',
          result.error,
        );
      }
    } finally {
      fs.closeSync(rootFd);
    }
    return;
  }

  if (process.platform !== 'linux') {
    fs.closeSync(rootFd);
    throw new IpcResultWriteError(
      'Rooted IPC result writes require Linux or macOS',
    );
  }
  const parentFd = openRealResultParent(rootFd, parts);
  const tmpPath = `/proc/self/fd/${parentFd}/${tmpName}`;
  let tempFd: number | undefined;
  let tempCreated = false;
  try {
    tempFd = fs.openSync(tmpPath, 'wx', 0o600);
    tempCreated = true;
    fs.writeFileSync(tempFd, contents);
    fs.closeSync(tempFd);
    tempFd = undefined;
    fs.renameSync(tmpPath, `/proc/self/fd/${parentFd}/${destName}`);
    tempCreated = false;
  } finally {
    try {
      if (tempFd !== undefined) fs.closeSync(tempFd);
      if (tempCreated) fs.unlinkSync(tmpPath);
    } finally {
      fs.closeSync(parentFd);
    }
  }
}
