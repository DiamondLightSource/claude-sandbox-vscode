import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { hasGitPart, isInside, peerRoot, realpathLoose, Workspace } from "../../src/paths.ts";
import { SECRET, type Tmp, tmpWorkspace } from "../helpers/fakes.ts";

let t: Tmp;
let ws: Workspace;
beforeEach(() => {
  t = tmpWorkspace();
  fs.writeFileSync(path.join(t.ws, "a.md"), "hello\n");
  fs.mkdirSync(path.join(t.ws, "sub"));
  fs.writeFileSync(path.join(t.ws, "sub", "b.md"), "b\r\n");
  ws = new Workspace([t.ws]);
});
afterEach(() => t.cleanup());

describe("helpers", () => {
  it("isInside is by whole components", () => {
    assert.ok(isInside("/a/b", "/a"));
    assert.ok(isInside("/a", "/a"));
    assert.ok(!isInside("/ab", "/a"));
  });
  it("peerRoot: the parent, never the root nor a home folder, inside one or holding one", () => {
    assert.equal(peerRoot("/workspaces/proj", ["/root"]), "/workspaces");
    assert.equal(peerRoot("/workspaces/a/proj", []), "/workspaces/a");
    assert.equal(peerRoot("/proj", []), null, "the root");
    assert.equal(peerRoot("/root/proj", ["/root"]), null, "$HOME");
    assert.equal(peerRoot("/root/src/proj", ["/root"]), null, "inside $HOME");
    assert.equal(peerRoot("/home/proj", ["/home/u"]), null, "holds $HOME");
    assert.equal(peerRoot("/homes/proj", ["/home/u"]), "/homes");
  });
  it("hasGitPart, any case", () => {
    assert.ok(hasGitPart(".git/config"));
    assert.ok(hasGitPart("x/.GIT/hooks/pre-commit"));
    assert.ok(!hasGitPart(".github/x"));
  });
  it("realpathLoose resolves the existing part of a missing path", () => {
    fs.symlinkSync(t.outside, path.join(t.ws, "out"));
    assert.equal(realpathLoose(path.join(t.ws, "out", "new", "x.md")), path.join(t.outside, "new", "x.md"));
  });
});

describe("resolve", () => {
  it("accepts files in the workspace, existing or not", () => {
    const r = ws.resolve(path.join(t.ws, "a.md"));
    assert.ok(r.ok && r.real === path.join(t.ws, "a.md") && r.folder === t.ws);
    assert.ok(ws.resolve(path.join(t.ws, "new", "deep.md")).ok);
  });
  it("refuses relative, outside, .., symlinked-out, the folder itself and .git", () => {
    fs.symlinkSync(t.secret, path.join(t.ws, "link.md"));
    fs.symlinkSync(t.outside, path.join(t.ws, "outdir"));
    fs.mkdirSync(path.join(t.ws, ".git"));
    for (const p of [
      "a.md",
      "",
      t.secret,
      path.join(t.ws, "..", "outside", "secret.md"),
      path.join(t.ws, "sub", "..", "..", "outside", "secret.md"),
      path.join(t.ws, "link.md"),
      path.join(t.ws, "outdir", "secret.md"),
      t.ws,
      path.join(t.ws, ".git", "config"),
      "/etc/passwd",
      path.join(t.ws, "a\0.md"),
      42,
      null,
    ]) {
      assert.equal(ws.resolve(p).ok, false, String(p));
    }
  });
  it("resolves file URIs only", () => {
    assert.ok(ws.resolveUri("file://" + path.join(t.ws, "a.md")).ok);
    assert.ok(ws.resolveUri("file://" + path.join(t.ws, "a%20b.md")).ok);
    assert.equal(ws.resolveUri("http://x" + path.join(t.ws, "a.md")).ok, false);
    assert.equal(ws.resolveUri("file://remote" + path.join(t.ws, "a.md")).ok, false);
    assert.equal(ws.resolveUri("file://" + t.secret).ok, false);
    assert.equal(ws.resolveUri("not a uri").ok, false);
    assert.equal(ws.resolveUri("file:///%E0%A4%A").ok, false);
  });
});

describe("readInside", () => {
  it("reads text, keeps CRLF, reports a missing file as new", () => {
    assert.deepEqual(ws.readInside(path.join(t.ws, "a.md"), t.ws), { kind: "text", text: "hello\n", exists: true });
    assert.deepEqual(ws.readInside(path.join(t.ws, "sub", "b.md"), t.ws), {
      kind: "text",
      text: "b\r\n",
      exists: true,
    });
    assert.deepEqual(ws.readInside(path.join(t.ws, "nope", "c.md"), t.ws), {
      kind: "missing",
      text: "",
      exists: false,
    });
  });
  it("refuses binary, FIFOs, directories, .git and paths outside", () => {
    fs.writeFileSync(path.join(t.ws, "bin.dat"), Buffer.from([0, 1, 2]));
    fs.writeFileSync(path.join(t.ws, "latin1.txt"), Buffer.from([0xe9]));
    fs.mkdirSync(path.join(t.ws, ".git"));
    fs.writeFileSync(path.join(t.ws, ".git", "config"), "[core]\n");
    execFileSync("mkfifo", [path.join(t.ws, "fifo")]);
    for (const p of ["bin.dat", "latin1.txt", "sub", ".git/config", "fifo"]) {
      assert.equal(ws.readInside(path.join(t.ws, p), t.ws).kind, "refused", p);
    }
    assert.equal(ws.readInside(t.secret, t.ws).kind, "refused");
    assert.equal(ws.readInside(t.secret, t.outside).kind, "refused", "only real workspace folders");
  });
  it("never follows a symlink at the file", () => {
    fs.symlinkSync(t.secret, path.join(t.ws, "link.md"));
    const r = ws.readInside(path.join(t.ws, "link.md"), t.ws);
    assert.equal(r.kind, "refused");
  });
  it("never follows a symlink at a folder above the file", () => {
    fs.symlinkSync(t.outside, path.join(t.ws, "outdir"));
    assert.equal(ws.readInside(path.join(t.ws, "outdir", "secret.md"), t.ws).kind, "refused");
  });
  it("refuses a symlink swapped in at the file after the check", () => {
    const target = path.join(t.ws, "a.md");
    const r = ws.readInside(target, t.ws, {
      beforeOpen: () => {
        fs.unlinkSync(target);
        fs.symlinkSync(t.secret, target);
      },
    });
    assert.equal(r.kind, "refused");
    assert.doesNotMatch(JSON.stringify(r), new RegExp(SECRET));
  });
  it("refuses a symlink swapped in at a parent folder after the check", () => {
    fs.writeFileSync(path.join(t.outside, "b.md"), SECRET);
    const r = ws.readInside(path.join(t.ws, "sub", "b.md"), t.ws, {
      beforeOpen: () => {
        fs.renameSync(path.join(t.ws, "sub"), path.join(t.ws, "sub-old"));
        fs.symlinkSync(t.outside, path.join(t.ws, "sub"));
      },
    });
    assert.equal(r.kind, "refused");
  });
});
