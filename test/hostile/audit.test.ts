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
import { snapshot, tmpWorkspace, tsFiles } from "../helpers/fakes.ts";
import { startTestLink } from "../helpers/link.ts";

const root = path.resolve(import.meta.dirname, "..", "..");

describe("rule 3: no code path writes a file", () => {
  it("src/ uses no write or delete API (libuv alone unlinks our socket when it closes)", () => {
    const write =
      /\bfs\.(write|writeSync|writeFile|writeFileSync|appendFile\w*|createWriteStream|rename\w*|copyFile\w*|cp\w*|truncate\w*|chmod\w*|chown\w*|lchown\w*|mkdir\w*|mkdtemp\w*|rm|rmSync|rmdir\w*|symlink\w*|link|linkSync|unlink|unlinkSync|utimes\w*)\b|O_WRONLY|O_RDWR|O_CREAT|O_TRUNC|O_APPEND|workspace\.fs\.(?!stat\()|applyEdit|WorkspaceEdit/;
    const hits: string[] = [];
    for (const f of tsFiles(path.join(root, "src"))) {
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
    const hits = tsFiles(path.join(root, "src")).flatMap((f) =>
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
    for (const f of tsFiles(path.join(root, "src"))) {
      for (const m of fs.readFileSync(f, "utf8").matchAll(/from "([^"]+)"/g)) {
        assert.ok(/^(node:|\.|vscode$)/.test(m[1]!), `${f} imports ${m[1]}`);
      }
    }
  });
});

describe("rules 6, 9, 10: the processes the extension starts", () => {
  const read = (f: string): string => fs.readFileSync(path.join(root, f), "utf8");
  it("child_process only in the pty relay and the version check, with constant programs", () => {
    const users = tsFiles(path.join(root, "src"))
      .filter((f) => /child_process/.test(fs.readFileSync(f, "utf8").replace(/\/\/.*$/gm, "")))
      .map((f) => path.relative(root, f))
      .sort();
    assert.deepEqual(users, ["src/install.ts", "src/pty.ts", "src/vscode/installOffer.ts"].filter((f) => f !== "src/install.ts"));
    // the relay: the root-owned interpreter (a test seam aside), never a shell
    assert.match(read("src/pty.ts"), /spawn\(o\.python \?\? PYTHON, helperArgs\(/);
    assert.match(read("src/pty.ts"), /shell: false/);
    assert.match(read("src/ptyHelper.ts"), /export const PYTHON = "\/usr\/libexec\/claude-sandbox\/venv\/bin\/python";/);
    assert.match(read("src/ptyHelper.ts"), /export const CLAUDE = "\/usr\/local\/bin\/claude";/);
    // the version check: claude-sandbox by absolute path
    assert.match(read("src/vscode/installOffer.ts"), /execFile\(CLAUDE_SANDBOX, \["version"\]/);
    assert.match(read("src/install.ts"), /export const CLAUDE_SANDBOX = "\/usr\/local\/bin\/claude-sandbox";/);
  });

  it("terminals: the session's pty relay and the install's constant command; nothing typed into a shell", () => {
    const hits = tsFiles(path.join(root, "src")).flatMap((f) =>
      fs
        .readFileSync(f, "utf8")
        .split("\n")
        .filter((l) => /createTerminal\(|(?<!ws)\.sendText\(|shellPath|shellArgs/.test(l.replace(/\/\/.*$/, "")))
        .map((l) => `${path.basename(f)}: ${l.trim()}`),
    );
    assert.deepEqual(hits, [
      "installOffer.ts: const term = vscode.window.createTerminal({",
      'installOffer.ts: shellPath: "/bin/sh",',
      'installOffer.ts: shellArgs: ["-c", INSTALL_SCRIPT, "sh", ...argv],',
      "terminal.ts: this.terminal = vscode.window.createTerminal({",
    ]);
    // the session's terminal is a Pseudoterminal running CLAUDE through the relay
    assert.match(read("src/vscode/terminal.ts"), /program: CLAUDE,/);
    assert.match(read("src/vscode/terminal.ts"), /\n\s+pty,\n/);
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
      link = await startTestLink(t.ws);
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
    for (const f of tsFiles(path.join(root, "src"))) {
      const text = fs.readFileSync(f, "utf8").replace(/\/\/.*$/gm, "");
      assert.doesNotMatch(text, /terminal-config|CLAUDE_SANDBOX_SHARED_CONFIG|homedir\(/, f);
      if (!f.endsWith("settings.ts")) assert.doesNotMatch(text, /\.claude(?![\w-])/, f);
    }
  });
});
