# Design

claude-sandbox-vscode makes VS Code the IDE of a Claude Code session that runs
inside [claude-sandbox](https://github.com/DiamondLightSource/claude-sandbox).
It speaks Claude Code's IDE protocol (MCP, JSON-RPC 2.0, one message per
WebSocket text frame), the role Anthropic's own extension plays for an
unsandboxed Claude. claude-sandbox itself is not changed.

The reference implementation is md-collab-editor
([gilesknap/ClaudeSandboxEditor](https://github.com/gilesknap/ClaudeSandboxEditor)):
the "IDE link" section of its `CLAUDE.md`, `IdeBridge` in `server.py`, and
`tests/test_ide.py`. This extension ports that design to TypeScript.

## Scope

The extension supports one setup: a devcontainer with claude-sandbox installed
in it (`uvx claude-sandbox install`), with VS Code attached from the host. The
extension runs in the devcontainer's remote extension host. Rootless Podman and
the devcontainer are claude-sandbox prerequisites. claude-sandbox's standalone
mode (the host launcher starting its own container) is not a target.

One linked Claude session per VS Code window. Any other Claude is started the
usual way (`claude` in a terminal) and runs sandboxed with no IDE link. While a
connection is open, the link refuses a new one rather than replacing it, so a
standalone Claude that finds the lock (for example with `/ide`) cannot take the
linked session's place (the second upgrade gets `409`, before any MCP traffic). A
reconnect after the connection closes is accepted. The session's own `/clear`,
`/resume` and fork keep the link: the hooks are matched so the lock outlives them.

## How the link works

1. The extension listens on a Unix socket at the workspace root,
   `.claude-sandbox-vscode-<P>.sock` (mode 0600). The jail sees the workspace,
   so it sees the socket.
2. The extension starts the sandbox's `claude` shadow (`/usr/local/bin/claude`,
   which runs Claude in the jail) as the terminal's own process with a
   `--settings` JSON carrying `env.CLAUDE_CODE_SSE_PORT=P`, a `SessionStart`
   hook and a `SessionEnd` hook. Claude Code honours only the last
   `--settings`, so a user's own JSON settings are merged with ours, never
   followed by a second one (a settings *file* means no link).
3. The `SessionStart` hook (matcher `startup|resume|fork`) runs inside the
   jail. Unless something already listens on `127.0.0.1:P` (it is idempotent:
   a resumed or forked session reuses the relay) it starts
   `setsid socat TCP4-LISTEN:P,bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:<sock>`.
   It waits (at most 10 s, polling `/proc/net/tcp`) until socat listens; on
   timeout it exits 0 silently and writes no lock. Then it writes the lock
   file `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/ide/<P>.lock` itself, no-clobber:
   `umask 077`, `printf` to a temp name in that folder, `ln` (which fails if
   the lock exists) into place. A lock already there (ours from before, or
   another devcontainer's sharing the config folder that chose the same port)
   is left alone; in the second case this session runs without a link. The
   lock is `{"pid":1,"workspaceFolders":[...],"ideName":...,
   "transport":"ws","authToken":...}`; `"pid": 1` keeps Claude's stale-lock
   sweep from deleting it. The `SessionEnd` hook (matcher
   `logout|prompt_input_exit|bypass_permissions_disabled|other`: real exits,
   not `clear` or `resume`, after which a new session starts in the same
   process) removes the lock only if its content is byte for byte ours. Both
   hooks print nothing to stdout (a SessionStart hook's stdout becomes model
   context). The extension is already listening on its socket before the
   terminal starts. The host never writes into the jail's `~/.claude` (it is
   agent-writable).
4. Claude polls the lock folder and connects to `127.0.0.1:P` in the jail
   (about 0.3 s after the lock appears; up to 12 s seen), socat carries it to
   the socket, and the extension checks `X-Claude-Code-Ide-Authorization`.
   Claude Code 2.1.292 then sends, within ~10 ms: `initialize` (id 0,
   protocolVersion `2025-11-25`), `notifications/initialized`,
   `ide_connected {"pid": N}` (a notification, never answered) and
   `tools/list` (id 1); no pings after. Its upgrade offers
   `Sec-WebSocket-Extensions: permessage-deflate` (refused by not echoing it)
   and `Sec-WebSocket-Protocol: mcp` (echoed). `CLAUDE_CODE_SSE_PORT` given
   only through `--settings` env works, and with the port explicit
   `workspaceFolders` need not match Claude's cwd. So when the window's folders
   change, the bridge checks paths against the new set at once, and the lock's
   `workspaceFolders` (written at start) are left stale.

**The token is in claude-sandbox's argv** (inside `--settings`, in the hook's
command). That is acceptable: the socket is 0600 in the workspace, so other
host users cannot connect whatever they read from `/proc/<pid>/cmdline`, and
processes running as the same user are already trusted (they could read the
token from the lock or attach to VS Code anyway).

