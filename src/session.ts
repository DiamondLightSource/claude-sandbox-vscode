// The linked session's input: the user's keys, and the asks and mentions the presets send
// (trust boundary rule 6). No vscode import: the Pseudoterminal glue is src/vscode/terminal.ts.
// Ported from md-collab-editor's TermSession.ask / mention / _wait_ready / _answer_pending.
//
// An ask is typed only while Claude Code's input box is on screen (src/prompt.ts), never
// while a menu is up or a proposed change waits for an answer (Enter would answer it), and it is
// checked again just before the Enter. A session that has only just started is waited for, at
// most START_WAIT_MS: Claude Code keeps text typed before its prompt is up but drops the Enter.
// With the IDE link up, Claude is first sent the selection, then a ping, whose answer means it
// has handled the selection; the question goes as ONE bracketed paste without control
// characters (paste.ts), then Enter. Without the link (or no answer to the ping) the question
// starts with a typed @-mention of the lines instead. Asks are one at a time, and the user's own
// keys wait while an ask is between its paste and its Enter.

import { lineSpan, typedRef } from "./ask.ts";
import type { LinkState, Position } from "./mcp.ts";
import { pasteText } from "./paste.ts";
import type { Resolved } from "./paths.ts";
import type { PromptWatcher } from "./prompt.ts";

export const START_WAIT_MS = 20_000;
/** For Claude to store the selection once it has answered the ping. */
export const SETTLE_MS = 50;
/** Between pasting a question and pressing Enter. */
export const ENTER_DELAY_MS = 100;
/** A frame is taken as drawn once output has paused this long... */
export const QUIET_MS = 150;
/** ...waited for at most this long before the screen is read as it is. */
export const SETTLE_MAX_MS = 1000;
const POLL_MS = 50;

/** What the session needs of the link (the Bridge). */
export interface LinkPort {
  readonly state: LinkState;
  readonly workspace: { resolve(p: unknown): Resolved };
  waitingDiffs(): string[];
  select(fsPath: string, start: Position, end: Position, text: string): void;
  clearSelection(): boolean;
  ping(ms?: number): Promise<boolean>;
  mention(fsPath: string, lines?: { start: number; end: number }): boolean;
}

export interface FileRange {
  fsPath: string;
  start: Position;
  end: Position;
  /** The selected text (empty: the whole file). */
  text: string;
}

export interface AskRequest {
  question: string;
  file?: FileRange;
}

export type SendResult = { ok: true; via: "ide" | "typed" } | { ok: false; error: string };

