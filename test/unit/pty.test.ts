import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { FLUSH_MS, OutputBatcher, PtyProcess } from "../../src/pty.ts";
import { PromptWatcher } from "../../src/prompt.ts";
import { clampDim, CLAUDE, DIM_MAX, helperArgs, PTY_HELPER, PYTHON, resizeLine } from "../../src/ptyHelper.ts";

// claude-sandbox's interpreter when it is installed (the devcontainer), else the system's (CI),
// by absolute path: the relay runs programs by path, never through PATH
const python = fs.existsSync(PYTHON)
  ? PYTHON
  : (["/usr/bin/python3", "/usr/local/bin/python3"].find((p) => fs.existsSync(p)) ?? "/usr/bin/python3");

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

  it("a slow reader of the output holds up neither keys nor resizes (the relay never blocks)", async () => {
    // the program floods its output and records, in a file, the keys and resizes it gets; the
    // extension stops reading the output meanwhile (as a busy extension host would)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csv-pty-"));
    const log = path.join(dir, "log");
    const prog = [
      "import os, signal, sys, threading, tty",
      "tty.setraw(0)",
      // unbuffered: the signal handler may run in the middle of another write
      `f = os.open(${JSON.stringify(log)}, os.O_WRONLY | os.O_APPEND | os.O_CREAT)`,
      "signal.signal(signal.SIGWINCH, lambda *a: os.write(f, b'winch\\n'))",
      "def flood():",
      "    line = ('\\x1b[H' + 'x' * 4000).encode()",
      "    while True: os.write(1, line)",
      "threading.Thread(target=flood, daemon=True).start()",
      "while True:",
      "    d = os.read(0, 65536)",
      "    os.write(f, b'keys %d\\n' % len(d))",
      "    if b'q' in d: sys.exit(0)",
    ].join("\n");
    const r = run(python, ["-c", prog]);
    const stdout = (r.p as unknown as { child: { stdout: { pause(): void; resume(): void } } }).child.stdout;
    try {
      await r.until(/xxxx/);
      stdout.pause();
      await new Promise((res) => setTimeout(res, 300)); // the relay's buffer and the pipe fill
      r.p.write("a".repeat(100_000));
      r.p.resize(90, 20);
      const end = Date.now() + 3000;
      const seen = (): string => (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "");
      while (!(/winch/.test(seen()) && /keys/.test(seen())) && Date.now() < end) await new Promise((res) => setTimeout(res, 50));
      assert.match(seen(), /keys \d+/, "keys reached the program while its output was not being read");
      assert.match(seen(), /winch/, "the resize reached the program too");
      stdout.resume();
      r.p.write("q");
      assert.equal(await r.exit, 0);
    } finally {
      stdout.resume(); // a relay that blocked on its output would not even see the hang-up
      r.p.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a program that cannot be run: 127, with the reason on the terminal", async () => {
    const r = run("/nonexistent/claude", []);
    assert.equal(await r.exit, 127);
    assert.match(r.out(), /cannot run '\/nonexistent\/claude'/);
  });
  it("a missing interpreter is explained on the terminal, not only as exit 127", async () => {
    let out = "";
    const code = await new Promise<number>((res) => {
      new PtyProcess(
        { program: "/bin/true", args: [], cwd: "/", env: {}, cols: 80, rows: 24, python: "/nonexistent/venv/bin/python" },
        { onData: (t) => (out += t), onExit: res },
      );
    });
    assert.equal(code, 127);
    assert.match(out, /\/nonexistent\/venv\/bin\/python is missing\. Is claude-sandbox installed/);
  });

  it("under a flood of redraws, with input bursts, resizes and a stalling host at once, nothing locks up", async () => {
    // a TUI-like program: one thread redraws a full screen as fast as it can, the main one counts
    // the keys it gets and records each SIGWINCH's size; the extension side feeds every chunk to
    // the prompt watcher (as the terminal does), throws once from its output handler, and stalls
    // its event loop now and then (a busy extension host)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csv-pty-"));
    const log = path.join(dir, "log");
    const prog = String.raw`
import fcntl, os, signal, struct, sys, termios, threading, tty
tty.setraw(0)
f = os.open(sys.argv[1], os.O_WRONLY | os.O_APPEND | os.O_CREAT)  # unbuffered: the handler may run mid-write
def winch(*a):
    r, c = struct.unpack("HHHH", fcntl.ioctl(0, termios.TIOCGWINSZ, b"\0" * 8))[:2]
    os.write(f, b"size %d %d\n" % (c, r))
signal.signal(signal.SIGWINCH, winch)
def flood():
    n = 0
    while True:
        n += 1
        rows = "".join("\x1b[%d;1H\x1b[38;5;%dm row %d frame %d \u2500\u276f \u6f22\x1b[K" % (r + 1, r, r, n) for r in range(30))
        os.write(1, ("\x1b[?25l" + rows + "\x1b[?25h").encode())
threading.Thread(target=flood, daemon=True).start()
got = 0
while True:
    d = os.read(0, 65536)
    got += len(d)
    os.write(f, b"keys %d\n" % got)
    if d.endswith(b"q"):
        sys.exit(0)
`;
    const watcher = new PromptWatcher(80, 24);
    let chunks = 0;
    let threw = false;
    const errors: string[] = [];
    let exited: (c: number) => void = () => undefined;
    const exit = new Promise<number>((r) => (exited = r));
    const p = new PtyProcess(
      { program: python, args: ["-c", prog, log], cwd: "/", env: { PATH: process.env.PATH, TERM: "xterm-256color" }, cols: 80, rows: 24, python },
      {
        onData: (t) => {
          chunks++;
          watcher.feed(t, Date.now());
          if (!threw) {
            threw = true;
            throw new Error("a fault in the output path");
          }
        },
        onExit: (c) => exited(c),
        onError: (e) => errors.push(e),
      },
    );
    const seen = (): string => (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "");
    const spin = (ms: number): void => {
      const end = Date.now() + ms;
      while (Date.now() < end);
    };
    try {
      // the program is drawing (so raw mode is set: setting it discards unread input)
      for (let i = 0; i < 250 && chunks === 0; i++) await new Promise((r) => setTimeout(r, 20));
      const burst = "a".repeat(64 * 1024);
      let sent = 0;
      for (let i = 0; i < 40; i++) {
        p.write(burst);
        sent += burst.length;
        p.resize(60 + i, 20 + (i % 10));
        if (i % 8 === 0) spin(150);
        await new Promise((r) => setTimeout(r, 10));
      }
      p.resize(132, 43);
      p.write("q");
      sent += 1;
      let timer: NodeJS.Timeout | undefined;
      const code = await Promise.race([exit, new Promise<number>((r) => (timer = setTimeout(() => r(-1), 20_000)))]);
      clearTimeout(timer);
      assert.equal(code, 0, "the program got every key and exited");
      assert.match(seen(), new RegExp(`keys ${sent}\\n`), "every byte of input arrived");
      assert.match(seen(), /size 132 43\n/, "the last resize arrived");
      assert.ok(chunks > 10, "output kept flowing");
      assert.ok(errors.some((e) => /output handler failed: Error: a fault in the output path/.test(e)), "the fault was reported");
      assert.equal(watcher.screen.cols, 80, "the watcher is sized by the terminal, not by the program");
    } finally {
      p.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("terminal writes are coalesced", () => {
  it("many small reads become one write per FLUSH_MS (about 16 ms), in order, nothing lost", async () => {
    assert.ok(FLUSH_MS >= 8 && FLUSH_MS <= 20);
    const writes: string[] = [];
    const b = new OutputBatcher((t) => writes.push(t), () => undefined, 30);
    let want = "";
    for (let i = 0; i < 10_000; i++) {
      const c = `\x1b[${i % 30};1H${i}`;
      b.push(c);
      want += c;
    }
    assert.equal(writes.length, 0, "nothing written synchronously");
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(writes.length, 1);
    assert.equal(writes[0], want);
    b.push("tail");
    b.flush(); // at exit
    assert.deepEqual(writes.slice(1), ["tail"]);
    b.flush();
    assert.equal(writes.length, 2, "an empty flush writes nothing");
  });
  it("a throwing sink is reported and later batches still go out", async () => {
    const errs: unknown[] = [];
    const got: string[] = [];
    let first = true;
    const b = new OutputBatcher(
      (t) => {
        if (first) {
          first = false;
          throw new Error("boom");
        }
        got.push(t);
      },
      (e) => errs.push(e),
      1,
    );
    b.push("a");
    await new Promise((r) => setTimeout(r, 10));
    b.push("b");
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(errs.length, 1);
    assert.deepEqual(got, ["b"]);
    b.push("c");
    b.dispose();
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(got, ["b"], "nothing after dispose");
  });
});
