// The "Changed this session" view: workspace files that changed while the linked session ran
// (src/changes.ts), from VS Code's file watcher. A click opens VS Code's diff against HEAD through
// the built-in Git extension's API (it reads the files, and runs git; the extension runs no git
// of its own and reads no file contents). There is no revert: that would be the host writing
// into the jail-writable workspace; Source Control's Discard is the way back.
//
// Each path is lstat-ed (metadata only, never followed): a folder is not listed, and a symlink
// is listed as one but never opened, so a link the jail planted to a file outside the workspace
// is not shown in a diff. "Review All" opens every listed file in VS Code's multi-file diff
// editor (vscode.changes), symlinks left out the same way.

import * as path from "node:path";
import * as vscode from "vscode";
import { ChangeSet, entryKind as entry, reviewPlan, splitByGit, type Change, type Entry } from "../changes.ts";

/** The collapsed group of listed files git shows no change for now. */
const QUIET = { quiet: true } as const;
type Node = Change | typeof QUIET;

const EMPTY_SCHEME = "claude-sandbox-empty";
const AUTO_OPEN_MS = 400;
/** Watcher events come in bursts (a checkout, an install): the view is redrawn at most this often. */
const REFRESH_MS = 100;

// The parts of the Git extension's API (vscode.git, getAPI(1)) used here.
interface GitChange {
  readonly uri: vscode.Uri;
  readonly status: number;
}
interface GitRepository {
  readonly state: {
    readonly workingTreeChanges: readonly GitChange[];
    readonly indexChanges: readonly GitChange[];
    readonly untrackedChanges?: readonly GitChange[];
    readonly mergeChanges?: readonly GitChange[];
    readonly onDidChange: vscode.Event<void>;
  };
}
interface GitApi {
  getRepository(uri: vscode.Uri): GitRepository | null;
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
}
// Status values for a file HEAD does not have
const INDEX_ADDED = 1;
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
  /** The Git extension's API once loaded, and the repositories whose status we follow. */
  private git: GitApi | null = null;
  private readonly repos = new Map<GitRepository, vscode.Disposable>();
  private readonly subs: vscode.Disposable[] = [];
  private watching: vscode.Disposable[] = [];
  private readonly autoTimers = new Map<string, NodeJS.Timeout>();
  private refreshTimer: NodeJS.Timeout | undefined;
  /** The count changed (status bar). */
  onCount: (unreviewed: number) => void = () => undefined;

  constructor() {
    this.view = vscode.window.createTreeView("claudeSandbox.changes", { treeDataProvider: this, showCollapseAll: false });
    this.subs.push(
      this.view,
      this.emitter,
      vscode.workspace.registerTextDocumentContentProvider(EMPTY_SCHEME, { provideTextDocumentContent: () => "" }),
      vscode.commands.registerCommand("claudeSandbox.openChange", (c?: Change) => c && this.open(c, false)),
      vscode.commands.registerCommand("claudeSandbox.markReviewed", (c?: Change) => {
        if (c && this.set.markReviewed(c.path)) this.refresh();
      }),
      vscode.commands.registerCommand("claudeSandbox.reviewAll", () => this.reviewAll()),
      vscode.commands.registerCommand("claudeSandbox.markAllReviewed", () => {
        let any = false;
        for (const c of this.set.list()) any = this.set.markReviewed(c.path) || any;
        if (any) this.refresh();
      }),
    );
  }

  /** A session started: a new list, and watching until stop(). */
  start(roots: readonly string[]): void {
    this.stop();
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

  /** The repository a path is in, its status followed from then on (the groups redraw with it). */
  private repoOf(p: string): GitRepository | null {
    const repo = this.git?.getRepository(vscode.Uri.file(p)) ?? null;
    if (repo !== null && !this.repos.has(repo)) this.repos.set(repo, repo.state.onDidChange(() => this.refreshSoon()));
    return repo;
  }

  /** Listed files git shows a change for now (or outside any repository), and the rest. */
  private split(): { active: Change[]; quiet: Change[] } {
    const changed = new Map<GitRepository, Set<string>>();
    return splitByGit(this.set.list(), (c) => {
      const repo = this.git === null ? null : this.repoOf(c.path);
      if (repo === null) return undefined;
      let paths = changed.get(repo);
      if (paths === undefined) {
        const s = repo.state;
        const all = [...s.workingTreeChanges, ...s.indexChanges, ...(s.untrackedChanges ?? []), ...(s.mergeChanges ?? [])];
        paths = new Set(all.map((x) => x.uri.fsPath));
        changed.set(repo, paths);
      }
      return paths.has(c.path);
    });
  }

  /** The session ended: the list stays for review, nothing more is recorded. */
  stop(): void {
    this.watching.forEach((d) => d.dispose());
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

  private record(kind: Change["kind"], u: vscode.Uri, symlink = false): void {
    if (u.scheme !== "file") return;
    const c = this.set.event(kind, u.fsPath, Date.now(), symlink);
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
    this.emitter.fire(undefined);
    const n = this.unreviewed;
    this.view.badge = n > 0 ? { value: n, tooltip: `${n} changed file${n === 1 ? "" : "s"} not reviewed` } : undefined;
    this.view.message = this.set.size === 0 && this.watching.length > 0 ? "No files have changed yet this session." : "";
    this.onCount(n);
  }

  /** Unreviewed files git shows a change for (the folded group is not counted). */
  get unreviewed(): number {
    return this.split().active.filter((c) => !c.reviewed).length;
  }

  /** HEAD's side of a change: HEAD, or empty for a file HEAD lacks (untracked or added). */
  private original(git: GitApi, repo: GitRepository, c: Change, uri: vscode.Uri): vscode.Uri {
    const s = repo.state;
    const isNew = [...s.workingTreeChanges, ...s.indexChanges, ...(s.untrackedChanges ?? [])].some(
      (x) => x.uri.fsPath === c.path && (x.status === UNTRACKED || x.status === INDEX_ADDED || x.status === INTENT_TO_ADD),
    );
    return isNew ? empty(uri) : git.toGitUri(uri, "HEAD");
  }

  /** Re-checks a change before showing it: a symlink now is marked, and not opened. */
  private async check(c: Change): Promise<Entry> {
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
      if (!auto) void vscode.window.showInformationMessage(`${name} is a symlink: it is not opened here. Look at it in Source Control.`);
      return;
    }
    const opts: vscode.TextDocumentShowOptions = { preview: true, preserveFocus: auto };
    const git = await gitApi();
    const repo = git?.getRepository(uri) ?? null;
    if (git === null || repo === null) {
      if (c.kind === "deleted") void vscode.window.showInformationMessage(`${name} was deleted (not in a Git repository).`);
      else await vscode.window.showTextDocument(uri, opts);
      return;
    }
    if (c.kind === "deleted") {
      await vscode.commands.executeCommand("vscode.diff", git.toGitUri(uri, "HEAD"), empty(uri), `${name} (deleted)`, opts);
      return;
    }
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
    // the folded group is left out: git shows nothing to review in it
    const list = this.split().active;
    for (const c of list) if (c.kind !== "deleted") await this.check(c); // a symlink now is marked
    const repoOf = (c: Change): GitRepository | null => git?.getRepository(vscode.Uri.file(c.path)) ?? null;
    const plan = reviewPlan(list, (c) => {
      const repo = repoOf(c);
      return git !== null && repo !== null && (c.kind === "deleted" || this.original(git, repo, c, vscode.Uri.file(c.path)).scheme !== EMPTY_SCHEME);
    });
    const rows = plan.rows.map((r): [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined] => {
      const uri = vscode.Uri.file(r.path);
      return [uri, r.head && git !== null ? git.toGitUri(uri, "HEAD") : undefined, r.now ? uri : undefined];
    });
    const links = plan.symlinks;
    if (links > 0) void vscode.window.showInformationMessage(`Claude Sandbox: ${links} symlink${links === 1 ? " is" : "s are"} left out of the review.`);
    if (rows.length === 0) {
      void vscode.window.showInformationMessage("Claude Sandbox: no changed files to review.");
      return;
    }
    await vscode.commands.executeCommand("vscode.changes", plan.title, rows);
  }

  // -- TreeDataProvider

  getChildren(element?: Node): Node[] {
    if (element === undefined) {
      const { active, quiet } = this.split();
      return quiet.length > 0 ? [...active, QUIET] : active;
    }
    return element === QUIET ? this.split().quiet : [];
  }

  getTreeItem(n: Node): vscode.TreeItem {
    if ("quiet" in n) {
      const count = this.split().quiet.length;
      const item = new vscode.TreeItem(`No change in git (${count})`, vscode.TreeItemCollapsibleState.Collapsed);
      item.iconPath = new vscode.ThemeIcon("eye-closed");
      item.tooltip = "Changed this session, but git shows no change now: back as HEAD has them, or ignored by git. Left out of Review All.";
      item.contextValue = "quiet";
      return item;
    }
    const c = n;
    const uri = vscode.Uri.file(c.path);
    const item = new vscode.TreeItem(uri, vscode.TreeItemCollapsibleState.None);
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const rel = folder ? path.relative(folder.uri.fsPath, path.dirname(c.path)) : path.dirname(c.path);
    // "created" is not shown: an atomic write (a temp file renamed over it) looks the same to the
    // watcher; Git decorations (U, M) on the item say what it is
    const tags = [c.kind === "deleted" ? "deleted" : "", c.symlink ? "symlink" : "", c.reviewed ? "reviewed" : ""]
      .filter(Boolean)
      .join(", ");
    item.description = [rel === "" ? "" : rel, tags ? `(${tags})` : ""].filter(Boolean).join(" ");
    item.tooltip = `${c.path}\n${c.kind}${c.reviewed ? ", reviewed" : ""}`;
    if (c.reviewed) item.iconPath = new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed"));
    item.contextValue = c.reviewed ? "change.reviewed" : "change.unreviewed";
    item.command = { command: "claudeSandbox.openChange", title: "Open diff", arguments: [c] };
    return item;
  }

  dispose(): void {
    this.stop();
    this.repos.forEach((d) => d.dispose());
    this.repos.clear();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.subs.forEach((s) => s.dispose());
  }
}
