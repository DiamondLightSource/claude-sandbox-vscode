// Is claude-sandbox installed in this container, and is it current (no vscode import)?
// The install offer runs a command fixed here (trust boundary rule 10), only on the user's
// click, in a visible terminal; an outdated install gets a notice, never an upgrade.

import * as fs from "node:fs";
import * as path from "node:path";
import { isObj, own } from "./json.ts";
import { CLAUDE, PYTHON } from "./ptyHelper.ts";

export const CLAUDE_SANDBOX = "/usr/local/bin/claude-sandbox";
export const DOCS_URL = "https://diamondlightsource.github.io/claude-sandbox/";
export const PYPI_URL = "https://pypi.org/pypi/claude-sandbox/json";
export const SUDO = "/usr/bin/sudo";
export const DAY_MS = 24 * 60 * 60 * 1000;

/** What the shadow shim execs: claude-sandbox's interpreter, isolated, its _shadow entry. */
export const SHADOW_MARK = `${PYTHON} -I -m claude_sandbox _shadow`;

/**
 * Runs the install in a visible terminal and keeps it open afterwards: "$@" is the command
 * (positional parameters, never parsed as shell text).
 */
export const INSTALL_SCRIPT =
  '"$@"; s=$?; echo; echo "claude-sandbox install finished (exit $s). Press Enter to close."; read _; exit $s';

/** Whether a file's text is claude-sandbox's claude shim. */
export function isShadow(text: string): boolean {
  return text.startsWith("#!") && text.includes(SHADOW_MARK);
}

export interface InstallState {
  /** /usr/local/bin/claude is the shadow and claude-sandbox is there. */
  installed: boolean;
  why?: string;
}

/** Looks at the two files (the shim read only up to 4 KiB). */
export function installState(claude = CLAUDE, cli = CLAUDE_SANDBOX): InstallState {
  let text = "";
  try {
    const fd = fs.openSync(claude, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    try {
      if (!fs.fstatSync(fd).isFile()) return { installed: false, why: `${claude} is not a file` };
      const buf = Buffer.alloc(4096);
      text = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0)).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { installed: false, why: `${claude} is missing` };
  }
  if (!isShadow(text)) return { installed: false, why: `${claude} is not claude-sandbox's` };
  try {
    fs.accessSync(cli, fs.constants.X_OK);
  } catch {
    return { installed: false, why: `${cli} is missing` };
  }
  return { installed: true };
}

/** uvx: the system locations first, then the extension host's PATH; null if none. */
export function findUvx(envPath = process.env.PATH ?? ""): string | null {
  const dirs = ["/usr/local/bin", "/usr/bin", ...envPath.split(":").filter((d) => d.startsWith("/"))];
  for (const d of dirs) {
    const p = path.join(d, "uvx");
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch {
      // next
    }
  }
  return null;
}

/** The install command: `uvx claude-sandbox install`, through sudo unless we are root. */
export function installArgv(uid: number, uvx: string): string[] {
  const cmd = [uvx, "claude-sandbox", "install"];
  return uid === 0 ? cmd : [SUDO, ...cmd];
}

/** `claude-sandbox version`'s output → the version. */
export function parseVersionOutput(out: string): string | null {
  const m = /^claude-sandbox\s+(\S+)\s*$/m.exec(out);
  return m ? m[1]! : null;
}

/** PyPI's JSON → the latest version. */
export function pypiLatest(json: unknown): string | null {
  const v = own(own(json, "info"), "version");
  return typeof v === "string" && isObj(json) ? v : null;
}

interface Version {
  release: number[];
  pre: [number, number]; // [kind, n]: a 0, b 1, rc 2, none 3 (a bare .dev: -1)
  post: number;
  dev: number; // Infinity when there is none
}

const PRE: Record<string, number> = { a: 0, alpha: 0, b: 1, beta: 1, c: 2, rc: 2, pre: 2, preview: 2 };

/** A PEP 440 version, or a semver-ish one (`5.0.0-beta.2` = `5.0.0b2`); null if neither. */
export function parseVersion(s: string): Version | null {
  const m =
    /^v?(\d+(?:\.\d+)*)(?:[-_.]?(a|alpha|b|beta|c|rc|pre|preview)[-_.]?(\d*))?(?:[-_.]?post[-_.]?(\d*))?(?:[-_.]?dev[-_.]?(\d*))?(?:\+[\w.]+)?$/i.exec(
      s.trim(),
    );
  if (!m) return null;
  const post = m[4] !== undefined ? Number(m[4] || 0) : -1;
  const dev = m[5] !== undefined ? Number(m[5] || 0) : Infinity;
  // X.devN alone comes before X's pre-releases
  const none: [number, number] = post < 0 && dev !== Infinity ? [-1, 0] : [3, 0];
  return {
    release: m[1]!.split(".").map(Number),
    pre: m[2] ? [PRE[m[2].toLowerCase()]!, Number(m[3] || 0)] : none,
    post,
    dev,
  };
}

/** -1, 0 or 1; null when either cannot be read. */
export function compareVersions(a: string, b: string): number | null {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (x === null || y === null) return null;
  const n = Math.max(x.release.length, y.release.length);
  const pairs: [number, number][] = [];
  for (let i = 0; i < n; i++) pairs.push([x.release[i] ?? 0, y.release[i] ?? 0]);
  pairs.push([x.pre[0], y.pre[0]], [x.pre[1], y.pre[1]], [x.post, y.post], [x.dev, y.dev]);
  for (const [p, q] of pairs) if (p !== q) return p < q ? -1 : 1;
  return 0;
}

/** Whether `installed` is older than `latest` (unknown: false, no notice). */
export function outdated(installed: string, latest: string): boolean {
  return compareVersions(installed, latest) === -1;
}
