// What Claude Code is showing (trust boundary rule 6), read from the terminal's CURRENT SCREEN
// (src/screen.ts), not from whatever text was drawn last: an ask may be typed only while its
// input box is up, never into a menu (a permission prompt, the folder-trust question), where
// Enter would answer it.
//
// Claude Code 2.1.292 (captured through the pty relay; test/fixtures/) draws its input box at
// the bottom of the alternate screen: a full-width rule of "─" from column 0, a row starting
// "❯" + no-break space, perhaps more rows of input (indented two spaces), a second full-width
// rule, then a few footer rows (status line, mode). The cursor is shown inside the box. Any
// menu (permission prompt, /model, /help, /ide, the trust and MCP questions) replaces the box:
// the cursor is hidden, or there is no such box at the bottom. So "input" needs all of:
//
//   - the cursor visible, on the box's ❯ row or one of its indented continuation rows;
//   - a full-width rule directly above the ❯ row, and one below the last input row;
//   - below that, at most FOOTER_MAX rows, with no ❯ and no rule (no menu down there).
//
// Claude Code 2.1.295 may label the top rule ("──── ophyd-async @ some-branch ─", reported in
// issue #18; not drawn in our own captures); it still runs from column 0 to the last column, so
// it is accepted.
//
// The model cannot draw that. Claude Code renders model text (and the transcript) indented by
// two columns with control characters removed (verified: an assistant message holding ESC
// sequences, a "❯ " line and a full-width rule, resumed into a real session, drew all of it
// as indented plain text), so nothing it writes starts at column 0 or spans a full-width rule,
// and it never moves or shows the cursor. Anything not recognised is "choice": refused.
//
// While Claude works, its spinner sits just above the box ("✻ Fluttering… (1s · ↓ 25 tokens ·
// thinking)" in 2.1.292, "… (esc to interrupt)" in older ones); that is "busy". An ask sent while
// Claude works would only be queued, so this is a courtesy, not a guard.
//
// Vim mode: Claude Code shows "-- INSERT --" in the footer in insert mode and nothing in NORMAL
// mode; a bracketed paste is inserted and Enter submits in either (captured), so both are "input".

import { Screen } from "./screen.ts";

const GLYPH = "❯";
const BOX_START = GLYPH + " ";
const RULE = "─";
/** Rows Claude Code draws under the input box (status line, mode, hints); more is not the box. */
const FOOTER_MAX = 8;
/** Rows above the box searched for the spinner. */
const SPINNER_ROWS = 6;
const SPINNER_RE = /^[·✢*✶✻✽✳∗] \S[^…]*…/u;
const INTERRUPT_RE = /esc to interrupt/i;
const MENU_RULE_RE = /[─▔]{8}/;
/** The top rule with a label in it ("<repo> @ <branch>"), still spanning the full width. */
const LABELLED_RULE_RE = /^─{8,} \S.* ─$/u;

export type PromptState = "starting" | "input" | "busy" | "choice";

export interface Box {
  /** The rule rows above and below the input. */
  top: number;
  bottom: number;
}

/** Claude Code's input box at the bottom of the screen, with the cursor in it; null if not shown. */
export function findBox(screen: Screen): Box | null {
  const cur = screen.cursor;
  if (!cur.visible) return null;
  const rows = screen.lines();
  const rule = RULE.repeat(screen.cols);
  // up from the cursor to the ❯ row, through indented continuation rows
  let first = cur.row;
  while (first >= 0 && !rows[first]!.startsWith(BOX_START)) {
    if (!rows[first]!.startsWith("  ")) return null;
    first--;
  }
  if (first < 1 || !(rows[first - 1] === rule || LABELLED_RULE_RE.test(rows[first - 1]!))) return null;
  // down from the cursor to the closing rule
  let last = cur.row + 1;
  while (last < rows.length && rows[last] !== rule) {
    if (!rows[last]!.startsWith("  ")) return null;
    last++;
  }
  if (last >= rows.length) return null;
  // the footer: a few rows, none of them a menu
  for (let r = last + 1; r < rows.length; r++) {
    const row = rows[r]!;
    if (row.trim() === "") continue;
    if (r - last > FOOTER_MAX || row.includes(GLYPH) || MENU_RULE_RE.test(row)) return null;
  }
  return { top: first - 1, bottom: last };
}

/** Whether Claude Code's spinner is drawn just above the box. */
export function working(screen: Screen, box: Box): boolean {
  for (let r = box.top - 1; r >= 0 && r >= box.top - SPINNER_ROWS; r--) {
    const row = screen.line(r);
    if (row.trim() === "") continue;
    if (SPINNER_RE.test(row) || INTERRUPT_RE.test(row)) return true;
    if (!row.startsWith(" ")) return false; // a column-0 row that is not the spinner: transcript
  }
  return false;
}

export class PromptWatcher {
  readonly screen: Screen;
  /** Whether Claude Code has shown its input box, or a menu, at all yet. */
  prompted = false;
  /** When output last arrived (ms): a frame may be half drawn just after. */
  lastOutput = -Infinity;

  constructor(cols = 100, rows = 30) {
    this.screen = new Screen(cols, rows);
  }

  /** Output as it arrives (any chunking). O(text): the screen is only read by state(). */
  feed(text: string, now: number): void {
    this.screen.feed(text);
    this.lastOutput = now;
    // the box and every menu draw the glyph (the relay hands over whole characters)
    if (!this.prompted && text.includes(GLYPH)) this.prompted = true;
  }

  resize(cols: number, rows: number): void {
    this.screen.resize(cols, rows);
  }

  state(): PromptState {
    const box = findBox(this.screen);
    if (box !== null) return working(this.screen, box) ? "busy" : "input";
    return this.prompted ? "choice" : "starting";
  }
}
