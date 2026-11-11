import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  AUTO_OPEN_MAX,
  AUTO_OPEN_MS,
  AUTO_QUIET_MS,
  AutoOpenGuard,
  byPath,
  CHANGES_MAX,
  ChangeSet,
  drawn,
  entryKind,
  folderIndex,
  freshStatus,
  groupByRoot,
  groupRows,
  groupsCollapsed,
  isReviewTitle,
  type LevelRow,
  levelRows,
  picked,
  REFRESH_MAX_MS,
  REFRESH_MS,
  refreshDelay,
  refreshWait,
  reviewPick,
  reviewPlan,
  SAVE_WINDOW_MS,
  sameDrawn,
  splitByGit,
  VIEW_MAX,
} from "../../src/changes.ts";

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
      assert.equal(
        s.event("deleted", path.join(dir, "old"), 1, true)?.symlink,
        false,
        "a deleted entry is not opened either way",
      );
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
    assert.equal(s.markReviewed("/w/a.py", false), true, "Mark as not reviewed");
    assert.equal(s.unreviewed, 2);
    s.markReviewed("/w/a.py");
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
    for (const t of [title, `${title} (4 files)`, `${title} (1 file)`, `${title} (4 Dateien)`])
      assert.ok(isReviewTitle(t), t);
    for (const t of ["Changes", "Claude changes.md", "My Claude changes (4 files)", "mod.py (HEAD ↔ now)"])
      assert.ok(!isReviewTitle(t), t);
  });
});

describe("shown as Source Control shows it", () => {
  it("only files git shows a change for; outside a repository all", () => {
    const s = set();
    s.event("changed", "/w/mod.py", 0); // git: modified
    s.event("changed", "/w/reverted.py", 0); // git: nothing (back as HEAD has it)
    s.event("created", "/w/__pycache__/m.cpython-313.pyc", 0); // git: nothing (ignored)
    s.event("changed", "/v/outside-repo.md", 0); // no repository
    const git: Record<string, boolean | undefined> = {
      "/w/mod.py": true,
      "/w/reverted.py": false,
      "/w/__pycache__/m.cpython-313.pyc": false,
    };
    const { active, quiet } = splitByGit(s.list(), (c) => git[c.path]);
    assert.deepEqual(
      active.map((c) => c.path),
      ["/v/outside-repo.md", "/w/mod.py"],
    );
    assert.deepEqual(
      quiet.map((c) => c.path),
      ["/w/__pycache__/m.cpython-313.pyc", "/w/reverted.py"],
    );
    assert.deepEqual(
      splitByGit([], () => false),
      { active: [], quiet: [] },
    );
  });
});

describe("grouped by repository, as Source Control groups them", () => {
  it("one group per root, roots sorted, files in list order", () => {
    const s = set();
    s.event("changed", "/w/b.py", 0);
    s.event("changed", "/w/sub/repo2/x.ts", 0);
    s.event("changed", "/w/a.py", 0);
    s.event("changed", "/v/notes.md", 0);
    const rootOf = (c: { path: string }): string =>
      c.path.startsWith("/w/sub/repo2/") ? "/w/sub/repo2" : c.path.startsWith("/w/") ? "/w" : "/v";
    const groups = groupByRoot(s.list(), rootOf);
    assert.deepEqual(
      groups.map((g) => [g.root, g.changes.map((c) => c.path)]),
      [
        ["/v", ["/v/notes.md"]],
        ["/w", ["/w/a.py", "/w/b.py"]],
        ["/w/sub/repo2", ["/w/sub/repo2/x.ts"]],
      ],
    );
    assert.deepEqual(groupByRoot([], rootOf), []);
  });
});

describe("a full list", () => {
  it("counts what it drops; pruning forgets only old entries the view does not keep", () => {
    const s = set();
    for (let i = 0; i < CHANGES_MAX; i++) s.event("created", `/w/node_modules/p${i}.js`, 0);
    s.event("changed", "/w/real.py", 0);
    assert.equal(s.size, CHANGES_MAX);
    assert.equal(s.dropped, 1, "a new path past the limit is counted, not silently lost");
    s.event("changed", "/w/node_modules/p1.js", 10); // already listed: still updated
    assert.equal(s.get("/w/node_modules/p1.js")!.at, 10);
    // the view keeps p0 (git shows it changed); p1 changed too recently to judge
    const gone = s.prune((c) => c.path === "/w/node_modules/p0.js", 5);
    assert.equal(gone, CHANGES_MAX - 2);
    assert.deepEqual(
      s.list().map((c) => c.path),
      ["/w/node_modules/p0.js", "/w/node_modules/p1.js"],
    );
    assert.ok(s.event("changed", "/w/real.py", 20), "room again for real changes");
  });
});

