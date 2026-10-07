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
  installArgv,
  installState,
  isShadow,
  outdated,
  parseVersionOutput,
  pypiLatest,
  SHADOW_MARK,
  SUDO,
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
    assert.equal(isShadow("#!/bin/sh\nexec /root/.local/bin/claude \"$@\"\n"), false);
    assert.equal(isShadow("\x7fELF..." + SHADOW_MARK), false, "a binary is not the shim");
  });
  it("installState: the shim, the CLI and the interpreter, read without blocking on a FIFO", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "csv-install-"));
    try {
      const shim = path.join(d, "claude");
      const cli = path.join(d, "claude-sandbox");
      assert.match(installState("/bin/sh", "/bin/sh", path.join(d, "python")).why ?? "", /^\/bin\/sh is not claude-sandbox's/);
      fs.writeFileSync(shim, SHIM);
      fs.writeFileSync(cli, "#!/bin/sh\n", { mode: 0o755 });
      assert.match(installState(shim, cli, path.join(d, "python")).why!, /python is missing/, "a missing interpreter is not installed");
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
  it("the command is fixed: uvx --no-cache claude-sandbox@latest install, through sudo unless root", () => {
    assert.deepEqual(installArgv(0, "/usr/bin/uvx"), ["/usr/bin/uvx", "--no-cache", "claude-sandbox@latest", "install"]);
    assert.deepEqual(installArgv(1000, "/usr/bin/uvx"), [SUDO, "/usr/bin/uvx", "--no-cache", "claude-sandbox@latest", "install"]);
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
