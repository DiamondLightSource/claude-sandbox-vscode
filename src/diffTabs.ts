// The diff tabs' state machine (trust boundary rule 3), with no vscode import so it is unit
// tested; src/vscode/diffView.ts feeds it VS Code's events.
//
// - Accept → FILE_SAVED (the bridge answers with the text; nothing here writes a file).
// - Reject, or the user closing the tab → DIFF_REJECTED (a bare TAB_CLOSED would be an accept).
// - The bridge closing it (Claude closed it, or the connection went) → no answer from here;
//   a stale tab answered afterwards is a no-op (the bridge no longer waits for it).
// - Each proposal is answered at most once.
// - An entry stays (so VS Code can still stat and read it) until its tabs are seen closed,
//   or until it is closed with no tab open.

import type { Decision } from "./mcp.ts";

export const ORIGINAL_SCHEME = "claude-sandbox-original";
export const PROPOSAL_SCHEME = "claude-sandbox-proposal";

/** The diff id in either side's URI (`<scheme>:/<id>/<name>`), or undefined. */
export function diffIdOf(uri: { scheme: string; path: string }): string | undefined {
  if (uri.scheme !== ORIGINAL_SCHEME && uri.scheme !== PROPOSAL_SCHEME) return undefined;
  const id = uri.path.split("/")[1];
  return id === undefined || id === "" ? undefined : id;
}

export type Phase = "open" | "closing";

export interface Entry<T> {
  readonly id: string;
  phase: Phase;
  /** Bumped only when the proposal is written. */
  mtime: number;
  data: T;
}

export class DiffTabs<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly decide: (id: string, d: Decision) => boolean;
  private readonly now: () => number;

  constructor(decide: (id: string, d: Decision) => boolean, now: () => number = Date.now) {
    this.decide = decide;
    this.now = now;
  }

  add(id: string, data: T): Entry<T> {
    const e: Entry<T> = { id, phase: "open", mtime: this.now(), data };
    this.entries.set(id, e);
    return e;
  }

  get(id: string): Entry<T> | undefined {
    return this.entries.get(id);
  }

  ids(): string[] {
    return [...this.entries.keys()];
  }

  /** The proposal was written (the user edited and saved it): a new mtime. */
  written(id: string): void {
    const e = this.entries.get(id);
    if (e !== undefined) e.mtime = Math.max(this.now(), e.mtime + 1);
  }

  /**
   * The user's Accept (with the text to send) or Reject. True when the caller should now
   * close the tabs; false when it was answered already.
   */
  answer(id: string, d: { kind: "accept"; contents: string } | { kind: "reject" }): boolean {
    const e = this.entries.get(id);
    if (e === undefined || e.phase !== "open") return false;
    e.phase = "closing";
    this.decide(id, d);
    return true;
  }

  /** The bridge closes it (Claude closed it, or the connection went): no answer. */
  closeQuietly(id: string): boolean {
    const e = this.entries.get(id);
    if (e === undefined) return false;
    e.phase = "closing";
    return true;
  }

  /** A tab of diff `id` was closed: the user closing an open diff rejects it. */
  tabClosed(id: string, tabsLeft: number): void {
    const e = this.entries.get(id);
    if (e === undefined) return;
    if (e.phase === "open") {
      e.phase = "closing";
      this.decide(id, { kind: "closed" });
    }
    if (tabsLeft === 0) this.entries.delete(id);
  }

  /** Closing found no tab of `id` open: nothing more will ask for it. */
  noTabs(id: string): void {
    const e = this.entries.get(id);
    if (e !== undefined && e.phase === "closing") this.entries.delete(id);
  }

  clear(): void {
    this.entries.clear();
  }
}
