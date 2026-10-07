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

One linked Claude session per VS Code window, started with **Claude Sandbox:
Start**. Any other Claude is started the usual way (`claude` in a terminal) and runs sandboxed with no IDE link. While a
connection is open, the link refuses a new one rather than replacing it, so a
standalone Claude that finds the lock (for example with `/ide`) cannot take the
linked session's place (the second upgrade gets `409`, before any MCP traffic). A
reconnect after the connection closes is accepted. The session's own `/clear`,
`/resume` and fork keep the link: the hooks are matched so the lock outlives them.

Refusing does not break `/ide` in the linked session. Observed with Claude Code
2.1.292 against this bridge (the generated `--settings`, the in-jail hook and
socat, a real lock): `/ide` choosing the IDE it is already connected to opens
no new connection; it reports "Connected" within ~80 ms and keeps the old one.
Choosing None closes the connection, and choosing ours again reconnects (the
link accepts it: nothing is open). A second, standalone Claude choosing ours
with `/ide` while the linked session is connected gets the `409`, shows
"Failed to connect to Claude Sandbox for VS Code" ~100 ms later and does not
retry; the linked session stays connected.

## How the link works

1. The extension listens on a Unix socket at the workspace root,
   `.claude-sandbox-vscode-<P>.sock` (mode 0600). The jail sees the workspace,
   so it sees the socket.
2. The extension starts the sandbox's `claude` shadow (`/usr/local/bin/claude`,
   which runs Claude in the jail) as the terminal's own process (see
   [The launcher](#the-launcher)) with a
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
   `logout|prompt_input_exit|other`: real exits, not `clear` or `resume`, after
   which a new session starts in the same process; 2.1.292 knows no other
   reasons, `bypass_permissions_disabled` was removed in 2.1.234) removes the
   lock only if its content is byte for byte ours: only a regular file, not a
   symlink, is read (a FIFO planted there would block the hook), its size must
   be exactly ours, and no more than that many bytes are read (`head -c`). Both
   hooks send stdout and stderr to `/dev/null` (a SessionStart hook's stdout
   becomes model context). The extension is already listening on its socket before the
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
   command sent into a shell, so text never reaches a host shell. Asks are typed
   only while Claude Code's input box is showing (`❯` followed by a no-break
   space; anything else after the last `❯` drawn is a menu, and refused), never
   while a proposed change waits for an answer, and the state is checked again
   before the Enter. The question is one bracketed paste with control
   characters (ESC included) stripped. A session still starting is waited for
   at most 20 s, then nothing is typed. A typed @-mention (no link) goes only
   into the input box; `at_mentioned` and `selection_changed` only for files
   inside a workspace folder. The user's keys wait while an ask is between its
   paste and its Enter.
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
   connection is not read, and past 32 MiB queued it is dropped. The largest
   answer, `FILE_SAVED` with the accepted text, always fits: an openDiff
   proposal, and the text the user accepts, is at most `PROPOSAL_MAX` bytes
   (about 5.2 MiB), derived from the cap as (32 MiB − 1 MiB − 4 KiB) / 6, the
   worst JSON escaping (a control character, `\u00XX`) behind 1 MiB already
   queued with room for the envelope; a string request id is at most 256
   characters. A larger proposal is refused before anything is read; accepted
   text the user made larger is answered with an error, not sent. A WebSocket
   ping every 30 s; a client that has sent no bytes (a pong counts) since the
   previous ping is dropped. While we are not reading it (backpressure) its
   pongs wait unread, so then it counts as alive if it has taken any of what we
   queued since that ping (libuv's write queue fell), and is dropped if it took
   none. There is no idle-read timeout: Claude Code sends
   nothing after its opening frames. permessage-deflate refused. Parsed JSON
   is never merged into objects (`__proto__`); nothing from the jail is
   logged unescaped. getDiagnostics answers `{uri, diagnostics}` per file,
   never the host-side `fsPath`.

9. **The pty relay.** The session's terminal is a `Pseudoterminal` relaying to
   a child with a real pty, made by a Python program kept as a string constant
   in the extension (`src/ptyHelper.ts`) and run as
   `/usr/libexec/claude-sandbox/venv/bin/python -I -c <program> cols rows
   /usr/local/bin/claude <args>`: claude-sandbox's root-owned interpreter (the
   one its own shim runs), isolated, with no helper file on disk that anything
   could change. The interpreter, the program and `/usr/local/bin/claude` are
   constants; only Claude's arguments (the merged `--settings`, the user's
   `claudeSandbox.extraArgs`) vary, and they are argv words, never shell text.
   The child gets the pty as its controlling terminal in a session of its own
   and none of the relay's descriptors. Claude's environment is the extension
   host's minus `VSCODE_*`, `ELECTRON_*` and an inherited
   `CLAUDE_CODE_SSE_PORT`. Resizes (`cols rows` lines on fd 3) are validated.
   Only two places start processes: the relay, and `claude-sandbox version`
   by absolute path for the outdated notice.