describe("git status re-read before a diff (a file just made is new, not HEAD's)", () => {
  it("each repository once, files outside any skipped, a failure not fatal", async () => {
    let a = 0;
    let b = 0;
    const ra = { status: async () => void a++ };
    const rb = { status: async () => (b++, Promise.reject(new Error("git gone"))) };
    await freshStatus([ra, null, ra, rb, ra]);
    assert.deepEqual([a, b], [1, 1]);
    await freshStatus([]);
  });
});

describe("the context menu's files", () => {
  it("the selection when it holds the row right-clicked, else that row; repository rows left out", () => {
    const f = (p: string) => ({ path: p, kind: "changed" as const, reviewed: false, at: 0, symlink: false });
    const g = { root: "/w", changes: [] };
    type N = ReturnType<typeof f> | typeof g;
    const isFile = (n: N): n is ReturnType<typeof f> => "path" in n;
    const [a, b, c] = [f("/w/a"), f("/w/b"), f("/w/c")];
    assert.deepEqual(picked(a, [a, b, g], isFile), [a, b]);
    assert.deepEqual(picked(c, [a, b], isFile), [c], "right-click outside the selection");
    assert.deepEqual(picked(a, undefined, isFile), [a]);
    assert.deepEqual(picked(g, [g], isFile), []);
    assert.deepEqual(picked(undefined, [a], isFile), [], "from the palette: nothing");
  });
});

describe("what the tree draws", () => {
  const rootOf = () => "/w";
  const inRepo = () => true;
  it("is the same for events that change nothing a row shows, and differs for ones that do", () => {
    const s = set();
    s.event("changed", "/w/b.py", 0);
    s.event("changed", "/w/a.py", 0);
    const now = () => drawn(byPath(s.all()), rootOf, inRepo);
    const before = now();
    assert.ok(!sameDrawn(undefined, before), "nothing drawn yet");
    s.event("changed", "/w/a.py", 50); // changed again: a new record, the same row
    assert.ok(sameDrawn(before, now()));
    s.markReviewed("/w/a.py");
    assert.ok(!sameDrawn(before, now()), "reviewed is shown");
    s.markReviewed("/w/a.py", false);
    assert.ok(sameDrawn(before, now()));
    s.event("changed", "/w/c.py", 55);
    assert.ok(!sameDrawn(before, now()), "a file more");
    s.event("deleted", "/w/c.py", 56);
    const three = now();
    s.event("deleted", "/w/b.py", 60);
    assert.ok(!sameDrawn(three, now()), "deleted is shown");
    assert.ok(
      !sameDrawn(
        drawn(byPath(s.all()), rootOf, () => false),
        now(),
      ),
      "so is being in a repository",
    );
    assert.ok(
      !sameDrawn(
        drawn(byPath(s.all()), () => "/v", inRepo),
        now(),
      ),
      "and the group",
    );
    const link = set();
    link.event("changed", "/w/a.py", 0, true);
    link.event("changed", "/w/b.py", 0);
    link.event("deleted", "/w/c.py", 0);
    const plain = set();
    plain.event("changed", "/w/a.py", 0);
    plain.event("changed", "/w/b.py", 0);
    plain.event("deleted", "/w/c.py", 0);
    assert.ok(!sameDrawn(drawn(link.list(), rootOf, inRepo), drawn(plain.list(), rootOf, inRepo)), "and a symlink");
    plain.event("changed", "/w/d.py", 0);
    link.event("created", "/w/d.py", 0);
    link.get("/w/a.py")!.symlink = false;
    assert.ok(!sameDrawn(drawn(link.list(), rootOf, inRepo), drawn(plain.list(), rootOf, inRepo)), "and the kind");
  });

  it("the next refresh waits a multiple of the last one's time, between a floor and a cap", () => {
    assert.equal(refreshDelay(0), REFRESH_MS);
    assert.equal(refreshDelay(5), REFRESH_MS);
    assert.equal(refreshDelay(100), 400);
    assert.equal(refreshDelay(60_000), REFRESH_MAX_MS);
  });

  it("a change waits until that long after the last refresh ended, and at least the floor", () => {
    assert.equal(refreshWait(1000, 990, 500), 1990, "just after a slow refresh");
    assert.equal(refreshWait(2900, 990, 500), REFRESH_MS, "near its end: still a burst's worth");
    assert.equal(refreshWait(600_000, 990, 5000), REFRESH_MS, "a lone change minutes later");
    assert.equal(refreshWait(50, 0, 0), REFRESH_MS);
  });

  it("all() is list() unsorted", () => {
    const s = set();
    for (const p of ["/w/c", "/w/a", "/w/b"]) s.event("changed", p, 0);
    assert.deepEqual(
      s.all().map((c) => c.path),
      ["/w/c", "/w/a", "/w/b"],
    );
    assert.deepEqual(byPath(s.all()), s.list());
  });
});

