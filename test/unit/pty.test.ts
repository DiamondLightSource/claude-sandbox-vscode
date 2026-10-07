import assert from "node:assert/strict";
import * as fs from "node:fs";
import { describe, it } from "node:test";
import { PtyProcess } from "../../src/pty.ts";
import { clampDim, CLAUDE, DIM_MAX, helperArgs, PTY_HELPER, PYTHON, resizeLine } from "../../src/ptyHelper.ts";

// claude-sandbox's interpreter when it is installed (the devcontainer), else the system's (CI)
const python = fs.existsSync(PYTHON) ? PYTHON : "python3";

interface Run {
  p: PtyProcess;
  out: () => string;
  exit: Promise<number>;
  until: (re: RegExp, ms?: number) => Promise<void>;
}

function run(program: string, args: string[], cols = 80, rows = 24): Run {
  let out = "";
  let exited: (c: number) => void = () => undefined;
  const exit = new Promise<number>((r) => (exited = r));
  const errors: string[] = [];
  const p = new PtyProcess(
    { program, args, cwd: "/", env: { PATH: process.env.PATH, TERM: "dumb" }, cols, rows, python },
    { onData: (t) => (out += t), onExit: (c) => exited(c), onError: (e) => errors.push(e) },
  );
  const until = async (re: RegExp, ms = 5000): Promise<void> => {
    const end = Date.now() + ms;
    while (!re.test(out)) {
      if (Date.now() > end) {
        p.kill();
        throw new Error(`timed out waiting for ${re}: ${JSON.stringify(out)} ${errors.join("")}`);
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  return { p, out: () => out, exit, until };
}

describe("rule 9: the pty relay", () => {
  it("argv is constant but for the size and Claude's arguments; the interpreter is isolated (-I)", () => {
    const a = helperArgs(120, 40, CLAUDE, ["--settings", "{}"]);
    assert.deepEqual(a, ["-I", "-c", PTY_HELPER, "120", "40", CLAUDE, "--settings", "{}"]);
    assert.equal(PYTHON, "/usr/libexec/claude-sandbox/venv/bin/python");
    assert.deepEqual(helperArgs(0, 1e9, "/p", []).slice(3, 5), ["1", String(DIM_MAX)]);
    assert.equal(clampDim(NaN), 1);
    assert.equal(resizeLine(80.7, -3), "80 1\n");
  });

  it("the program gets the pty as its controlling terminal, at the size given, and no fd of ours", async () => {
    const fds = "for f in 3 4 5 6 7 8 9; do if { true >&$f; } 2>/dev/null; then echo open$f; fi; done; echo fds-done";
    const r = run("/bin/sh", ["-c", `stty size; tty; [ -t 0 ] && echo stdin-tty; ${fds}`], 100, 30);
    assert.equal(await r.exit, 0);
    assert.match(r.out(), /^30 100\r\n\/dev\/pts\/\d+\r\nstdin-tty\r\nfds-done\r\n$/);
  });

  it("arguments are words, never shell text", async () => {
    const r = run("/bin/echo", ["$(id)", "a;b", "|x"]);
    assert.equal(await r.exit, 0);
    assert.equal(r.out(), "$(id) a;b |x\r\n");
  });

  it("keys pass through (UTF-8 too)", async () => {
    const r = run("/bin/sh", ["-c", "echo ready; while read -r x; do echo got=$x; done"]);
    await r.until(/ready/);
    r.p.write("héllo ❯\r");
    await r.until(/got=héllo ❯/);
    r.p.write("\x04");
    assert.equal(await r.exit, 0);
  });

  it("resizes reach the program as SIGWINCH; bad resize lines are ignored", async () => {
    const r = run("/bin/bash", ["-c", "trap 'echo WINCH $(stty size)' WINCH; echo ready; while :; do sleep 0.05; done"]);
    await r.until(/ready/);
    (r.p as unknown as { ctl: { write(s: string): void } }).ctl.write("x y\n0 0\n99999 3\n\n");
    r.p.resize(132, 43);
    await r.until(/WINCH 43 132/);
    assert.doesNotMatch(r.out(), /WINCH (?!43 132)/);
    r.p.write("\x03");
    assert.equal(await r.exit, 130);
  });

  it("Ctrl-C is a SIGINT for the program; its exit status comes back (128 + n for a signal)", async () => {
    const a = run("/bin/sh", ["-c", "echo ready; sleep 30"]);
    await a.until(/ready/);
    a.p.write("\x03");
    assert.equal(await a.exit, 130);
    const b = run("/bin/sh", ["-c", "exit 7"]);
    assert.equal(await b.exit, 7);
  });

  it("output written just before exit is not lost", async () => {
    const r = run("/bin/sh", ["-c", "i=0; while [ $i -lt 2000 ]; do echo line$i; i=$((i+1)); done; exit 3"]);
    assert.equal(await r.exit, 3);
    assert.match(r.out(), /line1999\r\n$/);
  });

  it("kill(): the helper hangs up the session (SIGHUP), and its processes go", async () => {
    const r = run("/bin/sh", ["-c", "echo $$; echo ready; sleep 60"]);
    await r.until(/ready/);
    const pid = Number(/^(\d+)/.exec(r.out())![1]);
    const t0 = Date.now();
    r.p.kill();
    assert.equal(await r.exit, 129);
    assert.ok(Date.now() - t0 < 3000);
    assert.throws(() => process.kill(pid, 0));
  });

  it("a program that cannot be run: 127, with the reason on the terminal", async () => {
    const r = run("/nonexistent/claude", []);
    assert.equal(await r.exit, 127);
    assert.match(r.out(), /cannot run '\/nonexistent\/claude'/);
  });
});
