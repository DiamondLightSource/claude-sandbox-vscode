import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LinkState, Position } from "../../src/mcp.ts";
import { PASTE_END, PASTE_START } from "../../src/paste.ts";
import { PromptWatcher } from "../../src/prompt.ts";
import { Session, type LinkPort } from "../../src/session.ts";

const BOX = "❯\xa0\x1b[2mTry something";
const MENU = "Do you want to make this edit?\r\n❯ 1. Yes\r\n  2. No";
const p = (line: number, character: number): Position => ({ line, character });

class FakeLink implements LinkPort {
  state: LinkState = "connected";
  diffs: string[] = [];
  pingOk = true;
  log: string[] = [];
  onPing: () => void = () => undefined;
  readonly workspace = {
    resolve: (f: unknown) =>
      typeof f === "string" && f.startsWith("/w/") ? { ok: true as const, real: f, folder: "/w" } : { ok: false as const, why: "outside" },
  };
  waitingDiffs(): string[] {
    return this.diffs;
  }
  select(fsPath: string, start: Position, end: Position, text: string): void {
    this.log.push(`select ${fsPath} ${start.line}:${start.character}-${end.line}:${end.character} ${JSON.stringify(text)}`);
  }
  clearSelection(): boolean {
    this.log.push("clear");
    return true;
  }
  async ping(): Promise<boolean> {
    this.log.push("ping");
    this.onPing();
    return this.pingOk;
  }
  mention(fsPath: string, lines?: { start: number; end: number }): boolean {
    if (!this.workspace.resolve(fsPath).ok) return false;
    this.log.push(`mention ${fsPath}${lines ? ` ${lines.start}-${lines.end}` : ""}`);
    return true;
  }
}

function setup(o: { link?: FakeLink | null; output?: string; startWaitMs?: number } = {}) {
  const typed: string[] = [];
  const watcher = new PromptWatcher();
  const link = o.link === undefined ? new FakeLink() : o.link;
  let clock = 0;
  const events: string[] = [];
  const s = new Session({
    write: (d) => {
      typed.push(d);
      link?.log.push(`type ${JSON.stringify(d)}`);
    },
    watcher,
    link: () => link,
    cwd: "/w",
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      await new Promise((r) => setImmediate(r));
    },
    startWaitMs: o.startWaitMs ?? 20_000,
    onWaiting: () => events.push("waiting"),
  });
  if (o.output !== undefined) s.output(o.output);
  return { s, typed, link, watcher, events, advance: (ms: number) => (clock += ms) };
}

const paste = (t: string): string => PASTE_START + t + PASTE_END;
const sel = { fsPath: "/w/a.py", start: p(1, 0), end: p(3, 0), text: "x = 1\ny = 2\n" };