describe("folder rows (a group of more than VIEW_MAX files)", () => {
  const f = (p: string, reviewed = false) => ({ path: p, kind: "changed" as const, reviewed, at: 0, symlink: false });
  const install = () => {
    const cs = [f("/w/src/real.py"), f("/w/README.md"), f("/w/src/deep/other.py", true)];
    for (let i = 0; i < 20_000; i++) cs.push(f(`/w/.venv/lib/site-packages/pkg${i % 200}/mod${i}.py`));
    return cs;
  };
  const names = (r: ReturnType<ReturnType<typeof folderIndex>["get"]>) =>
    r === undefined ? undefined : [...r.folders.map((d) => `${d.name}/`), ...r.files.map((c) => c.path)];

  it("a real edit in src/ is reachable when .venv/ holds 20,000 files", () => {
    const ix = folderIndex(install(), "/w");
    const top = ix.get("/w")!;
    assert.deepEqual(names(top), [".venv/", "src/", "/w/README.md"]);
    assert.ok(top.folders.length + top.files.length <= VIEW_MAX);
    assert.deepEqual(names(ix.get("/w/src")), ["deep/", "/w/src/real.py"]);
    assert.deepEqual(names(ix.get("/w/src/deep")), ["/w/src/deep/other.py"]);
    assert.equal(ix.get("/w/nowhere"), undefined);
  });

  it("counts every file under a folder, and the unreviewed ones; no file is in two rows or none", () => {
    const cs = install();
    const ix = folderIndex(cs, "/w");
    const top = ix.get("/w")!;
    assert.deepEqual(
      top.folders.map((d) => [d.root, d.dir, d.files, d.unreviewed]),
      [
        ["/w", "/w/.venv", 20_000, 20_000],
        ["/w", "/w/src", 2, 1],
      ],
    );
    assert.equal(top.folders.reduce((n, d) => n + d.files, 0) + top.files.length, cs.length);
    assert.deepEqual(names(ix.get("/w/.venv")), ["lib/"]);
    const pkgs = ix.get("/w/.venv/lib/site-packages")!;
    assert.equal(pkgs.folders.length, 200);
    assert.equal(pkgs.files.length, 0);
    assert.ok(pkgs.folders.every((d) => d.files === 100 && d.root === "/w"));
    assert.equal(ix.get("/w/.venv/lib/site-packages/pkg7")!.files.length, 100);
    // every file is reached by expanding rows from the root
    const seen = new Set<string>();
    const walk = (dir: string): void => {
      const r = ix.get(dir)!;
      for (const c of r.files) {
        assert.ok(!seen.has(c.path), c.path);
        seen.add(c.path);
      }
      for (const d of r.folders) walk(d.dir);
    };
    walk("/w");
    assert.equal(seen.size, cs.length);
  });

  it("orders folders then files, each by path, whatever order the files come in", () => {
    const cs = [f("/w/b/y"), f("/w/z"), f("/w/a/x"), f("/w/b/x"), f("/w/a.txt"), f("/w/c/d/e/f"), f("/w/a.b/x")];
    const want = ["a/", "a.b/", "b/", "c/", "/w/a.txt", "/w/z"];
    assert.deepEqual(names(folderIndex(cs, "/w").get("/w")), want);
    assert.deepEqual(names(folderIndex([...cs].reverse(), "/w").get("/w")), want);
    assert.deepEqual(names(folderIndex([...cs].reverse(), "/w").get("/w/b")), ["/w/b/x", "/w/b/y"]);
  });

  it("a row is one directory, whatever else changes: its path does not move when a file appears beside it", () => {
    const cs = [f("/w/a/b/c/x")];
    const dirs = (xs: typeof cs) => [...folderIndex(xs, "/w").keys()].sort();
    assert.deepEqual(dirs(cs), ["/w", "/w/a", "/w/a/b", "/w/a/b/c"]);
    assert.deepEqual(dirs([...cs, f("/w/a/y")]), dirs(cs));
    assert.deepEqual(names(folderIndex(cs, "/w").get("/w/a")), ["b/"]);
  });

  it("a file and a folder may share a name", () => {
    const cs = [{ ...f("/w/d"), kind: "deleted" as const }, f("/w/d/z")];
    assert.deepEqual(names(folderIndex(cs, "/w").get("/w")), ["d/", "/w/d"]);
  });

  it("a file not under the group's root is listed at the root, not hidden", () => {
    const ix = folderIndex([f("/elsewhere/x"), f("/w/a/y"), f("/wx/z")], "/w");
    assert.deepEqual(names(ix.get("/w")), ["a/", "/elsewhere/x", "/wx/z"]);
    assert.deepEqual(names(ix.get("/w/a")), ["/w/a/y"]);
    assert.deepEqual(names(folderIndex([f("/a/b"), f("/c")], "/").get("/")), ["a/", "/c"]);
  });

  it("the redraw check covers what folder rows draw: a file reviewed deep in a collapsed folder changes it", () => {
    const cs = install();
    const now = () =>
      drawn(
        cs,
        () => "/w",
        () => false,
      );
    const before = now();
    assert.ok(sameDrawn(before, now()));
    cs[cs.length - 1]!.reviewed = true;
    assert.ok(!sameDrawn(before, now()));
  });
});

