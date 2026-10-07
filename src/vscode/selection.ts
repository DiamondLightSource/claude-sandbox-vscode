// Tracks the active editor's selection for the bridge, which sends it to Claude only for
// workspace files (trust boundary rule 5) and otherwise clears Claude's.

import * as vscode from "vscode";
import type { Bridge } from "../mcp.ts";

const DEBOUNCE_MS = 150;
const TEXT_MAX = 64 * 1024;

export function trackSelection(getBridge: () => Bridge | undefined): vscode.Disposable {
  let timer: NodeJS.Timeout | undefined;
  const report = (editor: vscode.TextEditor | undefined): void => {
    const bridge = getBridge();
    if (bridge === undefined) return;
    if (editor === undefined || editor.document.uri.scheme !== "file") {
      bridge.clearSelection();
      return;
    }
    const sel = editor.selection;
    const text = editor.document.getText(sel);
    bridge.select(
      editor.document.uri.fsPath,
      { line: sel.start.line, character: sel.start.character },
      { line: sel.end.line, character: sel.end.character },
      text.length > TEXT_MAX ? text.slice(0, TEXT_MAX) : text,
    );
  };
  const later = (editor: vscode.TextEditor | undefined): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => report(editor), DEBOUNCE_MS);
  };
  const subs = [
    vscode.window.onDidChangeTextEditorSelection((e) => later(e.textEditor)),
    vscode.window.onDidChangeActiveTextEditor((e) => later(e)),
  ];
  later(vscode.window.activeTextEditor);
  return new vscode.Disposable(() => {
    if (timer) clearTimeout(timer);
    subs.forEach((s) => s.dispose());
  });
}
