import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  compareVersions,
  findUvx,
  INSTALL_SCRIPT,
  INSTALL_VERSION,
  installArgv,
  installState,
  isPre,
  isShadow,
  MIN_VERSION,
  outdated,
  parseVersionOutput,
  pypiLatest,
  REQUIREMENT,
  SHADOW_MARK,
  SUDO,
  tooOld,
  uvxCandidates,
} from "../../src/install.ts";

// /usr/local/bin/claude as claude-sandbox 5.0 installs it
const SHIM = `#!/bin/bash
# /usr/local/bin/claude (and codex, pi): hand off to the root-owned install.
exec /usr/libexec/claude-sandbox/venv/bin/python -I -m claude_sandbox _shadow "\${0##*/}" -- "$@"
`;

describe("rule 10: the install offer", () => {
  it("knows the shadow shim (and nothing else) for claude-sandbox's", () => {
    assert.equal(isShadow(SHIM), true);
    assert.equal(isShadow('#!/bin/sh\nexec /root/.local/bin/claude "$@"\n'), false);
    assert.equal(isShadow("\x7fELF..." + SHADOW_MARK), false, "a binary is not the shim");
  });
  it("installState: the shim, the CLI and the interpreter, read without blocking on a FIFO", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "csv-install-"));
    try {
      const shim = path.join(d, "claude");
      const cli = path.join(d, "claude-sandbox");
      assert.match(
        installState("/bin/sh", "/bin/sh", path.join(d, "python")).why ?? "",
        /^\/bin\/sh is not claude-sandbox's/,
      );
      fs.writeFileSync(shim, SHIM);
      fs.writeFileSync(cli, "#!/bin/sh\n", { mode: 0o755 });
      assert.match(
        installState(shim, cli, path.join(d, "python")).why!,
        /python is missing/,
        "a missing interpreter is not installed",
      );
      fs.rmSync(shim);
      fs.rmSync(cli);
      assert.equal(installState(shim, cli).installed, false);
      fs.writeFileSync(shim, SHIM);
      assert.match(installState(shim, cli).why!, /claude-sandbox is missing/);
      fs.writeFileSync(cli, "#!/bin/sh\n", { mode: 0o755 });
      assert.deepEqual(installState(shim, cli, "/bin/sh"), { installed: true });
      fs.writeFileSync(shim, "#!/bin/sh\nexec real-claude\n");
      assert.match(installState(shim, cli).why!, /not claude-sandbox's/);
      fs.rmSync(shim);
      execFileSync("mkfifo", [shim]);
      assert.match(installState(shim, cli).why!, /not a file/);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
  it("the command is fixed: uvx --no-cache --from 'claude-sandbox>=INSTALL' claude-sandbox install --minimal, through sudo unless root", () => {
    const cmd = [
      "/usr/bin/uvx",
      "--no-cache",
      "--from",
      "claude-sandbox>=5.1.0",
      "claude-sandbox",
      "install",
      "--minimal",
    ];
    assert.deepEqual(installArgv(0, "/usr/bin/uvx"), cmd);
    assert.deepEqual(installArgv(1000, "/usr/bin/uvx"), [SUDO, ...cmd]);
    assert.equal(REQUIREMENT, `claude-sandbox>=${INSTALL_VERSION}`);
    assert.equal(isPre(MIN_VERSION), false, "a stable floor");
    assert.notEqual(
      compareVersions(INSTALL_VERSION, MIN_VERSION),
      -1,
      "the install floor is not below the works-with floor",
    );
  });
  it("a claude-sandbox older than MIN_VERSION is too old", () => {
    assert.equal(tooOld("4.7.1"), true);
    assert.equal(tooOld("4.8.0-beta.2"), true);
    assert.equal(tooOld("5.0.0-beta.2"), true);
    assert.equal(tooOld("5.0.0-beta.3"), true);
    assert.equal(tooOld("5.0.0"), false);
    assert.equal(tooOld("weird"), false, "unknown: not called too old");
  });
  it("the devcontainer's pinned claude-sandbox is not older than MIN_VERSION", () => {
    const root = path.resolve(import.meta.dirname, "..", "..");
    const script = fs.readFileSync(path.join(root, ".devcontainer", "postCreate.sh"), "utf8");
    const version = /uvx claude-sandbox==(\S+) install/.exec(script)?.[1];
    assert.ok(version, "postCreate.sh pins claude-sandbox");
    assert.notEqual(compareVersions(version, MIN_VERSION), null, `${version} is a version`);
    assert.equal(tooOld(version), false);
  });
  it("uvx only from fixed places the jail cannot write, never PATH or ~/.local/bin", () => {
    assert.deepEqual(uvxCandidates("/home/me"), ["/usr/local/bin/uvx", "/usr/bin/uvx", "/home/me/.cargo/bin/uvx"]);
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "csv-uvx-"));
    try {
      const [a, b, c] = ["a", "b", "c"].map((n) => path.join(d, n));
      for (const x of [a, b, c]) fs.mkdirSync(x!);
      const uid = process.getuid!();
      const cands = [path.join(a!, "uvx"), path.join(b!, "uvx")];
      assert.equal(findUvx(cands, uid), null, "none there");
      fs.writeFileSync(path.join(c!, "uvx"), "#!/bin/sh\n", { mode: 0o755 });
      fs.symlinkSync(path.join(c!, "uvx"), cands[0]!);
      assert.equal(findUvx(cands, uid), null, "a symlink out of the fixed folders");
      fs.writeFileSync(cands[1]!, "#!/bin/sh\n", { mode: 0o755 });
      fs.chmodSync(cands[1]!, 0o777);
      assert.equal(findUvx(cands, uid), null, "writable by others");
      fs.chmodSync(cands[1]!, 0o755);
      assert.equal(findUvx(cands, uid), fs.realpathSync(cands[1]!));
      assert.equal(findUvx(cands, uid + 1), uid === 0 ? fs.realpathSync(cands[1]!) : null, "owned by someone else");
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
  it("the visible terminal's script runs its arguments as words, never as shell text", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "csv-install-"));
    try {
      const marker = path.join(d, "pwned");
      const out = execFileSync("/bin/sh", ["-c", INSTALL_SCRIPT, "sh", "/bin/echo", `a; touch ${marker}`, "$(id)"], {
        input: "\n",
      }).toString();
      assert.match(out, new RegExp(`^a; touch ${marker} \\$\\(id\\)\\n`));
      assert.match(out, /exit 0/);
      assert.equal(fs.existsSync(marker), false);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("the outdated notice", () => {
  it("reads claude-sandbox version and PyPI's JSON", () => {
    assert.equal(parseVersionOutput("claude-sandbox 5.0.0-beta.2\n"), "5.0.0-beta.2");
    assert.equal(parseVersionOutput("something else"), null);
    assert.equal(pypiLatest({ info: { version: "5.0.1" } }), "5.0.1");
    assert.equal(pypiLatest(JSON.parse('{"__proto__": {"version": "9"}}')), null);
    assert.equal(pypiLatest({ info: { version: 5 } }), null);
  });
  it("a pre-release install is compared with the newest release, yanked ones left out", () => {
    const f = [{ yanked: false }];
    const json = {
      info: { version: "4.7.1" },
      releases: { "4.7.1": f, "5.0.0b1": f, "5.0.0b2": f, "5.0.0b3": [{ yanked: true }], "5.0.0b4": [], junk: f },
    };
    assert.equal(pypiLatest(json), "4.7.1", "stable install: info.version");
    assert.equal(pypiLatest(json, true), "5.0.0b2");
    assert.equal(pypiLatest({ info: { version: "5.1.0" }, releases: { "5.0.0b2": f } }, true), "5.1.0");
    assert.equal(pypiLatest(JSON.parse('{"releases": {"__proto__": [{}]}}'), true), null);
    assert.equal(isPre("5.0.0-beta.2"), true);
    assert.equal(isPre("5.0.0.dev1"), true);
    assert.equal(isPre("5.0.0"), false);
    assert.equal(isPre("5.0.0.post1"), false);
  });
  it("compares PEP 440 and semver-style versions", () => {
    assert.equal(compareVersions("5.0.0-beta.2", "5.0.0b2"), 0);
    assert.equal(compareVersions("5.0.0b2", "5.0.0"), -1);
    assert.equal(compareVersions("5.0.0rc1", "5.0.0b9"), 1);
    assert.equal(compareVersions("5.0", "5.0.0"), 0);
    assert.equal(compareVersions("5.0.0.dev3", "5.0.0a1"), -1);
    assert.equal(compareVersions("5.0.0.post1", "5.0.0"), 1);
    assert.equal(compareVersions("4.10.0", "4.9.9"), 1);
    assert.equal(compareVersions("1.0+local", "1.0"), 0);
    assert.equal(compareVersions("junk", "1.0"), null);
    assert.equal(outdated("5.0.0-beta.2", "5.0.0"), true);
    assert.equal(outdated("5.0.0", "5.0.0"), false);
    assert.equal(outdated("5.1.0", "5.0.0"), false);
    assert.equal(outdated("weird", "5.0.0"), false, "unknown: no notice");
  });
});