describe("a wide level (more rows than the tree draws at once)", () => {
  const f = (p: string, reviewed = false) => ({ path: p, kind: "changed" as const, reviewed, at: 0, symlink: false });
  const isRange = (r: LevelRow) => "range" in r;
  /** Every fetch from the root down: the most rows in one, how many fetches, and the files reached. */
  const walk = (cs: ReturnType<typeof f>[], max: number) => {
    const ix = folderIndex(cs, "/w");
    const seen: string[] = [];
    let most = 0;
    let fetches = 0;
    const visit = (dir: string, range?: number[]): void => {
      const rows = levelRows(ix.get(dir)!, "/w", dir, max, range);
      fetches++;
      most = Math.max(most, rows.length);
      for (const r of rows) {
        if ("range" in r) visit(r.dir, r.range);
        else if ("name" in r) visit(r.dir);
        else seen.push(r.path);
      }
    };
    visit("/w");
    return { most, fetches, seen, top: levelRows(ix.get("/w")!, "/w", "/w", max) };
  };
  const all = (cs: { path: string }[]) => cs.map((c) => c.path).sort();

  it("50,000 files directly in the root: 50 range rows, every file under one, no fetch over the limit", () => {
    const cs = Array.from({ length: 50_000 }, (_, i) => f(`/w/f${i}`, i % 2 === 0));
    const w = walk(cs, VIEW_MAX);
    assert.equal(w.top.length, 50);
    assert.ok(w.top.every(isRange));
    assert.equal(w.most, VIEW_MAX);
    assert.deepEqual(w.seen.slice().sort(), all(cs));
    const first = w.top[0]!;
    assert.ok("range" in first);
    const names = cs.map((c) => c.path.slice(3)).sort();
    assert.deepEqual([first.first, first.last, first.files, first.range], [names[0], names[999], 1000, [0]]);
    assert.equal(
      w.top.reduce((n, r) => n + ("range" in r ? r.unreviewed : 0), 0),
      25_000,
    );
  });

  it("50,000 one-file directories: ranges of folder rows, counted by their files", () => {
    const cs = Array.from({ length: 50_000 }, (_, i) => f(`/w/d${i}/only.py`));
    const w = walk(cs, VIEW_MAX);
    assert.equal(w.top.length, 50);
    assert.equal(w.most, VIEW_MAX);
    assert.deepEqual(w.seen.slice().sort(), all(cs));
    const last = w.top[49]!;
    assert.ok("range" in last);
    const dirs = cs.map((c) => c.path.split("/")[2]).sort();
    assert.deepEqual([last.first, last.last, last.files, last.unreviewed], [dirs[49_000], "d9999", 1000, 1000]);
  });

  it("a level exactly at the limit is its rows; one over is two ranges", () => {
    const at = Array.from({ length: VIEW_MAX - 1 }, (_, i) => f(`/w/f${i}`));
    at.push(f("/w/sub/x"));
    const flat = walk(at, VIEW_MAX);
    assert.equal(flat.top.length, VIEW_MAX);
    assert.ok(!flat.top.some(isRange));
    assert.ok("name" in flat.top[0]! && flat.top[0].name === "sub", "folders first");
    const over = walk([...at, f("/w/zzz")], VIEW_MAX);
    assert.equal(over.top.length, 2);
    const [a, b] = over.top as [LevelRow, LevelRow];
    assert.ok("range" in a && "range" in b);
    assert.deepEqual([a.first, a.files, b.first, b.last, b.files], ["sub", VIEW_MAX, "zzz", "zzz", 1]);
    assert.equal(over.seen.length, VIEW_MAX + 1);
  });

  it("more ranges than the limit are ranges of ranges", () => {
    const cs = Array.from({ length: 30 }, (_, i) => f(`/w/f${String(i).padStart(2, "0")}`));
    const w = walk(cs, 3);
    assert.equal(w.most, 3);
    assert.deepEqual(w.seen, all(cs), "in order");
    const top = w.top as { range: number[]; first: string; last: string; files: number }[];
    assert.deepEqual(
      top.map((r) => [r.range, r.first, r.last, r.files]),
      [
        [[0], "f00", "f26", 27],
        [[1], "f27", "f29", 3],
      ],
    );
    const ix = folderIndex(cs, "/w");
    const inner = levelRows(ix.get("/w")!, "/w", "/w", 3, [0, 2]) as typeof top;
    assert.deepEqual(
      inner.map((r) => [r.range, r.first, r.last]),
      [
        [[0, 2, 0], "f18", "f20"],
        [[0, 2, 1], "f21", "f23"],
        [[0, 2, 2], "f24", "f26"],
      ],
    );
    assert.deepEqual(
      levelRows(ix.get("/w")!, "/w", "/w", 3, [0, 2, 1]).map((r) => ("path" in r ? r.path : "")),
      ["/w/f21", "/w/f22", "/w/f23"],
    );
  });

  it("a range is known by its number: files added later in the level leave it as it was; a stale one is empty", () => {
    const cs = Array.from({ length: 2500 }, (_, i) => f(`/w/f${String(i).padStart(5, "0")}`));
    const rows = (xs: typeof cs, range: number[]) =>
      levelRows(folderIndex(xs, "/w").get("/w")!, "/w", "/w", 1000, range);
    const more = [...cs, f("/w/zzz1"), f("/w/zzz2")];
    assert.deepEqual(rows(more, [1]), rows(cs, [1]));
    assert.equal(rows(more, [2]).length, 502);
    assert.deepEqual(rows(cs, [3]), []);
    assert.deepEqual(rows(cs, [0, 0]), []);
    assert.deepEqual(rows(cs.slice(0, 10), [0]), []);
  });
});

