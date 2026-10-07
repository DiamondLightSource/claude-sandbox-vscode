import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import {
  agentSettings,
  END_MATCHER,
  linkSettings,
  lockJson,
  mergeSettings,
  sessionEndCommand,
  sessionStartCommand,
  SettingsError,
  shellQuote,
  socatPath,
  START_MATCHER,
  withSettings,
} from "../../src/settings.ts";

const TOKEN = "0123456789abcdef".repeat(4);
const SOCK = "/w/.claude-sandbox-vscode-23456.sock";

describe("quoting", () => {
  it("shellQuote survives the shell unchanged", () => {
    for (const s of ["plain", "a'b", "$(touch x)", "`x`", 'a"b\\c', "; rm -rf /", "%s %n"]) {
      assert.equal(execFileSync("sh", ["-c", `printf '%s' ${shellQuote(s)}`]).toString(), s);
    }
  });
  it("socatPath escapes socat's address characters", () => {
    assert.equal(socatPath("/a,b:c d!'\"(x)[y]{z}\\"), "/a\\,b\\:c\\ d\\!\\'\\\"\\(x\\)\\[y\\]\\{z\\}\\\\");
  });
});

describe("hook commands", () => {
  it("lockJson holds exactly what Claude Code 2.1.292 accepts", () => {
    assert.deepEqual(JSON.parse(lockJson(23456, TOKEN, ["/w"])), {
      pid: 1,
      workspaceFolders: ["/w"],
      ideName: "Claude Sandbox for VS Code",
      transport: "ws",
      authToken: TOKEN,
    });
  });
  it("refuses a bad token, port or path (newline, NUL, control characters, relative)", () => {
    assert.throws(() => lockJson(23456, "zz", ["/w"]), SettingsError);
    assert.throws(() => lockJson(23456, TOKEN.toUpperCase(), ["/w"]), SettingsError);
    assert.throws(() => lockJson(23456, TOKEN + "'", ["/w"]), SettingsError);
    assert.throws(() => lockJson(80, TOKEN, ["/w"]), SettingsError);
    assert.throws(() => lockJson(1.5, TOKEN, ["/w"]), SettingsError);
    for (const p of ["/w\nx", "/w\0x", "/w\u001bx", "/w\rx", "w"]) {
      assert.throws(() => lockJson(23456, TOKEN, [p]), SettingsError, JSON.stringify(p));
      assert.throws(() => sessionStartCommand(23456, TOKEN, p, ["/w"]), SettingsError, JSON.stringify(p));
    }
  });
  it("the SessionStart command starts socat only if it is not listening, then writes the lock no-clobber", () => {
    const c = sessionStartCommand(23456, TOKEN, SOCK, ["/w"]);
    assert.match(c, /^exec >\/dev\/null 2>&1; if ! grep -q ' 0100007F:5BA0 00000000:0000 0A ' \/proc\/net\/tcp/);
    assert.match(c, /then \(setsid socat TCP4-LISTEN:23456,bind=127\.0\.0\.1,reuseaddr,fork 'UNIX-CONNECT:/);
    assert.match(c, /\[ "\$i" -ge 100 \] && exit 0/, "no lock when socat never listens");
    assert.ok(c.lastIndexOf("/proc/net/tcp") < c.indexOf("printf"), "the lock after socat listens");
    assert.match(c, /ln "\$t" "\$d\/23456\.lock"/, "a hard link: never over an existing lock");
    assert.doesNotMatch(c, /mv /);
    assert.match(c, /umask 077/);
    assert.equal(execFileSync("sh", ["-n", "-c", c]).toString(), "", "valid sh");
    assert.throws(() => sessionStartCommand(23456, TOKEN, SOCK, ["/w"], -1), SettingsError);
  });
  it("the SessionEnd command removes the lock only if it is ours", () => {
    const c = sessionEndCommand(23456, TOKEN, ["/w"]);
    assert.match(c, /f="\$\{CLAUDE_CONFIG_DIR:-\$HOME\/\.claude\}\/ide"\/23456\.lock/);
    assert.ok(c.includes(shellQuote(lockJson(23456, TOKEN, ["/w"]))));
    assert.equal(execFileSync("sh", ["-n", "-c", c]).toString(), "", "valid sh");
  });
  it("linkSettings: the port in env, our two hooks with their matchers", () => {
    const s = linkSettings(23456, TOKEN, SOCK, ["/w"]);
    assert.deepEqual(s.env, { CLAUDE_CODE_SSE_PORT: "23456" });
    assert.equal(s.hooks.SessionStart.length, 1);
    assert.equal(s.hooks.SessionEnd.length, 1);
    assert.equal((s.hooks.SessionStart[0] as { matcher: string }).matcher, START_MATCHER);
    assert.equal((s.hooks.SessionEnd[0] as { matcher: string }).matcher, END_MATCHER);
  });
});

describe("merging into the user's --settings", () => {
  const ours = linkSettings(23456, TOKEN, SOCK, ["/w"]);
  it("appends --settings when there is none", () => {
    const argv = withSettings(["claude-sandbox", "--verbose"], ours);
    assert.deepEqual(argv.slice(0, 3), ["claude-sandbox", "--verbose", "--settings"]);
    assert.deepEqual(JSON.parse(argv[3]!).env, { CLAUDE_CODE_SSE_PORT: "23456" });
  });
  it("merges into the last JSON --settings, ours after theirs, never a second --settings", () => {
    const theirs = { model: "haiku", env: { MINE: "1" }, hooks: { SessionStart: [{ hooks: [] }], Stop: [] } };
    const argv = withSettings(
      ["claude-sandbox", "--settings", "{}", "--x", `--settings=${JSON.stringify(theirs)}`, "--verbose"],
      ours,
    );
    assert.equal(argv.filter((a) => a.startsWith("--settings")).length, 2, "the earlier one is left as it was");
    assert.deepEqual(argv.slice(0, 4), ["claude-sandbox", "--settings", "{}", "--x"]);
    assert.equal(argv[6], "--verbose");
    const merged = JSON.parse(argv[5]!);
    assert.equal(merged.model, "haiku");
    assert.deepEqual(merged.env, { MINE: "1", CLAUDE_CODE_SSE_PORT: "23456" });
    assert.equal(merged.hooks.SessionStart.length, 2);
    assert.deepEqual(merged.hooks.SessionStart[0], { hooks: [] });
    assert.deepEqual(merged.hooks.Stop, []);
  });
  it("refuses a settings file rather than dropping it", () => {
    assert.throws(() => withSettings(["claude-sandbox", "--settings", "/home/me/s.json"], ours), SettingsError);
  });
  it("agentSettings finds the last one", () => {
    assert.equal(agentSettings(["x"]), null);
    assert.deepEqual(agentSettings(["x", "--settings", '{"a":1}']), { start: 1, end: 3, value: { a: 1 } });
    assert.equal(agentSettings(["x", "--settings=[1]"])?.value, null);
  });
  it("__proto__ and constructor in the user's JSON stay plain keys and pollute nothing", () => {
    const evil = '{"__proto__": {"polluted": 1}, "constructor": {"prototype": {"polluted": 2}}, "env": {"__proto__": {"polluted": 3}}, "hooks": {"__proto__": []}}';
    const merged = mergeSettings(JSON.parse(evil), ours);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal(Object.getPrototypeOf(merged), null);
    const out = JSON.parse(JSON.stringify(merged));
    assert.ok(Object.hasOwn(out, "__proto__"));
    assert.equal(out.env.CLAUDE_CODE_SSE_PORT, "23456");
    assert.ok(Object.hasOwn(out.env, "__proto__"));
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });
});