## Trust boundary

The extension host runs outside the jail with the user's full privileges.
Everything in the jail can read the token and reach the socket, so treat every
message as hostile. These rules are the security design; each has a test in
`test/hostile/`.

1. **Tool list.** Only `openDiff`, `close_tab`, `closeAllDiffTabs`,
   `getDiagnostics`. Never `executeCode` or any tool that runs, opens, fetches
   or writes anything. Unknown methods get -32601.
2. **openDiff paths.** Resolve the real path; it must be inside a workspace
   folder and not inside `.git`. Read without following symlinks (`O_NOFOLLOW`
   on the final component, real-path check of the parent after opening).
   Anything else is an `isError` result, and nothing is read.
3. **The extension never writes workspace files.** Accept answers
   `FILE_SAVED` with the contents; Claude writes the file from inside the jail.
   Closing a diff tab answers `DIFF_REJECTED` (a bare `TAB_CLOSED` would be an
   accept). Each proposal is answered at most once; one closed by the bridge
   (Claude closed it, or its connection went) is answered by nothing in the
   UI. Accept and Reject work from either side of the diff (keyed on the diff
   id in either URI).
4. **getDiagnostics** returns only diagnostics for files inside a workspace
   folder.
5. **selection_changed** is sent only for files inside a workspace folder;
   otherwise a cleared selection (empty range, no `filePath`).
6. **Terminal input.** The `claude` shadow is the terminal's process, never a
   command sent into a shell, so text never reaches a host shell. Asks are sent
   only while Claude's `❯` prompt is showing, as one bracketed paste with
   control characters (ESC included) stripped.