describe("the group rows", () => {
  const f = (p: string) => ({ path: p, kind: "changed" as const, reviewed: false, at: 0, symlink: false });
  it("are expanded while a redraw sends at most the limit, rows and files together", () => {
    assert.ok(!groupsCollapsed(1, 50_000, VIEW_MAX), "one group is unwrapped: its level bounds it");
    assert.ok(!groupsCollapsed(2, VIEW_MAX - 2, VIEW_MAX));
    assert.ok(groupsCollapsed(2, VIEW_MAX - 1, VIEW_MAX));
    assert.ok(groupsCollapsed(50, 50_000, VIEW_MAX), "50 repositories of 1000 files");
    assert.ok(groupsCollapsed(600, 600, VIEW_MAX), "a group per directory");
  });

  it("up to the limit are listed; more are ranges, every group under one, no fetch over the limit", () => {
    const groups = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ root: `/w/r${String(i).padStart(4, "0")}`, changes: [f(`/w/r${i}/a`)] }));
    const few = groups(VIEW_MAX);
    assert.deepEqual(groupRows(few, VIEW_MAX), few);
    const many = groups(1500);
    const top = groupRows(many, VIEW_MAX);
    assert.deepEqual(
      top.map((r) => ("range" in r ? [r.root, r.dir, r.range, r.first, r.last, r.files, r.unreviewed] : [])),
      [
        ["", "", [0], "r0000", "r0999", 1000, 1000],
        ["", "", [1], "r1000", "r1499", 500, 500],
      ],
    );
    assert.deepEqual([...groupRows(many, VIEW_MAX, [0]), ...groupRows(many, VIEW_MAX, [1])], many);
    assert.deepEqual(groupRows(many, VIEW_MAX, [2]), []);
    assert.deepEqual(groupRows(few, VIEW_MAX, [0]), [], "an older draw's range");
  });
});

