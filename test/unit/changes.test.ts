import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { ChangeSet, entryKind, isReviewTitle, reviewPlan, SAVE_WINDOW_MS, splitByGit } from "../../src/changes.ts";

const set = () => new ChangeSet({ roots: ["/w", "/v/"] });

describe("Changed this session: the list", () => {
  it("records files in the workspace folders only, not under a .git segment or our sockets", () => {
    const s = set();
    for (const p of [
      "/w/a.py",
      "/v/b.md",
      "/elsewhere/c",
      "/w",
      "/wx/a",
      "/w/.git/index",
      "/w/sub/.git/HEAD",
      "/w/.claude-sandbox-vscode-31337.sock",
      "/w/.gitignore",
      "/w/x.git/y",
      "/w/node_modules/x/y.js",
    ]) {
      s.event("changed", p, 0);
    }
    // no pattern from settings: files.watcherExclude is workspace-writable (the jail could hide
    // files from this list with it, or hang the extension host with a pathological glob)
    assert.deepEqual(
      s.list().map((c) => c.path),
      ["/v/b.md", "/w/.gitignore", "/w/a.py", "/w/node_modules/x/y.js", "/w/x.git/y"],
    );
  });
  it("a path of any depth or shape is decided in time linear in its length", () => {
    const s = set();
    const deep = "/w/" + "a/".repeat(20_000) + "**/".repeat(5000) + "z";
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) s.wanted(deep);
    assert.ok(performance.now() - t0 < 2000);
  });
  it("a symlink is listed as one (lstat, never followed); a folder and a missing path are told apart", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csv-changes-"));
    try {
      fs.writeFileSync(path.join(dir, "f"), "x");
      fs.mkdirSync(path.join(dir, "d"));
      fs.symlinkSync("/etc/passwd", path.join(dir, "l"));
      fs.symlinkSync(path.join(dir, "d"), path.join(dir, "ld"));
      assert.equal(await entryKind(path.join(dir, "f")), "file");
      assert.equal(await entryKind(path.join(dir, "d")), "dir");
      assert.equal(await entryKind(path.join(dir, "l")), "symlink");
      assert.equal(await entryKind(path.join(dir, "ld")), "symlink", "a link to a folder is a symlink, not a folder");
      assert.equal(await entryKind(path.join(dir, "gone")), "gone");
      const s = new ChangeSet({ roots: [dir] });
      assert.equal(s.event("created", path.join(dir, "l"), 0, true)?.symlink, true);
      assert.equal(s.event("deleted", path.join(dir, "old"), 1, true)?.symlink, false, "a deleted entry is not opened either way");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

describe("Review All (vscode.changes rows)", () => {
  it("HEAD vs now; a new file against nothing; a deleted one HEAD vs nothing; symlinks left out", () => {
    const s = set();
    s.event("changed", "/w/mod.py", 0);
    s.event("created", "/w/new.py", 0);
    s.event("deleted", "/w/gone.py", 0);
    s.event("deleted", "/w/never-committed.py", 0);
    s.event("created", "/w/link", 0, true);
    s.event("changed", "/v/outside-repo.md", 0);
    const inHead = (c: { path: string }): boolean => c.path === "/w/mod.py" || c.path === "/w/gone.py";
    const plan = reviewPlan(s.list(), inHead);
    assert.deepEqual(plan.rows, [
      { path: "/v/outside-repo.md", head: false, now: true },
      { path: "/w/gone.py", head: true, now: false },
      { path: "/w/mod.py", head: true, now: true },
      { path: "/w/new.py", head: false, now: true },
    ]);
    assert.equal(plan.symlinks, 1);
    assert.equal(plan.title, "Claude changes", "VS Code adds the count");
  });
  it("Review All's tab is told apart by its label: the title, then VS Code's count", () => {
    // VS Code's MultiDiffEditorInput names the tab "<title> (N files)" / "<title> (1 file)",
    // localised, and shows the bare title until the resources resolve
    const title = reviewPlan([], () => true).title;
    for (const t of [title, `${title} (4 files)`, `${title} (1 file)`, `${title} (4 Dateien)`]) assert.ok(isReviewTitle(t), t);
    for (const t of ["Changes", "Claude changes.md", "My Claude changes (4 files)", "mod.py (HEAD ↔ now)"]) assert.ok(!isReviewTitle(t), t);
  });
});

describe("the list split by what git says now", () => {
  it("folds only files git shows no change for; outside a repository stays listed", () => {
    const s = set();
    s.event("changed", "/w/mod.py", 0); // git: modified
    s.event("changed", "/w/reverted.py", 0); // git: nothing (back as HEAD has it)
    s.event("created", "/w/__pycache__/m.cpython-313.pyc", 0); // git: nothing (ignored)
    s.event("changed", "/v/outside-repo.md", 0); // no repository
    const git: Record<string, boolean | undefined> = { "/w/mod.py": true, "/w/reverted.py": false, "/w/__pycache__/m.cpython-313.pyc": false };
    const { active, quiet } = splitByGit(s.list(), (c) => git[c.path]);
    assert.deepEqual(active.map((c) => c.path), ["/v/outside-repo.md", "/w/mod.py"]);
    assert.deepEqual(quiet.map((c) => c.path), ["/w/__pycache__/m.cpython-313.pyc", "/w/reverted.py"]);
    assert.deepEqual(splitByGit([], () => false), { active: [], quiet: [] });
  });
});
