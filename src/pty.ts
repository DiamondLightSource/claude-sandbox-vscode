// A program on a real pty, through the Python relay in ptyHelper.ts (trust boundary rule 9).
// No vscode import: the Pseudoterminal glue is src/vscode/terminal.ts.

import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { Writable } from "node:stream";
import { helperArgs, PYTHON, resizeLine } from "./ptyHelper.ts";

export interface PtyOptions {
  /** The program, by absolute path. */
  program: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols: number;
  rows: number;
  /** Test seam: the interpreter (always PYTHON in the extension). */
  python?: string;
}

export interface PtyEvents {
  /** Output, decoded as UTF-8 (a character split between reads is held back). */
  onData(text: string): void;
  /** The program's exit status (128 + n for signal n); helper failures also land here. */
  onExit(code: number): void;
  /** What the helper itself wrote to stderr (never the program's: that goes to the pty). */
  onError?(text: string): void;
}

export class PtyProcess {
  private readonly child: ChildProcess;
  private readonly ctl: Writable;
  private exited = false;

  constructor(o: PtyOptions, events: PtyEvents) {
    this.child = spawn(o.python ?? PYTHON, helperArgs(o.cols, o.rows, o.program, o.args), {
      cwd: o.cwd,
      env: o.env,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      shell: false,
    });
    this.ctl = this.child.stdio[3] as Writable;
    const decoder = new StringDecoder("utf8");
    this.child.stdout!.on("data", (b: Buffer) => {
      const t = decoder.write(b);
      if (t) events.onData(t);
    });
    this.child.stderr!.on("data", (b: Buffer) => events.onError?.(b.toString("utf8")));
    // a pipe the helper closed (it exited) is not an error of ours
    for (const s of [this.child.stdin!, this.ctl]) s.on("error", () => undefined);
    let done = false;
    const exit = (code: number): void => {
      if (done) return;
      done = true;
      this.exited = true;
      const rest = decoder.end();
      if (rest) events.onData(rest);
      events.onExit(code);
    };
    this.child.on("error", (err) => {
      events.onError?.(String(err));
      exit(127);
    });
    this.child.on("close", (code, signal) => exit(code ?? (signal ? 128 + signalNumber(signal) : 1)));
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get running(): boolean {
    return !this.exited;
  }

  /** Keys typed into the pty, as they are (Ctrl-C is \x03...). */
  write(data: string): void {
    if (!this.exited) this.child.stdin!.write(data);
  }

  resize(cols: number, rows: number): void {
    if (!this.exited) this.ctl.write(resizeLine(cols, rows));
  }

  /** End it: the helper closes the pty (SIGHUP to the session, SIGKILL after 3 s). */
  kill(): void {
    if (this.exited) return;
    this.child.stdin!.end();
    this.ctl.end();
  }
}

function signalNumber(signal: NodeJS.Signals): number {
  const n: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };
  return n[signal] ?? 0;
}
