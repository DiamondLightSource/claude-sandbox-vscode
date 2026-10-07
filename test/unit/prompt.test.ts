import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BUSY_MS, PromptWatcher } from "../../src/prompt.ts";

const feed = (...chunks: string[]): PromptWatcher => {
  const w = new PromptWatcher();
  for (const c of chunks) w.feed(c, 0);
  return w;
};

// as Claude Code 2.1.292 drew its input box (captured through the pty relay)
// the folder-trust question, as 2.1.292 drew it: a cursor move after the glyph, no number
const TRUST_MENU = "\x1b[2G\x1b[38;5;153m❯\x1b[4GNo,\x1b[8Gexit\x1b[39m\n\n\x1b[4GYes,\x1b[9GI\x1b[11Gtrust";
const INPUT_BOX =
  '────────────────────\n\x1b[1B\x1b[39m❯\xa0\x1b[2mTry "how do I log an error?"\n\x1b[1B\x1b[22m────';

describe("rule 6: the prompt state read from Claude Code's output", () => {
  it("starting until the glyph is drawn", () => {
    const w = feed("claude-sandbox: making the jail…\r\n", "\x1b[2J");
    assert.equal(w.glyphState(), "starting");
    assert.equal(w.prompted, false);
  });
  it("the input box (❯ + no-break space), as Claude Code draws it", () => {
    assert.equal(feed(INPUT_BOX).state(10_000), "input");
  });
  it("a menu's marked choice: numbered, or not (the folder-trust question, as 2.1.292 draws it)", () => {
    for (const m of [
      "❯ 1. Yes",
      "❯\x1b[1C2. Yes, and don't ask again",
      "\x1b[36m❯\x1b[39m \x1b[36m1.\x1b[39m Yes",
      "❯\r\n  3. No",
      TRUST_MENU,
      "❯ Yes, I trust this folder",
      "❯ \x1b[3",
      "❯ 1",
    ]) {
      assert.equal(feed(INPUT_BOX, "Do you want to proceed?\r\n", m).glyphState(), "choice", JSON.stringify(m));
    }
  });
  it("what the user typed into the box (\"1. \") is not a menu", () => {
    assert.equal(feed("❯\xa01. first point").glyphState(), "input");
  });
  it("the last glyph drawn wins: back to the box after a menu", () => {
    assert.equal(feed(INPUT_BOX, "❯ 1. Yes", "\x1b[2K", INPUT_BOX).glyphState(), "input");
  });
  it("a glyph with nothing yet after it but colour, or half a colour change, is pending (nothing typed)", () => {
    assert.equal(feed(INPUT_BOX, "❯").glyphState(), "pending");
    assert.equal(feed(INPUT_BOX, "❯\x1b[3").glyphState(), "pending");
    assert.equal(feed(INPUT_BOX, "❯\x1b[39m").glyphState(), "pending");
    assert.equal(feed(INPUT_BOX, "❯\x1b[3", "9m\xa0x").glyphState(), "input", "split between chunks");
    assert.equal(feed(INPUT_BOX, "❯", " 1. Yes").glyphState(), "choice", "split between chunks");
  });
  it("the glyph split between chunks still counts as prompted", () => {
    const glyph = Buffer.from("❯");
    // the relay decodes UTF-8 across reads (StringDecoder), so chunks are whole characters;
    // a character never arrives halved, but the glyph and its follower may be apart
    assert.equal(glyph.length, 3);
    const w = feed("x❯", "\xa0y");
    assert.equal(w.prompted, true);
    assert.equal(w.glyphState(), "input");
  });
  it("busy while 'esc to interrupt' was drawn in the last BUSY_MS, even split or styled", () => {
    const w = new PromptWatcher();
    w.feed(INPUT_BOX, 0);
    w.feed("✻ Thinking… (3s · esc to int", 1000);
    w.feed("errupt)", 1001);
    assert.equal(w.state(1500), "busy");
    assert.equal(w.state(1001 + BUSY_MS + 1), "input");
    const s = new PromptWatcher();
    s.feed(INPUT_BOX, 0);
    s.feed("\x1b[2mesc\x1b[22m to \x1b[1minterrupt", 5000);
    assert.equal(s.state(5100), "busy");
  });
  it("a menu is a menu even while busy", () => {
    const w = new PromptWatcher();
    w.feed("esc to interrupt ❯ 1. Yes", 0);
    assert.equal(w.state(1), "choice");
  });
});
