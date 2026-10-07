// Feeds the editor's selection to the bridge through SelectionTracker (src/selection.ts): only a
// text editor showing a file replaces Claude's selection, so focusing the Claude terminal (or
// any non-text tab) keeps it. The bridge sends it only for workspace files (trust boundary
// rule 5) and otherwise clears Claude's.

import * as vscode from "vscode";
import type { Bridge } from "../mcp.ts";
import { SelectionTracker, type EditorSelection } from "../selection.ts";

function snapshot(editor: vscode.TextEditor | undefined): EditorSelection | undefined {
  if (editor === undefined) return undefined;
  const sel = editor.selection;
  return {
    scheme: editor.document.uri.scheme,
    fsPath: editor.document.uri.fsPath,
    start: { line: sel.start.line, character: sel.start.character },
    end: { line: sel.end.line, character: sel.end.character },
    text: editor.document.getText(sel),
  };
}

/** Whether a text tab still shows this file. */
function openIn(uri: vscode.Uri): boolean {
  return vscode.window.tabGroups.all.some((g) =>
    g.tabs.some((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === uri.toString()),
  );
}

export function trackSelection(getBridge: () => Bridge | undefined): vscode.Disposable {
  const tracker = new SelectionTracker(getBridge);
  const subs = [
    vscode.window.onDidChangeTextEditorSelection((e) => tracker.event(snapshot(e.textEditor))),
    vscode.window.onDidChangeActiveTextEditor((e) => tracker.event(snapshot(e))),
    vscode.window.tabGroups.onDidChangeTabs((e) => {
      for (const tab of e.closed) {
        const uri = tab.input instanceof vscode.TabInputText ? tab.input.uri : undefined;
        if (uri?.scheme === "file" && !openIn(uri)) tracker.closed(uri.fsPath);
      }
    }),
  ];
  tracker.event(snapshot(vscode.window.activeTextEditor));
  return new vscode.Disposable(() => {
    tracker.dispose();
    subs.forEach((s) => s.dispose());
  });
}
