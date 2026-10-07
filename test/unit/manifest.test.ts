// package.json: what the workspace cannot set, and that every contributed command exists.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

const root = path.resolve(import.meta.dirname, "..", "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const src = (dir: string): string =>
  fs
    .readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => fs.readFileSync(path.join(e.parentPath, e.name), "utf8"))
    .join("\n");

describe("rule 11: settings the workspace cannot set", () => {
  it("every setting is application-scoped (user settings only: not workspace, folder, or a devcontainer's machine settings)", () => {
    const props = pkg.contributes.configuration.properties as Record<string, { scope?: string }>;
    assert.deepEqual(Object.keys(props).sort(), ["claudeSandbox.autoOpenDiffs", "claudeSandbox.extraArgs", "claudeSandbox.presets"]);
    for (const [k, v] of Object.entries(props)) assert.equal(v.scope, "application", k);
  });
  it("the code reads no other setting of ours, and nothing that runs from settings", () => {
    const code = src(path.join(root, "src"));
    const ours = [...code.matchAll(/getConfiguration\("claudeSandbox"\)\.get(?:<[^>]+>)?\("(\w+)"/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(ours)].sort(), ["autoOpenDiffs", "extraArgs", "presets"]);
    const others = [...code.matchAll(/getConfiguration\("(\w+)"\)/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(others)].sort(), ["claudeSandbox", "files"], "files.watcherExclude only");
  });
});

describe("the manifest", () => {
  it("runs in the devcontainer, activates after startup", () => {
    assert.deepEqual(pkg.extensionKind, ["workspace"]);
    assert.deepEqual(pkg.activationEvents, ["onStartupFinished"]);
    assert.equal(pkg.dependencies, undefined);
  });
  it("every contributed command is registered, and every registered one contributed", () => {
    const code = src(path.join(root, "src"));
    const contributed = (pkg.contributes.commands as { command: string }[]).map((c) => c.command).sort();
    const registered = [
      ...[...code.matchAll(/registerCommand\(\s*"([\w.]+)"/g)].map((m) => m[1]!),
      ...[...code.matchAll(/registerCommand\(`claudeSandbox\.preset\.\$\{p\.id\}`/g)].flatMap(() =>
        ["explain", "reword", "tighten"].map((id) => `claudeSandbox.preset.${id}`),
      ),
    ].sort();
    assert.deepEqual(registered, contributed);
  });
  it("Start, the presets and Mention have keybindings; the editor submenu holds the presets", () => {
    const keys = (pkg.contributes.keybindings as { command: string }[]).map((k) => k.command);
    for (const c of ["start", "preset.explain", "preset.reword", "preset.tighten", "askSelection", "mention"]) {
      assert.ok(keys.includes(`claudeSandbox.${c}`), c);
    }
    const sub = (pkg.contributes.menus["claudeSandbox.editor"] as { command: string }[]).map((m) => m.command);
    assert.ok(sub.includes("claudeSandbox.preset.explain") && sub.includes("claudeSandbox.mention"));
  });
  it("the view container's icon ships in the package", () => {
    const icon = pkg.contributes.viewsContainers.activitybar[0].icon as string;
    assert.ok(fs.existsSync(path.join(root, icon)));
    assert.match(fs.readFileSync(path.join(root, ".vscodeignore"), "utf8"), new RegExp(`^!${icon}$`, "m"));
  });
});
