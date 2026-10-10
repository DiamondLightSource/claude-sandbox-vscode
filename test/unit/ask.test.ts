import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BUILTIN_PRESETS,
  codeActions,
  customPresets,
  extraArgs,
  lineSpan,
  PRESETS_MAX,
  typedRef,
} from "../../src/ask.ts";

const p = (line: number, character: number) => ({ line, character });

describe("presets", () => {
  it("Explain, Reword and Tighten are built in", () => {
    assert.deepEqual(
      BUILTIN_PRESETS.map((x) => x.id),
      ["explain", "reword", "tighten"],
    );
  });
  it("the user's presets: valid entries only, trimmed, capped, first of a title; prototype keys are plain keys", () => {
    const got = customPresets([
      { title: " Summarise ", prompt: "Summarise it." },
      { title: "", prompt: "x" },
      { title: "t" },
      "nope",
      null,
      JSON.parse('{"__proto__": {"title": "evil"}, "title": "Own", "prompt": "p"}'),
      { title: 3, prompt: "p" },
      { title: "Summarise", prompt: "Another." },
    ]);
    assert.deepEqual(got, [
      { title: "Summarise", prompt: "Summarise it." },
      { title: "Own", prompt: "p" },
    ]);
    assert.deepEqual(customPresets("x"), []);
    assert.equal(
      customPresets(Array.from({ length: 99 }, (_, i) => ({ title: `a${i}`, prompt: "b" }))).length,
      PRESETS_MAX,
    );
  });
  it("code actions: the user's presets, the built-in ones, then Mention; Mention alone, asked for, with no selection", () => {
    const got = codeActions(true, false, [{ title: "Mine", prompt: "p" }]);
    assert.deepEqual(
      got.map((a) => a.title),
      ["Mine", "Explain", "Reword", "Tighten", "Mention"],
    );
    assert.deepEqual(got[0], { title: "Mine", command: "claudeSandbox.runPreset", args: ["Mine"] });
    assert.equal(got.at(-1)!.command, "claudeSandbox.mention");
    assert.deepEqual(
      codeActions(false, true, [{ title: "Mine", prompt: "p" }]).map((a) => a.command),
      ["claudeSandbox.mention"],
    );
    assert.deepEqual(codeActions(false, false, []), [], "no lightbulb on every line");
  });
  it("extraArgs: strings only", () => {
    assert.deepEqual(extraArgs(["--model", "opus", 3, null, "a\u0000b"]), ["--model", "opus"]);
    assert.deepEqual(extraArgs("--model opus"), []);
  });
});

describe("@-mentions", () => {
  it("lineSpan counts lines as Claude Code does", () => {
    assert.equal(lineSpan(p(3, 2), p(3, 2)), null);
    assert.deepEqual(lineSpan(p(0, 0), p(0, 5)), [1, 1]);
    assert.deepEqual(lineSpan(p(1, 0), p(3, 0)), [2, 3], "ends at the start of line 4: not covered");
    assert.deepEqual(lineSpan(p(1, 0), p(1, 0 + 1)), [2, 2]);
  });
  it("typedRef: relative inside the folder, quoted with whitespace, absolute outside", () => {
    assert.equal(typedRef("/w/src/a.py", "/w", [2, 4]), "@src/a.py#L2-4");
    assert.equal(typedRef("/w/src/a.py", "/w/", [2, 2]), "@src/a.py#L2");
    assert.equal(typedRef("/w/my file.md", "/w", null), '@"my file.md"');
    assert.equal(typedRef("/other/x.md", "/w", null), "@/other/x.md");
  });
});
