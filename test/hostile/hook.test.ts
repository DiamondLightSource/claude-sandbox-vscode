// Rule 7 end to end: the SessionStart hook, run here as Claude Code would run it in the jail
// (sh, its own HOME), starts socat (once), writes the lock file itself only once socat
// listens and never over another's, and Claude's TCP connection reaches our socket. The workspace's name is built to break out of the command if any
// character were not quoted.

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { IdeLink } from "../../src/link.ts";
import { lockJson, sessionEndCommand, sessionStartCommand } from "../../src/settings.ts";
import { Client } from "../helpers/client.ts";
import { startTestLink, tmpWorkspace, type Tmp } from "../helpers/fakes.ts";

const hasSocat = spawnSync("sh", ["-c", "command -v socat"]).status === 0;
const EVIL = "a'b $(touch PWNED1) `touch PWNED2` ;c,d:e\"f!x";

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

function findPwned(dir: string): string[] {
  return execFileSync("find", [dir, "-name", "PWNED*"]).toString().split("\n").filter(Boolean);
}

let t: Tmp;
let link: IdeLink | undefined;
let pids: string;
let shimPath: string;

/**
 * A `setsid` shim first on PATH that records its pid and execs its arguments in place (no new
 * session), so the pid recorded is socat's own and the test kills exactly the socat it
 * started, without pattern-matching other processes or losing one that setsid reparented.
 * `fakeSocat` puts a socat first on PATH that never listens.
 */
