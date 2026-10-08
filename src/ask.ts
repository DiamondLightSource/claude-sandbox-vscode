// Presets and the text an ask types (no vscode import). The typing itself, and when it may
// happen, is src/session.ts.

import { isObj, own } from "./json.ts";
import type { Position } from "./mcp.ts";

export interface Preset {
  title: string;
  prompt: string;
}

export const BUILTIN_PRESETS: readonly (Preset & { id: string })[] = [
  { id: "explain", title: "Explain", prompt: "Explain the selected text." },
  {
    id: "reword",
    title: "Reword",
    prompt: "Reword the selected text so it reads clearly and naturally. Keep its meaning.",
  },
  {
    id: "tighten",
    title: "Tighten",
    prompt: "Tighten the selected text: make it shorter and more direct without losing anything it says.",
  },
];

export const PRESETS_MAX = 50;
const TITLE_MAX = 80;
const PROMPT_MAX = 8000;

/** The user's `claudeSandbox.presets` setting: valid entries only, trimmed and capped. */
export function customPresets(value: unknown): Preset[] {
  if (!Array.isArray(value)) return [];
  const out: Preset[] = [];
  for (const v of value.slice(0, PRESETS_MAX)) {
    if (!isObj(v)) continue;
    const title = own(v, "title");
    const prompt = own(v, "prompt");
    if (typeof title !== "string" || typeof prompt !== "string") continue;
    if (!title.trim() || !prompt.trim()) continue;
    const t = title.trim().slice(0, TITLE_MAX);
    // A code action names a preset by title, so a title repeated later is dropped.
    if (out.some((x) => x.title === t)) continue;
    out.push({ title: t, prompt: prompt.slice(0, PROMPT_MAX) });
  }
  return out;
}

/** The user's `claudeSandbox.extraArgs` setting: strings only (anything else: none). */
export function extraArgs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((a): a is string => typeof a === "string" && !/[\u0000]/.test(a));
}

/**
 * The first and last lines (from 1) a range covers, as Claude Code counts them (a range that
 * ends at the start of a line does not cover that line), or null for an empty range.
 */
export function lineSpan(start: Position, end: Position): [number, number] | null {
  if (start.line === end.line && start.character === end.character) return null;
  const a = start.line + 1;
  let b = end.line + 1;
  if (end.character === 0 && b > a) b -= 1;
  return [a, b];
}

/** `file` relative to `cwd` when inside it, otherwise as it is. */
export function relTo(file: string, cwd: string): string {
  const base = cwd.replace(/\/+$/, "");
  return base && file.startsWith(base + "/") ? file.slice(base.length + 1) : file;
}

/**
 * The typed @-mention of a file (and lines): `@path#La-b`, relative to `cwd` when inside it,
 * quoted when it has whitespace.
 */
export function typedRef(file: string, cwd: string, span: [number, number] | null): string {
  const p = relTo(file, cwd);
  let ref = "@" + (/\s/.test(p) ? `"${p}"` : p);
  if (span) ref += span[0] === span[1] ? `#L${span[0]}` : `#L${span[0]}-${span[1]}`;
  return ref;
}
