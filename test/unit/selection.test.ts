import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Position } from "../../src/mcp.ts";
import { SelectionTracker, TEXT_MAX, type EditorSelection } from "../../src/selection.ts";

const p = (line: number, character: number): Position => ({ line, character });
const ed = (fsPath: string, start: Position, end: Position, text = "", scheme = "file"): EditorSelection => ({ scheme, fsPath, start, end, text });

// what Claude holds, as the bridge decides it (rule 5: only workspace files, else cleared)
function setup() {
  let claude: { file: string; start: Position; end: Position; text: string } | "cleared" | null = null;
  const sent: string[] = [];
  const sink = {
    select(fsPath: string, start: Position, end: Position, text: string): void {
      sent.push(fsPath);
      claude = fsPath.startsWith("/w/") ? { file: fsPath, start, end, text } : "cleared";
    },
  };
  const t = new SelectionTracker(() => sink, 5);
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));
  return { t, settle, sent, claude: () => claude };
}

describe("rule 5: the selection Claude keeps", () => {
  it("select in a.py, then focus the Claude terminal: still a.py's selection", async () => {
    const s = setup();
    s.t.event(ed("/w/a.py", p(1, 0), p(3, 0), "x\ny\n"));
    await s.settle();
    s.t.event(undefined); // the terminal tab: no active text editor
    s.t.event(ed("output:1", p(0, 0), p(0, 0), "", "output")); // the output panel
    await s.settle();
    assert.deepEqual(s.claude(), { file: "/w/a.py", start: p(1, 0), end: p(3, 0), text: "x\ny\n" });
    assert.deepEqual(s.sent, ["/w/a.py"]);
  });
  it("focusing the terminal right after selecting does not cancel the pending send", async () => {
    const s = setup();
    s.t.event(ed("/w/a.py", p(0, 0), p(0, 5), "hello"));
    s.t.event(undefined);
    await s.settle();
    assert.deepEqual(s.sent, ["/w/a.py"]);
  });
  it("a selection in a file outside the workspace clears Claude's", async () => {
    const s = setup();
    s.t.event(ed("/w/a.py", p(1, 0), p(3, 0), "x"));
    await s.settle();
    s.t.event(ed("/etc/hosts", p(0, 0), p(0, 4), "127."));
    await s.settle();
    assert.equal(s.claude(), "cleared");
  });
  it("a cursor move (empty selection) in b.py sends b.py's position, not a clear", async () => {
    const s = setup();
    s.t.event(ed("/w/a.py", p(1, 0), p(3, 0), "x"));
    await s.settle();
    s.t.event(ed("/w/b.py", p(7, 2), p(7, 2)));
    await s.settle();
    assert.deepEqual(s.claude(), { file: "/w/b.py", start: p(7, 2), end: p(7, 2), text: "" });
  });
  it("debounced: only the last of a burst is sent; long text capped", async () => {
    const s = setup();
    s.t.event(ed("/w/a.py", p(0, 0), p(0, 1), "a"));
    s.t.event(ed("/w/a.py", p(0, 0), p(9, 0), "z".repeat(TEXT_MAX + 10)));
    await s.settle();
    assert.equal(s.sent.length, 1);
    const c = s.claude() as { text: string };
    assert.equal(c.text.length, TEXT_MAX);
  });
});
