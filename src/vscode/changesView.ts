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
// is not shown in a diff. "Review All" opens every listed file in VS Code's multi-file diff
// editor (vscode.changes), symlinks left out the same way, in place of one already open. Next and
// Previous Change step through that editor's changes (VS Code's own commands, which go on into the
// next file), opening it first when it is not the active editor.

import * as path from "node:path";
import * as vscode from "vscode";
import {
  CHANGES_MAX,
  type Change,
  type ChangeGroup,
  ChangeSet,
  type EntryKind,
  entryKind as entry,
  freshStatus as fresh,
  groupByRoot,
  isReviewTitle,
  picked,
  reviewPlan,
  splitByGit,
} from "../changes.ts";

/** A row of the view: a file, or (when the files span several repositories) a repository. */
type Node = Change | ChangeGroup;
const isGroup = (n: Node): n is ChangeGroup => "root" in n;
const isFile = (n: Node): n is Change => !isGroup(n);
/** The files a context-menu command acts on (see picked). */
const files = (clicked?: Node, selected?: Node[]): Change[] => picked(clicked, selected, isFile);

const EMPTY_SCHEME = "claude-sandbox-empty";
const AUTO_OPEN_MS = 400;
/** VS Code's (1.106+) next and previous change in the active multi-file diff editor. */
const STEP = { next: "multiDiffEditor.goToNextChange", previous: "multiDiffEditor.goToPreviousChange" } as const;
/** Watcher events come in bursts (a checkout, an install): the view is redrawn at most this often. */
const REFRESH_MS = 100;
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
  getRepository(uri: vscode.Uri): GitRepository | null;
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
}
// Status values for a file HEAD does not have
const INDEX_ADDED = 1;
const INDEX_RENAMED = 3;
const INDEX_COPIED = 4;
const UNTRACKED = 7;
const INTENT_TO_ADD = 9;

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

