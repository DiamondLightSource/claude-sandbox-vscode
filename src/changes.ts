// The "Changed this session" list (no vscode import): which workspace files changed while the
// linked session ran, from VS Code's file watcher events, and which the user has marked as
// reviewed. Paths only: nothing here, or in the view, reads or writes a file's contents
// (VS Code's diff editor does the reading). Changes the user's own saves cause are skipped,
// and so are .git (any path segment) and our sockets. Nothing else is filtered, and no pattern
// from settings is read: files.watcherExclude is a workspace setting the jail can write (VS
// Code's watcher already applies it; compiling it again here only added a ReDoS and a way to
// hide files from this list).

import { promises as fsp } from "node:fs";

export type ChangeKind = "created" | "changed" | "deleted";

export interface Change {
  path: string;
  kind: ChangeKind;
  reviewed: boolean;
  /** When it last changed (ms). */
  at: number;
  /** A symlink when last seen (lstat): listed, never opened. */
  symlink: boolean;
}

/** A save by the user counts as theirs for this long after it. */
export const SAVE_WINDOW_MS = 2000;
/**
 * The most files the list records: an install rewrites thousands (`npm ci`: ~8,500 under
 * node_modules), so this is well above that; a full list first forgets what the view does not
 * show (see ChangeSet.prune).
 */
export const CHANGES_MAX = 50_000;

const SOCKET_RE = /^\.claude-sandbox-vscode-\d+\.sock$/;

export type EntryKind = "file" | "dir" | "symlink" | "gone";

/** What is at `p` now, without following a symlink (lstat: metadata only, no content read). */
export async function entryKind(p: string): Promise<EntryKind> {
  try {
    const st = await fsp.lstat(p);
    return st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : "file";
  } catch {
    return "gone";
  }
}

export interface ChangeSetOptions {
  roots: readonly string[];
  saveWindowMs?: number;
}

export class ChangeSet {
  private readonly roots: string[];
  private readonly saveWindow: number;
  private readonly items = new Map<string, Change>();
  private readonly saves = new Map<string, number>();

  constructor(o: ChangeSetOptions) {
    this.roots = o.roots.map((r) => r.replace(/\/+$/, "") || "/");
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
    return !SOCKET_RE.test(parts[parts.length - 1]!);
  }

  /** A watcher event. The changed entry, or null when it is ignored. */
  event(kind: ChangeKind, path: string, now: number, symlink = false): Change | null {
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
      this.dropped++;
      return null;
    }
    const c: Change = { path, kind: k, reviewed: false, at: now, symlink: k !== "deleted" && symlink };
    this.items.set(path, c);
    return c;
  }

  get(path: string): Change | undefined {
    return this.items.get(path);
  }

  /** New paths not recorded because the list was full (CHANGES_MAX). */
  dropped = 0;

  /**
   * Makes room: forgets the entries `keep` rejects that last changed before `before` (ms).
   * The view keeps what it shows (what git shows changed) and forgets the rest, e.g. an
   * `npm ci`'s thousands of ignored `node_modules` files, so they cannot fill the list and
   * crowd out real changes; a forgotten file comes back if it changes again. How many went.
   */
  prune(keep: (c: Change) => boolean, before: number): number {
    let n = 0;
    for (const [p, ch] of this.items) {
      if (ch.at < before && !keep(ch)) {
        this.items.delete(p);
        n++;
      }
    }
    return n;
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
 * The list split by what git says now. `inGit(c)`: true when git shows the file changed
 * (working tree, index, untracked, a merge, or a rename's old path), false when it shows
 * nothing (the file matches HEAD again, or git ignores it: build output, `.pyc`), undefined
 * outside any repository. The view shows `active` only, as Source Control does; so git state
 * the session controls (a commit, `.gitignore`, `.git/info/exclude`, skip-worktree) can take
 * a file out of the view, exactly as it takes it out of Source Control.
 */
export function splitByGit(changes: readonly Change[], inGit: (c: Change) => boolean | undefined): { active: Change[]; quiet: Change[] } {
  const active: Change[] = [];
  const quiet: Change[] = [];
  for (const c of changes) (inGit(c) === false ? quiet : active).push(c);
  return { active, quiet };
}

/** The files of one repository (or, outside any, one workspace folder) in the view. */
export interface ChangeGroup {
  /** The repository's root, or the folder's path. */
  root: string;
  changes: Change[];
}

/**
 * The view's files grouped by `rootOf` (a file's repository root, else its workspace folder),
 * as Source Control groups by repository: groups by root, files in their list order.
 */
export function groupByRoot(changes: readonly Change[], rootOf: (c: Change) => string): ChangeGroup[] {
  const groups = new Map<string, Change[]>();
  for (const c of changes) {
    const r = rootOf(c);
    const g = groups.get(r);
    if (g === undefined) groups.set(r, [c]);
    else g.push(c);
  }
  return [...groups].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([root, cs]) => ({ root, changes: cs }));
}

/** One file of "Review All": its HEAD side (or none: new, or no repository), its current side (none: deleted). */
export interface ReviewRow {
  path: string;
  head: boolean;
  now: boolean;
}

/**
 * Review All's title. VS Code's multi-file diff editor adds the count to it for the tab's label
 * (MultiDiffEditorInput: "Claude changes (3 files)"), and shows the bare title until the
 * resources resolve.
 */
const REVIEW_TITLE = "Claude changes";

/**
 * "Review All" (VS Code's multi-file diff editor, vscode.changes): a row per listed file,
 * symlinks left out (never opened), a deleted file only when HEAD has it (else there is
 * nothing to show). `inHead` says whether HEAD has the file (false outside a repository).
 */
export function reviewPlan(changes: readonly Change[], inHead: (c: Change) => boolean): { rows: ReviewRow[]; symlinks: number; title: string } {
  const rows: ReviewRow[] = [];
  let symlinks = 0;
  for (const c of changes) {
    if (c.symlink) {
      symlinks++;
      continue;
    }
    const head = inHead(c);
    if (c.kind === "deleted") {
      if (head) rows.push({ path: c.path, head: true, now: false });
    } else rows.push({ path: c.path, head, now: true });
  }
  return { rows, symlinks, title: REVIEW_TITLE };
}

/** Whether a tab's label is Review All's: its title, then VS Code's " (N files)" (localised). */
export function isReviewTitle(label: string): boolean {
  return label === REVIEW_TITLE || label.startsWith(`${REVIEW_TITLE} (`);
}

/**
 * Re-reads each repository's git status once before a diff is built: the Git extension's status
 * lags the file watcher, so a file just made would not be untracked yet and would be diffed
 * against a HEAD that lacks it. A failure keeps the status it had.
 */
export async function freshStatus(repos: readonly ({ status(): Promise<void> } | null)[]): Promise<void> {
  const unique = [...new Set(repos)].filter((r) => r !== null);
  await Promise.all(unique.map((r) => r.status().catch(() => undefined)));
}