export interface SessionOptions {
  /** Into the pty. */
  write(data: string): void;
  watcher: PromptWatcher;
  link(): LinkPort | null;
  /** Claude's working folder (typed @-mentions are relative to it). */
  cwd: string;
  /** Test seams. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  startWaitMs?: number;
  /** Told once when an ask has waited a second for the session to start. */
  onWaiting?: () => void;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class Session {
  private readonly o: SessionOptions;
  private alive = true;
  private queue: Promise<unknown> = Promise.resolve();
  private held: string[] | null = null;

  constructor(o: SessionOptions) {
    this.o = o;
  }

  get running(): boolean {
    return this.alive;
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  private sleep(ms: number): Promise<void> {
    return (this.o.sleep ?? realSleep)(ms);
  }

  /** Output from the pty. */
  output(text: string): void {
    this.o.watcher.feed(text, this.now());
  }

  /** The user's keys (from the terminal): straight through, unless an ask holds the input. */
  input(data: string): void {
    if (!this.alive) return;
    if (this.held !== null) this.held.push(data);
    else this.o.write(data);
  }

  exited(): void {
    this.alive = false;
    this.release();
  }

  private release(): void {
    const held = this.held;
    this.held = null;
    if (held !== null && this.alive) for (const d of held) this.o.write(d);
  }

  /** Why an ask must not be typed (or its Enter pressed) now, or null. */
  why(): string | null {
    if (!this.alive) return "The Claude session has ended.";
    const link = this.o.link();
    if (link !== null && link.waitingDiffs().length > 0) {
      return "Claude is waiting for your answer to a proposed change: accept or reject it first.";
    }
    switch (this.o.watcher.state()) {
      case "input":
        return null;
      case "choice":
        return "Claude Code is asking you something in the terminal (its input box is not showing): answer it there first.";
      case "busy":
        return "Claude is working: send it again once it has finished.";
      default:
        return "Claude Code's input box is not showing, so nothing was sent.";
    }
  }

  /**
   * Until Claude Code has drawn its first screen (at most START_WAIT_MS), and until the screen
   * shows the input box or output has paused (a frame half drawn is not read as a menu).
   */
  private async ready(): Promise<string | null> {
    const since = this.now();
    let told = false;
    for (;;) {
      if (!this.alive) return "The Claude session ended before it could take the question.";
      const st = this.o.watcher.state();
      const waited = this.now() - since;
      if (st === "starting") {
        if (waited >= (this.o.startWaitMs ?? START_WAIT_MS)) {
          return "Claude Code has not started yet (its input box is not up), so nothing was sent: try again once it is.";
        }
        if (!told && waited >= 1000) {
          told = true;
          this.o.onWaiting?.();
        }
      } else if (st === "input" || st === "busy" || !this.drawing(since)) {
        return null;
      }
      await this.sleep(POLL_MS);
    }
  }

  /** Whether output is still arriving (a frame may be half drawn), for at most SETTLE_MAX_MS from `since`. */
  private drawing(since: number): boolean {
    const now = this.now();
    return now - this.o.watcher.lastOutput < QUIET_MS && now - since < SETTLE_MAX_MS;
  }

  /** Until the screen shows the input box, or output has paused (at most SETTLE_MAX_MS). */
  private async settle(): Promise<void> {
    const since = this.now();
    while (this.alive && this.o.watcher.state() !== "input" && this.drawing(since)) await this.sleep(POLL_MS);
  }

  /** One at a time, in order. */
  private serial<T>(f: () => Promise<T>): Promise<T> {
    const run = this.queue.then(f, f);
    this.queue = run.catch(() => undefined);
    return run;
  }

  ask(req: AskRequest): Promise<SendResult> {
    return this.serial(() => this.askNow(req));
  }

  private async askNow(req: AskRequest): Promise<SendResult> {
    let text = req.question;
    if (!text.trim()) return { ok: false, error: "There is no question to send." };
    let why = await this.ready();
    if (why === null) why = this.why();
    if (why !== null) return { ok: false, error: why };
    const f = req.file;
    const span = f ? lineSpan(f.start, f.end) : null;
    let via: "ide" | "typed" = "typed";
    const link = this.o.link();
    if (link !== null && link.state === "connected" && f !== undefined) {
      if (link.workspace.resolve(f.fsPath).ok) {
        link.select(f.fsPath, f.start, f.end, f.text);
        if (await link.ping()) {
          await this.sleep(SETTLE_MS); // Claude stores the selection a moment after answering
          via = "ide";
        }
      } else if (link.clearSelection()) {
        // a file elsewhere: Claude must not attach the last selection
        await link.ping();
      }
    }
    // typed, the mention carries the lines; a whole file is named either way
    if (f !== undefined && (via === "typed" || span === null)) {
      text = typedRef(f.fsPath, this.o.cwd, via === "typed" ? span : null) + " " + text;
    }
    await this.settle(); // the ping took time: look again
    why = this.why();
    if (why !== null) return { ok: false, error: why };
    this.held = [];
    try {
      this.o.write(pasteText(text));
      await this.sleep(ENTER_DELAY_MS);
      await this.settle(); // the paste is being drawn into the box
      why = this.why(); // Claude asked something meanwhile
      if (why !== null) return { ok: false, error: "The question was typed but not sent. " + why };
      this.o.write("\r");
    } finally {
      this.release();
    }
    return { ok: true, via };
  }

  /**
   * Put an @-mention of a file (and lines) into Claude's prompt, never Enter: at_mentioned
   * over the link for a workspace file, else typed, and typed only into the input box.
   */
  mention(f: FileRange): Promise<SendResult> {
    return this.serial(async () => {
      if (!this.alive) return { ok: false, error: "The Claude session has ended." };
      const span = lineSpan(f.start, f.end);
      const rel = f.fsPath.startsWith(this.o.cwd + "/") ? f.fsPath.slice(this.o.cwd.length + 1) : f.fsPath;
      const link = this.o.link();
      // Claude Code inserts at_mentioned paths unquoted: one with whitespace is typed instead
      if (link !== null && link.state === "connected" && !/\s/.test(rel)) {
        const lines = span ? { start: span[0] - 1, end: span[1] - 1 } : undefined;
        if (link.mention(f.fsPath, lines)) return { ok: true, via: "ide" };
      }
      await this.settle();
      const why = this.why();
      if (why !== null) return { ok: false, error: why };
      this.o.write(pasteText(typedRef(f.fsPath, this.o.cwd, span) + " "));
      return { ok: true, via: "typed" };
    });
  }
}
