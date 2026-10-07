import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  compareVersions,
  INSTALL_SCRIPT,
  installArgv,
  installState,
  isShadow,
  outdated,
  parseVersionOutput,
  pypiLatest,
  SHADOW_MARK,
  SUDO,
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
  it("installState: the shim and the CLI, read without blocking on a FIFO", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "csv-install-"));
    try {
      const shim = path.join(d, "claude");
      const cli = path.join(d, "claude-sandbox");
      assert.equal(installState(shim, cli).installed, false);
      fs.writeFileSync(shim, SHIM);
      assert.match(installState(shim, cli).why!, /claude-sandbox is missing/);
      fs.writeFileSync(cli, "#!/bin/sh\n", { mode: 0o755 });
      assert.deepEqual(installState(shim, cli), { installed: true });
      fs.writeFileSync(shim, "#!/bin/sh\nexec real-claude\n");
      assert.match(installState(shim, cli).why!, /not claude-sandbox's/);
      fs.rmSync(shim);
      execFileSync("mkfifo", [shim]);
      assert.match(installState(shim, cli).why!, /not a file/);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
  it("the command is fixed: uvx claude-sandbox install, through sudo unless root", () => {
    assert.deepEqual(installArgv(0, "/usr/bin/uvx"), ["/usr/bin/uvx", "claude-sandbox", "install"]);
    assert.deepEqual(installArgv(1000, "/usr/bin/uvx"), [SUDO, "/usr/bin/uvx", "claude-sandbox", "install"]);
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
