// Directory-relative file operations without following symlinks.
//
// Node has no openat(2). On Linux, /proc/self/fd/<fd>/<name> resolves through the open
// directory itself (the magic link is the directory we opened, not a path looked up again),
// so it does what openat(fd, name) does. Every name passed here is one path component, and
// the final component is opened with O_NOFOLLOW: a symlink there is refused (ELOOP).
//
// The jail can write the workspace, so it can swap a file or a folder
// for a symlink at any moment; walking one component at a time from an open directory is
// what makes such a swap harmless. Without /proc (not Linux) the link is unavailable.

import * as fs from "node:fs";

const C = fs.constants;
export const O_NOFOLLOW = C.O_NOFOLLOW ?? 0;
const O_DIRECTORY = C.O_DIRECTORY ?? 0;
export const O_NONBLOCK = C.O_NONBLOCK ?? 0;

/** Whether this platform has what the safe file operations need. */
export function supported(): boolean {
  if (process.platform !== "linux" || !O_NOFOLLOW || !O_DIRECTORY) return false;
  try {
    return fs.statSync("/proc/self/fd").isDirectory();
  } catch {
    return false;
  }
}

/** One path component: no separator, not empty, not . or .., no NUL. */
export function isName(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\0");
}

function at(dirFd: number, name: string): string {
  if (!isName(name)) throw Object.assign(new Error(`not a single name: ${JSON.stringify(name)}`), { code: "EINVAL" });
  return `/proc/self/fd/${dirFd}/${name}`;
}

/** Open directory `path` (an absolute path whose last component must not be a symlink). */
export function openDir(path: string): number {
  return fs.openSync(path, C.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
}

/** Open sub-directory `name` of `dirFd`, refusing a symlink. */
export function openDirAt(dirFd: number, name: string): number {
  return fs.openSync(at(dirFd, name), C.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
}

/** Open `name` in `dirFd` read-only (O_NOFOLLOW and O_NONBLOCK always added: a FIFO never blocks). */
export function openReadAt(dirFd: number, name: string): number {
  return fs.openSync(at(dirFd, name), fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
}

/** The path the kernel holds for open fd `fd` (what it really is, after any swap). */
export function fdPath(fd: number): string {
  return fs.readlinkSync(`/proc/self/fd/${fd}`);
}

export function closeQuietly(fd: number | undefined): void {
  if (fd === undefined) return;
  try {
    fs.closeSync(fd);
  } catch {
    // already closed
  }
}

/** Read up to `max` bytes from `fd`; null if it holds more. */
export function readCapped(fd: number, max: number): Buffer | null {
  const chunks: Buffer[] = [];
  let total = 0;
  const buf = Buffer.alloc(64 * 1024);
  for (;;) {
    const n = fs.readSync(fd, buf, 0, buf.length, null);
    if (n === 0) break;
    total += n;
    if (total > max) return null;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks, total);
}
