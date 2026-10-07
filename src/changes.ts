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
export const CHANGES_MAX = 5000;

const SOCKET_RE = /^\.claude-sandbox-vscode-\d+\.sock$/;

export type Entry = "file" | "dir" | "symlink" | "gone";

/** What is at `p` now, without following a symlink (lstat: metadata only, no content read). */
export async function entryKind(p: string): Promise<Entry> {
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
      return null;
    }
    const c: Change = { path, kind: k, reviewed: false, at: now, symlink: k !== "deleted" && symlink };
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
 * The list split by what git says now. `inGit(c)`: true when git shows the file changed
 * (working tree, index, untracked or a merge), false when it shows nothing (the file matches
 * HEAD again, or git ignores it: build output, `.pyc`), undefined outside any repository.
 * Only false goes to `quiet`, which the view folds into one collapsed group: still listed, so
 * a `.gitignore` the session edits cannot hide a file from the list, only fold it (and the
 * `.gitignore` itself is then a change).
 */
export function splitByGit(changes: readonly Change[], inGit: (c: Change) => boolean | undefined): { active: Change[]; quiet: Change[] } {
  const active: Change[] = [];
  const quiet: Change[] = [];
  for (const c of changes) (inGit(c) === false ? quiet : active).push(c);
  return { active, quiet };
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
export const REVIEW_TITLE = "Claude changes";

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
