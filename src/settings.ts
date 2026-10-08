// The --settings JSON that links a sandboxed Claude Code to this extension (trust boundary
// rule 7), and its merge into a user's own settings.
//
// The host never writes into the jail's ~/.claude (it is agent-writable). Instead a
// SessionStart hook, run by Claude Code inside the jail, starts socat (127.0.0.1:P in the
// jail → our Unix socket in the workspace) unless it already listens, waits until it listens,
// and only then writes the lock file ~/.claude/ide/<P>.lock itself, no-clobber (a temp name
// in that folder, then a hard link, which fails if the lock is there already). A SessionEnd
// hook removes it, for real exits only: /clear and /resume end a session and start another
// in the same process, and the link must survive them.
//
// Everything put into those shell commands is validated and quoted here: the port is an
// integer in range, the token 64 lower-case hex digits, the paths absolute with no control
// characters, and each value is passed as one single-quoted shell word.
//
// Claude Code honours only the LAST --settings it is given, so a user's own JSON settings
// are merged with ours (withSettings), never followed by a second --settings.

import { isObj, own } from "./json.ts";

const IDE_NAME = "Claude Sandbox for VS Code";
export const PORT_MIN = 20000;
export const PORT_MAX = 60000;

export class SettingsError extends Error {}

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** One single-quoted POSIX shell word. */
export function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, `'\\''`) + "'";
}

