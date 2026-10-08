// Explain / Reword / Tighten, the user's own presets and "Mention in Claude", from the editor's
// context menu and keybindings, and the presets, for a selection, from the Refactor menu and
// Ctrl+. (as code actions). Each goes to the linked session (src/session.ts decides whether and
// how it may be typed). The user's presets come only from the application-scoped setting
// `claudeSandbox.presets`: the workspace cannot set them, and a code action names one by title,
// never carries a prompt.

import * as vscode from "vscode";
import { BUILTIN_PRESETS, customPresets, type Preset } from "../ask.ts";
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

function userPresets(): Preset[] {
  return customPresets(vscode.workspace.getConfiguration("claudeSandbox").get("presets"));
}

const KIND = vscode.CodeActionKind.RefactorRewrite.append("claudeSandbox");

/** A selection's presets, the user's first then the built-in ones, in the Refactor menu and Ctrl+. */
class PresetActions implements vscode.CodeActionProvider {
  static readonly metadata: vscode.CodeActionProviderMetadata = { providedCodeActionKinds: [KIND] };

  provideCodeActions(_doc: vscode.TextDocument, range: vscode.Range | vscode.Selection): vscode.CodeAction[] {
    if (range.isEmpty) return [];
    const action = (title: string, command: string, args: unknown[] = []): vscode.CodeAction => {
      const a = new vscode.CodeAction(`Claude: ${title}`, KIND);
      a.command = { title, command, arguments: args };
      return a;
    };
    return [
      ...userPresets().map((p) => action(p.title, "claudeSandbox.runPreset", [p.title])),
      ...BUILTIN_PRESETS.map((p) => action(p.title, `claudeSandbox.preset.${p.id}`)),
    ];
  }
}

export function registerPresets(host: PresetHost): vscode.Disposable[] {
  const subs = BUILTIN_PRESETS.map((p) =>
    vscode.commands.registerCommand(`claudeSandbox.preset.${p.id}`, () => ask(host, p.prompt)),
  );
  subs.push(
    vscode.languages.registerCodeActionsProvider({ scheme: "file" }, new PresetActions(), PresetActions.metadata),
    vscode.commands.registerCommand("claudeSandbox.runPreset", async (title: unknown) => {
      const p = userPresets().find((x) => x.title === title);
      if (p !== undefined) await ask(host, p.prompt);
    }),
    vscode.commands.registerCommand("claudeSandbox.customPreset", async () => {
      if (needSession(host) === null) return;
      const presets = userPresets();
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
