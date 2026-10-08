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
in it, version 5.0.0b3 or later
(`uvx --from 'claude-sandbox>=5.0.0b3' claude-sandbox install`), with VS Code attached from the host. The
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

1. The extension listens on a Unix socket at the root of the workspace folder
   Claude runs in (chosen at Start in a multi-root window),
   `.claude-sandbox-vscode-<P>.sock` (mode 0600). The jail sees that folder, so
   it sees the socket. Claude starts in that same folder (see
   [The launcher](#the-launcher)).
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
   id in either URI). The changes view's Stage and Revert to HEAD are the
   built-in Git extension's, not ours (rule 12).
4. **getDiagnostics** returns only diagnostics for files inside a workspace
   folder.
5. **selection_changed** is sent only for files inside a workspace folder;
   otherwise a cleared selection (empty range, no `filePath`). Only a text
   editor showing a file changes what Claude has (`src/selection.ts`): its
   selection, or with nothing selected its cursor (file and line, not a
   clear). Focusing the Claude terminal (it lives in the editor area, so VS
   Code reports no active text editor), a webview, the output panel or a
   diff's proposal side keeps the last selection; a selection in a file
   outside the workspace clears it.
6. **Terminal input.** The `claude` shadow is the terminal's process, never a
   command sent into a shell, so text never reaches a host shell. Asks are typed
   only while Claude Code's input box is on the screen **now**, read from a
   small virtual screen (`src/screen.ts`: a VT parser that keeps the cells and
   the cursor; printable text with wide characters as best effort, CR/LF, the
   cursor moves, ED/EL, insert/delete, the scroll region, the alternate screen
   Claude Code 2.1.292 runs in), not from whatever text was drawn last. "Input"
   (`src/prompt.ts`) needs all of: the cursor visible, on a row starting `❯`
   + space (or one of its indented continuation rows); a full-width rule of
   `─` from column 0 directly above that row and another below the input; and
   under that at most 8 footer rows with no `❯` and no rule. Anything else is
   refused: every menu captured from 2.1.292 (permissions, `/model`, `/ide`,
   `/help`, the folder-trust and new-MCP-server questions) hides the cursor or
   replaces the box. The model cannot draw that region: Claude Code renders
   model text, tool output and the transcript indented by two columns with
   control characters removed (captured: an assistant message holding ESC
   sequences, `❯ ` lines and full-width rules, resumed into a real session,
   drew all of it as indented plain text), and it never places the cursor. The
   review's spoofs (a menu, then the input-box form drawn after it) are a
   fixture and read as a menu. Never while a proposed change waits for an
   answer. The screen is read again (after output has paused, at most 1 s)
   before the paste and before the Enter. The question is one bracketed paste
   with control characters (ESC included) stripped. A session still starting
   is waited for at most 20 s, then nothing is typed. A typed @-mention (no
   link) goes only into the input box; `at_mentioned` and `selection_changed`
   only for files inside a workspace folder. The user's keys wait while an ask
   is between its paste and its Enter. **Residual:** the screen says what
   Claude Code drew, and a menu that appears between the last check and the
   Enter takes that Enter; and whatever an Enter reaches (an answered
   question, a submitted prompt) still runs inside the jail, never on the
   host.
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
   Every descriptor of the relay (pty master, stdin, stdout, fd 3) is
   non-blocking, with bounded buffers (1 MiB each way): a side that is slow
   (the extension host not reading the output, Claude not reading its keys)
   never stops the others, so keys and resizes still go through.
   Only two places start processes: the relay, and `claude-sandbox version`
   by absolute path, with a fixed `PATH` and nothing else in its environment,
   for the outdated notice and the "too old" message.
10. **Install offer.** Nothing runs without the user's click. The command is
    fixed in the extension (`uvx --no-cache --from 'claude-sandbox>=5.0.0b3'
    claude-sandbox install`,
    prefixed with `/usr/bin/sudo` when not uid 0), run in a visible terminal as
    `/bin/sh -c <constant script> sh <argv...>` (the command as positional
    parameters, never shell text). A requirement, not a bare name: an unpinned
    `uvx` reuses an older cached tool, and `@latest` never picks a pre-release,
    while PyPI's latest stable (4.7.1) predates the shim and interpreter the
    extension needs. The floor names a pre-release, so uv allows betas for it. `--no-cache`: uv's cache is under `~/.cache`, which claude-sandbox
    binds read-write into the jail. uvx is taken only from fixed paths:
    `/usr/local/bin/uvx`, `/usr/bin/uvx` (the jail sees `/` read-only) and the
    user's `~/.cargo/bin/uvx` (home from the password database, not `$HOME`;
    the jail's home is an empty tmpfs with a few folders bound back, and
    `~/.cargo` is not one of them). It must be a regular file owned by root or
    the user and writable by no one else, and a symlink must stay within those
    folders. Never the extension host's `PATH` (devcontainer.json's
    `remoteEnv`, which the jail can edit, sets it), and never `~/.local/bin/uvx`:
    claude-sandbox binds that file (and `~/.local/bin/uv`) read-write into the
    jail, so a session could have replaced it. With no uvx found the
    notification links to the claude-sandbox docs
    (<https://diamondlightsource.github.io/claude-sandbox/>). An outdated
    install gets a notice, never an upgrade; the PyPI check runs at most once a
    day and fails silently.
11. **Settings.** Every setting (`claudeSandbox.extraArgs`,
    `claudeSandbox.presets`, `claudeSandbox.autoOpenDiffs`,
    `claudeSandbox.reviewEdits`) is
    `scope: application`: user settings only. Workspace and folder settings
    are agent-writable, and so in effect is `machine` scope in a devcontainer
    (`customizations.vscode.settings` in the workspace's `devcontainer.json`
    become remote machine settings on rebuild), so neither is used.
    `autoOpenDiffs` is harmless either way; it is application-scoped for one
    simple rule. No other extension's setting is read: in particular not
    `files.watcherExclude`, which `.vscode/settings.json` (jail-writable) sets.
    Compiling its globs let the jail hang the extension host (a pathological
    pattern; the review proved a 30 s `test`) and hide files from the changes
    view.
12. **The changes view reads and writes nothing.** It records paths from VS
    Code's file watcher, skipping any path with a `.git` segment and our
    sockets (no pattern from settings), and `lstat`s a path (metadata only,
    never followed): a folder is not listed, a symlink is listed with the
    description "symlink" and never opened as a diff, alone or in Review All,
    so a link the jail planted to a file outside the workspace is not shown.
    VS Code's diff editor reads the files; the built-in Git extension runs git.
    Like Source Control, it shows only files the Git extension reports a
    change for, so git state the session controls (a commit, `.gitignore`,
    `.git/info/exclude`, skip-worktree) can take a file out of the view just
    as it takes it out of Source Control; the view is a convenience over git
    state, not an audit. Its Stage and Revert to HEAD write nothing
    themselves: they call the Git extension's repository `add`, `revert`
    (Unstage) and `clean` (Discard), the code behind Source Control's own
    buttons, so a revert is exactly what pressing Unstage then Discard there
    would do, with the same exposure to a path the jail swaps in meanwhile.
    Revert asks first (a modal prompt) as Discard does; a file outside any
    repository is left alone.

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

The "busy" check is a courtesy: while Claude works, 2.1.292 draws its spinner
just above the box ("· Fluttering… (1s · ↓ 187 tokens · thinking)"; older
versions "… esc to interrupt"), and an ask is refused with a warning. An ask
that slips through while Claude works is queued by Claude Code, which answers
nothing; the screen check is what keeps an Enter from answering a question.

Vim mode: in NORMAL mode the box is unchanged and no indicator is shown
(2.1.292 shows `-- INSERT --` only in insert mode), so it reads as input. That
is harmless: captured, a bracketed paste in NORMAL mode is inserted as text
and Enter submits it.

`claudeSandbox.reviewEdits` (off by default) adds `Edit`, `Write` and
`NotebookEdit` to `permissions.ask` in the merged `--settings` (after any ask
list of the user's, without repeats; not `MultiEdit`, which 2.1.292 does not
know), so each of those edits asks, in auto mode too, and arrives here as an
`openDiff`. Edits made any other way (`sed -i`, `echo > f`, a script) are not
those tools: no prompt and no diff. The Claude Changes view lists them.

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
| 5 selection_changed | `test/unit/mcp.test.ts` "rule 5"; `test/unit/selection.test.ts` (select in a.py, focus the terminal: still a.py; a file outside the workspace clears it; a cursor in b.py sends b.py's position; closing the last tab of the selection's file clears it, a pending one too) |
| 6 Terminal input | `test/unit/paste.test.ts` (the paste primitive); `test/unit/screen.test.ts` (the VT model: text, wrap, cursor moves, ED/EL/ECH, the scroll region, wide characters, the alternate screen, cursor visibility, ignored sequences, caps, combining marks capped per cell); `test/unit/prompt.test.ts` (the screen read at points of real Claude Code 2.1.292 sessions, `test/fixtures/claude-2.1.292.json`: the box, typed and multi-row input, `/permissions`, `/model`, `/ide`, `/help`, the trust and MCP questions, working, vim INSERT and NORMAL, a resumed transcript holding model-drawn fake boxes; any chunking; the review's spoof bytes, `test/fixtures/review-spoofs.json`, alone and over a real menu; fake boxes at column 0; resizes; 50 MB in small chunks within a time budget); `test/unit/session.test.ts` (selection → ping → one paste → Enter; refused in a menu, with a diff waiting, while working; a menu that appears during the ping or before the Enter; waiting for a starting session, and giving up; typed fallback; keys held; Mention via `at_mentioned` or typed only into the box); `test/unit/mcp.test.ts` "the ping barrier", "at_mentioned"; `test/hostile/audit.test.ts` "terminals" (no `sendText`, the session's terminal is a Pseudoterminal running CLAUDE) |
| 7 Lock files and sockets | `test/hostile/hook.test.ts` (the hook run for real with socat, in a workspace whose name tries to break out of the command; idempotent, one socat; another's lock left alone and not removed at SessionEnd; no lock when socat never listens; the matchers; silent on stderr when the lock folder cannot be made), "SessionEnd removes only a lock that is ours, byte for byte" (trailing newline, NUL, prefix, suffix kept; a FIFO at the lock path neither blocks nor is removed; a symlink and its target left; a huge file); `test/unit/settings.test.ts` "hook commands"; `test/hostile/audit.test.ts` "rule 7" (every fs path recorded during a session; none under the config folder); `test/hostile/link.test.ts` "rule 7: the socket name" |
| 8 Parser and connection limits | `test/unit/websocket.test.ts`; `test/hostile/link.test.ts` "rule 8" (0600, deflate refused, tokens, 4 handshakes, slow handshake, 1009, 1002, one linked session (the `/ide` behaviour above recorded by hand with Claude Code 2.1.292), a client that stops reading (backpressure), the 32 MiB cap, pings, a slow reader not dropped while paused); `test/unit/mcp.test.ts` "connections", "rule 8" and "the largest answer (FILE_SAVED) always fits under the output cap" (`PROPOSAL_MAX` derived from `MAX_QUEUED`, a worst-case proposal and id, a larger proposal or accepted text), `test/unit/settings.test.ts` (`__proto__`); `test/unit/log.test.ts` |
| 9 The pty relay | `test/unit/pty.test.ts` (Claude's environment without VS Code's channels, an inherited link port or another Claude's child markers; argv constant but for size and arguments; the pty is the controlling terminal at the given size with no fd of ours; arguments are words; keys and UTF-8; SIGWINCH on resize, bad resize lines ignored; Ctrl-C and exit status; output before exit kept; kill hangs up; a slow reader of the output holds up neither keys nor resizes (fails on the old blocking relay); a flood of redraws with input bursts, resizes, a stalling host and a throwing output handler at once; a missing program is 127, a missing interpreter is explained; writes coalesced per 16 ms, a throwing sink reported); `test/hostile/audit.test.ts` "child_process only in the pty relay and the version check" |
| 10 Install offer | `test/unit/install.test.ts` (the shim, CLI and interpreter recognised, read without blocking on a FIFO; the fixed command with `--no-cache` and the `>=5.0.0b3` requirement, and sudo; older than the minimum is too old; uvx only from the fixed paths, not a symlink out of them, not writable by others, not owned by another user; the terminal script runs its arguments as words; version parsing and comparison; PyPI JSON read as own keys); `test/hostile/audit.test.ts` "terminals" |
| 11 Settings | `test/unit/manifest.test.ts` (every setting `scope: application`; the code reads no other setting of ours and no other extension's, `files.watcherExclude` included; keybindings on the `Ctrl+Alt+C` chord only); `test/unit/settings.test.ts` "reviewEdits" (the ask list merged and deduplicated, theirs kept, `__proto__` a plain key) |
| 12 Changes view | `test/unit/changes.test.ts` (only workspace files, not a `.git` segment or sockets, no settings patterns; any path decided in linear time; lstat: a symlink listed as one, a folder and a missing path told apart; the user's saves skipped; kinds; reviewed until changed again; Review All's rows: HEAD vs now, new against nothing, deleted HEAD vs nothing, symlinks left out; `splitByGit`: only what git shows changed, outside a repository all; git status re-read once per repository first, so a just-made file is shown and new); `test/hostile/audit.test.ts` "rule 3" (no write API; `workspace.fs` only for `stat`; Stage and Revert only through the Git extension's `add`, `revert` and `clean`, after a modal prompt); `picked` (the context menu's files) |

## Implementation notes

- The extension host feeds every output chunk to the screen model, so that is
  O(chunk): the cells are updated in place, the state is computed only when an
  ask asks for it, and memory is the screen (at most 1000 × 500 cells, two
  grids). Output reaches VS Code's terminal in one write per 16 ms batch
  (`OutputBatcher`; a Pseudoterminal has no flow control). The stage-2 reader
  instead appended each chunk to a 256 KiB string and sliced it, copying the
  whole tail per chunk: measured at ~0.4 MB/s of small chunks, far below what
  Claude Code's full-screen redraws produce. That is the likely cause of a
  freeze seen in a real devcontainer (only the Claude terminal: no input, no
  redraw on resize): the extension host fell behind, and the relay, then
  blocking on its stdout, stopped reading keys and resize lines. A fault in the
  output, input or resize path is logged and never stops the stream.
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
  `src/pty.ts`, `src/screen.ts`, `src/prompt.ts`, `src/session.ts`,
  `src/paste.ts`, `src/install.ts`; none imports `vscode`. `src/ask.ts`
  (presets, @-mentions), `src/selection.ts` (which selection Claude keeps) and
  `src/changes.ts` (the changes list, Review All's rows) are vscode-free
  models. The VS Code
  glue is `src/vscode/` and `src/extension.ts`.
- The socket path is limited to 107 bytes, so a workspace at a very long path
  gets no link (Start says so).
- `getDiagnostics` for one file with no diagnostics answers one entry with an
  empty list (VS Code's own shape). Whether Anthropic's extension answers `[]`
  instead could not be established; Claude accepts either.

## The launcher

**Claude Sandbox: Start** (palette, the status-bar item, `Ctrl+Alt+C Ctrl+Alt+C`) opens
the one linked session as a terminal in the editor area, beside the active
editor. Starting while a session runs focuses its terminal. The terminal's
process is the pty relay (rule 9) running `/usr/local/bin/claude` with the
merged `--settings` (`withSettings`) and the user's `claudeSandbox.extraArgs`.
In a multi-root window Start asks which workspace folder Claude runs in,
offering the last one chosen first (from a workspace folder's Explorer context
menu, that folder); with one folder it just uses it.
claude-sandbox makes that folder the one writable project, the link's socket
is there (the jail sees it), and Claude Code takes it as its project. The link's
workspace is that folder alone: files in the other folders are outside it for
openDiff, selections, @-mentions and diagnostics, and if the folder is removed
from the window the link's workspace is empty.

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
on stdin, output on stdout, resizes on fd 3, the exit status as its own,
every descriptor non-blocking with bounded buffers. It
runs under claude-sandbox's root-owned interpreter, which is installed
wherever the shadow is, and is passed as `-c` text so there is no file to
protect.

## Install offer

On startup (`onStartupFinished`), if `/usr/local/bin/claude` is not
claude-sandbox's shim (its text names `…/venv/bin/python -I -m claude_sandbox
_shadow`) or `/usr/local/bin/claude-sandbox` is missing, a notification says
"claude-sandbox isn't installed in this container" (or, when
`claude-sandbox version` reports one older than 5.0.0b3, that it needs 5.0.0b3
or later) and offers **Install**, which opens a visible terminal running
`uvx --no-cache --from 'claude-sandbox>=5.0.0b3' claude-sandbox install` (with sudo when not root; uvx only from the fixed paths of rule 10).
Without uvx it links to the claude-sandbox docs instead. Start checks the same
(the interpreter too) and offers the same; a relay that cannot start because
the interpreter is missing says so on the terminal, not just "exited 127". Once a day at most, `claude-sandbox
version` is compared with PyPI's latest (its latest stable, or for a
pre-release install the newest release that is not yanked); a newer one gets a
notice naming `uvx --from 'claude-sandbox>=5.0.0b3' claude-sandbox install`,
never an upgrade.

## Presets

The editor's context menu has a **Claude Sandbox** submenu: Explain, Reword,
Tighten, **My presets…** (from `claudeSandbox.presets`, a list of
`{title, prompt}` in user settings) and **Mention in Claude**. With text
selected, the presets are also code actions of kind
`refactor.rewrite.claudeSandbox`, one flat list in **Refactor…** and `Ctrl+.`:
the user's first, then Explain, Reword and Tighten. A user preset's action
names it by title (the hidden `claudeSandbox.runPreset` looks the prompt up in
the setting), so no command argument carries a prompt. There is no free-form
ask: Claude already sees the selection with whatever is typed in its terminal.
Keybindings share one chord prefix,
`Ctrl+Alt+C`: Start `Ctrl+Alt+C Ctrl+Alt+C`, then a letter for Explain `E`,
Reword `R`, Tighten `T`, My presets `P`, Mention `M`, Review All `V`
(Next and Previous Change take `F8` and `Shift+F8`, scoped to Review All: see
the Claude Changes view).
The earlier single `Ctrl+Alt+<letter>` keys collided with VS Code's own
(`Ctrl+Alt+I` is Open Chat on Linux and Windows); VS Code binds nothing to
`Ctrl+Alt+C` on Linux or Windows (Copy Path is `Ctrl+Shift+Alt+C` /
`Shift+Alt+C`), so one prefix claims a single key and the letters after it
cannot collide. The chord is the same on macOS (where `Cmd+Alt+C` is Copy
Path, not `Ctrl+Alt+C`).
Each needs the linked session running. An ask follows rule 6: the selection
over the link, an MCP ping as a barrier, the prompt as one paste, Enter. With
no selection the whole file is named with a typed `@path`. If Claude is in a
menu, has a proposed change waiting, or is working (its spinner is drawn), a
warning says so and nothing is typed; a session still starting is waited for up to 20 s. Mention
sends `at_mentioned` (Claude Code inserts `@path#La-b` into its input, no
Enter); a path with whitespace, or no link, is typed instead, and only into the
input box.

## Claude Changes view

A side-bar view container (its own icon) holds **Changed this session**: the
files in Claude's workspace folder that changed while the linked session ran, from
`vscode.workspace.createFileSystemWatcher`, excluding paths with a `.git`
segment, our sockets, folders, and changes from the user's own saves (within
2 s of `onWillSave`/`onDidSave`). VS Code's watcher applies
`files.watcherExclude` itself; the extension does not read it (rule 11). The
list is reset at each Start and kept after the session ends. A click opens VS
Code's diff against HEAD through the built-in Git extension's API (`getAPI(1)`,
`toGitUri(uri, 'HEAD')`, `vscode.diff`); a file HEAD lacks (untracked or added)
opens as itself; a deleted one is HEAD against empty; a symlink is listed
("symlink") and not opened. As in Source Control, a file is shown only while
the Git extension reports a change for it (working tree, index, untracked, a
merge, or a rename's old path): one put back as HEAD has it, ignored, or
committed drops out, and comes back if it changes again. Files outside any
repository are always shown. The list records at most 50,000 files (an `npm ci` rewrites
thousands under `node_modules`); when full it first forgets files the view does
not show that changed at least 5 s ago (a forgotten file returns if it changes
again), and if still full says how many later changes it did not record. When the shown files span more than one
repository (or, outside any, workspace folder) they are grouped under one
node per root, as Source Control groups by repository; with one root the
files are listed directly. Each repository's status is followed
(`state.onDidChange`, keyed by `rootUri`) from the first time it is looked
at, until the next Start. **Mark as reviewed** (inline) ticks a file until it
changes again; the view's badge and the status bar count the rest.
The right-click menu (on the selection, several rows at once) has **Open
File** (not for a deleted file or a symlink), **Mark as reviewed** / **Mark
as not reviewed**, **Stage** (the Git extension's `add`; a staged file is
marked reviewed), **Revert to HEAD**, **Reveal in Explorer View** and **Copy
Path** / **Copy Relative Path**. Revert to HEAD, and **Revert All Changes to
HEAD** in the title bar's `…` menu (every file the view shows, not
`git.cleanAll`, which would discard the whole repository's changes), ask
first, then unstage what is staged (`revert`) and discard the rest (`clean`):
a tracked file is checked out, one HEAD lacks is deleted (to the trash where
VS Code can). Stage and Revert are offered only for files in a repository.
**Review All Changes** (the view's title bar, the palette, `Ctrl+Alt+C V`)
opens every listed file in VS Code's multi-file diff editor:
`vscode.changes` with title "Claude changes" (VS Code adds " (N files)" for
the tab), in place of a Review All tab already open (each `vscode.changes` is a
new editor, so it would otherwise open beside it), and one
`[resource, HEAD, now]` row per file, a missing side `undefined` (VS Code shows
a new file as added, a deleted one as deleted); symlinks left out. No host git
command runs; VS Code reads the contents.
**Next Change** and **Previous Change** (the view's title bar, the palette)
run VS Code's own `multiDiffEditor.goToNextChange` / `goToPreviousChange`
(VS Code 1.106+, where they are also the multi-file diff editor's own arrows
and `Alt+F5` / `Shift+Alt+F5`), which step through the active multi-file diff
editor's changes and on into the next or previous file. When Review All is not
the active editor (its tab's label is not "Claude changes", alone or followed
by VS Code's count) they open it instead, at the top; the next step goes to its
first change. They take `F8` and `Shift+F8`, VS Code's next and previous
problem, only where stepping through changes is what the user is doing: with
Review All active or the Changes view focused. Review All active is the
`claudeSandbox.reviewing` context key, from the active tab's label, set only
when VS Code has the commands (`getCommands` at activation), so on 1.105 `F8`
in Review All still goes to problems. These are the only keys outside the
`Ctrl+Alt+C` prefix.
`claudeSandbox.autoOpenDiffs` (off by default) opens each change's diff as a
preview. Grouping by prompt is a later addition.
