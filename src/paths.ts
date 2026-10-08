// Path policy (trust boundary rules 2, 4 and 5). Every path Claude names is resolved to its
// real path and must be inside a workspace folder (not the folder itself) and, for files we
// read, not inside .git. Files are read one component at a time from the workspace folder's
// open directory, never following a symlink (dirfd.ts), so a symlink swapped in after the
// check, at the file or at any folder above it, is refused; and the opened file's real path
// (as the kernel holds it) is checked again after opening.

import * as fs from "node:fs";
import * as path from "node:path";
import * as dirfd from "./dirfd.ts";

/** The largest file openDiff reads (the message cap; a larger file cannot come back anyway). */
const TEXT_MAX = 16 * 1024 * 1024;

export type Resolved = { ok: true; real: string; folder: string } | { ok: false; why: string };

export type ReadResult =
  | { kind: "text"; text: string; exists: true }
  | { kind: "missing"; text: ""; exists: false }
  | { kind: "refused"; why: string };

/** Test seam: called after the policy check, just before the file is opened. */
export interface ReadHooks {
  beforeOpen?: () => void;
}

/** Whether `p` is `folder` or inside it (both absolute and normalised). */
export function isInside(p: string, folder: string): boolean {
  const f = folder.endsWith(path.sep) ? folder : folder + path.sep;
  return p === folder || p.startsWith(f);
}

/**
 * The real path of `p`, which need not exist: the deepest existing ancestor resolved, the
 * rest appended (as Python's os.path.realpath). Throws on a symlink loop or a bad path.
 */
export function realpathLoose(p: string): string {
  let cur = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
      const parent = path.dirname(cur);
      if (parent === cur) throw err;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

export function hasGitPart(rel: string): boolean {
  return rel.split(path.sep).some((part) => part.toLowerCase() === ".git");
}

export class Workspace {
  /** Real paths of the workspace folders. */
  readonly folders: readonly string[];

  constructor(folders: readonly string[]) {
    this.folders = folders.map((f) => fs.realpathSync.native(f));
  }

  static resolvable(folder: string): boolean {
    try {
      fs.realpathSync.native(folder);
      return true;
    } catch {
      return false;
    }
  }

  /** Resolve a path from the jail: absolute, its real path inside a folder, not a folder. */
  resolve(p: unknown, opts: { allowGit?: boolean } = {}): Resolved {
    if (typeof p !== "string" || p === "" || p.includes("\0")) return { ok: false, why: "not a path" };
    if (!path.isAbsolute(p)) return { ok: false, why: "not an absolute path" };
    let real: string;
    try {
      real = realpathLoose(p);
    } catch {
      return { ok: false, why: "cannot resolve that path" };
    }
    const folder = this.folders.find((f) => isInside(real, f) && real !== f);
    if (folder === undefined) return { ok: false, why: "outside the workspace folders" };
    if (!opts.allowGit && hasGitPart(path.relative(folder, real))) return { ok: false, why: "inside .git" };
    return { ok: true, real, folder };
  }

  /** resolve() for a file:// URI. */
  resolveUri(uri: unknown, opts: { allowGit?: boolean } = {}): Resolved {
    if (typeof uri !== "string") return { ok: false, why: "not a URI" };
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      return { ok: false, why: "not a URI" };
    }
    if (url.protocol !== "file:" || (url.host !== "" && url.host !== "localhost")) {
      return { ok: false, why: "not a local file URI" };
    }
    let p: string;
    try {
      p = decodeURIComponent(url.pathname);
    } catch {
      return { ok: false, why: "not a URI" };
    }
    return this.resolve(p, opts);
  }

  /**
   * Read text file `real` (a resolved real path inside `folder`) without following any
   * symlink: one name at a time from the folder, O_NOFOLLOW, regular files only, and the
   * opened file's real path checked again. Nothing is read when any check fails.
   */
  readInside(real: string, folder: string, hooks: ReadHooks = {}): ReadResult {
    if (!this.folders.includes(folder) || !isInside(real, folder) || real === folder) {
      return { kind: "refused", why: "outside the workspace folders" };
    }
    const rel = path.relative(folder, real);
    if (hasGitPart(rel)) return { kind: "refused", why: "inside .git" };
    const parts = rel.split(path.sep);
    if (parts.some((n) => !dirfd.isName(n))) return { kind: "refused", why: "not a plain path" };
    hooks.beforeOpen?.();
    let dir: number | undefined;
    let file: number | undefined;
    try {
      try {
        dir = dirfd.openDir(folder);
        for (const name of parts.slice(0, -1)) {
          const sub = dirfd.openDirAt(dir, name);
          dirfd.closeQuietly(dir);
          dir = sub;
        }
        file = dirfd.openReadAt(dir, parts[parts.length - 1]!);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing", text: "", exists: false };
        return { kind: "refused", why: "a symlink or not a plain file" };
      }
      const st = fs.fstatSync(file);
      if (!st.isFile()) return { kind: "refused", why: "not a regular file" };
      // defence in depth: where the kernel says the opened file really is
      const where = dirfd.fdPath(file);
      if (where !== real || !isInside(where, folder) || hasGitPart(path.relative(folder, where))) {
        return { kind: "refused", why: "the file moved while it was opened" };
      }
      if (st.size > TEXT_MAX) return { kind: "refused", why: "too large" };
      const data = dirfd.readCapped(file, TEXT_MAX);
      if (data === null) return { kind: "refused", why: "too large" };
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
      } catch {
        return { kind: "refused", why: "not a text file" };
      }
      if (text.includes("\0")) return { kind: "refused", why: "not a text file" };
      return { kind: "text", text, exists: true };
    } finally {
      dirfd.closeQuietly(file);
      dirfd.closeQuietly(dir);
    }
  }
}