describe("rule 6: asks are typed only into Claude Code's input box", () => {
  it("with the link: selection, ping, then ONE bracketed paste and Enter", async () => {
    const { s, link } = setup({ output: BOX });
    const r = await s.ask({ question: "Explain\x1b[201~ this\x03", file: sel });
    assert.deepEqual(r, { ok: true, via: "ide" });
    assert.deepEqual(link!.log, [
      'select /w/a.py 1:0-3:0 "x = 1\\ny = 2\\n"',
      "ping",
      `type ${JSON.stringify(paste("Explain[201~ this"))}`,
      'type "\\r"',
    ]);
  });
  it("a whole file (empty selection) is named with a typed @-mention as well", async () => {
    const { s, typed } = setup({ output: BOX });
    await s.ask({ question: "Review it", file: { fsPath: "/w/a.py", start: p(2, 3), end: p(2, 3), text: "" } });
    assert.equal(typed[0], paste("@a.py Review it"));
  });
  it("no answer to the ping, or no link: the lines are typed as an @-mention", async () => {
    const a = setup({ output: BOX });
    a.link!.pingOk = false;
    assert.deepEqual(await a.s.ask({ question: "Explain", file: sel }), { ok: true, via: "typed" });
    assert.equal(a.typed[0], paste("@a.py#L2-3 Explain"));
    const b = setup({ output: BOX, link: null });
    assert.deepEqual(await b.s.ask({ question: "Explain", file: sel }), { ok: true, via: "typed" });
    assert.equal(b.typed[0], paste("@a.py#L2-3 Explain"));
  });
  it("a file outside the workspace: Claude's selection is cleared first, nothing of it sent", async () => {
    const { s, link } = setup({ output: BOX });
    await s.ask({ question: "Explain", file: { ...sel, fsPath: "/etc/passwd" } });
    assert.deepEqual(link!.log.slice(0, 2), ["clear", "ping"]);
    assert.ok(!link!.log.some((l) => l.startsWith("select")));
  });
  it("a menu on screen: refused, nothing typed", async () => {
    const { s, typed } = setup({ output: BOX + MENU });
    const r = await s.ask({ question: "Explain", file: sel });
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /asking you something/);
    assert.deepEqual(typed, []);
  });
  it("a proposed change waiting for an answer: refused, nothing typed", async () => {
    const { s, typed, link } = setup({ output: BOX });
    link!.diffs = ["d-1"];
    const r = await s.ask({ question: "Explain", file: sel });
    assert.match((r as { error: string }).error, /proposed change/);
    assert.deepEqual(typed, []);
  });
  it("busy: refused, nothing typed", async () => {
    const { s, typed } = setup({ output: BOX + "✻ Working… (esc to interrupt)" });
    const r = await s.ask({ question: "Explain" });
    assert.match((r as { error: string }).error, /working/);
    assert.deepEqual(typed, []);
  });
  it("a menu that appears during the ping: refused before the paste", async () => {
    const { s, typed, link } = setup({ output: BOX });
    link!.onPing = () => s.output(MENU);
    const r = await s.ask({ question: "Explain", file: sel });
    assert.equal(r.ok, false);
    assert.deepEqual(typed, []);
  });
  it("a menu that appears between paste and Enter: no Enter", async () => {
    const { s, typed, link } = setup({ output: BOX });
    const write = link!.log.push.bind(link!.log);
    link!.log.push = (...x: string[]) => {
      if (x[0]?.startsWith("type") && x[0].includes("200~")) s.output(MENU);
      return write(...x);
    };
    const r = await s.ask({ question: "Explain", file: sel });
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /typed but not sent/);
    assert.ok(!typed.includes("\r"));
  });
  it("starting: waits for the prompt (telling once after a second), then sends", async () => {
    const { s, typed, events } = setup({ startWaitMs: 1e12 });
    const pending = s.ask({ question: "Hi" });
    await new Promise((r) => setTimeout(r, 30));
    s.output(BOX);
    assert.deepEqual(await pending, { ok: true, via: "typed" });
    assert.deepEqual(typed, [paste("Hi"), "\r"]);
    assert.deepEqual(events, ["waiting"]);
  });
  it("starting: after START_WAIT with no prompt, fails with nothing typed", async () => {
    const { s, typed } = setup({ startWaitMs: 500 });
    const r = await s.ask({ question: "Hi" });
    assert.match((r as { error: string }).error, /not started yet/);
    assert.deepEqual(typed, []);
  });
  it("an ended session takes nothing", async () => {
    const { s, typed } = setup({ output: BOX });
    s.exited();
    assert.equal((await s.ask({ question: "Hi" })).ok, false);
    s.input("x");
    assert.deepEqual(typed, []);
  });
  it("the user's keys wait while an ask is between its paste and Enter, and asks go one at a time", async () => {
    const { s, typed } = setup({ output: BOX });
    const a = s.ask({ question: "one" });
    const b = s.ask({ question: "two" });
    await new Promise((r) => setImmediate(r));
    s.input("k");
    await Promise.all([a, b]);
    s.input("z");
    const iOne = typed.indexOf(paste("one"));
    assert.deepEqual(typed.slice(iOne, iOne + 2), [paste("one"), "\r"]);
    assert.ok(typed.indexOf("k") > iOne + 1, "k after the first Enter");
    assert.ok(typed.indexOf(paste("two")) > iOne + 1);
    assert.equal(typed.at(-1), "z");
  });
  it("an empty question is not sent", async () => {
    const { s, typed } = setup({ output: BOX });
    assert.equal((await s.ask({ question: "  " })).ok, false);
    assert.deepEqual(typed, []);
  });
});

describe("rule 6: Mention in Claude", () => {
  it("at_mentioned over the link (0-based lines), nothing typed, even with a menu up", async () => {
    const { s, typed, link } = setup({ output: BOX + MENU });
    assert.deepEqual(await s.mention(sel), { ok: true, via: "ide" });
    assert.deepEqual(link!.log, ["mention /w/a.py 1-2"]);
    assert.deepEqual(typed, []);
  });
  it("without the link, typed (no Enter) only into the input box", async () => {
    const a = setup({ output: BOX, link: null });
    assert.deepEqual(await a.s.mention(sel), { ok: true, via: "typed" });
    assert.deepEqual(a.typed, [paste("@a.py#L2-3 ")]);
    const b = setup({ output: BOX + MENU, link: null });
    assert.equal((await b.s.mention(sel)).ok, false);
    assert.deepEqual(b.typed, []);
  });
  it("a path with whitespace is typed, quoted (Claude Code inserts at_mentioned paths unquoted)", async () => {
    const { s, typed } = setup({ output: BOX });
    await s.mention({ ...sel, fsPath: "/w/my notes.md" });
    assert.deepEqual(typed, [paste('@"my notes.md"#L2-3 ')]);
  });
});
