import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { DiffTabs, diffIdOf, ORIGINAL_SCHEME, PROPOSAL_SCHEME } from "../../src/diffTabs.ts";
import type { Decision } from "../../src/mcp.ts";

function table(): { tabs: DiffTabs<{ n: number }>; said: [string, Decision][]; clock: { t: number } } {
  const said: [string, Decision][] = [];
  const clock = { t: 1000 };
  const tabs = new DiffTabs<{ n: number }>(
    (id, d) => {
      said.push([id, d]);
      return true;
    },
    () => clock.t,
  );
  return { tabs, said, clock };
}

describe("rule 3: the diff tabs' state machine", () => {
  it("the user closing an open diff rejects it (DIFF_REJECTED), once", () => {
    const { tabs, said } = table();
    tabs.add("a", { n: 1 });
    tabs.tabClosed("a", 1); // one of two tabs (the diff open in two groups)
    assert.deepEqual(said, [["a", { kind: "closed" }]]);
    assert.ok(tabs.get("a"), "kept while a tab of it is open");
    tabs.tabClosed("a", 0);
    assert.equal(said.length, 1, "answered once");
    assert.equal(tabs.get("a"), undefined);
  });

  it("accept answers FILE_SAVED's text once; its tabs closing afterwards answer nothing", () => {
    const { tabs, said } = table();
    tabs.add("a", { n: 1 });
    assert.equal(tabs.answer("a", { kind: "accept", contents: "new" }), true);
    assert.equal(tabs.answer("a", { kind: "reject" }), false, "a second click is a no-op");
    assert.ok(tabs.get("a"), "still there for VS Code to stat while the tab closes");
    tabs.tabClosed("a", 0);
    assert.deepEqual(said, [["a", { kind: "accept", contents: "new" }]]);
    assert.equal(tabs.get("a"), undefined);
  });

  it("reject answers DIFF_REJECTED", () => {
    const { tabs, said } = table();
    tabs.add("a", { n: 1 });
    assert.ok(tabs.answer("a", { kind: "reject" }));
    tabs.tabClosed("a", 0);
    assert.deepEqual(said, [["a", { kind: "reject" }]]);
  });

  it("closed by the bridge (Claude closed it, or the connection was lost): no answer", () => {
    const { tabs, said } = table();
    tabs.add("a", { n: 1 });
    tabs.add("b", { n: 2 });
    assert.ok(tabs.closeQuietly("a"));
    tabs.tabClosed("a", 0);
    assert.ok(tabs.closeQuietly("b"));
    assert.equal(tabs.answer("b", { kind: "accept", contents: "x" }), false, "a stale tab accepts nothing");
    tabs.noTabs("b"); // its tab was never open
    assert.deepEqual(said, []);
    assert.deepEqual(tabs.ids(), [], "nothing left behind");
    assert.equal(tabs.closeQuietly("a"), false);
  });

  it("noTabs drops only an entry being closed; unknown ids are ignored", () => {
    const { tabs, said } = table();
    tabs.add("a", { n: 1 });
    tabs.noTabs("a");
    assert.ok(tabs.get("a"), "an open diff stays");
    tabs.tabClosed("zz", 0);
    tabs.written("zz");
    assert.deepEqual(said, []);
    tabs.clear();
    assert.deepEqual(tabs.ids(), []);
  });

  it("mtime changes only when the proposal is written", () => {
    const { tabs, clock } = table();
    const e = tabs.add("a", { n: 1 });
    assert.equal(e.mtime, 1000);
    clock.t = 5000;
    assert.equal(tabs.get("a")!.mtime, 1000, "reading or stat-ing does not bump it");
    tabs.written("a");
    assert.equal(tabs.get("a")!.mtime, 5000);
    tabs.written("a"); // same clock tick: still a new mtime
    assert.equal(tabs.get("a")!.mtime, 5001);
  });
});

describe("Accept and Reject from either side of the diff", () => {
  it("diffIdOf reads the id from the original and the proposal URIs only", () => {
    assert.equal(diffIdOf({ scheme: PROPOSAL_SCHEME, path: "/abc-1/f.md" }), "abc-1");
    assert.equal(diffIdOf({ scheme: ORIGINAL_SCHEME, path: "/abc-1/f.md" }), "abc-1");
    assert.equal(diffIdOf({ scheme: "file", path: "/abc-1/f.md" }), undefined);
    assert.equal(diffIdOf({ scheme: PROPOSAL_SCHEME, path: "/" }), undefined);
  });

  it("the commands are offered when either side has focus", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "..", "package.json"), "utf8"));
    const menus = pkg.contributes.menus as Record<string, { command: string; when: string }[]>;
    const entries = [...menus["editor/title"]!, ...menus.commandPalette!].filter((m) => /Diff$/.test(m.command));
    assert.equal(entries.length, 4);
    for (const m of entries) {
      assert.match(m.when, new RegExp(`resourceScheme == ${PROPOSAL_SCHEME}\\b`), m.command);
      assert.match(m.when, new RegExp(`resourceScheme == ${ORIGINAL_SCHEME}\\b`), m.command);
    }
  });
});
