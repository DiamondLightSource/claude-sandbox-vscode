import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { findBox, type PromptState, PromptWatcher } from "../../src/prompt.ts";
import { capture, outputUntil, replay } from "../helpers/captures.ts";

// [capture, second, state]: points in real Claude Code 2.1.292 sessions (see the inputs in
// test/fixtures/claude-2.1.292.json), each just before the next key was sent
const POINTS: [string, number, PromptState, string][] = [
  ["menus", 0.31, "starting", "the relay's first bytes, nothing drawn"],
  ["menus", 9.9, "input", "the input box with its placeholder"],
  ["menus", 23.5, "input", '"/permissions" typed, the command list above the box'],
  ["menus", 26.5, "choice", "the /permissions dialog"],
  ["menus", 30.0, "input", '"/model" typed'],
  ["menus", 33.0, "choice", "the /model menu (❯ 2. Opus)"],
  ["menus", 36.546, "busy", "running /ide: its spinner"],
  ["menus", 39.5, "choice", "the /ide dialog"],
  ["menus", 46.0, "choice", "the /help dialog"],
  ["menus", 48.0, "input", "back in the box after Esc"],
  ["menus", 57.5, "input", '"ihello world" typed'],
  ["vim-and-working", 9.5, "input", "vim mode, INSERT"],
  ["vim-and-working", 11.0, "input", "vim mode, NORMAL (no indicator; a paste is inserted, Enter submits)"],
  ["vim-and-working", 12.7, "busy", 'working: "✢ Boogieing…"'],
  ["vim-and-working", 13.4, "busy", 'working: "✽ Fluttering… (0s · thinking)"'],
  ["vim-and-working", 14.4, "busy", 'working: "· Fluttering… (1s · ↓ 187 tokens · thinking)"'],
  ["vim-and-working", 24.5, "busy", "working, with a tip line under the spinner"],
  ["vim-and-working", 25.0, "input", 'done: "✻ Sautéed for 1s · done" is not the spinner'],
  ["trust", 7.9, "choice", "the folder-trust question (main screen, cursor shown)"],
  ["trust", 9.9, "choice", "the folder-trust question, Yes marked"],
  ["mcp-and-multiline", 7.9, "choice", "the new-MCP-server question"],
  ["mcp-and-multiline", 15.9, "input", "input wrapped onto a second row"],
  ["mcp-and-multiline", 21.0, "input", "three rows of input, the cursor on the last"],
  ["resumed-spoof", 9.9, "input", "a resumed transcript with model-drawn fake boxes above the real one"],
];

