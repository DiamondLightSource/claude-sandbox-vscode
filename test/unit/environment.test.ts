import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CONTAINER_MARKERS, egressJailOff, environmentProblems, NO_TUN, needs, TUN } from "../../src/environment.ts";

const files =
  (...present: string[]) =>
  (p: string): boolean =>
    present.includes(p);

describe("issue #41: refuse outside a devcontainer", () => {
  const tun = (p: string): boolean => p === TUN;
  it("a devcontainer with the tun device is usable", () => {
    for (const marker of CONTAINER_MARKERS) {
      assert.deepEqual(
        environmentProblems({ remoteName: "dev-container", exists: files(marker), isCharDevice: tun }),
        [],
      );
    }
    assert.deepEqual(
      environmentProblems({ remoteName: "attached-container", exists: files("/.dockerenv"), isCharDevice: tun }),
      [],
    );
  });
  it("a local window on a host is refused, without the tun line", () => {
    const found = environmentProblems({ remoteName: undefined, exists: files(), isCharDevice: () => false });
    assert.equal(found.length, 2);
    assert.match(found[0]!, /local/);
    assert.match(found[1]!, /not running in a container/);
    assert.equal(needs(found), "needs a devcontainer");
  });
  it("an SSH or WSL remote is refused", () => {
    for (const remoteName of ["ssh-remote", "wsl"]) {
      const found = environmentProblems({ remoteName, exists: files(), isCharDevice: tun });
      assert.match(found[0]!, new RegExp(`${remoteName} remote`));
    }
  });
  it("a devcontainer without /dev/net/tun is refused", () => {
    const found = environmentProblems({
      remoteName: "dev-container",
      exists: files("/run/.containerenv"),
      isCharDevice: () => false,
      readConf: () => "",
    });
    assert.deepEqual(found, [`the container has no ${TUN}`]);
    assert.equal(needs(found), `needs ${TUN}`);
  });
  it("a devcontainer without /dev/net/tun is usable with the egress jail off in the conf", () => {
    const probe = { remoteName: "dev-container", exists: files("/.dockerenv"), isCharDevice: () => false };
    assert.deepEqual(environmentProblems({ ...probe, readConf: () => "egress-jail = 0\n" }), []);
    assert.deepEqual(environmentProblems({ ...probe, readConf: () => "egress-jail = 1\n" }), [NO_TUN]);
  });
  it("the conf is read as claude-sandbox reads it", () => {
    assert.equal(egressJailOff("egress-jail=0"), true);
    assert.equal(egressJailOff("  egress-jail   =   0   # off for now\n"), true);
    assert.equal(egressJailOff("no-forge\negress-jail = 0\negress-jail = 1\n"), true);
    assert.equal(egressJailOff(""), false);
    assert.equal(egressJailOff("# egress-jail = 0\n"), false);
    assert.equal(egressJailOff("egress-jail\n"), false);
    assert.equal(egressJailOff("egress-jail =\n"), false);
    assert.equal(egressJailOff("egress-jail = 1\negress-jail = 0\n"), false);
    assert.equal(egressJailOff("egress-jail = no\n"), false);
  });
});
