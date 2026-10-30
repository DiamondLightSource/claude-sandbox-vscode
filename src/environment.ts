// Is this window a devcontainer set up for claude-sandbox (no vscode import)? The extension
// supports only that (docs/design.md, Scope): outside one, Install would run claude-sandbox's
// installer (with sudo) on the host and Start would run Claude with no container around it, so
// both refuse (issue #41) and say what is missing.

import * as fs from "node:fs";
import { MIN_VERSION } from "./install.ts";

/** The remote names of a VS Code window attached to a container. */
export const CONTAINER_REMOTES = ["dev-container", "attached-container"];
/** The files podman (/run/.containerenv) and docker (/.dockerenv) write into every container. */
export const CONTAINER_MARKERS = ["/run/.containerenv", "/.dockerenv"];
/** The device claude-sandbox's network egress jail needs; without it Claude refuses to launch. */
export const TUN = "/dev/net/tun";
export const TUN_DOCS = "https://diamondlightsource.github.io/claude-sandbox/how-to/network-egress-jail.html";
/** claude-sandbox's system conf: `egress-jail = 0` there turns the jail off, and with it the need for TUN. */
export const SANDBOX_CONF = "/etc/claude-sandbox.conf";
export const NO_TUN = `the container has no ${TUN}`;

/** What a devcontainer must have for this extension, for the refusal's detail. */
export const REQUIREMENTS = [
  "VS Code attached to a devcontainer (Dev Containers: Reopen in Container), so the extension runs in the container, not on the host",
  `the container started with ${TUN} (devcontainer.json: "runArgs": ["--device=${TUN}"]), for claude-sandbox's network egress jail`,
  `claude-sandbox ${MIN_VERSION} or later installed in the container (the extension offers the install once the above hold)`,
];

export interface Probe {
  /** vscode.env.remoteName: undefined in a local window. */
  remoteName: string | undefined;
  exists?: (p: string) => boolean;
  isCharDevice?: (p: string) => boolean;
  /** SANDBOX_CONF's text, "" when it is missing or unreadable. */
  readConf?: () => string;
}

function charDevice(p: string): boolean {
  try {
    return fs.statSync(p).isCharacterDevice();
  } catch {
    return false;
  }
}

function sandboxConf(): string {
  try {
    return fs.readFileSync(SANDBOX_CONF, "utf8");
  } catch {
    return "";
  }
}

/** Whether the conf turns the egress jail off, read as claude-sandbox's parse_config reads it:
 * `#` starts a comment, the first `egress-jail` line wins, a bare key means on. */
export function egressJailOff(conf: string): boolean {
  for (const raw of conf.split("\n")) {
    const [key, ...value] = (raw.split("#")[0] ?? "").split("=");
    if (key?.trim() === "egress-jail") return value.join("=").trim() === "0";
  }
  return false;
}

/** What is missing, one line each; empty when the window is a usable devcontainer. */
export function environmentProblems({
  remoteName,
  exists = fs.existsSync,
  isCharDevice = charDevice,
  readConf = sandboxConf,
}: Probe): string[] {
  const problems: string[] = [];
  if (remoteName === undefined || !CONTAINER_REMOTES.includes(remoteName)) {
    problems.push(
      remoteName === undefined
        ? "this VS Code window is local, not attached to a devcontainer"
        : `this VS Code window is a ${remoteName} remote, not a devcontainer`,
    );
  }
  // the files, not the container env var: the extension host's environment comes from
  // devcontainer.json's remoteEnv, which the jail can edit (as for the conf: the jail cannot
  // write /etc, so the conf is read, but not the CLAUDE_SANDBOX_EGRESS_JAIL variable)
  if (!CONTAINER_MARKERS.some(exists)) problems.push("the extension host is not running in a container");
  // only worth saying inside a container: on a host it is beside the point
  else if (!isCharDevice(TUN) && !egressJailOff(readConf())) problems.push(NO_TUN);
  return problems;
}

/** The status bar's word on the problems: only the tun device missing, or no devcontainer. */
export function needs(problems: readonly string[]): string {
  return problems.length === 1 && problems[0] === NO_TUN ? `needs ${TUN}` : "needs a devcontainer";
}
