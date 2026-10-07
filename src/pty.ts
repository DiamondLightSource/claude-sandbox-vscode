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
    // a throw in the data path is reported, never left to stop the stream or the session
    const deliver = (t: string): void => {
      try {
        events.onData(t);
      } catch (e) {
        events.onError?.(`output handler failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      }
    };
    this.child.stdout!.on("data", (b: Buffer) => {
      const t = decoder.write(b);
      if (t) deliver(t);
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
      if (rest) deliver(rest);
      events.onExit(code);
    };
    this.child.on("error", (err: NodeJS.ErrnoException) => {
      events.onError?.(String(err));
      // the relay itself could not start: say why on the terminal, not just "exited with 127"
      const python = o.python ?? PYTHON;
      deliver(
        err.code === "ENOENT"
          ? `\r\ncannot start the terminal relay: ${python} is missing. Is claude-sandbox installed in this container? Run Claude Sandbox: Start again to be offered the install.\r\n`
          : `\r\ncannot start the terminal relay (${python}): ${err.message}\r\n`,
      );
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

/** Output is handed to the terminal at most this often: one write per batch. */
export const FLUSH_MS = 16;

/**
 * Coalesces the relay's output into one write per FLUSH_MS, however small the reads (VS Code's
 * Pseudoterminal has no flow control: every write is a message to the window). Appending is
 * O(chunk); the batch is joined once per flush. A throw from the sink is reported, never left
 * to stop later batches.
 */
export class OutputBatcher {
  private parts: string[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly sink: (text: string) => void;
  private readonly onError: (err: unknown) => void;
  private readonly ms: number;

  constructor(sink: (text: string) => void, onError: (err: unknown) => void, ms = FLUSH_MS) {
    this.sink = sink;
    this.onError = onError;
    this.ms = ms;
  }

  push(text: string): void {
    this.parts.push(text);
    this.timer ??= setTimeout(() => this.flush(), this.ms);
  }

  /** Now (at exit, so nothing is lost). */
  flush(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.parts.length === 0) return;
    const text = this.parts.length === 1 ? this.parts[0]! : this.parts.join("");
    this.parts = [];
    try {
      this.sink(text);
    } catch (e) {
      this.onError(e);
    }
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.parts = [];
  }
}
