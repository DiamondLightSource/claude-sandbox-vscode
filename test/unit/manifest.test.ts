// package.json: what the workspace cannot set, and that every contributed command exists.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { tsFiles } from "../helpers/fakes.ts";

const root = path.resolve(import.meta.dirname, "..", "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const src = (dir: string): string =>
  tsFiles(dir)
    .map((f) => fs.readFileSync(f, "utf8"))
    .join("\n");

describe("rule 11: settings the workspace cannot set", () => {
  it("every setting is application-scoped (user settings only: not workspace, folder, or a devcontainer's machine settings)", () => {
    const props = pkg.contributes.configuration.properties as Record<string, { scope?: string }>;
    assert.deepEqual(Object.keys(props).sort(), ["claudeSandbox.autoOpenDiffs", "claudeSandbox.extraArgs", "claudeSandbox.presets", "claudeSandbox.reviewEdits"]);
    for (const [k, v] of Object.entries(props)) assert.equal(v.scope, "application", k);
  });
  it("the code reads no other setting of ours, and nothing that runs from settings", () => {
    const code = src(path.join(root, "src"));
    const ours = [...code.matchAll(/getConfiguration\("claudeSandbox"\)\.get(?:<[^>]+>)?\("(\w+)"/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(ours)].sort(), ["autoOpenDiffs", "extraArgs", "presets", "reviewEdits"]);
    const others = [...code.matchAll(/getConfiguration\("(\w+)"\)/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(others)].sort(), ["claudeSandbox"], "no other extension's settings (files.watcherExclude is workspace-writable)");
  });
});

describe("the manifest", () => {
  it("keybindings: one Ctrl+Alt+C chord prefix, nothing on VS Code's own Ctrl+Alt+<letter> keys; F8 only in a review", () => {
    const kb = pkg.contributes.keybindings as { command: string; key: string; mac?: string; when?: string }[];
    // F8 and Shift+F8 (VS Code's next and previous problem) step through changes, but only in
    // Review All or with the Changes view focused
    const steps = kb.filter((k) => k.command === "claudeSandbox.nextChange" || k.command === "claudeSandbox.previousChange");
    assert.deepEqual(steps.map((k) => k.key).sort(), ["f8", "shift+f8"]);
    for (const k of steps) {
      assert.equal(k.when, "claudeSandbox.reviewing && activeEditor == 'multiDiffEditor' || focusedView == 'claudeSandbox.changes'", k.command);
    }
    const chords = kb.filter((k) => !steps.includes(k));
    for (const k of chords) {
      assert.match(k.key, /^ctrl\+alt\+c (?:ctrl\+alt\+c|[a-z])$/, k.command);
      assert.equal(k.mac, undefined, "the same chord on every platform");
    }
    assert.equal(new Set(chords.map((k) => k.key)).size, chords.length, "no two the same");
    assert.ok(!kb.some((k) => k.key === "ctrl+alt+i"), "Ctrl+Alt+I is VS Code's Open Chat");
  });
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
    for (const c of ["start", "preset.explain", "preset.reword", "preset.tighten", "customPreset", "mention"]) {
      assert.ok(keys.includes(`claudeSandbox.${c}`), c);
    }
    const sub = (pkg.contributes.menus["claudeSandbox.editor"] as { command: string }[]).map((m) => m.command);
    assert.ok(sub.includes("claudeSandbox.preset.explain") && sub.includes("claudeSandbox.mention"));
  });
  it("Run preset, the Refactor menu's way to a preset of the user's, is not in the palette", () => {
    const palette = pkg.contributes.menus.commandPalette as { command: string; when: string }[];
    assert.ok(palette.some((m) => m.command === "claudeSandbox.runPreset" && m.when === "false"));
  });
  it("the view container's icon ships in the package", () => {
    const icon = pkg.contributes.viewsContainers.activitybar[0].icon as string;
    assert.ok(fs.existsSync(path.join(root, icon)));
    assert.match(fs.readFileSync(path.join(root, ".vscodeignore"), "utf8"), new RegExp(`^!${icon}$`, "m"));
  });
});
