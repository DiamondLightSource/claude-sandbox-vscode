// Which editor selection Claude should have (no vscode import; the glue is
// src/vscode/selection.ts). The Claude terminal lives in the editor area, so clicking into it
// makes VS Code report "no active text editor": that must not clear what the user selected
// just before (Claude showed "N lines selected" and the user is now typing a question about it).
//
// So only a text editor showing a file replaces Claude's selection: its selection, or with
// nothing selected its cursor position (file and line, as Claude Code expects). The bridge
// sends it only for a workspace file and otherwise clears Claude's (trust boundary rule 5), so
// selecting in a file outside the workspace clears it. Anything else (the terminal, a webview,
// no editor, an editor that is not a file: output, untitled, a diff's proposal side) keeps the
// last one, and does not cancel one still waiting for its debounce.

import type { Position } from "./mcp.ts";

export const DEBOUNCE_MS = 150;
export const TEXT_MAX = 64 * 1024;

export interface EditorSelection {
  /** The document's URI scheme ("file" for a file on disk). */
  scheme: string;
  fsPath: string;
  start: Position;
  end: Position;
  text: string;
}

/** What the bridge needs. */
export interface SelectionSink {
  select(fsPath: string, start: Position, end: Position, text: string): void;
}

/** Whether an editor event replaces Claude's selection. */
export function replacesSelection(e: EditorSelection | undefined): e is EditorSelection {
  return e !== undefined && e.scheme === "file";
}

export class SelectionTracker {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly sink: () => SelectionSink | undefined;
  private readonly debounceMs: number;

  constructor(sink: () => SelectionSink | undefined, debounceMs = DEBOUNCE_MS) {
    this.sink = sink;
    this.debounceMs = debounceMs;
  }

  /** An active-editor or selection change; undefined: no text editor (the terminal has focus). */
  event(e: EditorSelection | undefined): void {
    if (!replacesSelection(e)) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const text = e.text.length > TEXT_MAX ? e.text.slice(0, TEXT_MAX) : e.text;
      this.sink()?.select(e.fsPath, e.start, e.end, text);
    }, this.debounceMs);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}
