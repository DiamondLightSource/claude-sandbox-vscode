# Claude Sandbox for VS Code

Makes VS Code the IDE of a Claude Code session that runs inside
[claude-sandbox](https://github.com/DiamondLightSource/claude-sandbox): Claude
sees your editor selection, shows proposed edits as diffs in VS Code for you to
accept or reject, and reads the workspace's diagnostics. It speaks Claude
Code's IDE protocol (MCP over a WebSocket), the role Anthropic's own extension
plays for an unsandboxed Claude. claude-sandbox itself is not changed.

**Status: stage 1.** The bridge works; the terminal launcher is not built yet.
Run **Claude Sandbox: Copy launch command** and paste the copied
`claude --settings '…'` into a devcontainer terminal in the workspace folder.

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

1. The extension listens on a Unix socket in the workspace root
   (`.claude-sandbox-vscode-<port>.sock`, mode 0600), which the jail can see.
2. claude-sandbox is given `--settings` with `CLAUDE_CODE_SSE_PORT` and
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
- Diagnostics and selections are sent only for workspace files.
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
the end-to-end hook test.

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
