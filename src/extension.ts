// Wires the bridge (no vscode imports) to VS Code. Stage 1: the link is started by hand
// ("Claude Sandbox: Start IDE link") and "Copy launch command" puts
// `claude --settings '<json>'` (the sandbox's claude shadow) on the clipboard.
//
// TODO(stage 2): the terminal launcher (the claude shadow as the terminal's own process with the
// merged --settings, settings.withSettings) and ask/mention presets (paste.ts).

import * as vscode from "vscode";
import { IdeLink } from "./link.ts";
import type { Logger } from "./log.ts";
import { mergeSettings, shellQuote } from "./settings.ts";
import { vscodeDiagnostics } from "./vscode/diagnostics.ts";
import { DiffEditors } from "./vscode/diffView.ts";
import { trackSelection } from "./vscode/selection.ts";

let link: IdeLink | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const out = vscode.window.createOutputChannel("Claude Sandbox");
  const logger: Logger = { info: (m) => out.appendLine(m) };
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  const showState = (s: string): void => {
    status.text = `$(plug) Claude: ${s}`;
    status.show();
  };
  const diffs = new DiffEditors((id, d) => link?.bridge.decide(id, d) ?? false);

  const folders = (): string[] =>
    (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === "file").map((f) => f.uri.fsPath);

  const start = async (): Promise<void> => {
    if (link !== undefined) return;
    try {
      link = await IdeLink.start({
        folders: folders(),
        presenter: diffs,
        diagnostics: vscodeDiagnostics,
        logger,
        version: String(context.extension.packageJSON.version ?? "dev"),
        onState: showState,
      });
      showState("waiting");
    } catch (err) {
      void vscode.window.showErrorMessage(`Claude Sandbox: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const stop = async (): Promise<void> => {
    const l = link;
    link = undefined;
    status.hide();
    await l?.close();
  };

  context.subscriptions.push(
    out,
    status,
    diffs,
    trackSelection(() => link?.bridge),
    // paths are checked against the current folders (the lock's workspaceFolders stay stale:
    // Claude connects whatever they say, the port being explicit)
    vscode.workspace.onDidChangeWorkspaceFolders(() => link?.setFolders(folders())),
    vscode.commands.registerCommand("claudeSandbox.startLink", start),
    vscode.commands.registerCommand("claudeSandbox.stopLink", stop),
    vscode.commands.registerCommand("claudeSandbox.copySettings", async () => {
      await start();
      if (link === undefined) return;
      await vscode.env.clipboard.writeText(
        `claude --settings ${shellQuote(JSON.stringify(mergeSettings(null, link.settings)))}`,
      );
      void vscode.window.showInformationMessage(
        "Claude Sandbox: launch command copied. Paste it into a devcontainer terminal. It holds the link's token.",
      );
    }),
  );
}

export async function deactivate(): Promise<void> {
  const l = link;
  link = undefined;
  await l?.close();
}
