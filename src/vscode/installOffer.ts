// The install offer and the outdated notice (trust boundary rule 10). Nothing runs without the
// user's click; the command is fixed in src/install.ts, never read from settings; an outdated
// install gets a notice only, and a failed check (no network) says nothing.

import { execFile } from "node:child_process";
import * as vscode from "vscode";
import {
  CLAUDE_SANDBOX,
  DAY_MS,
  DOCS_URL,
  findUvx,
  INSTALL_SCRIPT,
  installArgv,
  installState,
  outdated,
  parseVersionOutput,
  PYPI_URL,
  pypiLatest,
} from "../install.ts";

const LAST_CHECK = "claudeSandbox.lastVersionCheck";

/** Offers the install if claude-sandbox is missing. True if it is installed. */
export async function checkInstalled(log: (m: string) => void): Promise<boolean> {
  const st = installState();
  if (st.installed) return true;
  log(`[install] ${st.why ?? "not installed"}`);
  const uvx = findUvx();
  if (uvx === null) {
    const pick = await vscode.window.showWarningMessage(
      "claude-sandbox isn't installed in this container, and uv (uvx) isn't either.",
      "How to install",
    );
    if (pick) void vscode.env.openExternal(vscode.Uri.parse(DOCS_URL));
    return false;
  }
  const argv = installArgv(process.getuid?.() ?? 0, uvx);
  const pick = await vscode.window.showWarningMessage(
    "claude-sandbox isn't installed in this container.",
    { detail: `Install runs \`${argv.join(" ")}\` in a terminal.` },
    "Install",
    "About claude-sandbox",
  );
  if (pick === "About claude-sandbox") void vscode.env.openExternal(vscode.Uri.parse(DOCS_URL));
  if (pick !== "Install") return false;
  const term = vscode.window.createTerminal({
    name: "claude-sandbox install",
    shellPath: "/bin/sh",
    shellArgs: ["-c", INSTALL_SCRIPT, "sh", ...argv],
  });
  term.show();
  const sub = vscode.window.onDidCloseTerminal((t) => {
    if (t !== term) return;
    sub.dispose();
    if (installState().installed) {
      void vscode.window.showInformationMessage("claude-sandbox is installed. Run Claude Sandbox: Start.");
    }
  });
  return false;
}

function installedVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(CLAUDE_SANDBOX, ["version"], { timeout: 15_000, maxBuffer: 64 * 1024 }, (err, stdout) => {
      resolve(err ? null : parseVersionOutput(String(stdout)));
    });
  });
}

/** At most once a day: a notice when PyPI has a newer claude-sandbox. Never upgrades. */
export async function checkOutdated(state: vscode.Memento, log: (m: string) => void): Promise<void> {
  const last = state.get<number>(LAST_CHECK, 0);
  if (Date.now() - last < DAY_MS) return;
  await state.update(LAST_CHECK, Date.now());
  const have = await installedVersion();
  if (have === null) return;
  let latest: string | null = null;
  try {
    const res = await fetch(PYPI_URL, { signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } });
    if (!res.ok) return;
    latest = pypiLatest(await res.json());
  } catch {
    return; // offline: silent
  }
  if (latest === null || !outdated(have, latest)) return;
  log(`[install] claude-sandbox ${have} installed, ${latest} on PyPI`);
  void vscode.window.showInformationMessage(
    `claude-sandbox ${latest} is available (this container has ${have}). Update it in a devcontainer terminal with \`uvx claude-sandbox@latest install\` (sudo if not root).`,
  );
}
