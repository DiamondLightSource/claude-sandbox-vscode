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
import { mergeSettings, SettingsError, shellQuote, withReviewEdits, withSettings, type LinkSettings } from "./settings.ts";
import { ChangesView } from "./vscode/changesView.ts";
import { vscodeDiagnostics } from "./vscode/diagnostics.ts";
import { DiffEditors } from "./vscode/diffView.ts";
import { checkInstalled, checkOutdated } from "./vscode/installOffer.ts";
import { registerPresets } from "./vscode/presets.ts";
import { trackSelection } from "./vscode/selection.ts";
import { ClaudeTerminal } from "./vscode/terminal.ts";

let link: IdeLink | undefined;
// the folder the link was started for: its socket is there, and Claude runs in it
let linkRoot: string | undefined;
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
  const diffs = new DiffEditors(
    (id, d) => link?.bridge.decide(id, d) ?? false,
    () => (claude?.running ? claude.terminal.name : undefined),
  );

  const folders = (): string[] =>
    (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === "file").map((f) => f.uri.fsPath);
  // claudeSandbox.reviewEdits (default off): Edit/Write/NotebookEdit always ask, so each file
  // edit opens as a diff here, whatever the permission mode
  const sessionSettings = (l: IdeLink): LinkSettings =>
    vscode.workspace.getConfiguration("claudeSandbox").get<boolean>("reviewEdits", false) === true
      ? withReviewEdits(l.settings)
      : l.settings;
  const errorMessage = (err: unknown): void => {
    void vscode.window.showErrorMessage(`Claude Sandbox: ${err instanceof Error ? err.message : String(err)}`);
  };

  // the folder Claude runs in, which claude-sandbox makes its one writable project: asked for
  // when the window has more than one, the last one chosen offered first
  const LAST_ROOT = "claudeSandbox.lastRoot";
  const pickRoot = async (roots: readonly string[]): Promise<string | undefined> => {
    if (roots.length === 1) return roots[0];
    const last = context.workspaceState.get<string>(LAST_ROOT);
    const ordered = last !== undefined && roots.includes(last) ? [last, ...roots.filter((r) => r !== last)] : [...roots];
    const pick = await vscode.window.showQuickPick(
      ordered.map((r) => ({ label: vscode.workspace.getWorkspaceFolder(vscode.Uri.file(r))?.name ?? r, description: r, root: r })),
      { title: "Claude Sandbox: start in which folder?", placeHolder: "Claude can write only this folder" },
    );
    if (pick !== undefined) await context.workspaceState.update(LAST_ROOT, pick.root);
    return pick?.root;
  };

  const ensureLink = async (root: string): Promise<IdeLink | undefined> => {
    if (link !== undefined && linkRoot === root) return link;
    if (link !== undefined) await closeLink();
    try {
      linkRoot = root;
      link = await IdeLink.start({
        folders: [root],
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
    linkRoot = undefined;
    linkState = "off";
    showState();
    await l?.close();
  };

  const start = async (folder?: vscode.Uri): Promise<void> => {
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
    // from the Explorer's context menu on a workspace folder, that one; otherwise ask
    const given = folder instanceof vscode.Uri && roots.includes(folder.fsPath) ? folder.fsPath : undefined;
    const cwd = given ?? (await pickRoot(roots));
    if (cwd === undefined) return;
    const l = await ensureLink(cwd);
    if (l === undefined) return;
    let args: string[];
    try {
      const user = extraArgs(vscode.workspace.getConfiguration("claudeSandbox").get("extraArgs"));
      args = withSettings([CLAUDE, ...user], sessionSettings(l)).slice(1);
    } catch (err) {
      await closeLink();
      errorMessage(err instanceof SettingsError ? err.message : err);
      return;
    }
    claude?.dispose();
    // cwd: the chosen folder, where the link's socket is and what Claude Code takes as its
    // project (the same folder every time, whichever file happens to be active)
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
    changes.start([cwd]);
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
    // paths are checked against the link's folder while it is still open in the window (the
    // lock's workspaceFolders stay stale: Claude connects whatever they say, the port being explicit)
    vscode.workspace.onDidChangeWorkspaceFolders(() => link?.setFolders(folders().filter((f) => f === linkRoot))),
    vscode.commands.registerCommand("claudeSandbox.start", start),
    vscode.commands.registerCommand("claudeSandbox.copySettings", async () => {
      const roots = folders();
      if (roots.length === 0) {
        void vscode.window.showWarningMessage("Claude Sandbox: open a folder first.");
        return;
      }
      // a linked session keeps its link (and folder); otherwise ask which folder it is for
      const root = link?.linked ? linkRoot : await pickRoot(roots);
      if (root === undefined) return;
      const l = await ensureLink(root);
      if (l === undefined) return;
      await vscode.env.clipboard.writeText(`claude --settings ${shellQuote(JSON.stringify(mergeSettings(null, sessionSettings(l))))}`);
      void vscode.window.showInformationMessage(
        `Claude Sandbox: launch command copied. Paste it into a devcontainer terminal in ${root}. It holds the link's token.`,
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
  linkRoot = undefined;
  await l?.close();
}
