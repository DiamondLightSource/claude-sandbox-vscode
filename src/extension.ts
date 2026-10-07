// Wires the bridge (no vscode imports) to VS Code: "Claude Sandbox: Start" opens the one linked
// session as a terminal in the editor area (src/vscode/terminal.ts), the presets type asks into
// it (src/vscode/presets.ts), the "Changed this session" view lists what changed while it ran
// (src/vscode/changesView.ts), and on startup the install offer and the outdated notice
// (src/vscode/installOffer.ts). "Copy launch command" stays as an advanced way to link a Claude
// started by hand.
//
// A window reload ends the session: deactivation closes the link and hangs up the terminal's
// pty, and the reloaded window draws a new port and token.

import * as vscode from "vscode";
import { extraArgs } from "./ask.ts";
import { IdeLink } from "./link.ts";
import type { Logger } from "./log.ts";
import type { LinkState } from "./mcp.ts";
import { CLAUDE } from "./ptyHelper.ts";
import { mergeSettings, SettingsError, shellQuote, withSettings } from "./settings.ts";
import { ChangesView } from "./vscode/changesView.ts";
import { vscodeDiagnostics } from "./vscode/diagnostics.ts";
import { DiffEditors } from "./vscode/diffView.ts";
import { checkInstalled, checkOutdated } from "./vscode/installOffer.ts";
import { registerPresets } from "./vscode/presets.ts";
import { trackSelection } from "./vscode/selection.ts";
import { ClaudeTerminal } from "./vscode/terminal.ts";

let link: IdeLink | undefined;
let claude: ClaudeTerminal | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const out = vscode.window.createOutputChannel("Claude Sandbox");
  const logger: Logger = { info: (m) => out.appendLine(m) };
  const status = vscode.window.createStatusBarItem("claudeSandbox.status", vscode.StatusBarAlignment.Right, 100);
  status.name = "Claude Sandbox";
  status.command = "claudeSandbox.start";
  const changes = new ChangesView();
  let linkState: LinkState = "off";
  const showState = (): void => {
    const running = claude?.running === true;
    const s = running || link !== undefined ? linkState : "off";
    const n = changes.unreviewed;
    status.text = `$(${s === "connected" ? "sparkle" : s === "waiting" ? "sync~spin" : "circle-slash"}) Claude: ${s}${n > 0 ? ` · ${n} changed` : ""}`;
    status.tooltip = running ? "Claude Sandbox: show the session" : "Claude Sandbox: Start";
    status.show();
  };
  changes.onCount = showState;
  const onState = (s: LinkState): void => {
    linkState = s;
    showState();
  };
  showState();
  const diffs = new DiffEditors((id, d) => link?.bridge.decide(id, d) ?? false);

  const folders = (): string[] =>
    (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === "file").map((f) => f.uri.fsPath);
  const errorMessage = (err: unknown): void => {
    void vscode.window.showErrorMessage(`Claude Sandbox: ${err instanceof Error ? err.message : String(err)}`);
  };

  const ensureLink = async (): Promise<IdeLink | undefined> => {
    if (link !== undefined) return link;
    try {
      link = await IdeLink.start({
        folders: folders(),
        presenter: diffs,
        diagnostics: vscodeDiagnostics,
        logger,
        version: String(context.extension.packageJSON.version ?? "dev"),
        onState,
      });
      onState("waiting");
      return link;
    } catch (err) {
      errorMessage(err);
      return undefined;
    }
  };
  const closeLink = async (): Promise<void> => {
    const l = link;
    link = undefined;
    linkState = "off";
    showState();
    await l?.close();
  };

  const start = async (): Promise<void> => {
    if (claude?.running) {
      claude.terminal.show();
      return;
    }
    if (!(await checkInstalled(logger.info))) return;
    const roots = folders();
    if (roots.length === 0) {
      void vscode.window.showWarningMessage("Claude Sandbox: open a folder first.");
      return;
    }
    // a link that a Claude started by hand (Copy launch command) holds is not ours to reuse
    if (link?.linked) {
      void vscode.window.showWarningMessage(
        "Claude Sandbox: a Claude started by hand is linked to this window. Exit it first.",
      );
      return;
    }
    const l = await ensureLink();
    if (l === undefined) return;
    let args: string[];
    try {
      const user = extraArgs(vscode.workspace.getConfiguration("claudeSandbox").get("extraArgs"));
      args = withSettings([CLAUDE, ...user], l.settings).slice(1);
    } catch (err) {
      await closeLink();
      errorMessage(err instanceof SettingsError ? err.message : err);
      return;
    }
    claude?.dispose();
    // cwd: the first workspace folder, where the link's socket is and what Claude Code takes
    // as its project (the same folder every time, whichever file happens to be active)
    const cwd = roots[0]!;
    const term = new ClaudeTerminal({
      args,
      cwd,
      link: () => link?.bridge ?? null,
      log: logger.info,
      onExit: (code) => {
        logger.info(`[session] Claude exited (${code})`);
        changes.stop();
        void vscode.commands.executeCommand("setContext", "claudeSandbox.running", false);
        void closeLink();
      },
    });
    claude = term;
    changes.start(roots);
    void vscode.commands.executeCommand("setContext", "claudeSandbox.running", true);
    term.terminal.show();
    showState();
  };

  context.subscriptions.push(
    out,
    status,
    diffs,
    changes,
    trackSelection(() => link?.bridge),
    // paths are checked against the current folders (the lock's workspaceFolders stay stale:
    // Claude connects whatever they say, the port being explicit)
    vscode.workspace.onDidChangeWorkspaceFolders(() => link?.setFolders(folders())),
    vscode.commands.registerCommand("claudeSandbox.start", start),
    vscode.commands.registerCommand("claudeSandbox.copySettings", async () => {
      const l = await ensureLink();
      if (l === undefined) return;
      await vscode.env.clipboard.writeText(`claude --settings ${shellQuote(JSON.stringify(mergeSettings(null, l.settings)))}`);
      void vscode.window.showInformationMessage(
        "Claude Sandbox: launch command copied. Paste it into a devcontainer terminal. It holds the link's token.",
      );
    }),
    ...registerPresets({
      session: () => (claude?.running ? claude.session : null),
      reveal: () => claude?.terminal.show(true),
      start,
    }),
    { dispose: () => claude?.dispose() },
  );

  // the install offer and the outdated notice, after startup
  void (async () => {
    if (await checkInstalled(logger.info)) await checkOutdated(context.globalState, logger.info);
  })().catch((err) => logger.info(`[install] ${String(err)}`));
}

export async function deactivate(): Promise<void> {
  claude?.dispose();
  claude = undefined;
  const l = link;
  link = undefined;
  await l?.close();
}
