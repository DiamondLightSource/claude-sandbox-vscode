import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ChangeSet, globToRegExp, SAVE_WINDOW_MS } from "../../src/changes.ts";

const set = (exclude: string[] = []) => new ChangeSet({ roots: ["/w", "/v/"], exclude });

describe("Changed this session: the list", () => {
  it("records files in the workspace folders only, not .git, our sockets or watcherExclude", () => {
    const s = set(["**/node_modules", "**/.venv/**", "**/*.log"]);
    for (const p of [
      "/w/a.py",
      "/v/b.md",
      "/elsewhere/c",
      "/w",
      "/wx/a",
      "/w/.git/index",
      "/w/sub/.git/HEAD",
      "/w/.claude-sandbox-vscode-31337.sock",
      "/w/node_modules/x/y.js",
      "/w/.venv/lib/z.py",
      "/w/out/run.log",
    ]) {
      s.event("changed", p, 0);
    }
    assert.deepEqual(s.list().map((c) => c.path), ["/v/b.md", "/w/a.py"]);
  });
  it("skips the user's own saves within the window (not deletions), not later changes", () => {
    const s = set();
    s.userSaved("/w/a.py", 1000);
    assert.equal(s.event("changed", "/w/a.py", 1000 + SAVE_WINDOW_MS), null);
    assert.equal(s.event("created", "/w/a.py", 1500), null, "a Save As is the user's too");
    assert.ok(s.event("changed", "/w/a.py", 1001 + SAVE_WINDOW_MS));
    assert.ok(s.event("changed", "/w/b.py", 1000), "another file");
  });
  it("kinds: created stays created, created then deleted drops it, deleted then created is changed", () => {
    const s = set();
    s.event("created", "/w/n.py", 0);
    s.event("changed", "/w/n.py", 1);
    assert.equal(s.get("/w/n.py")?.kind, "created");
    s.event("deleted", "/w/n.py", 2);
    assert.equal(s.get("/w/n.py"), undefined);
    s.event("deleted", "/w/o.py", 3);
    assert.equal(s.get("/w/o.py")?.kind, "deleted");
    s.event("created", "/w/o.py", 4);
    assert.equal(s.get("/w/o.py")?.kind, "changed");
  });
  it("Mark as reviewed ticks it until it changes again; counts unreviewed", () => {
    const s = set();
    s.event("changed", "/w/a.py", 0);
    s.event("changed", "/w/b.py", 0);
    assert.equal(s.unreviewed, 2);
    assert.equal(s.markReviewed("/w/a.py"), true);
    assert.equal(s.markReviewed("/w/a.py"), false, "already");
    assert.equal(s.markReviewed("/w/zzz"), false);
    assert.equal(s.unreviewed, 1);
    s.event("changed", "/w/a.py", 5);
    assert.equal(s.get("/w/a.py")?.reviewed, false);
    assert.equal(s.unreviewed, 2);
    s.clear();
    assert.equal(s.size, 0);
  });
});

describe("globToRegExp (files.watcherExclude patterns)", () => {
  it("**, *, ?, {a,b}, [...] and folder contents", () => {
    const m = (g: string, p: string): boolean => globToRegExp(g).test(p);
    assert.ok(m("**/.git/objects/**", ".git/objects/ab/cd"));
    assert.ok(m("**/.git/objects/**", "sub/.git/objects/ab"));
    assert.ok(m("**/node_modules/*/**", "node_modules/x/y.js"));
    assert.ok(m("**/node_modules", "a/node_modules/x/y.js"), "a folder's contents");
    assert.ok(m("*.{log,tmp}", "x.tmp"));
    assert.ok(!m("*.{log,tmp}", "d/x.tmp"), "* stays in one folder");
    assert.ok(m("file?.txt", "file1.txt"));
    assert.ok(m("[ab].md", "b.md") && !m("[!ab].md", "a.md"));
    assert.ok(!m("a.b", "axb"), "dots are literal");
    assert.ok(m("/abs/**", "/abs/x/y"));
  });
});