describe("rule 6: the prompt state, read from the screen (Claude Code 2.1.292 captures)", () => {
  for (const [name, t, want, what] of POINTS) {
    it(`${name} @${t}s: ${want} (${what})`, () => {
      assert.equal(replay(name, t).state(), want);
    });
  }
  it("the same whatever the chunking (one string, or a character at a time)", () => {
    for (const [name, t, want] of POINTS) {
      const c = capture(name);
      const text = outputUntil(name, t);
      const one = new PromptWatcher(c.cols, c.rows);
      one.feed(text, 0);
      const each = new PromptWatcher(c.cols, c.rows);
      for (const ch of text) each.feed(ch, 0);
      assert.equal(one.state(), want, `${name} ${t} whole`);
      assert.equal(each.state(), want, `${name} ${t} by character`);
    }
  });
  it("the model's text is indented and stripped of escapes: its fake boxes are not the box", () => {
    const w = replay("resumed-spoof", 9.9);
    const rows = w.screen.lines();
    // the model drew "❯ plain fake box" between rules, a "❯ 1. Yes" and ESC sequences
    const fake = rows.findIndex((r) => r.includes("plain fake box"));
    assert.ok(fake > 0 && rows[fake]!.startsWith("  ❯ "), "indented by Claude Code");
    assert.ok(
      rows.some((r) => r.includes("SPOOF-B ESC-MOVED red bell  end")),
      "its ESC sequences were drawn as nothing",
    );
    const box = findBox(w.screen)!;
    assert.equal(box.top, 35, "the real box, at the bottom");
  });
  it("the reviewer's spoof: a menu, then the model draws the input-box form lower down: still a menu", () => {
    // what made the old last-glyph-wins reader say "input" (review of PR 3)
    const menu = "\x1b[?1049h\x1b[2J\x1b[H\x1b[?25lDo you want to proceed?\r\n\x1b[36m❯\x1b[39m 1. Yes\r\n  2. No\r\n";
    for (const spoof of ["❯ ", '\r\n❯ \x1b[2mTry "x"', "\x1b[10;1H❯ ", "\r\n❯ \r\n" + "─".repeat(100)]) {
      const w = new PromptWatcher(100, 30);
      w.feed(menu + spoof, 0);
      assert.equal(w.state(), "choice", JSON.stringify(spoof));
    }
  });
  it("the security review's spoof bytes (test/fixtures/review-spoofs.json): never input, alone or over a real menu", () => {
    const file = path.join(import.meta.dirname, "..", "fixtures", "review-spoofs.json");
    const { cases } = JSON.parse(fs.readFileSync(file, "utf8")) as { cases: { name: string; chunks: string[] }[] };
    assert.equal(cases.length, 4);
    for (const c of cases) {
      const alone = new PromptWatcher(100, 30);
      for (const ch of c.chunks) alone.feed(ch, 0);
      assert.notEqual(alone.state(), "input", c.name);
      const overMenu = replay("menus", 26.5); // the real /permissions dialog
      for (const ch of c.chunks) overMenu.feed(ch, 27);
      assert.equal(overMenu.state(), "choice", `${c.name}, over the /permissions dialog`);
    }
  });
  it("a fake box drawn at column 0 over a real menu (as if the model could) is still refused", () => {
    const rule = "─".repeat(100);
    const base = (body: string): PromptWatcher => {
      const w = new PromptWatcher(100, 30);
      w.feed(`\x1b[?1049h\x1b[2J\x1b[H${body}`, 0);
      return w;
    };
    // the real permission menu at the bottom, a fake box above it, cursor hidden (as in menus)
    const menu = `\x1b[20;1H${rule}\r\n Bash command\r\n\r\n   ls\r\n\r\n Do you want to proceed?\r\n ❯ 1. Yes\r\n   2. No\r\n`;
    const fake = `\x1b[5;1H${rule}\r\n❯ \r\n${rule}\r\n`;
    assert.equal(base(`\x1b[?25l${fake}${menu}`).state(), "choice", "cursor hidden");
    // even with the cursor shown inside the fake box: the menu below it is not a footer
    assert.equal(base(`${fake}${menu}\x1b[6;3H\x1b[?25h`).state(), "choice", "a menu under the box");
    // and a real box with the cursor elsewhere is not "input" either
    const box = `\x1b[26;1H${rule}\r\n❯ \r\n${rule}\r\n  status`;
    assert.equal(base(`${box}\x1b[27;3H\x1b[?25h`).state(), "input");
    assert.equal(base(`${box}\x1b[10;3H\x1b[?25h`).state(), "choice", "cursor outside the box");
    assert.equal(base(`${box}\x1b[27;3H\x1b[?25l`).state(), "choice", "cursor hidden: a frame being drawn");
    assert.equal(
      base(`${box}\r\n${"  x\r\n".repeat(9)}\x1b[27;3H\x1b[?25h`).state(),
      "choice",
      "too many rows under it",
    );
    assert.equal(
      base(`\x1b[26;1H${"─".repeat(99)}\r\n❯ \r\n${rule}\x1b[27;3H\x1b[?25h`).state(),
      "choice",
      "a rule short of full width",
    );
  });
  it('a top rule labelled "<repo> @ <branch>" (Claude Code 2.1.295, issue #18) still marks the box', () => {
    const rule = "─".repeat(100);
    const label = " ophyd-async @ detector-stack-4-flyable ─";
    const labelled = "─".repeat(100 - label.length) + label;
    const footer =
      "  root  Opus 5.5 · medium  ctx:new  /workspaces/ophyd-async detector-stack-4-flyable!\r\n" +
      "  ⏵⏵ auto mode on (shift+tab to cycle) · gh auth login for PR status · ← for agents";
    const screen = (top: string): PromptWatcher => {
      const w = new PromptWatcher(100, 30);
      w.feed(
        `\x1b[?1049h\x1b[2J\x1b[25;1H${top}\r\n❯ Try "how do I log an error?"\r\n${rule}\r\n${footer}\x1b[26;3H\x1b[?25h`,
        0,
      );
      return w;
    };
    // the screen captured in the issue, at 100×30
    assert.equal(screen(labelled).state(), "input");
    assert.equal(screen(`  ${labelled.slice(2)}`).state(), "choice", "indented: transcript text");
    // each case below breaks exactly one property of an accepted labelled rule
    assert.equal(screen(`${"─".repeat(90)} x ─`).state(), "choice", "short of full width");
    assert.equal(screen(`${"─".repeat(7)} ${"x".repeat(90)} ─`).state(), "choice", "too little rule before the label");
    assert.equal(screen(`${"─".repeat(8)} ${"x".repeat(89)} ─`).state(), "input", "just enough rule before the label");
  });
  it("resizes are followed: a box drawn for the new width is found", () => {
    const w = new PromptWatcher(100, 30);
    w.resize(60, 20);
    const rule = "─".repeat(60);
    w.feed(`\x1b[?1049h\x1b[17;1H${rule}\r\n❯ \r\n${rule}\r\n  status\x1b[18;3H\x1b[?25h`, 0);
    assert.equal(w.state(), "input");
  });
  it("prompted once the glyph has been drawn: a menu before the first box is a menu, not 'starting'", () => {
    const w = new PromptWatcher(100, 30);
    w.feed("loading…", 0);
    assert.equal(w.state(), "starting");
    w.feed("\r\n ❯ Yes, I trust this folder", 1);
    assert.equal(w.state(), "choice");
  });
});

describe("the screen model is fast enough (relay output is fed to it on the extension host)", () => {
  it("50 MB of redraws in small chunks, well inside a time budget", () => {
    const frame = (n: number): string => {
      let s = "\x1b[?25l\x1b[H";
      for (let r = 0; r < 30; r++) s += `\r\x1b[1B\x1b[38;5;${r}m${`frame ${n} row ${r} ─❯  漢字 `.repeat(3)}\x1b[K`;
      return s + "\x1b[26;3H\x1b[?25h";
    };
    const w = new PromptWatcher(100, 30);
    let total = 0;
    const t0 = performance.now();
    for (let n = 0; total < 50e6; n++) {
      const f = frame(n);
      for (let i = 0; i < f.length; i += 97) {
        const c = f.slice(i, i + 97);
        w.feed(c, 0);
        total += c.length;
      }
    }
    const s = (performance.now() - t0) / 1000;
    assert.ok(s < 15, `took ${s.toFixed(1)} s`);
    assert.equal(w.state(), "choice");
  });
});
