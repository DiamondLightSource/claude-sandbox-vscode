// Explain / Reword / Tighten, the user's own presets, "Ask about selection…" and "Mention in
// Claude", from the editor's context menu and keybindings. Each goes to the linked session
// (src/session.ts decides whether and how it may be typed). Presets come only from the
// application-scoped setting `claudeSandbox.presets`: the workspace cannot set them.

import * as vscode from "vscode";
import { BUILTIN_PRESETS, customPresets } from "../ask.ts";
import type { FileRange, SendResult, Session } from "../session.ts";

export interface PresetHost {
  /** The running session, or null. */
  session(): Session | null;
  /** Show the session's terminal without taking focus. */
  reveal(): void;
  start(): Promise<void>;
}

function target(editor: vscode.TextEditor | undefined): FileRange | null {
  if (editor === undefined || editor.document.uri.scheme !== "file") return null;
  const sel = editor.selection;
  return {
    fsPath: editor.document.uri.fsPath,
    start: { line: sel.start.line, character: sel.start.character },
    end: { line: sel.end.line, character: sel.end.character },
    text: editor.document.getText(sel),
  };
}

async function report(r: SendResult, host: PresetHost): Promise<void> {
  if (r.ok) host.reveal();
  else void vscode.window.showWarningMessage(`Claude Sandbox: ${r.error}`);
}

function needSession(host: PresetHost): Session | null {
  const s = host.session();
  if (s !== null && s.running) return s;
  void vscode.window
    .showWarningMessage("Claude Sandbox: start the linked session first.", "Start")
    .then((pick) => pick && host.start());
  return null;
}

async function ask(host: PresetHost, question: string): Promise<void> {
  const s = needSession(host);
  if (s === null) return;
  const f = target(vscode.window.activeTextEditor);
  await report(await s.ask(f === null ? { question } : { question, file: f }), host);
}

export function registerPresets(host: PresetHost): vscode.Disposable[] {
  const subs = BUILTIN_PRESETS.map((p) =>
    vscode.commands.registerCommand(`claudeSandbox.preset.${p.id}`, () => ask(host, p.prompt)),
  );
  subs.push(
    vscode.commands.registerCommand("claudeSandbox.askSelection", async () => {
      if (needSession(host) === null) return;
      const q = await vscode.window.showInputBox({
        title: "Ask Claude about the selection",
        prompt: "Sent with the selection attached",
        ignoreFocusOut: true,
      });
      if (q?.trim()) await ask(host, q);
    }),
    vscode.commands.registerCommand("claudeSandbox.customPreset", async () => {
      if (needSession(host) === null) return;
      const presets = customPresets(vscode.workspace.getConfiguration("claudeSandbox").get("presets"));
      if (presets.length === 0) {
        const pick = await vscode.window.showInformationMessage(
          "No presets of your own yet: add them to the claudeSandbox.presets user setting.",
          "Open settings",
        );
        if (pick) void vscode.commands.executeCommand("workbench.action.openSettings", "claudeSandbox.presets");
        return;
      }
      const pick = await vscode.window.showQuickPick(
        presets.map((p) => ({ label: p.title, detail: p.prompt, preset: p })),
        { title: "Claude Sandbox preset", matchOnDetail: true },
      );
      if (pick) await ask(host, pick.preset.prompt);
    }),
    vscode.commands.registerCommand("claudeSandbox.mention", async () => {
      const s = needSession(host);
      if (s === null) return;
      const f = target(vscode.window.activeTextEditor);
      if (f === null) {
        void vscode.window.showWarningMessage("Claude Sandbox: mention needs a file open in the editor.");
        return;
      }
      await report(await s.mention(f), host);
    }),
  );
  return subs;
}