describe("Review All's limit", () => {
  const f = (p: string) => ({ path: p, kind: "changed" as const, reviewed: false, at: 0, symlink: false });
  it("takes every file up to the limit, by path", () => {
    const cs = [f("/w/b"), f("/w/a")];
    assert.deepEqual(
      reviewPick(cs, () => 2, 2),
      { files: [f("/w/a"), f("/w/b")], left: 0 },
    );
  });
  it("above it: files HEAD has, then a repository's new files, then files outside one, each by path", () => {
    const cs = [
      f("/w/.venv/a"),
      f("/w/.venv/b"),
      f("/w/repo/aaa-new1"),
      f("/w/repo/aaa-new2"),
      f("/w/repo/src/real.py"),
      f("/w/repo/z"),
    ];
    const rank = (c: { path: string }) => (!c.path.startsWith("/w/repo/") ? 2 : c.path.includes("new") ? 1 : 0);
    const paths = (max: number) => reviewPick(cs, rank, max).files.map((c) => c.path);
    assert.deepEqual(paths(1), ["/w/repo/src/real.py"], "new files sorting first do not push a tracked edit out");
    assert.deepEqual(paths(3), ["/w/repo/aaa-new1", "/w/repo/src/real.py", "/w/repo/z"]);
    assert.deepEqual(paths(5), [
      "/w/.venv/a",
      "/w/repo/aaa-new1",
      "/w/repo/aaa-new2",
      "/w/repo/src/real.py",
      "/w/repo/z",
    ]);
    assert.equal(reviewPick(cs, rank, 5).left, 1);
    assert.deepEqual(reviewPick([...cs].reverse(), rank, 3), reviewPick(cs, rank, 3), "whatever order they come in");
  });
});

describe("autoOpenDiffs' guard", () => {
  it("opens diffs for a few files, and none while many change at once", () => {
    const g = new AutoOpenGuard();
    for (let n = 1; n <= AUTO_OPEN_MAX; n++) assert.equal(g.next(n, n), "open");
    assert.equal(g.next(AUTO_OPEN_MAX + 1, 20), "burst", "the waiting diffs are cancelled");
    // the install goes on: 100 files every 100 ms for 5 s
    let t = 20;
    for (; t < 5000; t += 100) for (let i = 0; i < 100; i++) assert.equal(g.next(1, t), "skip");
    const last = t - 100;
    assert.equal(g.next(1, last + AUTO_QUIET_MS - 1), "skip");
    assert.equal(g.next(1, last + AUTO_QUIET_MS), "open", "the burst is over");
  });
  it("an edit now and then during a burst's last moments does not prolong it", () => {
    const g = new AutoOpenGuard();
    assert.equal(g.next(AUTO_OPEN_MAX + 1, 0), "burst");
    for (let t = AUTO_OPEN_MS; t < AUTO_QUIET_MS; t += AUTO_OPEN_MS) assert.equal(g.next(1, t), "skip");
    assert.equal(g.next(1, AUTO_QUIET_MS), "open");
  });
});
