// The "Changed this session" view: workspace files that changed while the linked session ran
// (src/changes.ts), from VS Code's file watcher. A click opens VS Code's diff against HEAD through
// the built-in Git extension's API (it reads the files, and runs git; the extension runs no git
// of its own and reads no file contents). There is no revert: that would be the host writing
// into the jail-writable workspace; Source Control's Discard is the way back.

import * as path from "node:path";
import * as vscode from "vscode";
import { ChangeSet, type Change } from "../changes.ts";

const EMPTY_SCHEME = "claude-sandbox-empty";
const AUTO_OPEN_MS = 400;

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

export class ChangesView implements vscode.TreeDataProvider<Change>, vscode.Disposable {
  private set: ChangeSet = new ChangeSet({ roots: [] });
  private readonly emitter = new vscode.EventEmitter<Change | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly view: vscode.TreeView<Change>;
  private readonly subs: vscode.Disposable[] = [];
  private watching: vscode.Disposable[] = [];
  private readonly autoTimers = new Map<string, NodeJS.Timeout>();
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
    const exclude = vscode.workspace.getConfiguration("files").get<Record<string, boolean>>("watcherExclude") ?? {};
    this.set = new ChangeSet({ roots, exclude: Object.keys(exclude).filter((k) => exclude[k] === true) });
    const w = vscode.workspace.createFileSystemWatcher("**/*");
    const saved = (d: vscode.TextDocument): void => {
      if (d.uri.scheme === "file") this.set.userSaved(d.uri.fsPath, Date.now());
    };
    this.watching = [
      w,
      w.onDidCreate((u) => void this.created(u)),
      w.onDidChange((u) => this.record("changed", u)),
      w.onDidDelete((u) => this.record("deleted", u)),
      vscode.workspace.onWillSaveTextDocument((e) => saved(e.document)),
      vscode.workspace.onDidSaveTextDocument(saved),
    ];
    void vscode.commands.executeCommand("setContext", "claudeSandbox.watching", true);
    this.refresh();
  }

  /** The session ended: the list stays for review, nothing more is recorded. */
  stop(): void {
    this.watching.forEach((d) => d.dispose());
    this.watching = [];
    for (const t of this.autoTimers.values()) clearTimeout(t);
    this.autoTimers.clear();
    void vscode.commands.executeCommand("setContext", "claudeSandbox.watching", false);
  }

  private async created(u: vscode.Uri): Promise<void> {
    if (u.scheme !== "file" || !this.set.wanted(u.fsPath)) return;
    try {
      // metadata only: a new folder is not listed (its files are)
      if ((await vscode.workspace.fs.stat(u)).type & vscode.FileType.Directory) return;
    } catch {
      // gone already
    }
    this.record("created", u);
  }

  private record(kind: Change["kind"], u: vscode.Uri): void {
    if (u.scheme !== "file") return;
    const c = this.set.event(kind, u.fsPath, Date.now());
    this.refresh();
    if (c === null || c.kind === "deleted") return;
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

  private refresh(): void {
    this.emitter.fire(undefined);
    const n = this.set.unreviewed;
    this.view.badge = n > 0 ? { value: n, tooltip: `${n} changed file${n === 1 ? "" : "s"} not reviewed` } : undefined;
    this.view.message = this.set.size === 0 && this.watching.length > 0 ? "No files have changed yet this session." : "";
    this.onCount(n);
  }

  get unreviewed(): number {
    return this.set.unreviewed;
  }

  /** VS Code's diff against HEAD; a file HEAD lacks opens as itself; a deleted one, HEAD vs empty. */
  async open(c: Change, auto: boolean): Promise<void> {
    const uri = vscode.Uri.file(c.path);
    const name = path.basename(c.path);
    const opts: vscode.TextDocumentShowOptions = { preview: true, preserveFocus: auto };
    const git = await gitApi();
    const repo = git?.getRepository(uri) ?? null;
    if (git === null || repo === null) {
      if (c.kind === "deleted") void vscode.window.showInformationMessage(`${name} was deleted (not in a Git repository).`);
      else await vscode.window.showTextDocument(uri, opts);
      return;
    }
    const head = git.toGitUri(uri, "HEAD");
    if (c.kind === "deleted") {
      const empty = vscode.Uri.from({ scheme: EMPTY_SCHEME, path: uri.path });
      await vscode.commands.executeCommand("vscode.diff", head, empty, `${name} (deleted)`, opts);
      return;
    }
    const s = repo.state;
    const isNew = [...s.workingTreeChanges, ...s.indexChanges, ...(s.untrackedChanges ?? [])].some(
      (x) => x.uri.fsPath === c.path && (x.status === UNTRACKED || x.status === INDEX_ADDED || x.status === INTENT_TO_ADD),
    );
    if (isNew) await vscode.window.showTextDocument(uri, opts);
    else await vscode.commands.executeCommand("vscode.diff", head, uri, `${name} (HEAD ↔ now)`, opts);
  }

  // -- TreeDataProvider

  getChildren(element?: Change): Change[] {
    return element === undefined ? this.set.list() : [];
  }

  getTreeItem(c: Change): vscode.TreeItem {
    const uri = vscode.Uri.file(c.path);
    const item = new vscode.TreeItem(uri, vscode.TreeItemCollapsibleState.None);
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const rel = folder ? path.relative(folder.uri.fsPath, path.dirname(c.path)) : path.dirname(c.path);
    // "created" is not shown: an atomic write (a temp file renamed over it) looks the same to the
    // watcher; Git decorations (U, M) on the item say what it is
    const tags = [c.kind === "deleted" ? "deleted" : "", c.reviewed ? "reviewed" : ""].filter(Boolean).join(", ");
    item.description = [rel === "" ? "" : rel, tags ? `(${tags})` : ""].filter(Boolean).join(" ");
    item.tooltip = `${c.path}\n${c.kind}${c.reviewed ? ", reviewed" : ""}`;
    if (c.reviewed) item.iconPath = new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed"));
    item.contextValue = c.reviewed ? "change.reviewed" : "change.unreviewed";
    item.command = { command: "claudeSandbox.openChange", title: "Open diff", arguments: [c] };
    return item;
  }

  dispose(): void {
    this.stop();
    this.subs.forEach((s) => s.dispose());
  }
}
