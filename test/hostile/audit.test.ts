// Audits of the host-side code as a whole.
// - Rule 3: nothing in src/ can write a workspace file (a scan for write APIs).
// - Rule 7: a whole link session never touches the jail's config folder (every fs call that
//   takes a path is recorded while a link starts, serves Claude and closes).

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import * as path from "node:path";
import { describe, it } from "node:test";
import { IdeLink } from "../../src/link.ts";
import { Client, openDiff, toolCall } from "../helpers/client.ts";
import { FakeDiagnostics, FakePresenter, MemLogger, snapshot, tmpWorkspace } from "../helpers/fakes.ts";

const root = path.resolve(import.meta.dirname, "..", "..");

function sources(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => path.join(e.parentPath, e.name));
}

describe("rule 3: no code path writes a file", () => {
  it("src/ uses no write or delete API (libuv alone unlinks our socket when it closes)", () => {
    const write =
      /\bfs\.(write|writeSync|writeFile|writeFileSync|appendFile\w*|createWriteStream|rename\w*|copyFile\w*|cp\w*|truncate\w*|chmod\w*|chown\w*|lchown\w*|mkdir\w*|mkdtemp\w*|rm|rmSync|rmdir\w*|symlink\w*|link|linkSync|unlink|unlinkSync|utimes\w*)\b|O_WRONLY|O_RDWR|O_CREAT|O_TRUNC|O_APPEND|workspace\.fs\.|applyEdit|WorkspaceEdit|child_process/;
    const hits: string[] = [];
    for (const f of sources(path.join(root, "src"))) {
      fs.readFileSync(f, "utf8")
        .split("\n")
        .forEach((line) => {
          const code = line.replace(/\/\/.*$/, "").trim();
          if (write.test(code)) hits.push(`${path.relative(root, f)}: ${code}`);
        });
    }
    assert.deepEqual(hits, []);
  });

  it("the only save() is of our in-memory proposal documents", () => {
    const hits = sources(path.join(root, "src")).flatMap((f) =>
      fs
        .readFileSync(f, "utf8")
        .split("\n")
        .filter((l) => /\.save\(/.test(l))
        .map((l) => `${path.basename(f)}: ${l.trim()}`),
    );
    assert.deepEqual(hits, ["diffView.ts: if (doc?.isDirty) await doc.save();"]);
    assert.match(fs.readFileSync(path.join(root, "src", "vscode", "diffView.ts"), "utf8"), /d\.uri\.toString\(\) === e\.data\.right\.toString\(\)/);
  });

  it("src/ has no runtime dependency", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as Record<string, unknown>;
    assert.equal(pkg.dependencies, undefined);
    for (const f of sources(path.join(root, "src"))) {
      for (const m of fs.readFileSync(f, "utf8").matchAll(/from "([^"]+)"/g)) {
        assert.ok(/^(node:|\.|vscode$)/.test(m[1]!), `${f} imports ${m[1]}`);
      }
    }
  });
});

describe("rule 7: the host never opens anything under the config folder", () => {
  it("a whole link session records no path under it", async () => {
    const t = tmpWorkspace();
    const cfg = path.join(t.dir, "home", ".config", "terminal-config");
    fs.mkdirSync(path.join(cfg, ".claude", "ide"), { recursive: true });
    fs.writeFileSync(path.join(t.ws, "a.md"), "a\n");
    const cfgBefore = snapshot(cfg);
    const env = { HOME: process.env.HOME, CSC: process.env.CLAUDE_SANDBOX_SHARED_CONFIG };
    process.env.HOME = path.join(t.dir, "home");
    process.env.CLAUDE_SANDBOX_SHARED_CONFIG = cfg;

    const cjsFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const seen: string[] = [];
    const saved = new Map<string, unknown>();
    for (const name of Object.keys(cjsFs)) {
      const fn = cjsFs[name];
      if (typeof fn !== "function" || !/^[a-z]/.test(name) || name === "fstatSync" || name === "closeSync") continue;
      saved.set(name, fn);
      const wrapped = function (this: unknown, ...args: unknown[]): unknown {
        for (const a of args) if (typeof a === "string" || a instanceof URL || Buffer.isBuffer(a)) seen.push(String(a));
        return (fn as (...x: unknown[]) => unknown).apply(this, args);
      };
      Object.assign(wrapped, fn); // realpathSync.native and friends
      cjsFs[name] = wrapped;
    }
    syncBuiltinESMExports();
    let link: IdeLink | undefined;
    try {
      link = await IdeLink.start({
        folders: [t.ws],
        presenter: new FakePresenter(),
        diagnostics: new FakeDiagnostics(),
        logger: new MemLogger(),
      });
      const c = await Client.open(link.socketPath, link.token);
      await c.handshake();
      c.send(openDiff(3, path.join(t.ws, "a.md"), "b\n"));
      await c.call(toolCall(4, "getDiagnostics", {}));
      await c.call(toolCall(5, "closeAllDiffTabs", {}));
      c.end();
      await link.close();
      link = undefined;
    } finally {
      await link?.close();
      for (const [name, fn] of saved) cjsFs[name] = fn;
      syncBuiltinESMExports();
      process.env.HOME = env.HOME;
      if (env.CSC === undefined) delete process.env.CLAUDE_SANDBOX_SHARED_CONFIG;
      else process.env.CLAUDE_SANDBOX_SHARED_CONFIG = env.CSC;
    }
    assert.ok(seen.some((p) => p.startsWith(t.ws) || p.startsWith("/proc/self/fd/")), "the recorder saw fs calls");
    assert.deepEqual(
      seen.filter((p) => p.startsWith(cfg) || /\/\.claude(?![\w-])/.test(p)),
      [],
    );
    assert.deepEqual(snapshot(cfg), cfgBefore);
    t.cleanup();
  });

  it("no source names the config folder except the hook's in-jail path", () => {
    for (const f of sources(path.join(root, "src"))) {
      const text = fs.readFileSync(f, "utf8").replace(/\/\/.*$/gm, "");
      assert.doesNotMatch(text, /terminal-config|CLAUDE_SANDBOX_SHARED_CONFIG|homedir\(/, f);
      if (!f.endsWith("settings.ts")) assert.doesNotMatch(text, /\.claude(?![\w-])/, f);
    }
  });
});
