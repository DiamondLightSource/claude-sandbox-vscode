// What Claude Code is showing, read from its terminal output (trust boundary rule 6): an ask may
// be typed only while its `❯` input box is up, never into a numbered menu (a permission prompt,
// the folder-trust question), where Enter, or a digit, would answer it. Ported from
// md-collab-editor's TermSession.prompt_state.
//
// Claude Code draws `❯` both for its input box and as the cursor of a menu's marked choice, and
// the last one it drew is the one on screen. Its input box (2.1.292) is the glyph followed by a
// no-break space ("❯\u00a0", then the placeholder or what the user typed, so a typed "1. " is not
// taken for a menu). Anything else after the glyph is a menu: "❯ 1. Yes" in a permission prompt,
// "❯\x1b[4GNo, exit" (a cursor move, no number) in the folder-trust question. So only the input
// box's exact form allows typing, and whatever is not recognised is refused. A glyph with nothing
// yet after it is "pending": not known, so nothing is typed either.
//
// While Claude works it draws "esc to interrupt" with its spinner; seen within BUSY_MS, the
// session counts as busy. That is best effort (an ask sent while Claude works would only be
// queued by Claude Code, never answer anything); the menu check is the one that matters.

export const GLYPH = "❯";
export const TAIL_MAX = 256 * 1024;
export const BUSY_MS = 1500;

// the input box: the glyph, perhaps colour changes, then a no-break space
const INPUT_RE = /^(?:\u001b\[[0-9;]*m)* /;
// nothing yet but colour changes, perhaps ending in half of one
const UNFINISHED_RE = /^(?:\u001b\[[0-9;]*m)*(?:\u001b\[?[0-9;]*)?$/;
const CSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b./g;
const BUSY_RE = /esc to interrupt/i;

export type PromptState = "starting" | "input" | "choice" | "pending" | "busy";

export class PromptWatcher {
  private tail = "";
  private hint = "";
  private busyAt = -Infinity;
  /** Whether Claude Code has drawn its glyph at all yet. */
  prompted = false;

  /** Output as it arrives (any chunking). */
  feed(text: string, now: number): void {
    this.tail += text;
    if (this.tail.length > TAIL_MAX) this.tail = this.tail.slice(-TAIL_MAX);
    if (!this.prompted && text.includes(GLYPH)) this.prompted = true;
    // the hint may be split between chunks, or by styling
    const plain = (this.hint + text).replace(CSI_RE, "");
    if (BUSY_RE.test(plain)) this.busyAt = now;
    this.hint = plain.slice(-32);
  }

  /** What the glyph last drawn marks, ignoring the busy hint. */
  glyphState(): Exclude<PromptState, "busy"> {
    const i = this.tail.lastIndexOf(GLYPH);
    if (i < 0) return this.prompted ? "pending" : "starting";
    const after = this.tail.slice(i + GLYPH.length, i + GLYPH.length + 256);
    if (INPUT_RE.test(after)) return "input";
    if (UNFINISHED_RE.test(after)) return "pending";
    return "choice";
  }

  state(now: number): PromptState {
    const g = this.glyphState();
    if (g === "input" && now - this.busyAt < BUSY_MS) return "busy";
    return g;
  }
}