10. **Install offer.** Nothing runs without the user's click. The command is
    fixed in the extension (`uvx claude-sandbox install`, prefixed with
    `/usr/bin/sudo` when not uid 0; uvx looked for in `/usr/local/bin`,
    `/usr/bin`, then the extension host's `PATH`), run in a visible terminal as
    `/bin/sh -c <constant script> sh <argv...>` (the command as positional
    parameters, never shell text). An outdated install gets a notice, never an
    upgrade; the PyPI check runs at most once a day and fails silently.
11. **Settings.** Every setting (`claudeSandbox.extraArgs`,
    `claudeSandbox.presets`, `claudeSandbox.autoOpenDiffs`) is
    `scope: application`: user settings only. Workspace and folder settings
    are agent-writable, and so in effect is `machine` scope in a devcontainer
    (`customizations.vscode.settings` in the workspace's `devcontainer.json`
    become remote machine settings on rebuild), so neither is used.
    `autoOpenDiffs` is harmless either way; it is application-scoped for one
    simple rule. The only other setting read is `files.watcherExclude`.
12. **The changes view reads and writes nothing.** It records paths from VS
    Code's file watcher and stats a new path (metadata only) to skip folders.
    VS Code's diff editor reads the files; the built-in Git extension runs git.
    There is no revert action: that would be the host writing into the
    jail-writable workspace (Source Control's Discard is the way back).

## Out of scope (residual risk)

A jailed process with the token that answers pings can hold the single
connection slot indefinitely. It can only deny its own IDE link: anything in
the jail could equally kill the linked Claude, and nothing on the host is
exposed by it.

The token is in the jail from the start, so a jailed process can also take the
slot in the moment before Claude connects (about 0.3 s after the lock
appears). Claude then gets `409` and runs without a link, while the status bar
shows "connected" to the impostor, which can show `openDiff` proposals as if
they were Claude's. That gains it nothing over writing the workspace itself
(which the jail can do anyway) beyond the user's Accept click, and it can only
deny or take over its own link: no host access.

A window reload ends the session. Deactivation closes the socket and hangs up
the session's pty (the relay closes it: SIGHUP, then SIGKILL after 3 s), and
the terminal is transient, so it is not revived. The reloaded window draws a
new port and token at the next Start. A Claude started by hand with **Copy
launch command** keeps running after a reload, unlinked.

The "busy" check (Claude Code drew "esc to interrupt" in the last 1.5 s) is
best effort. An ask that slips through while Claude works is queued by Claude
Code, which answers nothing; the menu check is what keeps an Enter from
answering a question.

The changes view records every watcher event in the workspace while the
session runs, whoever caused it, except the user's own saves (within 2 s).
A `git checkout` or a formatter run by another extension shows up too.

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
| 6 Terminal input | `test/unit/paste.test.ts` (the paste primitive); `test/unit/prompt.test.ts` (input box vs menu as Claude Code 2.1.292 draws them, the folder-trust menu with no number, pending, busy); `test/unit/session.test.ts` (selection → ping → one paste → Enter; refused in a menu, with a diff waiting, while busy; a menu that appears during the ping or before the Enter; waiting for a starting session, and giving up; typed fallback; keys held; Mention via `at_mentioned` or typed only into the box); `test/unit/mcp.test.ts` "the ping barrier", "at_mentioned"; `test/hostile/audit.test.ts` "terminals" (no `sendText`, the session's terminal is a Pseudoterminal running CLAUDE) |
| 9 The pty relay | `test/unit/pty.test.ts` (argv constant but for size and arguments; the pty is the controlling terminal at the given size with no fd of ours; arguments are words; keys and UTF-8; SIGWINCH on resize, bad resize lines ignored; Ctrl-C and exit status; output before exit kept; kill hangs up; a missing program is 127); `test/hostile/audit.test.ts` "child_process only in the pty relay and the version check" |
| 10 Install offer | `test/unit/install.test.ts` (the shim recognised, read without blocking on a FIFO; the fixed command and sudo; the terminal script runs its arguments as words; version parsing and comparison; PyPI JSON read as own keys); `test/hostile/audit.test.ts` "terminals" |
| 11 Settings | `test/unit/manifest.test.ts` (every setting `scope: application`; the code reads no other setting of ours; every contributed command registered) |
| 12 Changes view | `test/unit/changes.test.ts` (only workspace files, not `.git`, sockets or `files.watcherExclude`; the user's saves skipped; kinds; reviewed until changed again); `test/hostile/audit.test.ts` "rule 3" (no write API; `workspace.fs` only for `stat`) |
| 7 Lock files and sockets | `test/hostile/hook.test.ts` (the hook run for real with socat, in a workspace whose name tries to break out of the command; idempotent, one socat; another's lock left alone and not removed at SessionEnd; no lock when socat never listens; the matchers; silent on stderr when the lock folder cannot be made), "SessionEnd removes only a lock that is ours, byte for byte" (trailing newline, NUL, prefix, suffix kept; a FIFO at the lock path neither blocks nor is removed; a symlink and its target left; a huge file); `test/unit/settings.test.ts` "hook commands"; `test/hostile/audit.test.ts` "rule 7" (every fs path recorded during a session; none under the config folder); `test/hostile/link.test.ts` "rule 7: the socket name" |
| 8 Parser and connection limits | `test/unit/websocket.test.ts`; `test/hostile/link.test.ts` "rule 8" (0600, deflate refused, tokens, 4 handshakes, slow handshake, 1009, 1002, one linked session (the `/ide` behaviour above recorded by hand with Claude Code 2.1.292), a client that stops reading (backpressure), the 32 MiB cap, pings, a slow reader not dropped while paused); `test/unit/mcp.test.ts` "connections", "rule 8" and "the largest answer (FILE_SAVED) always fits under the output cap" (`PROPOSAL_MAX` derived from `MAX_QUEUED`, a worst-case proposal and id, a larger proposal or accepted text), `test/unit/settings.test.ts` (`__proto__`); `test/unit/log.test.ts` |

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
  `src/diffTabs.ts`, `src/link.ts`, and for stage 2 `src/ptyHelper.ts`,
  `src/pty.ts`, `src/prompt.ts`, `src/session.ts`, `src/paste.ts`,
  `src/install.ts`; none imports `vscode`. `src/ask.ts` (presets, @-mentions)
  and `src/changes.ts` (the changes list) are vscode-free models. The VS Code
  glue is `src/vscode/` and `src/extension.ts`.
- The socket path is limited to 107 bytes, so a workspace at a very long path
  gets no link (Start says so).
- `getDiagnostics` for one file with no diagnostics answers one entry with an
  empty list (VS Code's own shape). Whether Anthropic's extension answers `[]`
  instead could not be established; Claude accepts either.

## The launcher

**Claude Sandbox: Start** (palette, the status-bar item, `Ctrl+Alt+C`) opens
the one linked session as a terminal in the editor area, beside the active
editor. Starting while a session runs focuses its terminal. The terminal's
process is the pty relay (rule 9) running `/usr/local/bin/claude` with the
merged `--settings` (`withSettings`) and the user's `claudeSandbox.extraArgs`.
Its working folder is the first workspace folder: the link's socket is there,
and Claude Code takes the folder as its project, the same one every time
whichever file happens to be active.

The status-bar item shows the link: `off`, `waiting` (the session runs, Claude
has not connected yet) or `connected`, and the count of changed files not yet
reviewed. When Claude exits, the link closes; a 0 exit closes the tab, any
other leaves it open with the code until a key is pressed.

### Why a Python pty relay

VS Code's API shows an extension nothing of what a normal terminal prints, and
the presets must see Claude Code's output to know its input box is up. So the
terminal is a `Pseudoterminal`, and its process needs a real pty (Claude Code
is a full-screen TUI). Node has none without a native module (node-pty: a
runtime dependency, built per platform and Electron version). util-linux
`script` gives a pty but no way to pass VS Code's resizes to it (its window
size comes from its own terminal, which here is a pipe). A ~100-line Python
program using `os.openpty`, `TIOCSCTTY` and `TIOCSWINSZ` does all of it: keys
on stdin, output on stdout, resizes on fd 3, the exit status as its own. It
runs under claude-sandbox's root-owned interpreter, which is installed
wherever the shadow is, and is passed as `-c` text so there is no file to
protect.

## Install offer

On startup (`onStartupFinished`), if `/usr/local/bin/claude` is not
claude-sandbox's shim (its text names `…/venv/bin/python -I -m claude_sandbox
_shadow`) or `/usr/local/bin/claude-sandbox` is missing, a notification says
"claude-sandbox isn't installed in this container" and offers **Install**,
which opens a visible terminal running `uvx claude-sandbox install` (with sudo
when not root). Without uvx it links to the claude-sandbox docs instead. Start
checks the same and offers the same. Once a day at most, `claude-sandbox
version` is compared with PyPI's latest; a newer one gets a notice naming
`uvx claude-sandbox@latest install`, never an upgrade.

## Presets

The editor's context menu has a **Claude Sandbox** submenu: Explain, Reword,
Tighten, **My presets…** (from `claudeSandbox.presets`, a list of
`{title, prompt}` in user settings), **Ask about selection…** (an input box)
and **Mention in Claude**. Keybindings: Explain `Ctrl+Alt+E`, Reword
`Ctrl+Alt+R`, Tighten `Ctrl+Alt+I`, Ask `Ctrl+Alt+A`, Mention `Ctrl+Alt+M`.
Each needs the linked session running. An ask follows rule 6: the selection
over the link, an MCP ping as a barrier, the prompt as one paste, Enter. With
no selection the whole file is named with a typed `@path`. If Claude is in a
menu, has a proposed change waiting, or is working, a warning says so and
nothing is typed; a session still starting is waited for up to 20 s. Mention
sends `at_mentioned` (Claude Code inserts `@path#La-b` into its input, no
Enter); a path with whitespace, or no link, is typed instead, and only into the
input box.

## Claude Changes view

A side-bar view container (its own icon) holds **Changed this session**: the
files in the workspace folders that changed while the linked session ran, from
`vscode.workspace.createFileSystemWatcher`, excluding `.git`, our sockets,
`files.watcherExclude`, and changes from the user's own saves (within 2 s of
`onWillSave`/`onDidSave`). The list is reset at each Start and kept after the
session ends. A click opens VS Code's diff against HEAD through the built-in
Git extension's API (`getAPI(1)`, `toGitUri(uri, 'HEAD')`, `vscode.diff`); a
file HEAD lacks (untracked or added) opens as itself; a deleted one is HEAD
against empty. **Mark as reviewed** (inline) ticks a file until it changes
again; the view's badge and the status bar count the rest.
`claudeSandbox.autoOpenDiffs` (off by default) opens each change's diff as a
preview. Grouping by prompt is a later addition.