function shim(dir: string, fakeSocat = false): string {
  const bin = path.join(dir, fakeSocat ? "shim-fake" : "shim-bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "setsid"), `#!/bin/sh\necho $$ >>'${pids}'\nexec "$@"\n`, { mode: 0o755 });
  if (fakeSocat) fs.writeFileSync(path.join(bin, "socat"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`;
}

function started(): string[] {
  return fs.existsSync(pids) ? fs.readFileSync(pids, "utf8").split("\n").filter(Boolean) : [];
}

function run(command: string, env: Record<string, string>): { status: number | null; stdout: string; stderr: string } {
  return spawnSync("sh", ["-c", command], { cwd: t.dir, env, encoding: "utf8", timeout: 15000 });
}

function hookCommand(event: "SessionStart" | "SessionEnd"): { matcher: string; command: string } {
  const h = link!.settings.hooks[event][0] as { matcher: string; hooks: { command: string }[] };
  return { matcher: h.matcher, command: h.hooks[0]!.command };
}

async function startLink(folder: string, port: number): Promise<IdeLink> {
  return startTestLink(folder, { pickPort: () => port });
}

beforeEach(() => {
  t = tmpWorkspace();
  pids = path.join(t.dir, "socat.pids");
  shimPath = shim(t.dir);
});
afterEach(async () => {
  await link?.close();
  link = undefined;
  for (const pid of started()) {
    try {
      process.kill(Number(pid), "SIGKILL");
    } catch {
      // already gone
    }
  }
  t.cleanup();
});

describe("rule 7: the in-jail hook writes the lock", { skip: hasSocat ? false : "needs socat" }, () => {
  it("relays TCP to the socket, writes a 0600 lock once socat listens, and removes it at SessionEnd", async () => {
    const weird = path.join(t.dir, EVIL);
    fs.mkdirSync(weird);
    const port = await freePort();
    link = await startLink(weird, port);
    const home = path.join(t.dir, "home");
    fs.mkdirSync(home);
    const env = { PATH: shimPath, HOME: home };
    const r = run(hookCommand("SessionStart").command, env);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "", "a SessionStart hook's stdout would reach the model");
    const lock = path.join(home, ".claude", "ide", `${port}.lock`);
    assert.equal(fs.statSync(lock).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(lock, "utf8"), lockJson(port, link.token, [weird]));
    assert.deepEqual(JSON.parse(fs.readFileSync(lock, "utf8")).workspaceFolders, [weird]);
    assert.deepEqual(fs.readdirSync(path.join(home, ".claude", "ide")), [`${port}.lock`], "no temp file left");
    assert.deepEqual(findPwned(t.dir), [], "nothing in the path ran");

    const c = await Client.open(port, JSON.parse(fs.readFileSync(lock, "utf8")).authToken);
    assert.equal(c.status, 101);
    const [init] = await c.handshake();
    assert.equal((init?.result as { serverInfo: { name: string } }).serverInfo.name, "claude-sandbox-vscode");
    assert.equal(link.bridge.state, "connected");
    c.end();

    const end = run(hookCommand("SessionEnd").command, env);
    assert.equal(end.status, 0);
    assert.equal(end.stdout, "");
    assert.ok(!fs.existsSync(lock));
    assert.deepEqual(findPwned(t.dir), [], "nothing in the path ran");
  });

  it("is idempotent (/resume, fork): one socat, the lock rewritten only if missing", async () => {
    const port = await freePort();
    link = await startLink(t.ws, port);
    const env = { PATH: shimPath, HOME: path.join(t.dir, "home") };
    const lock = path.join(t.dir, "home", ".claude", "ide", `${port}.lock`);
    assert.equal(run(hookCommand("SessionStart").command, env).status, 0);
    assert.equal(started().length, 1);
    const r = run(hookCommand("SessionStart").command, env);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
    assert.equal(started().length, 1, "socat already listens: no second one");
    fs.unlinkSync(lock);
    assert.equal(run(hookCommand("SessionStart").command, env).status, 0);
    assert.equal(started().length, 1);
    assert.equal(fs.readFileSync(lock, "utf8"), lockJson(port, link.token, [t.ws]));
  });

  it("leaves a lock that is not ours, and SessionEnd does not remove it", async () => {
    const port = await freePort();
    link = await startLink(t.ws, port);
    const env = { PATH: shimPath, HOME: path.join(t.dir, "home") };
    const dir = path.join(t.dir, "home", ".claude", "ide");
    fs.mkdirSync(dir, { recursive: true });
    const lock = path.join(dir, `${port}.lock`);
    fs.writeFileSync(lock, '{"another":"devcontainer"}');
    const r = run(hookCommand("SessionStart").command, env);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
    assert.equal(fs.readFileSync(lock, "utf8"), '{"another":"devcontainer"}');
    assert.deepEqual(fs.readdirSync(dir), [`${port}.lock`], "no temp file left");
    assert.equal(run(hookCommand("SessionEnd").command, env).status, 0);
    assert.equal(fs.readFileSync(lock, "utf8"), '{"another":"devcontainer"}');
  });

  it("writes no lock when socat never listens, and exits 0 silently", async () => {
    const port = await freePort();
    const home = path.join(t.dir, "home");
    const cmd = sessionStartCommand(port, "f".repeat(64), path.join(t.ws, "s.sock"), [t.ws], 3);
    const r = run(cmd, { PATH: shim(t.dir, true), HOME: home });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
    assert.equal(started().length, 1, "the (fake) socat was started");
    assert.ok(!fs.existsSync(path.join(home, ".claude", "ide", `${port}.lock`)));
  });

  it("CLAUDE_CONFIG_DIR in the jail is honoured", async () => {
    const cfg = path.join(t.dir, "cfg");
    const port = await freePort();
    const cmd = sessionStartCommand(port, "f".repeat(64), "/nonexistent/s.sock", ["/w"]);
    const r = run(cmd, { PATH: shimPath, HOME: "/nonexistent", CLAUDE_CONFIG_DIR: cfg });
    assert.equal(r.status, 0);
    assert.ok(fs.existsSync(path.join(cfg, "ide", `${port}.lock`)));
  });
});

describe("rule 7: the hooks run only when they should", () => {
  it("SessionStart on startup, resume and fork; SessionEnd on real exits only (not clear or resume)", async () => {
    link = await startLink(t.ws, await freePort());
    const start = hookCommand("SessionStart").matcher.split("|");
    const end = hookCommand("SessionEnd").matcher.split("|");
    assert.deepEqual(start, ["startup", "resume", "fork"]);
    assert.deepEqual(end, ["logout", "prompt_input_exit", "other"]);
    assert.ok(!end.includes("clear") && !end.includes("resume"));
  });
});

describe("rule 7: SessionEnd removes only a lock that is ours, byte for byte", () => {
  const PORT = 23457;
  const TOKEN = "e".repeat(64);
  const ours = (): string => lockJson(PORT, TOKEN, [t.ws]);
  function end(): { status: number | null; stdout: string; stderr: string; ms: number } {
    const t0 = Date.now();
    const r = run(sessionEndCommand(PORT, TOKEN, [t.ws]), { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: path.join(t.dir, "home") });
    return { ...r, ms: Date.now() - t0 };
  }
  function lockPath(): string {
    const dir = path.join(t.dir, "home", ".claude", "ide");
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${PORT}.lock`);
  }
  function silent(r: { status: number | null; stdout: string; stderr: string }): void {
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, "", "the hook prints nothing on stderr either");
  }

  it("removes ours", () => {
    const f = lockPath();
    fs.writeFileSync(f, ours());
    silent(end());
    assert.ok(!fs.existsSync(f));
  });

  it("keeps ours with a trailing newline, a NUL, a byte changed, a prefix or a suffix", () => {
    const f = lockPath();
    const o = ours();
    for (const v of [o + "\n", o + "\n\n", o.slice(0, 10) + "\0" + o.slice(10), "X" + o.slice(1), o.slice(0, -1), o + "x"]) {
      fs.writeFileSync(f, v);
      silent(end());
      assert.equal(fs.readFileSync(f, "utf8"), v, JSON.stringify(v.slice(-3)));
    }
  });

  it("does not block on a FIFO planted at the lock, and leaves it", () => {
    const f = lockPath();
    execFileSync("mkfifo", [f]);
    const r = end();
    silent(r);
    assert.ok(r.ms < 5000, `took ${r.ms} ms`);
    assert.ok(fs.lstatSync(f).isFIFO());
  });

  it("leaves a symlink to a copy of ours, and its target", () => {
    const f = lockPath();
    const target = path.join(t.dir, "copy.lock");
    fs.writeFileSync(target, ours());
    fs.symlinkSync(target, f);
    silent(end());
    assert.ok(fs.lstatSync(f).isSymbolicLink());
    assert.equal(fs.readFileSync(target, "utf8"), ours());
  });

  it("leaves a huge file without reading it whole, and is silent when there is no lock or no folder", () => {
    const f = lockPath();
    fs.writeFileSync(f, ours() + "x".repeat(64 * 1024 * 1024));
    silent(end());
    assert.ok(fs.existsSync(f));
    fs.unlinkSync(f);
    silent(end());
    fs.rmSync(path.join(t.dir, "home"), { recursive: true });
    fs.writeFileSync(path.join(t.dir, "home"), "not a folder");
    silent(end());
  });
});

describe("rule 7: SessionStart prints nothing on stderr when the lock folder cannot be made", () => {
  it("exits 0 silently", async () => {
    // something listens already (so no socat is started), then mkdir fails
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as net.AddressInfo).port;
    const home = path.join(t.dir, "home");
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", "ide"), "a file where the folder should be");
    const cmd = sessionStartCommand(port, "f".repeat(64), path.join(t.ws, "s.sock"), [t.ws], 3);
    const r = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      // asynchronously: the listener above must keep accepting while the hook runs
      const child = spawn("sh", ["-c", cmd], { cwd: t.dir, env: { PATH: shim(t.dir, true), HOME: home } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
    server.close();
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, "");
    assert.equal(started().length, 0, "no socat: something listened already");
  });
});
