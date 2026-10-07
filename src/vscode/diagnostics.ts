// getDiagnostics from VS Code's language features. The bridge filters what this returns to
// workspace files (trust boundary rule 4); this only converts.

import * as vscode from "vscode";
import type { DiagnosticsSource, FileDiagnostics } from "../mcp.ts";

const SEVERITY = ["Error", "Warning", "Information", "Hint"];

function convert(uri: vscode.Uri, list: readonly vscode.Diagnostic[]): FileDiagnostics {
  return {
    uri: uri.toString(),
    fsPath: uri.fsPath,
    diagnostics: list.map((d) => {
      const code = typeof d.code === "object" ? d.code.value : d.code;
      return {
        message: d.message,
        severity: SEVERITY[d.severity] ?? "Error",
        range: {
          start: { line: d.range.start.line, character: d.range.start.character },
          end: { line: d.range.end.line, character: d.range.end.character },
        },
        ...(d.source !== undefined ? { source: d.source } : {}),
        ...(code !== undefined ? { code: String(code) } : {}),
      };
    }),
  };
}

export const vscodeDiagnostics: DiagnosticsSource = {
  get(fsPath?: string): FileDiagnostics[] {
    if (fsPath !== undefined) {
      const uri = vscode.Uri.file(fsPath);
      return [convert(uri, vscode.languages.getDiagnostics(uri))];
    }
    return vscode.languages
      .getDiagnostics()
      .filter(([uri]) => uri.scheme === "file")
      .map(([uri, list]) => convert(uri, list));
  },
};