7. **Lock files and sockets.** The host never opens anything under the jail's
   config folder: the lock file is written by the in-jail `SessionStart`
   hook (temp name in the same folder, then a no-clobber `ln`, mode 0600).
   Everything put into the hook's shell command is validated and quoted: the
   port an integer, the token 64 hex digits, paths absolute with no control
   characters (newline and NUL refused), and each value one single-quoted
   shell word (the socket path also socat-escaped). The host
   deletes nothing in the workspace: a stale socket from a crashed window is
   harmless (each start picks a new port) and is left for the user. Our own
   socket is unlinked by libuv, by the exact path it bound, when the listener
   closes; we add no unlink of our own. If the jail swapped that name for
   something else meanwhile, the unlink removes only that directory entry
   (never a symlink's target), which the jail could have removed itself. A
   name already taken at the socket path (a planted symlink or file) means
   another port; it is never touched. The SessionEnd hook removes only a lock
   whose content is ours.
8. **Parser and connection limits.** Message ≤ 16 MiB, decided from the frame
   header, so one incomplete frame (or fragmented message) never buffers more
   than that. At most 4 connections in their handshake at once, each with a
   handshake timeout; one upgraded connection (one linked session). Output
   is under backpressure: while more than 1 MiB waits to be sent, the
   connection is not read, and past 32 MiB queued it is dropped. A WebSocket
   ping every 30 s; a client that has sent no frame (a pong counts) since the
   previous ping is dropped. There is no idle-read timeout: Claude Code sends
   nothing after its opening frames. permessage-deflate refused. Parsed JSON
   is never merged into objects (`__proto__`); nothing from the jail is
   logged unescaped. getDiagnostics answers `{uri, diagnostics}` per file,
   never the host-side `fsPath`.

## Out of scope (residual risk)

A jailed process with the token that answers pings can hold the single
connection slot indefinitely. It can only deny its own IDE link: anything in
the jail could equally kill the linked Claude, and nothing on the host is
exposed by it.

Host VS Code on a workspace the jail can write is exposed whether or not this
extension is installed: `.vscode/settings.json` (interpreter paths, tasks) and
`.git/config` (fsmonitor, filter drivers) run on the host. claude-sandbox's
ADR 27 lists these as not covered. Keep such workspaces untrusted in VS Code's
Workspace Trust, or review agent changes to them before reopening.

## Rule → test

`npm test` runs `test/unit/` (each module with fakes) and `test/hostile/` (a
client on the real socket, with the real token, attacking).

| Rule | Tests |
| --- | --- |
| 1 Tool list | `test/unit/mcp.test.ts` "rule 1"; `test/hostile/link.test.ts` "executeCode, unknown methods and `__proto__`/constructor payloads" |
| 2 openDiff paths | `test/unit/paths.test.ts` (resolve, readInside, symlink swapped in at the file and at a parent folder after the check); `test/unit/mcp.test.ts` "rule 2/3"; `test/hostile/link.test.ts` "openDiff and getDiagnostics outside the workspace read nothing", "a symlink swapped in after the check is refused" |
| 3 No workspace writes | `test/unit/mcp.test.ts` "rule 2/3" (FILE_SAVED, closed → DIFF_REJECTED); `test/unit/diffTabs.test.ts` (the tab state machine: close → DIFF_REJECTED, self-close or lost connection → no answer, accept → FILE_SAVED once, mtime only on write; Accept/Reject from either side); `test/hostile/link.test.ts` "an accepted diff is answered FILE_SAVED and the file is not written"; `test/hostile/audit.test.ts` "rule 3" (no write or delete API in `src/`) |
| 4 getDiagnostics | `test/unit/mcp.test.ts` "rule 4" (no `fsPath`), "workspace folders changed"; `test/hostile/link.test.ts` "openDiff and getDiagnostics outside the workspace" |
| 5 selection_changed | `test/unit/mcp.test.ts` "rule 5" |
| 6 Terminal input | `test/unit/paste.test.ts` (the paste primitive only: the launcher and the `❯` gate are stage 2) |
| 7 Lock files and sockets | `test/hostile/hook.test.ts` (the hook run for real with socat, in a workspace whose name tries to break out of the command; idempotent, one socat; another's lock left alone and not removed at SessionEnd; no lock when socat never listens; the matchers); `test/unit/settings.test.ts` "hook commands"; `test/hostile/audit.test.ts` "rule 7" (every fs path recorded during a session; none under the config folder); `test/hostile/link.test.ts` "rule 7: the socket name" |
| 8 Parser and connection limits | `test/unit/websocket.test.ts`; `test/hostile/link.test.ts` "rule 8" (0600, deflate refused, tokens, 4 handshakes, slow handshake, 1009, 1002, one linked session, a client that stops reading (backpressure), the 32 MiB cap, pings); `test/unit/mcp.test.ts` "connections" and "rule 8", `test/unit/settings.test.ts` (`__proto__`); `test/unit/log.test.ts` |

## Implementation notes

- Linux only. Node has no `openat(2)`; reads walk the path one component at a
  time through `/proc/self/fd/<dirfd>/<name>` with `O_NOFOLLOW` (`src/dirfd.ts`),
  and the opened file's real path (`readlink /proc/self/fd/<fd>`) is checked
  again. Without `/proc/self/fd` the link refuses to start.
- The socket file is created 0600 by binding under `umask 0177`, never
  `chmod`ed afterwards through a path the jail could swap. libuv removes it
  when the listener closes.
- The audit core is `src/websocket.ts`, `src/listener.ts`, `src/mcp.ts`,
  `src/paths.ts`, `src/dirfd.ts`, `src/settings.ts`, `src/json.ts`,
  `src/diffTabs.ts`, `src/link.ts`; none imports `vscode`. The VS Code glue is
  `src/vscode/` and `src/extension.ts`. `src/paste.ts` (rule 6) and the
  settings merge (`withSettings`) are tested now and used by the stage-2
  launcher.
- `getDiagnostics` for one file with no diagnostics answers one entry with an
  empty list (VS Code's own shape). Whether Anthropic's extension answers `[]`
  instead could not be established; Claude accepts either.

## Planned: stage 2

Not built yet. Agreed behaviour:

- **Install offer.** On activation, if `claude-sandbox` is missing, a
  notification offers **Install**, which opens a visible terminal running
  `uvx claude-sandbox install`. Nothing installs without the click. An outdated
  install gets a notice only, never an update. The command is fixed in the
  extension, never read from workspace settings.
- **Launcher.** **Claude Sandbox: Start** (status bar, palette, keybinding)
  opens the linked session as a terminal in the editor area, with
  the `claude` shadow as the terminal's own process. If the session is running it
  focuses that terminal instead.
- **Presets.** Editor context menu and keybindings: Explain, Reword, Tighten
  and similar. Each sends the selection to the linked session only while
  Claude's prompt is showing. Custom presets are a user setting
  (`scope: application`), so the workspace cannot change them.
- **Claude Changes view.** While the linked session runs, a side-bar view
  lists the workspace files changed this session (VS Code's file watcher,
  `.git` excluded). Each opens VS Code's diff against HEAD through the built-in
  Git extension's API; **Mark as reviewed** ticks a file off until it changes
  again. Auto-opening diffs is a setting, off by default. There is no revert
  button: reverting would mean the host writing into the jail-writable
  workspace, so Source Control's Discard is the way back. Grouping by prompt
  is a later addition.
