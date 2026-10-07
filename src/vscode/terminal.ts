// The linked session's terminal: a Pseudoterminal in the editor area relaying to the claude
// shadow on a real pty (src/pty.ts, the Python relay in src/ptyHelper.ts), so the extension sees
// Claude Code's output (src/prompt.ts) and can type asks only while its input box is showing
// (src/session.ts). The shadow is the terminal's own process, never a command sent to a shell
// (trust boundary rule 6).

import * as vscode from "vscode";
import { PromptWatcher } from "../prompt.ts";
import { OutputBatcher, PtyProcess } from "../pty.ts";
import { CLAUDE } from "../ptyHelper.ts";
import { Session, type LinkPort } from "../session.ts";

export interface ClaudeTerminalOptions {
  args: readonly string[];
  cwd: string;
  link(): LinkPort | null;
  /** The session ended (exit status); called once. */
  onExit(code: number): void;
  log(message: string): void;
}

/** The environment Claude gets: the extension host's, without VS Code's own channels. */
export function childEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    // VSCODE_IPC_HOOK_CLI and friends reach the window; an inherited port would be someone
    // else's link (ours is in --settings)
    if (k.startsWith("VSCODE_") || k.startsWith("ELECTRON_") || k === "CLAUDE_CODE_SSE_PORT") continue;
    env[k] = v;
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  return env;
}

export class ClaudeTerminal implements vscode.Disposable {
  readonly terminal: vscode.Terminal;
  readonly session: Session;
  private pty: PtyProcess | null = null;
  private readonly write = new vscode.EventEmitter<string>();
  private readonly close = new vscode.EventEmitter<number | void>();
  private readonly name = new vscode.EventEmitter<string>();
  private ended = false;
  private closeOnKey = false;
  private readonly out: OutputBatcher;

  constructor(o: ClaudeTerminalOptions) {
    const fault = (where: string, e: unknown): void =>
      o.log(`[pty] ${where} failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    // one write to VS Code's terminal per batch (src/pty.ts)
    this.out = new OutputBatcher((t) => this.write.fire(t), (e) => fault("terminal write", e));
    const watcher = new PromptWatcher();
    this.session = new Session({
      write: (d) => this.pty?.write(d),
      watcher,
      link: o.link,
      cwd: o.cwd,
      onWaiting: () => void vscode.window.setStatusBarMessage("$(sync~spin) Waiting for Claude Code to start…", 20_000),
    });
    const finish = (code: number): void => {
      if (this.ended) return;
      this.ended = true;
      this.out.flush();
      this.session.exited();
      o.onExit(code);
      if (code === 0) {
        this.close.fire(code);
      } else {
        this.closeOnKey = true;
        this.name.fire(`Claude Sandbox (exited ${code})`);
        this.write.fire(`\r\n\x1b[2m[Claude exited with code ${code}. Press any key to close this tab.]\x1b[0m\r\n`);
      }
    };
    const pty: vscode.Pseudoterminal = {
      onDidWrite: this.write.event,
      onDidClose: this.close.event,
      onDidChangeName: this.name.event,
      open: (dims) => {
        watcher.resize(dims?.columns ?? 100, dims?.rows ?? 30);
        this.pty = new PtyProcess(
          {
            program: CLAUDE,
            args: o.args,
            cwd: o.cwd,
            env: childEnv(process.env),
            cols: dims?.columns ?? 100,
            rows: dims?.rows ?? 30,
          },
          {
            onData: (t) => {
              // the prompt watcher's screen first; a fault there is logged and never stops the
              // terminal (asks are then refused: the screen reads as unknown)
              try {
                this.session.output(t);
              } catch (e) {
                fault("prompt watcher", e);
              }
              this.out.push(t);
            },
            onExit: finish,
            onError: (t) => o.log(`[pty] ${t.trimEnd()}`),
          },
        );
      },
      close: () => {
        // the tab was closed: end the session (the helper hangs up on it)
        this.pty?.kill();
        if (this.pty === null) finish(0);
      },
      // a fault in either is logged; the keys and resizes after it still go through
      handleInput: (data) => {
        try {
          if (this.closeOnKey) this.close.fire();
          else this.session.input(data);
        } catch (e) {
          fault("input", e);
        }
      },
      setDimensions: (dims) => {
        try {
          this.pty?.resize(dims.columns, dims.rows);
          watcher.resize(dims.columns, dims.rows);
        } catch (e) {
          fault("resize", e);
        }
      },
    };
    const beside = vscode.window.activeTextEditor !== undefined;
    this.terminal = vscode.window.createTerminal({
      name: "Claude Sandbox",
      pty,
      iconPath: new vscode.ThemeIcon("sparkle"),
      // a pty relay cannot be revived after a reload: the session ends with the window
      isTransient: true,
      location: beside ? { viewColumn: vscode.ViewColumn.Beside } : vscode.TerminalLocation.Editor,
    });
  }

  get running(): boolean {
    return !this.ended;
  }

  dispose(): void {
    this.out.dispose();
    this.pty?.kill();
    this.terminal.dispose();
    this.write.dispose();
    this.close.dispose();
    this.name.dispose();
  }
}
