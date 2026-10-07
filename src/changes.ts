// The "Changed this session" list (no vscode import): which workspace files changed while the
// linked session ran, from VS Code's file watcher events, and which the user has marked as
// reviewed. Paths only: nothing here, or in the view, reads or writes a file's contents
// (VS Code's diff editor does the reading). Changes the user's own saves cause are skipped,
// and so are .git, our sockets and what files.watcherExclude excludes.

export type ChangeKind = "created" | "changed" | "deleted";

export interface Change {
  path: string;
  kind: ChangeKind;
  reviewed: boolean;
  /** When it last changed (ms). */
  at: number;
}

/** A save by the user counts as theirs for this long after it. */
export const SAVE_WINDOW_MS = 2000;
export const CHANGES_MAX = 5000;

const SOCKET_RE = /^\.claude-sandbox-vscode-\d+\.sock$/;

export interface ChangeSetOptions {
  roots: readonly string[];
  /** files.watcherExclude patterns that are on (relative to a root, or absolute). */
  exclude?: readonly string[];
  saveWindowMs?: number;
}

export class ChangeSet {
  private readonly roots: string[];
  private readonly exclude: RegExp[];
  private readonly saveWindow: number;
  private readonly items = new Map<string, Change>();
  private readonly saves = new Map<string, number>();

  constructor(o: ChangeSetOptions) {
    this.roots = o.roots.map((r) => r.replace(/\/+$/, "") || "/");
    this.exclude = (o.exclude ?? []).map(globToRegExp);
    this.saveWindow = o.saveWindowMs ?? SAVE_WINDOW_MS;
  }

  /** The user is saving (or has saved) this file: its watcher events are theirs. */
  userSaved(path: string, now: number): void {
    this.saves.set(path, now);
  }

  /** The workspace folder `path` is in, and its path relative to it; null outside them all. */
  private relative(path: string): string | null {
    for (const r of this.roots) {
      if (path.startsWith(r === "/" ? "/" : r + "/")) return path.slice(r === "/" ? 1 : r.length + 1);
    }
    return null;
  }

  /** Whether a watcher event for `path` belongs in the list at all. */
  wanted(path: string): boolean {
    const rel = this.relative(path);
    if (rel === null || rel === "") return false;
    const parts = rel.split("/");
    if (parts.includes(".git")) return false;
    if (SOCKET_RE.test(parts[parts.length - 1]!)) return false;
    return !this.exclude.some((re) => re.test(rel) || re.test(path));
  }

  /** A watcher event. The changed entry, or null when it is ignored. */
  event(kind: ChangeKind, path: string, now: number): Change | null {
    if (!this.wanted(path)) return null;
    const saved = this.saves.get(path);
    if (saved !== undefined && now - saved <= this.saveWindow && kind !== "deleted") return null;
    const before = this.items.get(path);
    let k = kind;
    if (before !== undefined) {
      if (before.kind === "created" && kind === "changed") k = "created";
      else if (before.kind === "created" && kind === "deleted") {
        // made and gone again this session
        this.items.delete(path);
        return null;
      } else if (before.kind === "deleted" && kind === "created") k = "changed";
    } else if (this.items.size >= CHANGES_MAX) {
      return null;
    }
    const c: Change = { path, kind: k, reviewed: false, at: now };
    this.items.set(path, c);
    return c;
  }

  get(path: string): Change | undefined {
    return this.items.get(path);
  }

  markReviewed(path: string, reviewed = true): boolean {
    const c = this.items.get(path);
    if (c === undefined || c.reviewed === reviewed) return false;
    c.reviewed = reviewed;
    return true;
  }

  /** All of them, by path. */
  list(): Change[] {
    return [...this.items.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  get size(): number {
    return this.items.size;
  }

  get unreviewed(): number {
    let n = 0;
    for (const c of this.items.values()) if (!c.reviewed) n++;
    return n;
  }

  clear(): void {
    this.items.clear();
    this.saves.clear();
  }
}

/**
 * A VS Code glob (`**`, `*`, `?`, `{a,b}`, `[...]`) as a RegExp over a whole path. A pattern
 * matches a folder's contents too (`**\/node_modules` excludes what is in it).
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  let depth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:[^/]*/)*";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      depth++;
      re += "(?:";
    } else if (c === "}" && depth > 0) {
      depth--;
      re += ")";
    } else if (c === "," && depth > 0) re += "|";
    else if (c === "[") {
      const j = glob.indexOf("]", i + 1);
      if (j < 0) re += "\\[";
      else {
        const body = glob.slice(i + 1, j).replace(/\\/g, "\\\\");
        re += "[" + (body.startsWith("!") ? "^" + body.slice(1) : body) + "]";
        i = j;
      }
    } else re += c.replace(/[.+^$()|\\\]]/g, "\\$&");
  }
  while (depth-- > 0) re += ")";
  return new RegExp("^" + re + "(?:/.*)?$");
}