/** A path as one parameter of a socat address: its special characters backslash-escaped. */
export function socatPath(p: string): string {
  return p.replace(/([\\:,!'"()[\]{} ])/g, "\\$1");
}

function checkPort(port: number): void {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new SettingsError(`bad port ${port}`);
}

function checkToken(token: string): void {
  if (!/^[0-9a-f]{64}$/.test(token)) throw new SettingsError("the token must be 64 hex digits");
}

/** Absolute, and no control characters (newline, NUL, ESC...) that could break a command. */
function checkPath(p: string): void {
  if (!p.startsWith("/") || /[\u0000-\u001f\u007f]/.test(p)) {
    throw new SettingsError(`refusing a path with control characters or not absolute: ${JSON.stringify(p)}`);
  }
}

/** The lock file's JSON, as Claude Code 2.1.292 accepts it. */
export function lockJson(port: number, token: string, folders: readonly string[]): string {
  checkPort(port);
  checkToken(token);
  folders.forEach(checkPath);
  return JSON.stringify({ pid: 1, workspaceFolders: [...folders], ideName: IDE_NAME, transport: "ws", authToken: token });
}

/** /proc/net/tcp's form of 127.0.0.1:port in LISTEN state. */
function procListen(port: number): string {
  return ` 0100007F:${port.toString(16).toUpperCase().padStart(4, "0")} 00000000:0000 0A `;
}

const LOCK_DIR = '"${CLAUDE_CONFIG_DIR:-$HOME/.claude}/ide"';

/** Session sources that start the relay and write the lock (not clear or compact: the
 * session before them never removed it). */
export const START_MATCHER = "startup|resume|fork";
/** Session end reasons that remove the lock: real exits only, never clear or resume. Claude
 * Code 2.1.292 knows clear, resume, logout, prompt_input_exit and other
 * (bypass_permissions_disabled was removed in 2.1.234). */
export const END_MATCHER = "logout|prompt_input_exit|other";
/** How long the SessionStart hook waits for socat to listen, in tenths of a second. */
const WAIT_STEPS = 100;

/**
 * The SessionStart hook's command (POSIX sh, run in the jail). Idempotent: socat is started
 * only if nothing listens on 127.0.0.1:P yet. The lock is written only once something
 * listens (after WAIT_STEPS tenths of a second without, the hook gives up silently: no
 * link, no lock), and never over an existing <P>.lock (another devcontainer sharing the
 * config folder may own that port: this session then runs without a link). It prints
 * nothing, on stdout or stderr: a SessionStart hook's stdout would become context for the
 * model.
 */
export function sessionStartCommand(
  port: number,
  token: string,
  sockPath: string,
  folders: readonly string[],
  waitSteps = WAIT_STEPS,
): string {
  checkPath(sockPath);
  if (!Number.isInteger(waitSteps) || waitSteps < 0) throw new SettingsError("bad wait");
  const lock = lockJson(port, token, folders);
  const relay =
    `socat TCP4-LISTEN:${port},bind=127.0.0.1,reuseaddr,fork ` + shellQuote(`UNIX-CONNECT:${socatPath(sockPath)}`);
  const up = `grep -q ${shellQuote(procListen(port))} /proc/net/tcp 2>/dev/null`;
  return [
    "exec >/dev/null 2>&1",
    `if ! ${up}; then (setsid ${relay} </dev/null >/dev/null 2>&1 &); fi`,
    "i=0",
    `until ${up}; do [ "$i" -ge ${waitSteps} ] && exit 0; sleep 0.1; i=$((i+1)); done`,
    "umask 077",
    `d=${LOCK_DIR}`,
    `mkdir -p "$d" || exit 0`,
    `t="$d/.${port}.lock.$$.tmp"`,
    `printf '%s' ${shellQuote(lock)} >"$t" && ln "$t" "$d/${port}.lock" 2>/dev/null`,
    `rm -f "$t"`,
    "exit 0",
  ].join("; ");
}

/**
 * The SessionEnd hook's command (run only for the reasons in END_MATCHER): removes the lock
 * only if it is ours, byte for byte (one the SessionStart hook left alone is not). Only a
 * regular file is read (a FIFO planted there would block the hook; a symlink is not ours),
 * its size must be exactly ours (so a trailing newline or a NUL, which `$(...)` would drop,
 * makes it someone else's), and no more than that many bytes are read.
 */
export function sessionEndCommand(port: number, token: string, folders: readonly string[]): string {
  const lock = lockJson(port, token, folders);
  const n = Buffer.byteLength(lock);
  return [
    "exec >/dev/null 2>&1",
    `f=${LOCK_DIR}/${port}.lock`,
    `[ -f "$f" ] && [ ! -L "$f" ] && [ $(wc -c <"$f") -eq ${n} ] && [ "$(head -c ${n} "$f")" = ${shellQuote(lock)} ] && rm -f "$f"`,
    "exit 0",
  ].join("; ");
}

export interface LinkSettings {
  env: { CLAUDE_CODE_SSE_PORT: string };
  hooks: {
    SessionStart: Json[];
    SessionEnd: Json[];
  };
  /** claudeSandbox.reviewEdits: file-edit tools always ask (and so open their diff here). */
  permissions?: { ask: string[] };
}

/**
 * The tools `claudeSandbox.reviewEdits` makes Claude Code ask about, whatever its permission
 * mode: then an edit is shown as an openDiff proposal in VS Code. Not MultiEdit: 2.1.292 warns
 * that it matches no known tool. Edits made through the shell (`sed -i`, `echo > f`) are not
 * these tools and are not caught; the Claude Changes view lists them.
 */
const REVIEW_TOOLS: readonly string[] = ["Edit", "Write", "NotebookEdit"];

/** Our settings with the edit tools set to ask (claudeSandbox.reviewEdits). */
export function withReviewEdits(ours: LinkSettings): LinkSettings {
  return { ...ours, permissions: { ask: [...REVIEW_TOOLS] } };
}

/** Our settings: the port in Claude's environment, the two hooks with their matchers. */
export function linkSettings(port: number, token: string, sockPath: string, folders: readonly string[]): LinkSettings {
  const command = (matcher: string, c: string): Json => ({ matcher, hooks: [{ type: "command", command: c }] });
  return {
    env: { CLAUDE_CODE_SSE_PORT: String(port) },
    hooks: {
      SessionStart: [command(START_MATCHER, sessionStartCommand(port, token, sockPath, folders))],
      SessionEnd: [command(END_MATCHER, sessionEndCommand(port, token, folders))],
    },
  };
}

// ---------------------------------------------------------------- merging

type Obj = { [key: string]: Json };

function setKey(o: Obj, k: string, v: Json): void {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}

/**
 * A shallow copy of a parsed JSON object (an empty one for anything else), made with
 * defineProperty on a null-prototype object: a `__proto__` key stays a plain key and never
 * becomes a prototype (rule 8).
 */
function copyObj(src: unknown): Obj {
  const out = Object.create(null) as Obj;
  if (isObj(src)) for (const [k, v] of Object.entries(src as Obj)) setKey(out, k, v);
  return out;
}

/**
 * Merge ours into a user's settings object: env gains ours, our hooks follow theirs, and their
 * permissions.ask gains our tools (reviewEdits).
 */
export function mergeSettings(theirs: unknown, ours: LinkSettings): Obj {
  const base = copyObj(theirs);
  const env = copyObj(own(base, "env"));
  setKey(env, "CLAUDE_CODE_SSE_PORT", ours.env.CLAUDE_CODE_SSE_PORT);
  setKey(base, "env", env);
  const hooks = copyObj(own(base, "hooks"));
  for (const [event, list] of Object.entries(ours.hooks) as [string, Json[]][]) {
    const before = own(hooks, event);
    setKey(hooks, event, [...(Array.isArray(before) ? before : []), ...list]);
  }
  setKey(base, "hooks", hooks);
  if (ours.permissions !== undefined) {
    // their permissions kept; the ask list gains ours (concatenated, without repeats)
    const perms = copyObj(own(base, "permissions"));
    const askIn = own(perms, "ask");
    const ask: Json[] = Array.isArray(askIn) ? [...askIn] : [];
    for (const t of ours.permissions.ask) if (!ask.includes(t)) ask.push(t);
    setKey(perms, "ask", ask);
    setKey(base, "permissions", perms);
  }
  return base;
}

/**
 * The settings argument the agent command already gives Claude Code: the argv slice of its
 * last --settings and its parsed value (null when it is not a JSON object, i.e. a file).
 */
export function agentSettings(argv: readonly string[]): { start: number; end: number; value: Obj | null } | null {
  let found: { start: number; end: number; raw: string } | null = null;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--settings" && i + 1 < argv.length) {
      found = { start: i, end: i + 2, raw: argv[i + 1]! };
      i++;
    } else if (a.startsWith("--settings=")) {
      found = { start: i, end: i + 1, raw: a.slice("--settings=".length) };
    }
  }
  if (found === null) return null;
  let value: unknown = null;
  try {
    value = JSON.parse(found.raw);
  } catch {
    value = null;
  }
  return { start: found.start, end: found.end, value: isObj(value) ? (value as Obj) : null };
}

/**
 * The agent command with our settings: appended as --settings, or merged into its own last
 * --settings JSON. A settings FILE cannot be merged into: SettingsError (no link), never a
 * second --settings that would silently drop the user's.
 */
export function withSettings(argv: readonly string[], ours: LinkSettings): string[] {
  const found = agentSettings(argv);
  if (found === null) return [...argv, "--settings", JSON.stringify(mergeSettings(null, ours))];
  if (found.value === null) {
    throw new SettingsError(
      "The command gives Claude Code a settings file (--settings); give those settings as JSON so the link's can be merged in.",
    );
  }
  return [
    ...argv.slice(0, found.start),
    "--settings",
    JSON.stringify(mergeSettings(found.value, ours)),
    ...argv.slice(found.end),
  ];
}
