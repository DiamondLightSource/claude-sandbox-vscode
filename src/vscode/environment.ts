// The refusal outside a devcontainer set up for claude-sandbox (src/environment.ts): a modal
// error naming what is missing and what the extension needs, before Start, the launch command
// or the install offer can do anything.

import * as vscode from "vscode";
import { environmentProblems, NO_TUN, REQUIREMENTS, TUN_DOCS } from "../environment.ts";
import { DOCS_URL } from "../install.ts";

/** What is missing in this window (empty: a usable devcontainer). */
export function problems(): string[] {
  return environmentProblems({ remoteName: vscode.env.remoteName });
}

/** True in a usable devcontainer; otherwise logs why and, unless quiet, refuses in a modal. */
export async function checkEnvironment(log: (m: string) => void, quiet = false): Promise<boolean> {
  const found = problems();
  if (found.length === 0) return true;
  log(`[environment] refusing: ${found.join("; ")}`);
  if (quiet) return false;
  const tunOnly = found.length === 1 && found[0] === NO_TUN;
  const pick = await vscode.window.showErrorMessage(
    "Claude Sandbox runs only in a devcontainer set up for claude-sandbox.",
    {
      modal: true,
      detail: `Found: ${found.join("; ")}.\n\nIt needs:\n${REQUIREMENTS.map((r) => `• ${r}`).join("\n")}`,
    },
    "How to set up",
  );
  if (pick === "How to set up") void vscode.env.openExternal(vscode.Uri.parse(tunOnly ? TUN_DOCS : DOCS_URL));
  return false;
}
