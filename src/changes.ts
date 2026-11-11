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
    return byPath([...this.items.values()]);
  }

  /** All of them, in no order (the view sorts only the ones it shows). */
  all(): Change[] {
    return [...this.items.values()];
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

/** Sorts `changes` by path, in place. */
export function byPath(changes: Change[]): Change[] {
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** What the tree draws for the shown files (see drawn): a file's fields at one index of each. */
export interface Drawn {
  paths: string[];
  /** Kind, reviewed, symlink and in a repository, as one number. */
  bits: number[];
  roots: string[];
}

const KIND_BITS: Record<ChangeKind, number> = { created: 0, changed: 8, deleted: 16 };

/**
 * What the tree draws for these files: the view is redrawn only when it differs (sameDrawn)
 * from the last one drawn. A burst of watcher events for files the view does not show (an
 * install into an ignored folder) changes nothing in it. Every row comes from these fields
 * alone (a folder row's counts too: see folderIndex), so the same Drawn is the same tree,
 * whichever rows are expanded. The fields are kept and compared as they are, not hashed: no
 * two different trees compare the same.
 */
export function drawn(rows: readonly Change[], rootOf: (c: Change) => string, inRepo: (c: Change) => boolean): Drawn {
  const d: Drawn = { paths: [], bits: [], roots: [] };
  for (const c of rows) {
    d.paths.push(c.path);
    d.bits.push(KIND_BITS[c.kind] + (c.reviewed ? 4 : 0) + (c.symlink ? 2 : 0) + (inRepo(c) ? 1 : 0));
    d.roots.push(rootOf(c));
  }
  return d;
}

export function sameDrawn(a: Drawn | undefined, b: Drawn): boolean {
  if (a === undefined || a.paths.length !== b.paths.length) return false;
  for (let i = 0; i < a.paths.length; i++)
    if (a.bits[i] !== b.bits[i] || a.paths[i] !== b.paths[i] || a.roots[i] !== b.roots[i]) return false;
  return true;
}

/** Watcher events come in bursts (a checkout, an install): the view is refreshed at most this often. */
export const REFRESH_MS = 100;
/** A refresh waits this many times as long as the last one took, */
export const REFRESH_BACKOFF = 4;
/** but never longer than this. */
export const REFRESH_MAX_MS = 3000;

/**
 * How long the next refresh waits, given how long the last one took (ms, the tree's fetches
 * included): a refresh looks at every recorded file, so with tens of thousands the wait grows
 * with it and refreshing takes at most a fraction of the extension host's time.
 */
export function refreshDelay(lastMs: number): number {
  return Math.max(REFRESH_MS, Math.min(REFRESH_MAX_MS, Math.ceil(lastMs * REFRESH_BACKOFF)));
}

/**
 * The list split by what git says now. `inGit(c)`: true when git shows the file changed
 * (working tree, index, untracked, a merge, or a rename's old path), false when it shows
 * nothing (the file matches HEAD again, or git ignores it: build output, `.pyc`), undefined
 * outside any repository. The view shows `active` only, as Source Control does; so git state
 * the session controls (a commit, `.gitignore`, `.git/info/exclude`, skip-worktree) can take
 * a file out of the view, exactly as it takes it out of Source Control.
 */
export function splitByGit(
  changes: readonly Change[],
  inGit: (c: Change) => boolean | undefined,
): { active: Change[]; quiet: Change[] } {
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

/**
 * The most files a group lists flat. VS Code fetches every row of an expanded node at once and
 * each redraw sends them to the window: tens of thousands (an install into a folder that is in
 * no open repository, so nothing is ignored) stall it. A group with more is drawn as folder
 * rows (folderIndex). Also the most files Review All opens (reviewPick).
 */
export const VIEW_MAX = 1000;

/** A folder row of a group with more than VIEW_MAX files: the files under one directory. */
export interface ChangeFolder {
  /** Its group's root. */
  root: string;
  /** The directory's path. */
  dir: string;
  /** Its name. */
  name: string;
  /** How many files are under it, at any depth, and how many of those are not reviewed. */
  files: number;
  unreviewed: number;
}

/** The rows directly under one directory of a group drawn as folders. */
export interface FolderRows {
  folders: ChangeFolder[];
  files: Change[];
}

/**
 * A group drawn as folders, by directory (the group's root, and every directory under it
 * holding changed files): a folder row per sub-directory, by path, then the files directly in
 * it, by path. Every file of the group is under exactly one row at each level, so none is
 * hidden, and the view fetches a level only when its row is expanded. Built in one pass over
 * the group, once per redraw, so a level is a lookup. A row is one directory level: its
 * identity is its path, which no other file's coming or going changes, so an expanded row
 * stays expanded. A directory holding more than VIEW_MAX files directly lists them all when
 * expanded: the user asked for it. A file not under the group's root is listed at the root.
 */
export function folderIndex(changes: readonly Change[], root: string): Map<string, FolderRows> {
  const index = new Map<string, FolderRows>();
  const byDir = new Map<string, ChangeFolder>();
  const rows = (dir: string): FolderRows => {
    let r = index.get(dir);
    if (r === undefined) {
      r = { folders: [], files: [] };
      index.set(dir, r);
    }
    return r;
  };
  const top = rows(root);
  const prefix = root.endsWith("/") ? root : `${root}/`;
  // the last file's directory (with its "/"), its rows and the folder rows above it: files
  // come mostly a directory at a time, and the next one in it needs no walk
  let last = "";
  let lastRows = top;
  let above: ChangeFolder[] = [];
  // files of that directory not yet counted in the rows above it, and the unreviewed of them
  let n = 0;
  let open = 0;
  const count = (): void => {
    for (const f of above) {
      f.files += n;
      f.unreviewed += open;
    }
    n = 0;
    open = 0;
  };
  for (const c of changes) {
    if (!c.path.startsWith(prefix)) {
      top.files.push(c);
      continue;
    }
    if (last === "" || !c.path.startsWith(last) || c.path.indexOf("/", last.length) >= 0) {
      count();
      lastRows = top;
      above = [];
      let from = prefix.length;
      for (let end = c.path.indexOf("/", from); end >= 0; end = c.path.indexOf("/", from)) {
        const dir = c.path.slice(0, end);
        let f = byDir.get(dir);
        if (f === undefined) {
          f = { root, dir, name: c.path.slice(from, end), files: 0, unreviewed: 0 };
          byDir.set(dir, f);
          lastRows.folders.push(f);
        }
        above.push(f);
        lastRows = rows(dir);
        from = end + 1;
      }
      last = c.path.slice(0, from);
    }
    n++;
    if (!c.reviewed) open++;
    lastRows.files.push(c);
  }
  count();
  for (const r of index.values()) {
    r.folders.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
    byPath(r.files);
  }
  return index;
}

/**
 * The files a context-menu command acts on: VS Code passes the row right-clicked and the rows
 * selected. The selection when it holds that row (a right-click elsewhere acts on that row
 * alone), files only (a repository or folder row in the selection is not all of its files).
 */
export function picked<T, F extends T>(
  clicked: T | undefined,
  selected: readonly T[] | undefined,
  isFile: (n: T) => n is F,
): F[] {
  if (clicked === undefined) return [];
  const rows = selected?.includes(clicked) ? selected : [clicked];
  return rows.filter(isFile);
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
export function reviewPlan(
  changes: readonly Change[],
  inHead: (c: Change) => boolean,
): { rows: ReviewRow[]; symlinks: number; title: string } {
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

/**
 * The files Review All opens when there are more than `max` (VS Code's multi-file diff editor
 * cannot take tens of thousands), and how many are left out. By `rank`, then by path: files
 * HEAD has (0: a tracked file changed or deleted), then files in a repository that HEAD lacks
 * (1: untracked or added), then files outside any repository (2). So neither an install into
 * a folder no repository covers, nor a thousand new files in a repository, crowds out an edit
 * to a tracked file. The ones taken are returned by path.
 */
export function reviewPick(
  shown: readonly Change[],
  rank: (c: Change) => number,
  max: number,
): { files: Change[]; left: number } {
  if (shown.length <= max) return { files: byPath([...shown]), left: 0 };
  const ranked = shown.map((c) => ({ c, r: rank(c) }));
  ranked.sort((a, b) => a.r - b.r || (a.c.path < b.c.path ? -1 : a.c.path > b.c.path ? 1 : 0));
  return { files: byPath(ranked.slice(0, max).map((x) => x.c)), left: shown.length - max };
}

/** autoOpenDiffs: a changed file's diff opens once the file has been still for this long. */
export const AUTO_OPEN_MS = 400;
/** More files than this waiting for their diff at once is a burst (an install, a checkout). */
export const AUTO_OPEN_MAX = 10;
/** A burst is over this long after changes last came at a burst's pace. */
export const AUTO_QUIET_MS = 2000;

/**
 * autoOpenDiffs' guard: a diff for every changed file would open thousands during an install,
 * so while many files change at once none is opened. A burst starts when more than
 * AUTO_OPEN_MAX files wait for their diff, and lasts until AUTO_QUIET_MS after the last
 * AUTO_OPEN_MS in which more than AUTO_OPEN_MAX changes came; an edit every second or so
 * during its last moments is skipped but does not prolong it.
 */
export class AutoOpenGuard {
  private until = Number.NEGATIVE_INFINITY;
  private windowAt = Number.NEGATIVE_INFINITY;
  private windowChanges = 0;

  /**
   * For a file that just changed, with `waiting` files waiting for their diff (this one
   * included): "open" its diff after the usual wait; "burst": a burst starts, so the waiting
   * diffs are cancelled as well; "skip": one is under way.
   */
  next(waiting: number, now: number): "open" | "burst" | "skip" {
    if (now < this.until) {
      if (now - this.windowAt >= AUTO_OPEN_MS) {
        this.windowAt = now;
        this.windowChanges = 0;
      }
      if (++this.windowChanges > AUTO_OPEN_MAX) this.until = now + AUTO_QUIET_MS;
      return "skip";
    }
    if (waiting <= AUTO_OPEN_MAX) return "open";
    this.until = now + AUTO_QUIET_MS;
    this.windowAt = now;
    this.windowChanges = 0;
    return "burst";
  }
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
