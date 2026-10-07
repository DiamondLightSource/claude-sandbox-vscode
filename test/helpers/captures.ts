// Claude Code 2.1.292's real output (test/fixtures/claude-2.1.292.json), replayed.

import * as fs from "node:fs";
import * as path from "node:path";
import { PromptWatcher } from "../../src/prompt.ts";

export interface Capture {
  cols: number;
  rows: number;
  inputs: [number, string | [number, number]][];
  chunks: [number, string][];
}

const file = path.join(import.meta.dirname, "..", "fixtures", "claude-2.1.292.json");
export const CAPTURES = (JSON.parse(fs.readFileSync(file, "utf8")) as { captures: Record<string, Capture> }).captures;

export function capture(name: string): Capture {
  const c = CAPTURES[name];
  if (c === undefined) throw new Error(`no capture ${name}`);
  return c;
}

/** The output up to (and including) second `t`, as one string. */
export function outputUntil(name: string, t: number): string {
  return capture(name)
    .chunks.filter(([at]) => at <= t)
    .map(([, d]) => d)
    .join("");
}

/** A watcher fed a capture's chunks, as they were read, up to second `t`. */
export function replay(name: string, t = Infinity): PromptWatcher {
  const c = capture(name);
  const w = new PromptWatcher(c.cols, c.rows);
  for (const [at, d] of c.chunks) if (at <= t) w.feed(d, at * 1000);
  return w;
}
