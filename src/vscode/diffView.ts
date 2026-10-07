// openDiff's UI: the file on disk (read-only, left) beside the proposal (right, editable in
// memory only) in VS Code's diff editor, with Accept and Reject in the editor title of either
// side. Nothing here writes a workspace file (trust boundary rule 3): Accept hands the right
// side's text to the bridge, which answers FILE_SAVED, and Claude writes the file from the
// jail. What each event means (closing the tab is a rejection...) is src/diffTabs.ts.

import * as vscode from "vscode";
import { DiffTabs, diffColumn, diffIdOf, ORIGINAL_SCHEME, PROPOSAL_SCHEME, type Entry } from "../diffTabs.ts";
import type { Decision, DiffPresenter, DiffView } from "../mcp.ts";

interface Shown {
  view: DiffView;
  left: vscode.Uri;
  right: vscode.Uri;
  proposal: Uint8Array;
}

/** In-memory files for the proposals; writes stay here. */
class ProposalFs implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;
  private readonly tabs: DiffTabs<Shown>;
  constructor(tabs: DiffTabs<Shown>) {
    this.tabs = tabs;
  }

  private find(uri: vscode.Uri): Entry<Shown> {
    const e = this.tabs.get(diffIdOf(uri) ?? "");
    if (e === undefined) throw vscode.FileSystemError.FileNotFound(uri);
    return e;
  }
  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }
  stat(uri: vscode.Uri): vscode.FileStat {
    const e = this.find(uri);
    return { type: vscode.FileType.File, ctime: 0, mtime: e.mtime, size: e.data.proposal.length };
  }
  readDirectory(): [string, vscode.FileType][] {
    return [];
  }
  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions();
  }
  readFile(uri: vscode.Uri): Uint8Array {
    return this.find(uri).data.proposal;
  }
  writeFile(uri: vscode.Uri, content: Uint8Array): void {
    const e = this.find(uri);
    e.data.proposal = content;
    this.tabs.written(e.id);
  }
  delete(): void {
    throw vscode.FileSystemError.NoPermissions();
  }
  rename(): void {
    throw vscode.FileSystemError.NoPermissions();
  }
}

export class DiffEditors implements DiffPresenter, vscode.Disposable {
  private readonly tabs: DiffTabs<Shown>;
  private readonly subs: vscode.Disposable[] = [];

  private readonly claudeName: () => string | undefined;

  /** `claudeName`: the Claude terminal's current name (its tab's label), if one is running. */
  constructor(decide: (id: string, d: Decision) => boolean, claudeName: () => string | undefined = () => undefined) {
    this.tabs = new DiffTabs<Shown>(decide);
    this.claudeName = claudeName;
    this.subs.push(
      vscode.workspace.registerFileSystemProvider(PROPOSAL_SCHEME, new ProposalFs(this.tabs), { isCaseSensitive: true }),
      vscode.workspace.registerTextDocumentContentProvider(ORIGINAL_SCHEME, {
        provideTextDocumentContent: (uri) => this.tabs.get(diffIdOf(uri) ?? "")?.data.view.old ?? "",
      }),
      vscode.window.tabGroups.onDidChangeTabs((e) => {
        for (const tab of e.closed) {
          const id = this.idOf(tab);
          if (id !== undefined) this.tabs.tabClosed(id, this.openTabs(id).length);
        }
      }),
      vscode.commands.registerCommand("claudeSandbox.acceptDiff", (uri?: vscode.Uri) => this.answer(true, uri)),
      vscode.commands.registerCommand("claudeSandbox.rejectDiff", (uri?: vscode.Uri) => this.answer(false, uri)),
    );
  }

  private idOf(tab: vscode.Tab): string | undefined {
    const input = tab.input;
    if (input instanceof vscode.TabInputTextDiff && input.modified.scheme === PROPOSAL_SCHEME) {
      return diffIdOf(input.modified);
    }
    return undefined;
  }

  private openTabs(id: string): vscode.Tab[] {
    return vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => this.idOf(t) === id);
  }

  show(view: DiffView): void {
    const base = view.file.split("/").pop() ?? "file";
    const left = vscode.Uri.from({ scheme: ORIGINAL_SCHEME, path: `/${view.id}/${base}` });
    const right = vscode.Uri.from({ scheme: PROPOSAL_SCHEME, path: `/${view.id}/${base}` });
    this.tabs.add(view.id, { view, left, right, proposal: new TextEncoder().encode(view.proposed) });
    const title = `${view.title}${view.exists ? "" : " (new file)"}`;
    // focus stays in the Claude terminal: Enter there answers Claude's prompt; in the diff it
    // would have typed a newline into the proposal. The terminal's own group is avoided so
    // the diff neither hides it nor, closing, takes focus with it.
    const column = this.column();
    void vscode.commands.executeCommand("vscode.diff", left, right, title, {
      preview: false,
      preserveFocus: true,
      ...(column === undefined ? {} : { viewColumn: column === "beside" ? vscode.ViewColumn.Beside : column }),
    });
  }

  private column(): number | "beside" | undefined {
    const name = this.claudeName();
    const all = vscode.window.tabGroups.all;
    const active = vscode.window.tabGroups.activeTabGroup;
    return diffColumn(
      all.map((g) => ({
        column: g.viewColumn,
        active: g === active,
        holdsClaude: name !== undefined && g.tabs.some((t) => t.input instanceof vscode.TabInputTerminal && t.label === name),
      })),
    );
  }

  /** The bridge closes it: no answer. */
  close(id: string): void {
    if (this.tabs.closeQuietly(id)) void this.closeTabs(id);
  }

  private async closeTabs(id: string): Promise<void> {
    const e = this.tabs.get(id);
    if (e === undefined) return;
    // an edited proposal is saved into memory first, so closing does not ask
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === e.data.right.toString());
    if (doc?.isDirty) await doc.save();
    const tabs = this.openTabs(id);
    // preserveFocus: by default closing focuses the tab's group, which then empties and goes,
    // leaving focus nowhere instead of in the Claude terminal
    if (tabs.length) await vscode.window.tabGroups.close(tabs, true);
    else this.tabs.noTabs(id);
  }

  /** Accept or Reject, from either side of the diff (the command's URI, else the focused editor). */
  private async answer(accept: boolean, uri?: vscode.Uri): Promise<void> {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    const id = target === undefined ? undefined : diffIdOf(target);
    const e = id === undefined ? undefined : this.tabs.get(id);
    if (id === undefined || e === undefined) return;
    let d: { kind: "accept"; contents: string } | { kind: "reject" } = { kind: "reject" };
    if (accept) {
      const doc = vscode.workspace.textDocuments.find((x) => x.uri.toString() === e.data.right.toString());
      d = { kind: "accept", contents: doc ? doc.getText() : new TextDecoder().decode(e.data.proposal) };
    }
    if (this.tabs.answer(id, d)) await this.closeTabs(id);
  }

  dispose(): void {
    this.subs.forEach((s) => s.dispose());
    this.tabs.clear();
  }
}
