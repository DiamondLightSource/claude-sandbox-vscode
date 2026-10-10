# Claude Sandbox for VS Code

Makes VS Code the IDE of a Claude Code session running inside
[claude-sandbox](https://github.com/DiamondLightSource/claude-sandbox): Claude
sees your selection, shows proposed edits as diffs to accept or reject, and
reads the workspace's diagnostics. It speaks Claude Code's IDE protocol (MCP
over a WebSocket), the role Anthropic's own extension plays for an
unsandboxed Claude. The full design, protocol notes and security rules are in
[docs/design.md](docs/design.md).

## Install

The extension runs in a devcontainer. Until it is on the Marketplace, install
the latest GitHub release from a devcontainer terminal with VS Code attached:

```sh
curl -fsSLO https://github.com/DiamondLightSource/claude-sandbox-vscode/releases/latest/download/claude-sandbox-vscode.vsix
code --install-extension claude-sandbox-vscode.vsix
```

Or download the `.vsix` from the
[releases page](https://github.com/DiamondLightSource/claude-sandbox-vscode/releases)
and use **Extensions → ⋯ → Install from VSIX…**. Repeat to update.

It needs claude-sandbox 5.0.0b3 or later. If it is missing or older, a
notification offers **Install**, which runs
`uvx --no-cache --from 'claude-sandbox>=5.0.0b3' claude-sandbox install`
(with sudo when not root) in a terminal you can watch. uvx is taken only from
`/usr/local/bin`, `/usr/bin` or `~/.cargo/bin`, never from `PATH`. The
extension tells you (at most daily) when a newer claude-sandbox is on PyPI but
never upgrades it.

## Usage

- **Start**: **Claude Sandbox: Start** (command palette, the `Claude:` status
  bar item, or `Ctrl+Alt+C Ctrl+Alt+C`) opens Claude in a terminal beside
  your editor, sandboxed and linked to this window. Claude runs in, and can
  write, one workspace folder: in a multi-root workspace Start asks which (the
  last one chosen comes first), or right-click a folder in the Explorer and
  choose **Start**. The status bar goes from `waiting` to `connected`. Exiting Claude,
  closing its tab or reloading the window ends the session.
- **Presets**: select text, right-click **Claude Sandbox**, or press
  `Ctrl+Alt+C` then `E` Explain, `R` Reword, `T` Tighten, `P` My presets,
  `M` Mention (inserts `@file#L1-3` without sending), `V` Review All. With
  text selected, **Refactor…** (`Ctrl+Shift+R`) and `Ctrl+.` list your
  presets then Explain, Reword and Tighten; to drop Copilot's entries from
  those menus, set `github.copilot.editor.enableCodeActions` to `false`. A
  preset is typed only when Claude's input box is showing; while Claude is
  working or asking you something you get a warning instead. Claude sees
  your selection, or the cursor's file and line, for workspace files only.
- **Changed this session**: the side bar lists files changed while the
  session ran (your own saves excluded, and only those git shows a change
  for). Click one for a diff against HEAD, tick **Mark as reviewed**, or
  **Review All Changes** to open them in the multi-file diff editor, then step
  with **Next/Previous Change** (`F8`/`Shift+F8` in that editor or the view,
  VS Code 1.106+). Right-click a file (or a selection) to open it, stage
  it, revert it to HEAD, reveal it or copy its path; **Revert All Changes
  to HEAD** is in the view's `…` menu. Staging and reverting are done by VS
  Code's Git extension, as Source Control's Stage and Discard are.
- **Reviewing edits**: with `claudeSandbox.reviewEdits` on, every `Edit`,
  `Write` and `NotebookEdit` (in auto mode too) opens as a diff to accept or
  reject. Edits made through the shell are not caught; the changes view
  still lists them.

Settings (user scope only):

| Setting | Default | Purpose |
| --- | --- | --- |
| `claudeSandbox.extraArgs` | `[]` | Extra Claude Code arguments, e.g. `["--model", "opus"]` |
| `claudeSandbox.presets` | `[]` | Your presets: `[{"title": "Summarise", "prompt": "…"}]` |
| `claudeSandbox.autoOpenDiffs` | `false` | Open each change's diff as it happens |
| `claudeSandbox.reviewEdits` | `false` | Ask before file-edit tools, showing each as a diff |

**Claude Sandbox: Copy launch command (advanced)** copies a
`claude --settings '…'` to link a Claude you start by hand instead.

## How it works

The extension listens on a 0600 Unix socket in the folder Claude runs in,
which the jail can see. **Start** runs the sandbox's `claude` through a small
Python pty relay (so the extension knows when the input box is up), with
`--settings` hooks that, inside the jail, bridge `127.0.0.1:<port>` to the
socket with `socat` and write Claude Code's IDE lock file. Claude connects,
the token is checked, and the extension serves four MCP tools: `openDiff`,
`close_tab`, `closeAllDiffTabs`, `getDiagnostics`. One linked session per
window. Details: [docs/design.md](docs/design.md).

## Security

The extension host runs outside the sandbox with your privileges, so every
message from the sandbox is treated as hostile
([trust boundary](docs/design.md#trust-boundary)):

- Only the four tools above; nothing that runs code, opens URLs or writes
  files. Accept hands the text back for Claude to write from inside the
  sandbox.
- `openDiff` reads only real workspace paths outside `.git`, without
  following symlinks.
- Diagnostics, selections and mentions are sent only for workspace files.
- Presets are typed only into Claude's input box (read from a virtual
  screen), never into a menu, as one bracketed paste with control characters
  removed.
- The WebSocket server is hand-written with no runtime dependencies and caps
  message size, connections, queued output and idle clients.

Every rule has a test in `test/hostile/` or `test/unit/`
([mapping](docs/design.md#rule--test)).

**Out of scope:** a workspace the sandbox can write can attack VS Code through
`.vscode/settings.json` or `.git/config` whether or not this extension is
installed. Keep such workspaces untrusted in Workspace Trust, or review those
files before reopening.

## Development

Linux, Node 22.18+, `socat` and Python 3 for the tests. The repository's
devcontainer has all of them, installs claude-sandbox and runs `npm ci`; its
**Run Extension** launch configuration opens an Extension Development Host
with the development build.

```sh
npm ci
npm run typecheck
npm test            # test/unit and test/hostile
npm run build       # dist/extension.cjs
npm run package     # .vsix
```

## Releasing

Create a GitHub release with a new tag `X.Y.Z` (no `v` prefix) on `main`, or
just push the tag: `.github/workflows/release.yml` tests and attaches the
`.vsix` to the release, creating it if there is none. A suffixed tag such as `0.2.0-rc1`
makes a GitHub pre-release only. With the repository variable
`MARKETPLACE_PUBLISH` set to `true`, other tags are also published to the
Marketplace, signing in via GitHub OIDC with the `marketplace` environment's
`AZURE_CLIENT_ID` and `AZURE_TENANT_ID`.

## License

MIT, Copyright (c) 2026 Diamond Light Source Ltd.