export class ChangesView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private set: ChangeSet = new ChangeSet({ roots: [] });
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly view: vscode.TreeView<Node>;
  /**
   * The Git extension's API once loaded, and the repositories whose status we follow, by root
   * (getRepository returns a new wrapper object on every call, so not by object).
   */
  private git: GitApi | null = null;
  private readonly repos = new Map<string, vscode.Disposable>();
  /** What the view shows, and each file's group root, worked out once per redraw. */
  private shownCache: Change[] | undefined;
  private readonly rootOf = new Map<string, string>();
  /** Shown files in a repository (Stage and Revert are offered for these). */
  private readonly inRepo = new Set<string>();
  private readonly subs: vscode.Disposable[] = [];
  private watching: vscode.Disposable[] = [];
  private readonly autoTimers = new Map<string, NodeJS.Timeout>();
  private refreshTimer: NodeJS.Timeout | undefined;
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
      vscode.commands.registerCommand("claudeSandbox.markAllReviewed", () => {
        let any = false;
        for (const c of this.set.list()) any = this.set.markReviewed(c.path) || any;
        if (any) this.refresh();
      }),
      vscode.commands.registerCommand("claudeSandbox.nextChange", () => this.step("next")),
      vscode.commands.registerCommand("claudeSandbox.previousChange", () => this.step("previous")),
      // claudeSandbox.reviewing: Review All is the active editor (F8 and Shift+F8 step through it)
      vscode.window.tabGroups.onDidChangeTabs(() => this.reviewingChanged()),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.reviewingChanged()),
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
    void gitApi().then((g) => {
      this.git = g;
      this.refresh();
    });
    this.refresh();
  }

  private unfollow(): void {
    for (const d of this.repos.values()) d.dispose();
    this.repos.clear();
  }

  /**
   * The files this session touched that the view shows: as Source Control does, only those git
   * shows a change for now (back as HEAD has them, or ignored: not shown), and every one
   * outside a repository. Each repository's status is followed once it is first looked at.
   */
  private shown(): Change[] {
    if (this.shownCache !== undefined) return this.shownCache;
    const changed = new Map<string, Set<string>>();
    this.rootOf.clear();
    this.inRepo.clear();
    this.shownCache = splitByGit(this.set.list(), (c) => {
      const repo = this.git?.getRepository(vscode.Uri.file(c.path)) ?? null;
      if (repo === null) {
        const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(c.path));
        this.rootOf.set(c.path, folder?.uri.fsPath ?? path.dirname(c.path));
        return undefined;
      }
      this.rootOf.set(c.path, repo.rootUri.fsPath);
      this.inRepo.add(c.path);
      const root = repo.rootUri.toString();
      if (!this.repos.has(root))
        this.repos.set(
          root,
          repo.state.onDidChange(() => this.refreshSoon()),
        );
      let paths = changed.get(root);
      if (paths === undefined) {
        const s = repo.state;
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
    return this.shownCache;
  }

  /** The session ended: the list stays for review, nothing more is recorded. */
  stop(): void {
    for (const d of this.watching) d.dispose();
    this.watching = [];
    for (const t of this.autoTimers.values()) clearTimeout(t);
    this.autoTimers.clear();
    void vscode.commands.executeCommand("setContext", "claudeSandbox.watching", false);
  }

  /** Created or changed: a folder is not listed (its files are); a symlink is listed as one. */
  private async seen(kind: "created" | "changed", u: vscode.Uri): Promise<void> {
    if (u.scheme !== "file" || !this.set.wanted(u.fsPath)) return;
    const e = await entry(u.fsPath);
    if (e === "dir") return;
    this.record(kind, u, e === "symlink");
  }

  private lastPrune = 0;

  /** A full list: forget what the view does not show (see PRUNE_AGE_MS). */
  private makeRoom(now: number): void {
    if (now - this.lastPrune < PRUNE_EVERY_MS) return;
    this.lastPrune = now;
    const shown = new Set(this.shown().map((c) => c.path));
    if (this.set.prune((c) => shown.has(c.path), now - PRUNE_AGE_MS) > 0) this.shownCache = undefined;
  }

  private record(kind: Change["kind"], u: vscode.Uri, symlink = false): void {
    if (u.scheme !== "file") return;
    const now = Date.now();
    if (this.set.size >= CHANGES_MAX && this.set.get(u.fsPath) === undefined) this.makeRoom(now);
    const c = this.set.event(kind, u.fsPath, now, symlink);
    this.refreshSoon();
    if (c === null || c.kind === "deleted" || c.symlink) return;
    if (!vscode.workspace.getConfiguration("claudeSandbox").get<boolean>("autoOpenDiffs", false)) return;
    const t = this.autoTimers.get(c.path);
    if (t) clearTimeout(t);
    this.autoTimers.set(
      c.path,
      setTimeout(() => {
        this.autoTimers.delete(c.path);
        const now = this.set.get(c.path);
        if (now !== undefined && now.kind !== "deleted") void this.open(now, true);
      }, AUTO_OPEN_MS),
    );
  }

  private refreshSoon(): void {
    this.refreshTimer ??= setTimeout(() => {
      this.refreshTimer = undefined;
      this.refresh();
    }, REFRESH_MS);
  }

  private refresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    this.shownCache = undefined;
    this.emitter.fire(undefined);
    const n = this.unreviewed;
    this.view.badge = n > 0 ? { value: n, tooltip: `${n} changed file${n === 1 ? "" : "s"} not reviewed` } : undefined;
    this.view.message =
      this.set.dropped > 0
        ? `The list is full (${CHANGES_MAX} files): ${this.set.dropped} later change${this.set.dropped === 1 ? " was" : "s were"} not recorded. Use Source Control.`
        : this.shown().length === 0 && this.watching.length > 0
          ? "No files have changed yet this session."
          : "";
    this.onCount(n);
  }

  /** Unreviewed files the view shows. */
  get unreviewed(): number {
    return this.shown().filter((c) => !c.reviewed).length;
  }

  /** HEAD's side of a change: HEAD, or empty for a file HEAD lacks (untracked or added). */
  private original(git: GitApi, repo: GitRepository, c: Change, uri: vscode.Uri): vscode.Uri {
    const s = repo.state;
    const isNew = [...s.workingTreeChanges, ...s.indexChanges, ...(s.untrackedChanges ?? [])].some(
      (x) =>
        x.uri.fsPath === c.path && (x.status === UNTRACKED || x.status === INDEX_ADDED || x.status === INTENT_TO_ADD),
    );
    return isNew ? empty(uri) : git.toGitUri(uri, "HEAD");
  }

  /** Re-checks a change before showing it: a symlink now is marked, and not opened. */
  private async check(c: Change): Promise<EntryKind> {
    const e = await entry(c.path);
    if (e === "symlink" && !c.symlink && c.kind !== "deleted") {
      c.symlink = true;
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
    const git = await gitApi();
    const repo = git?.getRepository(uri) ?? null;
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
   * Every listed file in one multi-file diff editor (vscode.changes: [resource, original,
   * modified] rows, a missing side undefined, which VS Code 1.105+ accepts and shows as added or
   * deleted), against HEAD. VS Code reads the contents; symlinks are left out.
   */
  async reviewAll(): Promise<void> {
    const git = await gitApi();
    const repoOf = (c: Change): GitRepository | null => git?.getRepository(vscode.Uri.file(c.path)) ?? null;
    // the Git extension's status lags the watcher: a file just made would not be untracked yet,
    // so would be left out of what is shown or diffed against a HEAD that lacks it. Every
    // session file's repository is re-read (not only the shown ones'), then shown() recomputed.
    await fresh(this.set.list().map(repoOf));
    this.refresh();
    const list = this.shown();
    for (const c of list) if (c.kind !== "deleted") await this.check(c); // a symlink now is marked
    const plan = reviewPlan(list, (c) => {
      const repo = repoOf(c);
      return (
        git !== null &&
        repo !== null &&
        (c.kind === "deleted" || this.original(git, repo, c, vscode.Uri.file(c.path)).scheme !== EMPTY_SCHEME)
      );
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
    const git = await gitApi();
    const repos = new Map<string, { repo: GitRepository; paths: string[] }>();
    let outside = 0;
    for (const c of cs) {
      const repo = git?.getRepository(vscode.Uri.file(c.path)) ?? null;
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
      this.mark(
        cs.filter((c) => r.paths.includes(c.path)),
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

  /** The files grouped by repository (else workspace folder), as Source Control groups them. */
  private groups(): ChangeGroup[] {
    const shown = this.shown();
    return groupByRoot(shown, (c) => this.rootOf.get(c.path) ?? path.dirname(c.path));
  }

  getChildren(element?: Node): Node[] {
    if (element !== undefined) return isGroup(element) ? element.changes : [];
    const groups = this.groups();
    // one repository: its files, unwrapped
    return groups.length === 1 ? groups[0]!.changes : groups;
  }

  getTreeItem(n: Node): vscode.TreeItem {
    if (isGroup(n)) {
      const item = new vscode.TreeItem(path.basename(n.root) || n.root, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `root:${n.root}`;
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
    // the folder within its group's root (repository, else workspace folder)
    const root = this.rootOf.get(c.path) ?? vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
    const rel = root ? path.relative(root, path.dirname(c.path)) : path.dirname(c.path);
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
    this.stop();
    this.unfollow();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    for (const s of this.subs) s.dispose();
  }
}
