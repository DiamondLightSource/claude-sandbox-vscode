// The "Changed this session" view: workspace files that changed while the linked session ran
// (src/changes.ts), from VS Code's file watcher. A click opens VS Code's diff against HEAD through
// the built-in Git extension's API (it reads the files, and runs git; the extension runs no git
// of its own and reads no file contents). The context menu's Stage and Revert to HEAD (and the
// title bar's Revert All) are the Git extension's too: its repositories' add, and reset then
// clean, the code behind Source Control's Stage, Unstage and Discard; the extension itself
// writes nothing.
//
// Each path is lstat-ed (metadata only, never followed): a folder is not listed, and a symlink
// is listed as one but never opened, so a link the jail planted to a file outside the workspace
// is not shown in a diff. "Review All" opens the listed files (at most VIEW_MAX: see reviewPick)
// in VS Code's multi-file diff editor (vscode.changes), symlinks left out the same way, in place
// of one already open. Next and
// Previous Change step through that editor's changes (VS Code's own commands, which go on into the
// next file), opening it first when it is not the active editor.

import * as path from "node:path";
import * as vscode from "vscode";
import {
  AUTO_OPEN_MS,
  AutoOpenGuard,
  byPath,
  CHANGES_MAX,
  type Change,
  type ChangeFolder,
  type ChangeGroup,
  type ChangeRange,
  ChangeSet,
  type Drawn,
  drawn,
  type EntryKind,
  entryKind as entry,
  type FolderRows,
  folderIndex,
  freshStatus as fresh,
  groupByRoot,
  groupRows,
  groupsCollapsed,
  isReviewTitle,
  levelRows,
  picked,
  refreshDelay,
  refreshWait,
  reviewPick,
  reviewPlan,
  sameDrawn,
  splitByGit,
  VIEW_MAX,
} from "../changes.ts";

/**
 * A row of the view: a file, a repository (when the files span several), or, in a group of
 * more than VIEW_MAX files, a folder or a range of a level's rows (also a range of the
 * repository rows, when there are more than VIEW_MAX). No fetch (getChildren) returns more
 * than VIEW_MAX rows, and with no row expanded by the user a redraw sends at most VIEW_MAX
 * rows to the window (see groupsCollapsed). The rows the user expanded are fetched again on
 * a redraw, each fetch within that limit, at the pace of refreshDelay.
 */
type Node = Change | ChangeGroup | ChangeFolder | ChangeRange;
const isFile = (n: Node): n is Change => "path" in n;
const isFolder = (n: Node): n is ChangeFolder => "name" in n;
const isRange = (n: Node): n is ChangeRange => "range" in n;
/** The files a context-menu command acts on (see picked). */
const files = (clicked?: Node, selected?: Node[]): Change[] => picked(clicked, selected, isFile);

const EMPTY_SCHEME = "claude-sandbox-empty";
/** VS Code's (1.106+) next and previous change in the active multi-file diff editor. */
const STEP = { next: "multiDiffEditor.goToNextChange", previous: "multiDiffEditor.goToPreviousChange" } as const;
/**
 * A full list makes room by forgetting files the view does not show (git shows no change)
 * that are at least this old, so git has had time to report a new file; at most once per
 * this long, since a burst of thousands of events would otherwise each scan the list.
 */
const PRUNE_AGE_MS = 5000;
const PRUNE_EVERY_MS = 1000;

// The parts of the Git extension's API (vscode.git, getAPI(1)) used here.
interface GitChange {
  readonly uri: vscode.Uri;
  /** A rename's old path. */
  readonly originalUri?: vscode.Uri;
  readonly status: number;
}
interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: {
    readonly workingTreeChanges: readonly GitChange[];
    readonly indexChanges: readonly GitChange[];
    readonly untrackedChanges?: readonly GitChange[];
    readonly mergeChanges?: readonly GitChange[];
    /** Its submodules, each by its path within the repository. */
    readonly submodules?: readonly { readonly path: string }[];
    readonly onDidChange: vscode.Event<void>;
  };
  /** Re-reads git's status (the Git extension runs git; we do not). */
  status(): Promise<void>;
  /** Source Control's Stage: git add. */
  add(paths: string[]): Promise<void>;
  /** Source Control's Unstage: git reset HEAD -- paths. */
  revert(paths: string[]): Promise<void>;
  /**
   * Source Control's Discard, without its prompt: a tracked file is checked out from the index,
   * an untracked one deleted (to the trash where VS Code can); a path git shows no working-tree
   * change for is skipped.
   */
  clean(paths: string[]): Promise<void>;
}
interface GitApi {
  readonly onDidOpenRepository: vscode.Event<unknown>;
  readonly onDidCloseRepository: vscode.Event<unknown>;
  getRepository(uri: vscode.Uri): GitRepository | null;
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
}
// Status values for a file HEAD does not have
const INDEX_ADDED = 1;
const INDEX_RENAMED = 3;
const INDEX_COPIED = 4;
const UNTRACKED = 7;
const INTENT_TO_ADD = 9;
const NEW = [UNTRACKED, INDEX_ADDED, INTENT_TO_ADD];
/** The most paths a cache of roots holds: past it the cache is emptied, and filled again as files are looked at. */
const ROOTS_MAX = 2 * CHANGES_MAX;

