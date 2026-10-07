import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_CELL, MAX_COLS, MAX_ROWS, Screen } from "../../src/screen.ts";

const scr = (cols: number, rows: number, ...chunks: string[]): Screen => {
  const s = new Screen(cols, rows);
  for (const c of chunks) s.feed(c);
  return s;
};
const text = (s: Screen): string[] => s.lines().map((l) => l.trimEnd());

describe("the virtual screen (src/screen.ts)", () => {
  it("printable text, CR/LF, autowrap and scrolling at the bottom", () => {
    assert.deepEqual(text(scr(5, 4, "abcdefg\r\nxy")), ["abcde", "fg", "xy", ""]);
    assert.deepEqual(text(scr(5, 2, "a\r\nb\r\nc")), ["b", "c"]);
  });
  it("cursor moves: CUP, CUU/CUD/CUF/CUB, CHA, VPA, clamped to the screen", () => {
    const s = scr(10, 5, "\x1b[3;4HX\x1b[2AY\x1b[3BZ\x1b[20CW\x1b[50DV\x1b[5GU\x1b[1dT\x1b[99;99HS");
    assert.deepEqual(text(s), ["    YT", "", "   X", "V   UZ   W", "         S"]);
    assert.deepEqual(s.cursor, { row: 4, col: 9, visible: true });
  });
  it("erasing: ED 0/1/2 (3 keeps the screen), EL 0/1/2, ECH", () => {
    const fill = "\x1b[H" + "abcdef\r\n".repeat(3) + "abcdef";
    assert.deepEqual(text(scr(6, 4, fill, "\x1b[2;3H\x1b[J")), ["abcdef", "ab", "", ""]);
    assert.deepEqual(text(scr(6, 4, fill, "\x1b[2;3H\x1b[1J")), ["", "   def", "abcdef", "abcdef"]);
    assert.deepEqual(text(scr(6, 4, fill, "\x1b[2J")), ["", "", "", ""]);
    assert.deepEqual(text(scr(6, 4, fill, "\x1b[3J")), ["abcdef", "abcdef", "abcdef", "abcdef"]);
    assert.deepEqual(text(scr(6, 1, "abcdef\x1b[3G\x1b[K")), ["ab"]);
    assert.deepEqual(text(scr(6, 1, "abcdef\x1b[3G\x1b[1K")), ["   def"]);
    assert.deepEqual(text(scr(6, 1, "abcdef\x1b[3G\x1b[2K")), [""]);
    assert.deepEqual(text(scr(6, 1, "abcdef\x1b[2G\x1b[2X")), ["a  def"]);
  });
  it("the scroll region: LF at its bottom scrolls only the region; rows outside stay", () => {
    const s = scr(4, 5, "top\r\n1\r\n2\r\n3\r\nbot", "\x1b[2;4r\x1b[4;1H\nnew");
    assert.deepEqual(text(s), ["top", "2", "3", "new", "bot"]);
  });
  it("combining marks join the cell before, up to MAX_CELL units: a flood is dropped", () => {
    assert.deepEqual(text(scr(5, 1, "e\u0301x")), ["e\u0301x"]);
    const s = scr(5, 1, "a" + "\u0301".repeat(200_000) + "b");
    assert.equal(s.lines()[0]!.trimEnd(), "a" + "\u0301".repeat(MAX_CELL - 1) + "b");
  });
  it("wide characters take two cells; overwriting half of one blanks the other", () => {
    const s = scr(6, 1, "漢字x");
    assert.equal(s.line(0), "漢字x ");
    assert.equal(s.cursor.col, 5);
    assert.equal(scr(6, 1, "漢字x\x1b[2Gy").line(0), " y字x ");
  });
  it("the alternate screen: entered blank, left back to the main one with the cursor restored", () => {
    const s = scr(6, 2, "main\x1b[?1049h");
    assert.equal(s.alt, true);
    assert.deepEqual(text(s), ["", ""]);
    s.feed("\x1b[2;1Halt\x1b[?1049l");
    assert.equal(s.alt, false);
    assert.deepEqual(text(s), ["main", ""]);
    assert.deepEqual(s.cursor, { row: 0, col: 4, visible: true });
  });
  it("cursor visibility (DECTCEM); colours, OSC titles, DCS and queries draw nothing", () => {
    const s = scr(20, 1, "\x1b[?25l\x1b[38;5;174ma\x1b]0;title\x07b\x1bP1$r\x1b\\c\x1b[>0q\x1b[?u\x1b[c\x1b(Bd");
    assert.equal(s.line(0).trimEnd(), "abcd");
    assert.equal(s.cursor.visible, false);
  });
  it("lengths and sizes are capped: a huge CSI or OSC buffers nothing, sizes are clamped", () => {
    const s = scr(10, 2, "\x1b[" + "1;".repeat(100_000) + "H" + "x", "\x1b]" + "y".repeat(1_000_000) + "\x07z");
    assert.equal(s.line(0).trimEnd(), "xz");
    const big = new Screen(1e9, 1e9);
    assert.equal(big.cols, MAX_COLS);
    assert.equal(big.rows, MAX_ROWS);
    big.resize(0, -5);
    assert.equal(big.cols, 1);
    assert.equal(big.rows, 1);
  });
});
