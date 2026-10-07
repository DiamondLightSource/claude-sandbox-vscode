# Claude Sandbox for VS Code

Makes VS Code the IDE of a Claude Code session that runs inside
[claude-sandbox](https://github.com/DiamondLightSource/claude-sandbox): Claude
sees your editor selection, shows proposed edits as diffs in VS Code for you to
accept or reject, and reads the workspace's diagnostics. It speaks Claude
Code's IDE protocol (MCP over a WebSocket), the role Anthropic's own extension
plays for an unsandboxed Claude. claude-sandbox itself is not changed.

## Usage

The extension runs in a devcontainer (it installs into the container's VS Code
server).

1. **Install claude-sandbox.** If it isn't installed in the container, a
   notification offers **Install**, which runs
   `uvx --no-cache --from 'claude-sandbox>=5.0.0b1' claude-sandbox install`
   (with sudo when you are not root; the extension needs claude-sandbox
   5.0.0b1 or later, and an older install gets the same offer) in a terminal you can watch. Nothing runs until you click. uvx is
   used only from `/usr/local/bin`, `/usr/bin` or `~/.cargo/bin` (never from
   `PATH`, and not `~/.local/bin`, which the sandbox can write); without one
   there, the notification links to the
   [claude-sandbox docs](https://diamondlightsource.github.io/claude-sandbox/). When a newer claude-sandbox is on PyPI you get a notice
   (at most once a day); the extension never upgrades it.
2. **Start.** **Claude Sandbox: Start** (command palette, the `Claude:` status
   bar item, or `Ctrl+Alt+C Ctrl+Alt+C`) opens Claude in a terminal tab beside
   your editor, running in the sandbox and linked to this window. Claude
   always starts in the **first** workspace folder (in a multi-root window
   too): the link's socket lives there, where the sandbox can see it. The status bar shows `waiting` until Claude connects, then
   `connected`. Running Start again focuses the session. Exiting Claude, or
   closing its tab, ends the session; so does reloading the window.
3. **Presets.** Select text, right-click, **Claude Sandbox**: Explain, Reword,
   Tighten, **My presets…**, **Ask about selection…** or **Mention in Claude**
   (puts `@file#L1-3` into Claude's prompt without sending it). Keys: press
   `Ctrl+Alt+C`, then `E` Explain, `R` Reword, `T` Tighten, `P` My presets,
   `A` Ask, `M` Mention, `V` Review All (one prefix, so nothing shadows VS
   Code's own `Ctrl+Alt` keys such as Open Chat). A preset is typed only when
   Claude's input box is on screen: if Claude is asking you something (a
   permission or any other menu), waiting on a proposed change, or working
   (its spinner, e.g. `(1s · ↓ 25 tokens · thinking)`, is showing), you get a
   warning and nothing is typed. What you selected stays Claude's selection
   when you click into its terminal; a cursor in a workspace file sends that
   file and line; selecting in a file outside the workspace clears it.
4. **Changed this session.** The Claude Sandbox side bar lists the files that
   changed in the workspace while the session ran (your own saves left out).
   Click one for VS Code's diff against HEAD; tick it with **Mark as
   reviewed** (it unticks if it changes again). **Review All Changes** (the
   view's title bar, or the command) opens them all in VS Code's multi-file
   diff editor. Like Source Control, it shows only files git shows a change
   for: one put back as HEAD has it, or ignored by git (`.pyc`), or already
   committed, drops out (outside a repository every changed file is shown).
   When the files span several repositories they are grouped by repository.
   Symlinks are listed as "symlink" and never opened. The count
   is on the view and in the status bar. There is no revert button: use
   Source Control's Discard.
5. **Reviewing edits.** With `claudeSandbox.reviewEdits` (on by default)
   Claude asks before every `Edit`, `Write` and `NotebookEdit`, in auto mode
   too, and each such edit opens here as a diff to accept or reject. Edits
   made through the shell (`sed -i`, `echo > file`, a script) are **not**
   caught: no prompt, no diff. The Changed this session view lists them.

Settings (user settings only; a workspace cannot set them):

- `claudeSandbox.extraArgs`: extra arguments for Claude Code, e.g.
  `["--model", "opus"]`.
- `claudeSandbox.presets`: your own presets, `[{"title": "Summarise",
  "prompt": "Summarise the selection in one paragraph."}]`.
- `claudeSandbox.autoOpenDiffs`: open each change's diff as it happens (off).
- `claudeSandbox.reviewEdits`: make Claude ask before file-edit tools, so
  each edit is shown as a diff (on).

**Claude Sandbox: Copy launch command (advanced)** copies a
`claude --settings '…'` that links a Claude you start by hand in a
devcontainer terminal instead.

## Install

Until the extension is on the VS Code Marketplace, install it from the latest
GitHub release. In a terminal in the devcontainer, with VS Code attached:

```sh
curl -fsSLO https://github.com/DiamondLightSource/claude-sandbox-vscode/releases/latest/download/claude-sandbox-vscode.vsix
code --install-extension claude-sandbox-vscode.vsix
```

Or download the `.vsix` from the
[releases page](https://github.com/DiamondLightSource/claude-sandbox-vscode/releases)
and use **Extensions → ⋯ → Install from VSIX…**. Either way it installs into
the devcontainer. Repeat to update.

## How it works

1. The extension listens on a Unix socket in the first workspace folder
   (`.claude-sandbox-vscode-<port>.sock`, mode 0600), which the jail can see;
   Claude starts in that folder.
2. **Start** runs the sandbox's `claude` (`/usr/local/bin/claude`) as the
   terminal's own process, on a pty made by a small Python relay that the
   extension runs with claude-sandbox's own interpreter, so it can see when
   Claude's input box is up (a small virtual screen of what the terminal shows
   now). Claude is given `--settings` with `CLAUDE_CODE_SSE_PORT` and
   `SessionStart`/`SessionEnd` hooks. Inside the jail the start hook starts
   `socat` (TCP `127.0.0.1:<port>` to the socket) unless it already runs, and
   once it listens writes Claude Code's lock file
   (`~/.claude/ide/<port>.lock`, with the auth token), never over an existing
   one. The end hook removes it on a real exit (not on `/clear` or `/resume`).
3. Claude Code connects; the extension checks the token and serves four MCP
   tools: `openDiff`, `close_tab`, `closeAllDiffTabs`, `getDiagnostics`.

One linked Claude session per VS Code window, in a devcontainer with
claude-sandbox installed: while it is connected, another connection is
refused. Other Claude sessions run sandboxed without the IDE link.

The full design and the protocol notes are in [docs/design.md](docs/design.md).

## Security

The extension host runs outside the sandbox with your full privileges, and
anything inside the sandbox can read the token and reach the socket, so every
message is treated as hostile ([trust boundary](docs/design.md#trust-boundary)):

- Only the four tools above; nothing that runs code, opens URLs or writes files.
- `openDiff` reads only real paths inside a workspace folder, never in `.git`,
  one path component at a time without following symlinks (a symlink swapped
  in after the check is refused).
- The extension never writes a workspace file: Accept hands the text back and
  Claude writes it from inside the sandbox. Closing a diff is a rejection.
  Accept and Reject work from either side of the diff.
- Diagnostics, selections and mentions are sent only for workspace files.
- Claude runs as the terminal's own process, never typed into a shell. Presets
  are typed only while Claude's input box is on the screen now (read from a
  virtual screen, at the bottom, with the cursor in it: text the model writes
  cannot draw that), never into a menu where Enter would approve something,
  as one bracketed paste with control characters removed. Whatever an Enter
  reaches still runs inside the sandbox.
- The pty relay is a constant program run by claude-sandbox's root-owned
  interpreter (`-I`); only Claude's arguments vary. The install command is
  fixed in the extension and runs only on your click. All settings are
  user-scoped.
- The changes view reads and writes no file itself (it `lstat`s, never
  follows a symlink, and reads no workspace setting such as
  `files.watcherExclude`); VS Code's diff does the reading and the Git
  extension runs git.
- The host never writes into the sandbox's `~/.claude`; the in-sandbox hook
  writes the lock file, and every value in its shell command is validated and
  quoted. The host deletes nothing in the workspace either (its own socket
  goes when the link closes).
- The hand-written WebSocket server has no runtime dependencies: messages are
  capped at 16 MiB (from the frame header), at most 4 connections in their
  handshake and one linked session, a handshake timeout, backpressure on
  output (a client that stops reading is not read, and is dropped past
  32 MiB queued), a ping every 30 s (a client that answers nothing is
  dropped), permessage-deflate refused, parsed JSON never merged into
  objects, and nothing from the sandbox logged unescaped.
- The token appears in claude-sandbox's argv. Other users cannot use it (the
  socket is 0600); processes running as you are already trusted.

Every rule has a test in `test/hostile/` or `test/unit/`; the mapping is in
[docs/design.md](docs/design.md#rule--test).

**Out of scope (residual risk).** VS Code on a workspace the sandbox can write
is exposed whether or not this extension is installed: `.vscode/settings.json`
(interpreter paths, tasks) and `.git/config` (fsmonitor, filter drivers) run
on the host. Keep such workspaces untrusted in VS Code's Workspace Trust, or
review the agent's changes to them before reopening.

## Development

Linux, Node 22.18 or later (tests run the TypeScript directly), and `socat` for
the end-to-end hook test, and Python 3 for the pty relay test (claude-sandbox's interpreter when installed).

```sh
npm ci
npm run typecheck
npm test            # node --test: test/unit and test/hostile
npm run build       # esbuild → dist/extension.cjs
npm run package     # .vsix via @vscode/vsce
```

## Releasing

Push a tag `vX.Y.Z` on `main`. `.github/workflows/release.yml` sets the
version from the tag, runs the tests and attaches `claude-sandbox-vscode.vsix`
to a GitHub release. A tag with a suffix (`v0.2.0-rc1`) makes a GitHub
pre-release only.

Marketplace publishing is off until the repository variable
`MARKETPLACE_PUBLISH` is `true`. When it is, a release is also published to
the VS Code Marketplace.

Publishing signs in to Microsoft Entra ID with GitHub's OIDC token (no stored
secret). The `marketplace` environment holds two variables, `AZURE_CLIENT_ID`
and `AZURE_TENANT_ID`, for an app registration that has a federated
credential for this repository's `marketplace` environment and is a
Contributor member of the `diamondlightsource` Marketplace publisher.

## License

MIT, Copyright (c) 2026 Diamond Light Source Ltd.