/** An empty document: the missing side of a diff. */
function empty(uri: vscode.Uri): vscode.Uri {
  return vscode.Uri.from({ scheme: EMPTY_SCHEME, path: uri.path });
}

async function gitApi(): Promise<GitApi | null> {
  const ext = vscode.extensions.getExtension<{ getAPI(v: 1): GitApi }>("vscode.git");
  if (ext === undefined) return null;
  try {
    const exports = ext.isActive ? ext.exports : await ext.activate();
    return exports.getAPI(1);
  } catch {
    return null;
  }
}

/** A repository's submodule paths, as one string. */
function submodules(repo: GitRepository): string {
  return (repo.state.submodules ?? []).map((s) => s.path).join("\0");
}

export class ChangesView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private set: ChangeSet = new ChangeSet({ roots: [] });
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly view: vscode.TreeView<Node>;
  /** The Git extension's API once loaded. */
  private git: GitApi | null = null;
  /**
   * The Git extension's repository opened and closed events, listened to from the first time
   * its API loads until dispose(): each drops the followed repositories and the cached roots.
   */
  private gitSubs: vscode.Disposable[] | undefined;
  /**
   * The repositories whose status we follow, by root (getRepository returns a new wrapper
   * object on every call, so not by object).
   */
  private readonly repos = new Map<string, { repo: GitRepository; sub: vscode.Disposable }>();
  /**
   * Each recorded file's repository root (null: in none), asked of the Git extension once: its
   * lookup walks the open repositories and their submodules, too slow to repeat for every file
   * on every redraw. Emptied when a repository opens or closes, or a followed repository's
   * submodules change (a path under a submodule is not its parent's). A submodule of a
   * repository not yet followed is seen at the next of those. A path's entry goes when its
   * record leaves the list, and the whole cache when it holds more than twice CHANGES_MAX.
   */
  private readonly repoRoot = new Map<string, string | null>();
  /**
   * The workspace folder (else its own folder) of each recorded file in no repository, asked
   * of VS Code once. Emptied with repoRoot, and when the workspace folders change.
   */
  private readonly folderRoot = new Map<string, string>();
  /** What the tree last drew (see drawn), and the badge's count. */
  private drawn: Drawn | undefined;
  private badged = -1;
  /**
   * What the view shows, its groups, a large group's folder rows by directory, and each file's
   * group root, worked out once per redraw.
   */
  private shownCache: Change[] | undefined;
  private groupCache: Map<string, ChangeGroup> | undefined;
  private readonly indexCache = new Map<string, Map<string, FolderRows>>();
  private readonly rootOf = new Map<string, string>();
  /** Shown files in a repository (Stage and Revert are offered for these). */
  private readonly inRepo = new Set<string>();
  private readonly subs: vscode.Disposable[] = [];
  private watching: vscode.Disposable[] = [];
  private readonly autoTimers = new Map<string, NodeJS.Timeout>();
  private autoGuard = new AutoOpenGuard();
  private refreshTimer: NodeJS.Timeout | undefined;
  /**
   * When the last refresh ended, how long it took, and how long getChildren has taken since it
   * began (the tree's fetches after a redraw, and the user's expanding rows), in ms: the next
   * timed refresh waits until refreshDelay of the two times together after the last one ended
   * (refreshWait).
   */
  private refreshedAt = 0;
  private refreshCost = 0;
  private fetchCost = 0;
  private disposed = false;
  /** Which session's list this is: one more at each start(). */
  private session = 0;
  /** The claudeSandbox.reviewing context key's value. */
  private reviewingNow = false;
  /** VS Code has the STEP commands (1.106+): until then F8 is left to its problems. */
  private canStep = false;
  /** The count changed (status bar). */
  onCount: (unreviewed: number) => void = () => undefined;

  constructor() {
    this.view = vscode.window.createTreeView("claudeSandbox.changes", {
      treeDataProvider: this,
      showCollapseAll: false,
      canSelectMany: true,
    });
    this.subs.push(
      this.view,
      this.emitter,
      vscode.workspace.registerTextDocumentContentProvider(EMPTY_SCHEME, { provideTextDocumentContent: () => "" }),
      vscode.commands.registerCommand("claudeSandbox.openChange", (c?: Change) => c && this.open(c, false)),
      vscode.commands.registerCommand("claudeSandbox.markReviewed", (c?: Node, sel?: Node[]) =>
        this.mark(files(c, sel), true),
      ),
      vscode.commands.registerCommand("claudeSandbox.markUnreviewed", (c?: Node, sel?: Node[]) =>
        this.mark(files(c, sel), false),
      ),
      vscode.commands.registerCommand("claudeSandbox.openChangedFile", (c?: Node, sel?: Node[]) =>
        this.openFiles(files(c, sel)),
      ),
      vscode.commands.registerCommand("claudeSandbox.stageChange", (c?: Node, sel?: Node[]) =>
        this.stage(files(c, sel)),
      ),
      vscode.commands.registerCommand("claudeSandbox.revertChange", (c?: Node, sel?: Node[]) =>
        this.revert(files(c, sel)),
      ),
      vscode.commands.registerCommand("claudeSandbox.revertAll", () => this.revert(this.shown())),
      vscode.commands.registerCommand("claudeSandbox.revealChange", (c?: Node) => {
        if (c && isFile(c)) void vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(c.path));
      }),
      vscode.commands.registerCommand("claudeSandbox.copyChangePath", (c?: Node, sel?: Node[]) =>
        this.copy(files(c, sel), false),
      ),
      vscode.commands.registerCommand("claudeSandbox.copyChangeRelativePath", (c?: Node, sel?: Node[]) =>
        this.copy(files(c, sel), true),
      ),
      vscode.commands.registerCommand("claudeSandbox.reviewAll", () => this.reviewAll()),
      // every file the view shows: one it does not show is not reviewed by this
      vscode.commands.registerCommand("claudeSandbox.markAllReviewed", () => this.mark(this.shown(), true)),
      vscode.commands.registerCommand("claudeSandbox.nextChange", () => this.step("next")),
      vscode.commands.registerCommand("claudeSandbox.previousChange", () => this.step("previous")),
      // claudeSandbox.reviewing: Review All is the active editor (F8 and Shift+F8 step through it)
      vscode.window.tabGroups.onDidChangeTabs(() => this.reviewingChanged()),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.reviewingChanged()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.folderRoot.clear();
        this.refreshSoon();
      }),
    );
    // a Review All tab restored by a reload may already be active
    void vscode.commands.getCommands(true).then((all) => {
      this.canStep = all.includes(STEP.next);
      this.reviewingChanged();
    });
  }

  /** Review All is the active editor. */
  private get reviewing(): boolean {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    return tab !== undefined && isReviewTitle(tab.label);
  }

  /** Every open Review All tab. */
  private reviewTabs(): vscode.Tab[] {
    return vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => isReviewTitle(t.label));
  }

  private reviewingChanged(): void {
    const now = this.canStep && this.reviewing;
    if (now === this.reviewingNow) return;
    this.reviewingNow = now;
    void vscode.commands.executeCommand("setContext", "claudeSandbox.reviewing", now);
  }

  /**
   * The next or previous change in Review All, on into the next file. Review All is opened first
   * when it is not the active editor (at the top; the next step goes to its first change).
   */
  private async step(dir: keyof typeof STEP): Promise<void> {
    if (!this.reviewing) {
      await this.reviewAll();
      return;
    }
    if (!this.canStep) {
      void vscode.window.showInformationMessage(
        "Claude Sandbox: stepping through changes needs VS Code 1.106 or later.",
      );
      return;
    }
    await vscode.commands.executeCommand(STEP[dir]);
  }

  /** A session started: a new list, and watching until stop(). */
  start(roots: readonly string[]): void {
    this.stop();
    this.unfollow();
    this.session++;
    this.set = new ChangeSet({ roots });
    const w = vscode.workspace.createFileSystemWatcher("**/*");
    const saved = (d: vscode.TextDocument): void => {
      if (d.uri.scheme === "file") this.set.userSaved(d.uri.fsPath, Date.now());
    };
    this.watching = [
      w,
      w.onDidCreate((u) => void this.seen("created", u)),
      w.onDidChange((u) => void this.seen("changed", u)),
      w.onDidDelete((u) => this.record("deleted", u)),
      vscode.workspace.onWillSaveTextDocument((e) => saved(e.document)),
      vscode.workspace.onDidSaveTextDocument(saved),
    ];
    void vscode.commands.executeCommand("setContext", "claudeSandbox.watching", true);
    void this.api().then(() => this.refresh());
    this.refresh();
  }

  /** The Git extension's API, loaded on first use; null when there is none. */
  private async api(): Promise<GitApi | null> {
    if (this.git !== null) return this.git;
    const g = await gitApi();
    if (g === null) return null;
    if (this.disposed) return g; // nothing is listened to, or kept, after dispose()
    const reopened = (): void => {
      this.unfollow();
      this.refreshSoon();
    };
    this.gitSubs ??= [g.onDidOpenRepository(reopened), g.onDidCloseRepository(reopened)];
    this.git = g;
    return g;
  }

  private unfollow(): void {
    for (const r of this.repos.values()) r.sub.dispose();
    this.repos.clear();
    this.forgetRoots();
  }

  private forgetRoots(): void {
    this.repoRoot.clear();
    this.folderRoot.clear();
  }

  /** `p`'s record left the list: its cached roots go with it. */
  private forget(p: string): void {
    this.repoRoot.delete(p);
    this.folderRoot.delete(p);
  }

  /** The cached view of the list is out of date. */
  private stale(): void {
    this.shownCache = undefined;
    this.groupCache = undefined;
    this.indexCache.clear();
  }

  /** The root of the repository `p` is in (followed from now on), or null. */
  private rootFor(p: string): string | null {
    const known = this.repoRoot.get(p);
    if (known !== undefined) return known;
    // not loaded yet: asked again once it is; after dispose() no repository is followed
    if (this.git === null || this.disposed) return null;
    const repo = this.git.getRepository(vscode.Uri.file(p));
    const root = repo?.rootUri.fsPath ?? null;
    if (repo !== null && root !== null && !this.repos.has(root)) {
      let subs = submodules(repo);
      const changed = (): void => {
        const now = submodules(repo);
        if (now !== subs) {
          subs = now;
          this.forgetRoots();
        }
        this.refreshSoon();
      };
      this.repos.set(root, { repo, sub: repo.state.onDidChange(changed) });
    }
    if (this.repoRoot.size > ROOTS_MAX) this.repoRoot.clear();
    this.repoRoot.set(p, root);
    return root;
  }

  /** The repository `p` is in (followed from now on), or null. */
  private repoFor(p: string): GitRepository | null {
    const root = this.rootFor(p);
    return root === null ? null : (this.repos.get(root)?.repo ?? null);
  }

  /** The root of the group `p` is listed under: its repository's, else its workspace folder (else its own folder). */
  private groupRoot(p: string): string {
    const root = this.rootOf.get(p) ?? this.rootFor(p) ?? this.folderRoot.get(p);
    if (root !== undefined) return root;
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(p))?.uri.fsPath ?? path.dirname(p);
    if (this.folderRoot.size > ROOTS_MAX) this.folderRoot.clear();
    this.folderRoot.set(p, folder);
    return folder;
  }

  /**
   * The files this session touched that the view shows: as Source Control does, only those git
   * shows a change for now (back as HEAD has them, or ignored: not shown), and every one
   * outside a repository. Each repository's status is followed once it is first looked at.
   */
  private shown(): Change[] {
    if (this.shownCache !== undefined) return this.shownCache;
    const changed = new Map<string, Set<string>>();
    const active = splitByGit(this.set.all(), (c) => {
      const root = this.rootFor(c.path);
      if (root === null) return undefined;
      let paths = changed.get(root);
      if (paths === undefined) {
        const s = this.repos.get(root)!.repo.state;
        const all = [
          ...s.workingTreeChanges,
          ...s.indexChanges,
          ...(s.untrackedChanges ?? []),
          ...(s.mergeChanges ?? []),
        ];
        paths = new Set(all.flatMap((x) => (x.originalUri ? [x.uri.fsPath, x.originalUri.fsPath] : [x.uri.fsPath])));
        changed.set(root, paths);
      }
      return paths.has(c.path);
    }).active;
    this.rootOf.clear();
    this.inRepo.clear();
    for (const c of active) {
      if (this.rootFor(c.path) !== null) this.inRepo.add(c.path);
      this.rootOf.set(c.path, this.groupRoot(c.path));
    }
    this.shownCache = byPath(active);
    return this.shownCache;
  }

  /** The session ended: the list stays for review, nothing more is recorded. */
  stop(): void {
    for (const d of this.watching) d.dispose();
    this.watching = [];
    for (const t of this.autoTimers.values()) clearTimeout(t);
    this.autoTimers.clear();
    this.autoGuard = new AutoOpenGuard();
    void vscode.commands.executeCommand("setContext", "claudeSandbox.watching", false);
  }

  /** Created or changed: a folder is not listed (its files are); a symlink is listed as one. */
  private async seen(kind: "created" | "changed", u: vscode.Uri): Promise<void> {
    if (u.scheme !== "file" || !this.set.wanted(u.fsPath)) return;
    const session = this.session;
    const e = await entry(u.fsPath);
    // the event is its session's: not recorded in the list of one started since
    if (e === "dir" || session !== this.session) return;
    this.record(kind, u, e === "symlink");
  }

  private lastPrune = 0;

  /** Forget what the view does not show (see PRUNE_AGE_MS); what it shows is unchanged. */
  private makeRoom(now: number): void {
    if (now - this.lastPrune < PRUNE_EVERY_MS) return;
    this.lastPrune = now;
    // from git's status as it is, not as it was at the last redraw
    this.stale();
    const shown = new Set(this.shown().map((c) => c.path));
    this.set.prune((c) => {
      if (shown.has(c.path)) return true;
      this.forget(c.path);
      return false;
    }, now - PRUNE_AGE_MS);
  }

  private record(kind: Change["kind"], u: vscode.Uri, symlink = false): void {
    // an lstat (seen) may end after the session has
    if (u.scheme !== "file" || this.disposed || this.watching.length === 0) return;
    const now = Date.now();
    if (this.set.size >= CHANGES_MAX && this.set.get(u.fsPath) === undefined) this.makeRoom(now);
    const c = this.set.event(kind, u.fsPath, now, symlink);
    if (c === null && this.set.get(u.fsPath) === undefined) this.forget(u.fsPath); // made and gone again
    this.refreshSoon();
    if (c === null || c.kind === "deleted" || c.symlink) return;
    if (!vscode.workspace.getConfiguration("claudeSandbox").get<boolean>("autoOpenDiffs", false)) return;
    const t = this.autoTimers.get(c.path);
    const todo = this.autoGuard.next(this.autoTimers.size + (t ? 0 : 1), now);
    if (todo !== "open") {
      if (todo === "burst") {
        for (const w of this.autoTimers.values()) clearTimeout(w);
        this.autoTimers.clear();
        vscode.window.setStatusBarMessage("Claude Sandbox: many files are changing: their diffs are not opened", 5000);
      }
      return;
    }
    if (t) clearTimeout(t);
    this.autoTimers.set(
      c.path,
      setTimeout(() => {
        this.autoTimers.delete(c.path);
        if (this.disposed || this.watching.length === 0) return;
        const now = this.set.get(c.path);
        if (now !== undefined && now.kind !== "deleted") void this.open(now, true);
      }, AUTO_OPEN_MS),
    );
  }

  private refreshSoon(): void {
    if (this.disposed) return;
    this.refreshTimer ??= setTimeout(
      () => this.refreshDue(),
      refreshWait(performance.now(), this.refreshedAt, this.refreshCost + this.fetchCost),
    );
  }

  /** The timer's refresh, put off while the tree's fetches since the last one call for a longer wait. */
  private refreshDue(): void {
    this.refreshTimer = undefined;
    const wait = this.refreshedAt + refreshDelay(this.refreshCost + this.fetchCost) - performance.now();
    if (wait >= 1) this.refreshTimer = setTimeout(() => this.refreshDue(), wait);
    else this.refresh();
  }

  private refresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    if (this.disposed) return;
    const began = performance.now();
    this.fetchCost = 0;
    this.stale();
    const shown = this.shown();
    // every shown file, not only the rows fetched so far: a folder row's counts, and the rows
    // under an expanded one, come from them all
    const now = drawn(
      shown,
      (c) => this.groupRoot(c.path),
      (c) => this.inRepo.has(c.path),
    );
    if (!sameDrawn(this.drawn, now)) {
      this.drawn = now;
      this.emitter.fire(undefined);
    }
    const n = this.unreviewed;
    if (n !== this.badged) {
      this.badged = n;
      this.view.badge =
        n > 0 ? { value: n, tooltip: `${n} changed file${n === 1 ? "" : "s"} not reviewed` } : undefined;
    }
    const message = [
      this.set.dropped > 0
        ? `The list is full (${CHANGES_MAX} files): ${this.set.dropped} later change${this.set.dropped === 1 ? " was" : "s were"} not recorded. Use Source Control.`
        : "",
      shown.length === 0 && this.watching.length > 0 ? "No files have changed yet this session." : "",
    ]
      .filter(Boolean)
      .join(" ");
    if (message !== (this.view.message ?? "")) this.view.message = message;
    this.onCount(n);
    this.refreshedAt = performance.now();
    this.refreshCost = this.refreshedAt - began;
  }

  /** Unreviewed files the view shows. */
  get unreviewed(): number {
    return this.shown().filter((c) => !c.reviewed).length;
  }

  /** HEAD's side of a change: HEAD, or empty for a file HEAD lacks (untracked or added). */
  private original(git: GitApi, repo: GitRepository, c: Change, uri: vscode.Uri): vscode.Uri {
    const s = repo.state;
    const isNew = [...s.workingTreeChanges, ...s.indexChanges, ...(s.untrackedChanges ?? [])].some(
      (x) => x.uri.fsPath === c.path && NEW.includes(x.status),
    );
    return isNew ? empty(uri) : git.toGitUri(uri, "HEAD");
  }

  /** Re-checks a change before showing it: a symlink now is marked, and not opened. */
  private async check(c: Change): Promise<EntryKind> {
    const e = await entry(c.path);
    if (e === "symlink" && !c.symlink && c.kind !== "deleted") {
      c.symlink = true;
      // the tree's row may be an older record of the file than the list's
      const now = this.set.get(c.path);
      if (now !== undefined && now.kind !== "deleted") now.symlink = true;
      this.refreshSoon();
    }
    return e;
  }

  /** VS Code's diff against HEAD; a file HEAD lacks opens as itself; a deleted one, HEAD vs empty. */
  async open(c: Change, auto: boolean): Promise<void> {
    const uri = vscode.Uri.file(c.path);
    const name = path.basename(c.path);
    if ((await this.check(c)) === "symlink") {
      if (!auto)
        void vscode.window.showInformationMessage(
          `${name} is a symlink: it is not opened here. Look at it in Source Control.`,
        );
      return;
    }
    const opts: vscode.TextDocumentShowOptions = { preview: true, preserveFocus: auto };
    const git = await this.api();
    const repo = this.repoFor(c.path);
    if (git === null || repo === null) {
      if (c.kind === "deleted")
        void vscode.window.showInformationMessage(`${name} was deleted (not in a Git repository).`);
      else await vscode.window.showTextDocument(uri, opts);
      return;
    }
    if (c.kind === "deleted") {
      await vscode.commands.executeCommand(
        "vscode.diff",
        git.toGitUri(uri, "HEAD"),
        empty(uri),
        `${name} (deleted)`,
        opts,
      );
      return;
    }
    await fresh([repo]);
    this.refreshSoon(); // the view follows the status just read
    const left = this.original(git, repo, c, uri);
    if (left.scheme === EMPTY_SCHEME) await vscode.window.showTextDocument(uri, opts);
    else await vscode.commands.executeCommand("vscode.diff", left, uri, `${name} (HEAD ↔ now)`, opts);
  }

  /**
   * The listed files in one multi-file diff editor (vscode.changes: [resource, original,
   * modified] rows, a missing side undefined, which VS Code 1.105+ accepts and shows as added or
   * deleted), against HEAD. VS Code reads the contents; symlinks are left out. At most VIEW_MAX
   * files: with more, files HEAD has come first, then a repository's new files, then files
   * outside one, each by path (reviewPick), and a message says how many are not in the review.
   */
  async reviewAll(): Promise<void> {
    const git = await this.api();
    const repoOf = (c: Change): GitRepository | null => this.repoFor(c.path);
    // the Git extension's status lags the watcher: a file just made would not be untracked yet,
    // so would be left out of what is shown or diffed against a HEAD that lacks it. Every
    // session file's repository is re-read (not only the shown ones'), then shown() recomputed.
    await fresh(this.set.all().map(repoOf));
    this.refresh();
    const shown = this.shown();
    // each repository's paths HEAD lacks (untracked or added), as original() tells them
    const added = new Map<string, Set<string>>();
    const isNew = (root: string, c: Change): boolean => {
      let paths = added.get(root);
      if (paths === undefined) {
        const st = this.repos.get(root)?.repo.state;
        const all = st ? [...st.workingTreeChanges, ...st.indexChanges, ...(st.untrackedChanges ?? [])] : [];
        paths = new Set(all.filter((x) => NEW.includes(x.status)).map((x) => x.uri.fsPath));
        added.set(root, paths);
      }
      return paths.has(c.path);
    };
    const { files: list, left } = reviewPick(
      shown,
      (c) => {
        const root = this.rootFor(c.path);
        return root === null ? 2 : isNew(root, c) ? 1 : 0;
      },
      VIEW_MAX,
    );
    if (left > 0)
      void vscode.window.showInformationMessage(
        `Claude Sandbox: ${left} of ${shown.length} changed files ${left === 1 ? "is" : "are"} not in this review: it opens at most ${VIEW_MAX} (tracked files first, then a repository's new files, then files outside one, each by path). Open the others from the Changed this session view.`,
      );
    for (const c of list) if (c.kind !== "deleted") await this.check(c); // a symlink now is marked
    const plan = reviewPlan(list, (c) => {
      const root = this.rootFor(c.path);
      return git !== null && root !== null && (c.kind === "deleted" || !isNew(root, c));
    });
    const rows = plan.rows.map((r): [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined] => {
      const uri = vscode.Uri.file(r.path);
      return [uri, r.head && git !== null ? git.toGitUri(uri, "HEAD") : undefined, r.now ? uri : undefined];
    });
    const links = plan.symlinks;
    if (links > 0)
      void vscode.window.showInformationMessage(
        `Claude Sandbox: ${links} symlink${links === 1 ? " is" : "s are"} left out of the review.`,
      );
    if (rows.length === 0) {
      void vscode.window.showInformationMessage("Claude Sandbox: no changed files to review.");
      return;
    }
    // each vscode.changes is a new editor (no two match): the one already open is replaced
    const open = this.reviewTabs();
    if (open.length > 0) await vscode.window.tabGroups.close(open, true);
    await vscode.commands.executeCommand("vscode.changes", plan.title, rows);
  }

  // -- the context menu

  private mark(cs: readonly Change[], reviewed: boolean): void {
    let any = false;
    for (const c of cs) any = this.set.markReviewed(c.path, reviewed) || any;
    if (any) this.refresh();
  }

  /** The files themselves (not diffs); a symlink is not opened, as for diffs. */
  private async openFiles(cs: readonly Change[]): Promise<void> {
    for (const c of cs) {
      if (c.kind === "deleted") continue;
      const e = await this.check(c);
      if (e !== "file") {
        const why =
          e === "symlink"
            ? "is a symlink: it is not opened here. Look at it in Source Control."
            : e === "dir"
              ? "is now a folder."
              : "is gone.";
        void vscode.window.showInformationMessage(`${path.basename(c.path)} ${why}`);
        continue;
      }
      await vscode.window.showTextDocument(vscode.Uri.file(c.path), { preview: cs.length === 1 });
    }
  }

  private async copy(cs: readonly Change[], relative: boolean): Promise<void> {
    if (cs.length === 0) return;
    const text = cs.map((c) => (relative ? vscode.workspace.asRelativePath(c.path, false) : c.path)).join("\n");
    await vscode.env.clipboard.writeText(text);
  }

  /** The files by repository (status re-read), and how many are in none. */
  private async byRepo(
    cs: readonly Change[],
  ): Promise<{ repos: { repo: GitRepository; paths: string[] }[]; outside: number }> {
    await this.api();
    const repos = new Map<string, { repo: GitRepository; paths: string[] }>();
    let outside = 0;
    for (const c of cs) {
      const repo = this.repoFor(c.path);
      if (repo === null) {
        outside++;
        continue;
      }
      const key = repo.rootUri.toString();
      const r = repos.get(key) ?? { repo, paths: [] };
      r.paths.push(c.path);
      repos.set(key, r);
    }
    const list = [...repos.values()];
    await fresh(list.map((r) => r.repo));
    return { repos: list, outside };
  }

  private notInGit(n: number): void {
    if (n > 0)
      void vscode.window.showInformationMessage(
        `Claude Sandbox: ${n} file${n === 1 ? " is" : "s are"} not in a Git repository: left as they are.`,
      );
  }

  /** Source Control's Stage, by the Git extension; a staged file counts as reviewed. */
  private async stage(cs: readonly Change[]): Promise<void> {
    const { repos, outside } = await this.byRepo(cs);
    this.notInGit(outside);
    for (const r of repos) {
      try {
        await r.repo.add(r.paths);
      } catch (e) {
        void vscode.window.showErrorMessage(
          `Claude Sandbox: staging failed: ${e instanceof Error ? e.message : String(e)}`,
        );
        continue;
      }
      const staged = new Set(r.paths);
      this.mark(
        cs.filter((c) => staged.has(c.path)),
        true,
      );
    }
  }

  /**
   * Back to HEAD, by the Git extension (our extension writes nothing): staged changes are
   * unstaged (Source Control's Unstage), then the working tree discarded (its Discard: a tracked
   * file checked out, one HEAD lacks deleted). After one prompt of ours, as Discard asks first.
   * What git still shows afterwards, or a file HEAD lacks still there (Discard skips an untracked
   * file under git.untrackedChanges "hidden", and a merge conflict), is reported, not hidden.
   */
  private async revert(cs: readonly Change[]): Promise<void> {
    if (cs.length === 0) {
      void vscode.window.showInformationMessage("Claude Sandbox: no changed files to revert.");
      return;
    }
    const { repos, outside } = await this.byRepo(cs);
    this.notInGit(outside);
    const n = repos.reduce((k, r) => k + r.paths.length, 0);
    if (n === 0) return;
    const what = n === 1 ? `'${path.basename(repos[0]!.paths[0]!)}'` : `${n} files`;
    const yes = n === 1 ? "Revert File" : `Revert ${n} Files`;
    const pick = await vscode.window.showWarningMessage(
      `Revert ${what} to HEAD?`,
      {
        modal: true,
        detail:
          "Every uncommitted change is lost, staged ones and any made before this session included. A file HEAD does not have is deleted (to the trash where VS Code can).",
      },
      yes,
    );
    if (pick !== yes) return;
    // the session may have staged more while the prompt was up
    await fresh(repos.map((r) => r.repo));
    const left: string[] = [];
    for (const { repo, paths } of repos) {
      try {
        const want = new Set(paths);
        // a staged rename is reset whole: one side alone would leave the other staged
        const sides = (x: GitChange): string[] => [x.uri.fsPath, ...(x.originalUri ? [x.originalUri.fsPath] : [])];
        const staged = [
          ...new Set(
            repo.state.indexChanges
              .map(sides)
              .filter((ps) => ps.some((p) => want.has(p)))
              .flat(),
          ),
        ];
        // staged paths HEAD lacks (added, or a rename's or copy's new path): untracked once reset
        const added = new Set(
          repo.state.indexChanges
            .filter((x) => [INDEX_ADDED, INDEX_RENAMED, INDEX_COPIED].includes(x.status))
            .map((x) => x.uri.fsPath),
        );
        if (staged.length > 0) {
          await repo.revert(staged);
          await repo.status();
        }
        const all = [...new Set([...paths, ...staged])];
        await repo.clean(all);
        await repo.status();
        const s = repo.state;
        const still = new Set(
          [
            ...s.workingTreeChanges,
            ...s.indexChanges,
            ...(s.untrackedChanges ?? []),
            ...(s.mergeChanges ?? []),
          ].flatMap(sides),
        );
        for (const p of all) if (still.has(p) || (added.has(p) && (await entry(p)) !== "gone")) left.push(p);
      } catch (e) {
        void vscode.window.showErrorMessage(
          `Claude Sandbox: revert failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    if (left.length > 0) {
      const names =
        left
          .slice(0, 3)
          .map((p) => path.basename(p))
          .join(", ") + (left.length > 3 ? ", …" : "");
      void vscode.window.showWarningMessage(
        `Claude Sandbox: ${left.length} file${left.length === 1 ? " was" : "s were"} not reverted (${names}): look at ${left.length === 1 ? "it" : "them"} with git status.`,
      );
    }
    this.refresh();
  }

  // -- TreeDataProvider

  /** The files grouped by repository (else workspace folder), as Source Control groups them; by root. */
  private groups(): Map<string, ChangeGroup> {
    this.groupCache ??= new Map(groupByRoot(this.shown(), (c) => this.groupRoot(c.path)).map((g) => [g.root, g]));
    return this.groupCache;
  }

  /** A group lists its files flat up to VIEW_MAX of them, and as folder rows above that. */
  private foldered(root: string): boolean {
    return (this.groups().get(root)?.changes.length ?? 0) > VIEW_MAX;
  }

  /** The rows under a group's root, one of its folder rows, or a range row of either. */
  private under(root: string, dir?: string, range?: readonly number[]): Node[] {
    const g = this.groups().get(root);
    if (g === undefined) return [];
    if (!this.foldered(root)) return dir === undefined ? g.changes : [];
    let index = this.indexCache.get(root);
    if (index === undefined) {
      index = folderIndex(g.changes, root);
      this.indexCache.set(root, index);
    }
    const level = index.get(dir ?? root);
    return level === undefined ? [] : levelRows(level, root, dir ?? root, VIEW_MAX, range);
  }

  // Rows are looked up afresh by root and directory: the row VS Code passes may be an older draw's.
  getChildren(element?: Node): Node[] {
    const began = performance.now();
    const rows = this.children(element);
    this.fetchCost += performance.now() - began;
    return rows;
  }

  private children(element?: Node): Node[] {
    if (element === undefined || (isRange(element) && element.root === "")) {
      const groups = [...this.groups().values()];
      // one repository: its files, unwrapped
      if (groups.length === 1) return element === undefined ? this.under(groups[0]!.root) : [];
      return groupRows(groups, VIEW_MAX, element?.range);
    }
    if (isFile(element)) return [];
    if (isRange(element)) return this.under(element.root, element.dir, element.range);
    return isFolder(element) ? this.under(element.root, element.dir) : this.under(element.root);
  }

  getTreeItem(n: Node): vscode.TreeItem {
    if (isRange(n)) {
      const item = new vscode.TreeItem(`${n.first} … ${n.last}`, vscode.TreeItemCollapsibleState.Collapsed);
      // ids are joined with NUL, which no path holds, so no two rows share one
      item.id = `range\0${n.root}\0${n.dir}\0${n.range.join(".")}`;
      item.description = `${n.files} file${n.files === 1 ? "" : "s"}${n.unreviewed < n.files ? `, ${n.unreviewed} to review` : ""}`;
      item.tooltip = `${n.dir === "" ? "" : `${n.dir}: `}${n.first} to ${n.last}`;
      item.iconPath = new vscode.ThemeIcon("list-tree");
      item.contextValue = "changeRange";
      return item;
    }
    if (isFolder(n)) {
      const item = new vscode.TreeItem(n.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `dir\0${n.root}\0${n.dir}`;
      item.description = `${n.files} file${n.files === 1 ? "" : "s"}${n.unreviewed < n.files ? `, ${n.unreviewed} to review` : ""}`;
      item.tooltip = n.dir;
      item.iconPath = new vscode.ThemeIcon("folder");
      item.contextValue = "changeFolder";
      return item;
    }
    if (!isFile(n)) {
      // VS Code keeps a row's expanded or collapsed state by its id once it has drawn it, and
      // takes ours only for an id it has not seen: the two forms have ids of their own
      const collapsed = groupsCollapsed(this.groups().size, this.shown().length, VIEW_MAX);
      const item = new vscode.TreeItem(
        path.basename(n.root) || n.root,
        collapsed ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded,
      );
      item.id = `${collapsed ? "root-collapsed" : "root"}\0${n.root}`;
      const open = n.changes.filter((c) => !c.reviewed).length;
      item.description = `${path.dirname(n.root)} · ${n.changes.length} file${n.changes.length === 1 ? "" : "s"}${open < n.changes.length ? `, ${open} to review` : ""}`;
      item.tooltip = n.root;
      item.iconPath = new vscode.ThemeIcon("repo");
      item.contextValue = "changeGroup";
      return item;
    }
    const c = n;
    const uri = vscode.Uri.file(c.path);
    const item = new vscode.TreeItem(uri, vscode.TreeItemCollapsibleState.None);
    item.id = `file\0${c.path}`;
    // the folder within its group's root (repository, else workspace folder); under folder rows,
    // they say it
    const root = this.groupRoot(c.path);
    const rel = this.foldered(root) ? "" : path.relative(root, path.dirname(c.path));
    // "created" is not shown: an atomic write (a temp file renamed over it) looks the same to the
    // watcher; Git decorations (U, M) on the item say what it is
    const tags = [c.kind === "deleted" ? "deleted" : "", c.symlink ? "symlink" : "", c.reviewed ? "reviewed" : ""]
      .filter(Boolean)
      .join(", ");
    item.description = [rel === "" ? "" : rel, tags ? `(${tags})` : ""].filter(Boolean).join(" ");
    item.tooltip = `${c.path}\n${c.kind}${c.reviewed ? ", reviewed" : ""}`;
    if (c.reviewed) item.iconPath = new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed"));
    // "change;reviewed|unreviewed" then ";deleted", ";symlink", ";git": the menus' when clauses
    item.contextValue = [
      "change",
      c.reviewed ? "reviewed" : "unreviewed",
      c.kind === "deleted" ? "deleted" : "",
      c.symlink ? "symlink" : "",
      this.inRepo.has(c.path) ? "git" : "",
    ]
      .filter(Boolean)
      .join(";");
    item.command = { command: "claudeSandbox.openChange", title: "Open diff", arguments: [c] };
    return item;
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.unfollow();
    for (const s of this.gitSubs ?? []) s.dispose();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    for (const s of this.subs) s.dispose();
  }
}
