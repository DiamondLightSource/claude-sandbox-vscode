# Exploratory test charter

A checklist for an occasional hands-on check of the extension in a real VS
Code, for example before a release. It is worked through by a person or by an
LLM agent driving VS Code (through an automated VS Code driver, such as one
using the DevTools protocol, or by hand).

It does not repeat the deterministic tests. `npm test` (`test/unit/`,
`test/hostile/`, run in CI) already covers the protocol, the trust boundary
rules, the virtual screen, the pty relay, the install command and the changes
model; [design.md, Rule → test](design.md#rule--test) maps each rule to its
tests. This charter looks for what those tests cannot see:

- integration across VS Code, the devcontainer, the terminal and a live Claude
  session;
- UI and state glitches: focus, a status bar stuck on `waiting`, diffs opening
  in the wrong editor group, stale review state after a reload;
- unclear or noisy notifications;
- keybindings and context menus offered (or not) in the right places;
- the experience as a whole: is anything confusing?

Each check gives what to try, the expected outcome (from the
[README](../README.md) and [design.md](design.md), so a wrong behaviour is not
taken for a right one) and the evidence to collect. Where the docs say nothing,
the check says so: record what happens, and flag it if it surprised you.

## Contents

- [Setup](#setup)
- [How to work](#how-to-work)
- [Checks](#checks)
  - [S: Start and the session lifecycle](#s-start-and-the-session-lifecycle)
  - [K: Keybindings and menus](#k-keybindings-and-menus)
  - [P: Presets and Mention](#p-presets-and-mention)
  - [D: Proposed edits](#d-proposed-edits)
  - [R: Changed this session and Review All](#r-changed-this-session-and-review-all)
  - [C: Copy launch command](#c-copy-launch-command)
  - [I: Install and update notifications](#i-install-and-update-notifications)
  - [M: Multi-root](#m-multi-root)
  - [F: Failure modes](#f-failure-modes)
  - [X: Security rules at the UI](#x-security-rules-at-the-ui)
- [Flakiness](#flakiness)
- [Time box](#time-box)
- [Report template](#report-template)

## Setup

### Prerequisites

- A devcontainer with VS Code attached from the host (the only supported
  setup: [design.md, Scope](design.md#scope)). Rootless Podman is the usual
  engine; Docker works the same for this charter. This repository's own
  devcontainer is a good base: it mounts the parent folder as `/workspaces`,
  so other projects there are peers.
- VS Code 1.106 or later, so that Next and Previous Change can step (on 1.105
  they only open Review All). One check (R9) wants 1.105 too; skip it if you
  have only one version.
- claude-sandbox 5.0.0 or later in the container (the README's minimum). The
  extension's own install offer installs 5.1.0 or later. Check with
  `claude-sandbox version`.
- A Claude login the sandbox can use: run `claude` once in a devcontainer
  terminal and log in, then exit.
- `git`, and `ls`, `stat` and `cat` for evidence.

### The build under test

Build the `.vsix` from the branch under test in a devcontainer terminal:

```sh
npm ci
npm run package     # writes claude-sandbox-vscode-<version>.vsix
code --install-extension claude-sandbox-vscode-*.vsix --force
```

Or download the `claude-sandbox-vscode-vsix` artifact from the branch's CI run
and install that. Then run **Developer: Reload Window**.

- A branch build carries `package.json`'s version (`0.0.1`); releases take the
  tag's. Installing it over a newer Marketplace copy is a downgrade, so turn
  off extension auto-update for the run (`extensions.autoUpdate: false`, or
  the extension's own **Auto Update** toggle), or VS Code may put the release
  back mid-run.
- Confirm in the Extensions view that **Claude Sandbox for VS Code** shows the
  branch's version and runs in the container (not locally).
- The **Run Extension** launch configuration (an Extension Development Host)
  also works for a quick look, but a pass before a release should use the
  packaged `.vsix`.

### Sample workspace

Make these under `/workspaces` (any names will do; the charter uses these):

- `/workspaces/alpha`: a git repository with a few committed files:
  - `src/app.py` with a deliberate error (an undefined name) so the Problems
    panel has a diagnostic (any language with a linter in the container
    will do);
  - `README.md` with a paragraph of prose (for Reword and Tighten);
  - `notes/with space.md` (a path with whitespace: Mention types it
    instead of sending it over the link);
  - a `.gitignore` listing `ignored.txt`.
- `/workspaces/beta`: a second git repository with one or two files.
- `/workspaces/gamma`: a plain folder, not a git repository.
- `/workspaces/multi.code-workspace` listing `alpha`, `beta` and `gamma`.

Open `alpha` alone for most checks and the `.code-workspace` for the M checks.

User settings to have ready (the extension reads user settings only):

```jsonc
"claudeSandbox.presets": [
  { "title": "Summarise", "prompt": "Summarise the attached selection in one sentence." }
],
"claudeSandbox.reviewEdits": false,
"claudeSandbox.autoOpenDiffs": false,
"claudeSandbox.extraArgs": []
```

### Where the evidence is

| Evidence | Where |
| --- | --- |
| Extension log | Output panel, channel **Claude Sandbox**. Lines are tagged `[ide]`, `[session]`, `[pty]`, `[install]`. |
| Status bar | The right-hand item: `Claude: off`, `Claude: waiting` or `Claude: connected`, plus `· N changed` while files await review. Its tooltip is `Claude Sandbox: Start` or `Claude Sandbox: show the session`. |
| Link files | `ls -l /workspaces/alpha/.claude-sandbox-vscode-*.sock` (mode `srw-------`). |
| Files on disk | `git -C <folder> status --short`, `git -C <folder> diff`, `stat -c '%y %n' <file>`. |
| Terminal | The **Claude Sandbox** tab in the editor area; after a non-zero exit it is renamed `Claude Sandbox (exited N)`. |
| Changes view | Activity bar, **Claude Sandbox** icon, view **Changed this session**: rows, descriptions, badge count. |

Record the text of every notification exactly; wording is part of what is
being tested.

## How to work

- Work through the areas in order the first time: later ones assume a running
  session from S.
- Tick each check `pass`, `fail` or `skip` (with a reason) in the
  [report](#report-template).
- On anything odd, collect the evidence at once (log, status bar text, `git
  status`) before trying again: a retry can erase it.
- Restore anything you break on purpose (F and I checks) before moving on.
- Use a throwaway container for checks marked **(destructive)**.

## Checks

The IDs are for the report. "Palette" means the Command Palette; command
titles are shown as the palette shows them.

### S: Start and the session lifecycle

Expected behaviour: [README, Usage](../README.md#usage);
[design.md, The launcher](design.md#the-launcher);
[How the link works](design.md#how-the-link-works).

- [ ] **S1 Start from the palette.** With `src/app.py` open, run **Claude
  Sandbox: Start** (`claudeSandbox.start`).
  Expect: a **Claude Sandbox** terminal opens in the editor area beside the
  active editor; the status bar shows `Claude: waiting`, then
  `Claude: connected` (Claude connects about 0.3 s after its lock appears; up
  to 12 s has been seen). The log shows `[ide] listening on …` then
  `[ide] Claude Code connected (pid …, in the jail)`.
  Evidence: time from Start to `connected`; the socket's `ls -l`; the log.
- [ ] **S2 Start from the other entry points.** End the session, then start
  it from the status bar item, from `Ctrl+Alt+C Ctrl+Alt+C`, and from the
  **Changed this session** view's title bar (the sparkle icon) and welcome
  button. Expect the same result as S1 each time.
- [ ] **S3 Start while running.** With a session running, use each entry point
  again. Expect: the existing terminal is focused; no second session, no new
  socket, nothing new in the log. The view's title-bar Start is hidden while a
  session runs.
- [ ] **S4 Start with no folder.** In a window with no folder open, run Start.
  Expect the warning `Claude Sandbox: open a folder first.`
- [ ] **S5 Ask Claude something about the editor.** Select a few lines of
  `src/app.py`, then ask in the terminal "what have I selected?" and "what
  problems does `src/app.py` have?". Expect Claude to know the selection and
  to report the diagnostic (the link's `getDiagnostics`). Focus the terminal,
  the Output panel and a webview in turn: Claude keeps the last selection
  ([design.md rule 5](design.md#trust-boundary)).
- [ ] **S6 Exit with `/exit`.** Expect: the tab closes (exit code 0), the
  status bar shows `Claude: off`, the log shows `[session] Claude exited (0)`,
  the Changes view keeps its list. Any socket left is not an error: libuv
  removes it when the listener closes, and a crashed window's stale socket
  is left for the user ([rule 7](design.md#trust-boundary)).
- [ ] **S7 Close the tab.** Close the **Claude Sandbox** tab while Claude is
  idle, then again while it is working. Expect the session to end both times,
  status `Claude: off`, and no Claude process left
  (`pgrep -af claude` in another terminal).
- [ ] **S8 Non-zero exit.** Make Claude exit non-zero (for example
  `kill -TERM` its process from another terminal). Expect the tab to stay open
  renamed `Claude Sandbox (exited N)` with
  `[Claude exited with code N. Press any key to close this tab.]`; a key
  closes it.
- [ ] **S9 Reload.** Run **Developer: Reload Window** with a session
  running. Expect: the session ends, its terminal is not revived (it is
  transient), status `Claude: off`, no Claude left running. The next Start
  draws a new socket name (port).
- [ ] **S10 `/ide` inside the session.** In the linked session run `/ide`,
  choose **None**, then choose the extension again. Expect: after None the
  status bar goes back to `Claude: waiting` (the log says
  `[ide] Claude Code disconnected`); choosing it again shows `connected`.
  Choosing the IDE already connected keeps it connected
  ([design.md, Scope](design.md#scope)).
- [ ] **S11 `/clear`, `/resume`.** Run each in the linked session. Expect the
  link to survive (status stays or returns to `connected` without a new
  Start).
- [ ] **S12 Extra arguments.** Set `claudeSandbox.extraArgs` to
  `["--model", "opus"]` in user settings and start. Expect Claude to start on
  that model. Then set it to `["--settings", "/some/file.json"]`. Expect an
  error notification (`Claude Sandbox: The command gives Claude Code a
  settings file (--settings); …`) and no session (a settings file means no
  link). Restore `[]`.
- [ ] **S13 Stuck states.** Throughout the run, note any time the status bar
  shows `waiting` while Claude is clearly up and answering, or `connected`
  after the session ended. Either is a bug.

### K: Keybindings and menus

Expected behaviour: [README, Usage](../README.md#usage);
[design.md, Presets](design.md#presets) and
[Claude Changes view](design.md#claude-changes-view); the `contributes`
section of `package.json`.

Keybindings (all on Linux and Windows; the same keys on macOS):

| Key | Command | Only when |
| --- | --- | --- |
| `Ctrl+Alt+C Ctrl+Alt+C` | `claudeSandbox.start` | always |
| `Ctrl+Alt+C E` | `claudeSandbox.preset.explain` | text editor focused, a `file` or `vscode-remote` file |
| `Ctrl+Alt+C R` | `claudeSandbox.preset.reword` | as above |
| `Ctrl+Alt+C T` | `claudeSandbox.preset.tighten` | as above |
| `Ctrl+Alt+C P` | `claudeSandbox.customPreset` | as above |
| `Ctrl+Alt+C M` | `claudeSandbox.mention` | as above |
| `Ctrl+Alt+C V` | `claudeSandbox.reviewAll` | always |
| `F8` | `claudeSandbox.nextChange` | Review All active (VS Code 1.106+), or the Changes view focused |
| `Shift+F8` | `claudeSandbox.previousChange` | as above |

- [ ] **K1 Chords in an editor.** In `src/app.py` (a `vscode-remote` file in
  the UI) try each chord, with and without a selection. Expect each runs its
  command (P and M covered in detail under P).
- [ ] **K2 Chords elsewhere.** Try `Ctrl+Alt+C E` etc. with focus in an
  untitled file, the Settings JSON, the Output panel, the Explorer and the
  Claude terminal. Expect the preset and Mention chords to do nothing outside
  a file editor. `Ctrl+Alt+C Ctrl+Alt+C` and `Ctrl+Alt+C V` have no `when`
  clause; whether they reach VS Code from inside the Claude terminal (rather
  than going to Claude) is not documented: record what happens.
- [ ] **K3 `F8` outside review.** In an editor with a diagnostic, and no
  Review All open, `F8` must still go to the next problem.
- [ ] **K4 Editor context menu.** Right-click in `src/app.py`: a **Claude
  Sandbox** submenu with Explain, Reword, Tighten, My presets… and Mention in
  Claude. Right-click in an untitled file, a proposal diff (D checks) and a
  Git HEAD diff: the submenu should not appear there.
- [ ] **K5 Refactor… and `Ctrl+.`.** With text selected, **Refactor…**
  (`Ctrl+Shift+R`) and `Ctrl+.` list `Claude: Summarise` (your preset) first,
  then `Claude: Explain`, `Claude: Reword`, `Claude: Tighten`,
  `Claude: Mention`. With no selection they list only `Claude: Mention`, and
  the lightbulb does not appear on every line just from moving the cursor.
- [ ] **K6 Explorer context menu.** In a single-folder window, right-click
  files and the folder: no **Start**. (Multi-root: M2.)
- [ ] **K7 Palette contents.** Type `Claude Sandbox:` in the palette.
  Expect: Start, Explain, Reword, Tighten, My presets…, Mention in Claude,
  Mark all as reviewed, Revert All Changes to HEAD, Review All Changes,
  Previous Change, Next Change, Copy launch command (advanced). Not shown:
  Run preset, Open diff, Mark as reviewed, Mark as not reviewed, Open File,
  Stage, Revert to HEAD, Reveal in Explorer View, Copy Path, Copy Relative
  Path; Accept and Reject proposed change only while a proposal diff is
  focused.
- [ ] **K8 Copilot's entries.** If GitHub Copilot is installed, setting
  `github.copilot.editor.enableCodeActions` to `false` removes its entries
  from Refactor… and `Ctrl+.`, leaving the Claude ones.

### P: Presets and Mention

Expected behaviour: [README, Usage](../README.md#usage);
[design.md, Presets](design.md#presets) and
[rule 6](design.md#trust-boundary).

- [ ] **P1 Explain a selection.** Select a function in `src/app.py` and press
  `Ctrl+Alt+C E`. Expect: the Claude terminal is revealed without taking
  focus, the prompt is pasted and submitted once, and Claude explains that
  selection (it was sent over the link). Repeat with Reword and Tighten on
  `README.md` prose.
- [ ] **P2 No selection.** Put the cursor in `README.md` with nothing
  selected and run Explain. Expect the whole file to be named with a typed
  `@path` (visible in the submitted prompt).
- [ ] **P3 My presets.** `Ctrl+Alt+C P` opens a quick pick titled
  **Claude Sandbox preset** listing `Summarise` with its prompt as detail;
  choosing it sends it. With `claudeSandbox.presets` set to `[]`, expect
  `No presets of your own yet: …` with **Open settings**, which opens the
  setting.
- [ ] **P4 A preset removed under the menu.** Open `Ctrl+.` on a selection,
  then (without choosing) remove `Summarise` from settings in another window
  or quickly, and choose it. Expect
  `Claude Sandbox: that preset is no longer in your settings.`
- [ ] **P5 Busy refusals.** Trigger a preset while Claude is (a) working, (b)
  showing a permission question, (c) showing `/model`, (d) waiting on a
  proposed diff (D checks). Expect a warning each time and nothing typed:
  `Claude is working: send it again once it has finished.`,
  `Claude Code is asking you something in the terminal (its input box is not
  showing): answer it there first.`,
  `Claude is waiting for your answer to a proposed change: accept or reject
  it first.` Nothing must ever be typed into a menu: check the terminal after
  each.
- [ ] **P6 Starting session.** Run Start and immediately press
  `Ctrl+Alt+C E` on a selection. Expect the status bar message
  `Waiting for Claude Code to start…`, then the ask goes through once the
  input box appears (waits up to 20 s), or a warning that nothing was sent.
- [ ] **P7 No session.** With no session, run a preset. Expect
  `Claude Sandbox: start the linked session first.` with a **Start** button
  that starts one.
- [ ] **P8 Mention.** Select lines 3 to 5 of `src/app.py` and press
  `Ctrl+Alt+C M`. Expect `@src/app.py#L3-5` (or Claude's equivalent form)
  inserted into Claude's input with no Enter. Repeat with no selection (the
  file alone), and on `notes/with space.md` (typed instead of sent; check it
  is quoted or otherwise usable). With no editor open, expect
  `Claude Sandbox: mention needs a file open in the editor.`
- [ ] **P9 Typed text while an ask runs.** Type in the Claude terminal during
  a preset (between paste and Enter). Expect your keys to be held and to
  arrive after, not interleaved into the prompt.
- [ ] **P10 Vim mode.** If you use Claude Code's vim mode, run a preset in
  NORMAL and INSERT mode. Both are documented as working
  ([design.md, Out of scope](design.md#out-of-scope-residual-risk)).

### D: Proposed edits

Expected behaviour: [README, Usage](../README.md#usage) (Reviewing edits);
[rule 3](design.md#trust-boundary);
[design.md, Out of scope](design.md#out-of-scope-residual-risk)
(`reviewEdits`).

Turn on `claudeSandbox.reviewEdits` in user settings and start a new
session (it applies at Start).

- [ ] **D1 A diff opens.** Ask Claude to change one line in `src/app.py`.
  Expect a diff tab with Claude's title for it: left the file on disk
  (read-only), right the proposal; **Accept proposed change** and **Reject
  proposed change** (check and close icons) in the editor title. Focus stays in the Claude
  terminal. The diff opens in a group that is not the terminal's: the active
  editor group if that is not Claude's, otherwise another group, otherwise a
  new one beside. Log: `[ide] showing a proposed change to …`.
- [ ] **D2 Accept.** Click Accept. Expect: the diff closes, Claude writes the
  file from the sandbox (`git diff` shows exactly the proposal), the log says
  `[ide] accepted the change to …`, focus returns to Claude's group.
- [ ] **D3 Accept an edited proposal.** On the next diff, edit the right side
  before accepting. Expect the file on disk to hold your edited text, not
  Claude's original proposal.
- [ ] **D4 Reject.** Reject a diff. Expect the file unchanged (`git diff`,
  `stat` mtime unchanged), Claude told the edit was rejected, the log says
  `rejected`.
- [ ] **D5 Close the diff tab.** Close a proposal's tab instead of answering.
  Expect the same as Reject (not an accept).
- [ ] **D6 Accept from either side.** Focus the left (original) side and run
  **Accept proposed change** from the palette. Expect it to work as D2.
- [ ] **D7 New file.** Ask Claude to create a file. Expect the diff title to
  end `(new file)`.
- [ ] **D8 Several diffs, layouts.** With the editor split in two or three
  groups, and the Claude terminal in each in turn, trigger edits. Record where
  each diff opens. A diff that covers the Claude terminal, or that steals
  focus from it, is a bug.
- [ ] **D9 Auto mode.** Switch Claude to auto-accept edits mode and ask for an
  edit. Expect the diff still to appear (`reviewEdits` asks in auto mode too).
- [ ] **D10 Shell edits.** Ask Claude to change a file with `sed -i`. Expect
  no diff (documented: not caught) but the file listed in Changed this
  session.
- [ ] **D11 Settings off.** With `reviewEdits` off (new session), edits apply
  without a diff in VS Code (Claude's own prompt may still ask, depending on
  its mode).

### R: Changed this session and Review All

Expected behaviour: [README, Usage](../README.md#usage) (Changed this
session); [design.md, Claude Changes view](design.md#claude-changes-view);
[rule 12](design.md#trust-boundary).

Start a session in `alpha` and have Claude modify two tracked files, create
one, delete one, write `ignored.txt` and make a symlink
(`ln -s /etc/hostname link`). Save a file yourself too.

- [ ] **R1 The list.** Expect: the modified, new and deleted files listed;
  the symlink listed with description `symlink`; `ignored.txt` and your own
  save absent; the view's badge and the status bar's `· N changed` both equal
  to the number of unreviewed rows.
- [ ] **R2 Open a diff.** Click a modified file: a diff against HEAD. A new
  file opens as itself; a deleted one shows HEAD against empty; the symlink
  shows `link is a symlink: it is not opened here. Look at it in Source
  Control.`
- [ ] **R3 Mark as reviewed.** Use the inline check and the context menu's
  **Mark as reviewed** / **Mark as not reviewed**; the title bar's **Mark all
  as reviewed**. Expect the badge and status bar count to follow at once. Ask
  Claude to change a reviewed file again: it becomes unreviewed.
- [ ] **R4 Context menu per row type.** Right-click each kind of row. Expect:
  Open File not offered for deleted rows or symlinks; Reveal in Explorer View
  not for deleted rows; Stage and Revert to HEAD only in a git repository;
  Copy Path and Copy Relative Path everywhere (check the clipboard).
- [ ] **R5 Multi-select.** Select several rows and use Mark as reviewed,
  Stage and Revert to HEAD on them together.
- [ ] **R6 Stage.** Stage a file. Expect `git status --short` to show it
  staged and the row marked reviewed.
- [ ] **R7 Revert.** **Revert to HEAD** on a modified file and on a new file.
  Expect a modal confirmation first (Cancel leaves everything), then the
  tracked file checked out and the new file deleted; the rows leave the list.
  **Revert All Changes to HEAD** (the view's `…` menu) does the same for every
  listed file and nothing else in the repository (make an unrelated change in
  `beta` or an unlisted file first and check it survives). A file git could
  not revert is named in a warning.
- [ ] **R8 Review All.** `Ctrl+Alt+C V` (or the title bar's icon) opens one
  multi-file diff editor titled `Claude changes` (VS Code adds the count),
  with every listed file except the symlink, and an info message that the
  symlink is left out. Running it again replaces that tab rather than opening
  a second. With nothing listed: `Claude Sandbox: no changed files to review.`
- [ ] **R9 Next and Previous.** With Review All active, `F8` / `Shift+F8`
  step through changes and on into the next file. With the Changes view
  focused they work too. With Review All not active, Next opens it at the
  top. On VS Code 1.105: Next opens Review All, but stepping says
  `Claude Sandbox: stepping through changes needs VS Code 1.106 or later.`,
  and `F8` in Review All goes to problems.
- [ ] **R10 autoOpenDiffs.** Turn on `claudeSandbox.autoOpenDiffs` and have
  Claude change files. Expect each change's diff against HEAD to open as a
  preview. Note whether this fights with D's proposal diffs or steals focus.
- [ ] **R11 After the session.** End the session: the list stays, with the
  same reviewed state. Start again: the list resets.
- [ ] **R12 After a reload.** Reload with files listed. Record what the view
  shows (the docs say only that the list is kept after the session ends and
  reset at Start). Stale rows that cannot be opened, or a badge that does not
  match the rows, are bugs.
- [ ] **R13 Busy repository.** Have Claude run something that rewrites many
  files (for example `npm ci` in a Node project). Expect the view to stay
  responsive; above 50,000 files it says how many changes it did not record.

### C: Copy launch command

Expected behaviour: [README, Usage](../README.md#usage);
[design.md, Out of scope](design.md#out-of-scope-residual-risk).

- [ ] **C1 Copy.** With no session, run **Claude Sandbox: Copy launch command
  (advanced)** (`claudeSandbox.copySettings`). Expect the clipboard to hold
  `claude --settings '…'` and the message `Claude Sandbox: launch command
  copied. Paste it into a devcontainer terminal in /workspaces/alpha. It holds
  the link's token.` Status `Claude: waiting`.
- [ ] **C2 Link a hand-started Claude.** Paste it into a devcontainer terminal
  in `alpha`. Expect status `connected`; selections and diffs work as in S5
  and D1.
- [ ] **C3 Start while hand-linked.** Run Start. Expect
  `Claude Sandbox: a Claude started by hand is linked to this window. Exit it
  first.`
- [ ] **C4 Reload.** Reload the window. Expect the hand-started Claude to keep
  running, unlinked.
- [ ] **C5 Copy during a Start session.** Start a session, then run Copy
  launch command while it is `waiting` and again while `connected`, in a
  single-root and a multi-root window (choose a different folder when asked).
  The docs do not say what should happen. Record whether the Start session
  keeps its link and status; a running session losing its link is a bug.

### I: Install and update notifications

Expected behaviour: [README, Install](../README.md#install);
[design.md, Install offer](design.md#install-offer) and
[rule 10](design.md#trust-boundary). All **(destructive)**: use a throwaway
container.

- [ ] **I1 Missing.** Hide claude-sandbox
  (`sudo mv /usr/local/bin/claude-sandbox /usr/local/bin/claude-sandbox.off`)
  and reload. Expect a warning `claude-sandbox isn't installed in this
  container.` with **Install** and **About claude-sandbox**, whose detail
  names the command: `uvx --no-cache --from 'claude-sandbox>=5.1.0'
  claude-sandbox install --minimal`, by absolute path, with `/usr/bin/sudo`
  first when not root. Start shows the same offer.
- [ ] **I2 Install.** Click **Install**. Expect a visible terminal
  **claude-sandbox install** running that command; when it is closed after
  success, `claude-sandbox is installed. Run Claude Sandbox: Start.` Start
  then works.
- [ ] **I3 Too old.** If you can install a claude-sandbox older than 5.0.0,
  do. Expect `claude-sandbox <version> is installed, but this extension needs
  5.0.0 or later.` with the same offer.
- [ ] **I4 No uvx.** Hide claude-sandbox and make uvx unavailable in
  `/usr/local/bin`, `/usr/bin` and `~/.cargo/bin`. Expect the warning to say
  uvx isn't in those places, with **How to install** opening the
  claude-sandbox docs, and no Install button.
- [ ] **I5 Outdated notice.** With an older (but supported) claude-sandbox
  and network access, reload. Expect at most one info notice a day naming
  the newer version and the update command; it never upgrades. Reload again:
  no second notice that day. Offline, nothing.
- [ ] **I6 Noise.** Overall: is any notification shown more often than
  needed, unclear about what to do, or still showing after the problem is
  fixed?

### M: Multi-root

Expected behaviour: [README, Usage](../README.md#usage);
[design.md, The launcher](design.md#the-launcher).
Open `/workspaces/multi.code-workspace`.

- [ ] **M1 Folder choice.** Run Start. Expect a quick pick **Claude Sandbox:
  start in which folder?** (placeholder `Claude can write only this folder`)
  listing `alpha`, `beta`, `gamma`. Choose `beta`. End the session and Start
  again: `beta` is offered first. Escape at the pick starts nothing.
- [ ] **M2 Explorer Start.** Right-click the `gamma` root in the Explorer:
  **Start** is there (hidden while a session runs, and not on non-root
  folders or files). It starts in `gamma` without asking.
- [ ] **M3 One writable folder.** In a session started in `beta`, ask Claude
  to write a file in `alpha`. Expect the sandbox to refuse (peers are
  read-only); `git -C /workspaces/alpha status` unchanged.
- [ ] **M4 Selections across folders.** With the session in `beta`, select
  text in an `alpha` file and run Explain. Expect it to work (a peer: sent
  over the link). Check that Claude does not see a stale selection from
  another file.
- [ ] **M5 Changes view grouping.** Have Claude change files in its own
  folder only, then (in a second session) in `gamma`. With one root the files
  are listed directly; files spanning several repositories are grouped under
  a node per root.
- [ ] **M6 Folder removed.** Remove the session's folder from the workspace
  while it runs. Record what happens to the status bar, the terminal and
  later asks (the docs say the link's workspace becomes empty).

### F: Failure modes

- [ ] **F1 Claude exits mid-diff.** With a proposal diff open (D1), `/exit`
  or kill Claude. Expect the diff tab to close by itself with no answer
  sent, the file unchanged, status `off`, and no stray notification.
- [ ] **F2 Link lost mid-diff.** With a diff open, `/ide` → None. Expect the
  diff closed (its connection went), status `waiting`.
- [ ] **F3 Container restart.** Restart or rebuild the devcontainer with a
  session running. Expect, once VS Code reconnects: no session, status
  `off`, Start works again. Check the installed extension version again: a
  rebuild may reinstall the Marketplace copy.
- [ ] **F4 Second Claude.** In a plain devcontainer terminal run `claude`
  (sandboxed, no link) and `/ide`, choosing this extension, while the linked
  session is connected. Expect it to fail
  (`Failed to connect to Claude Sandbox for VS Code`), the linked session to
  stay connected, and the log line `[ide] refused a second connection: one
  Claude session is linked already`.
- [ ] **F5 Long path.** Open a folder whose absolute path is over about 75
  bytes (the socket path, folder plus `.claude-sandbox-vscode-<port>.sock`,
  is limited to 107) and Start. Expect an error naming the limit (`… move the
  workspace to a shorter path …`) and no session, not a silent hang.
- [ ] **F6 Two windows.** Open `alpha` and `beta` in two windows, start in
  both. Expect independent sessions; a preset in one window never reaches the
  other's Claude.
- [ ] **F7 Slow terminal.** Make Claude print a lot (a long file, a long
  build log). Expect the Claude terminal and the rest of VS Code to stay
  responsive to keys and resizes.

### X: Security rules at the UI

Only what a tester driving the UI can see. The rules themselves are tested by
`test/hostile/`; these probes check that the UI does not undo them.
Expected behaviour: [README, Security](../README.md#security);
[design.md, Trust boundary](design.md#trust-boundary).

- [ ] **X1 Workspace cannot set the extension's settings.** Put
  `"claudeSandbox.extraArgs": ["--model", "haiku"]` and a
  `claudeSandbox.presets` entry in `alpha/.vscode/settings.json`. Expect VS
  Code to mark them as user-only, and Start and My presets… to ignore them.
- [ ] **X2 Files outside the workspace.** Open a file from your home folder
  in the container (**File → Open File…**), select text and ask Claude
  what is selected. Expect Claude not to see it (the selection is cleared
  for files outside the folder and its peers). A preset on it names the file
  with a typed `@path` instead.
- [ ] **X3 `.git` is out of bounds for diffs.** With `reviewEdits` on, ask
  Claude to edit `.git/description`. Expect no proposal diff in VS Code (the
  log may say `openDiff … not shown`).
- [ ] **X4 The extension never writes.** In D2 to D5, the file's mtime changes
  only on Accept, when Claude writes it. A Reject or a closed tab never
  changes it.
- [ ] **X5 Symlinks are not followed.** R2's symlink is never opened, in a
  diff, by Open File or in Review All.
- [ ] **X6 uvx from fixed paths only.** In I1, the Install detail shows uvx at
  `/usr/local/bin/uvx`, `/usr/bin/uvx` or `~/.cargo/bin/uvx`. Put a `uvx`
  only in `~/.local/bin` (or elsewhere on `PATH`): expect I4's message, never
  an Install button that would run it.
- [ ] **X7 Socket permissions.** The `.claude-sandbox-vscode-*.sock` in the
  session's folder is mode `0600`.
- [ ] **X8 Nothing typed into menus.** Across all P checks, no preset text
  ever lands in a permission prompt, `/model` or any menu.

## Flakiness

Timing matters in this extension. Before reporting a timing glitch:

- Retry once. If it does not reproduce, report it as **intermittent**, with
  both timings.
- Note the timings: Start to `connected`, an ask to its Enter, a change to
  its row appearing.
- Known delays that are not bugs: up to 12 s to `connected`; an ask waits up
  to 20 s for a starting session; the output must pause before an ask is
  typed (about 150 ms); your own save is ignored within 2 s; VS Code's file
  watcher may batch events.

It is a real bug when, after a retry:

- something documented here does not happen, or something forbidden does
  (text typed into a menu, a file written on Reject);
- the status bar or a view stays wrong for more than a few seconds after the
  state changed (`waiting` with Claude answering, `connected` after exit, a
  badge that does not match the rows);
- focus or a tab ends up somewhere you would not expect and must fix by hand;
- a notification is wrong, unclear, or repeats.

## Time box

- **Full pass** (before a release): every area, about two to three hours. Do
  the destructive I checks and F3 in a throwaway container at the end.
- **Targeted pass** (one PR): about 30 to 45 minutes. A smoke run (S1, S6,
  P1, D1, D2, D4, R1, R8), then the areas the PR touches and their
  neighbours. For example, a change to `src/vscode/changesView.ts` gets all of
  R; one to `src/screen.ts` or `src/prompt.ts` gets all of P and X8; one to
  `src/install.ts` gets I and X6.

Stop and report early if Start itself fails: nothing else can be checked.

## Report template

```markdown
# Exploratory test report: <version or PR>

- Build: <vsix version, commit>
- VS Code: <version>; claude-sandbox: <version>; Claude Code: <version>
- Container engine: <podman/docker, version>
- Pass: <full | targeted: areas>; time spent: <h:mm>
- Tester: <person, or agent and driver>

## Results

| ID | Result | Note |
| --- | --- | --- |
| S1 | pass | connected after 1.4 s |
| S2 | fail | see bug 1 |
| I3 | skip | no claude-sandbox < 5.0.0 available |

## Bugs

### 1. <one-line summary>

- Severity: <blocker | major | minor | cosmetic>
- Check: <ID>; reproducible: <always | intermittent (n of m)>
- Steps:
  1. …
- Expected (cite README or design.md section): …
- Actual: …
- Evidence: <log lines, status bar text, `git diff`/`git status`, `ls -l`,
  screenshot>

## UX notes

Confusing wording, noisy or missing notifications, awkward focus or layout,
anything a new user would trip on.

## Candidates for deterministic tests

Checks that were repeatable and could move into `test/unit/` or
`test/hostile/`, with the module they would test and what the test would
assert.
```

Severity guide: **blocker** stops a release (Start fails, a write the user
did not accept, text typed into a menu); **major** breaks a feature or leaves
the UI in a wrong state; **minor** has a workaround; **cosmetic** is wording
or layout.
