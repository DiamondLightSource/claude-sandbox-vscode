import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Bridge, DIFFS_MAX, PING_PREFIX, ENVELOPE_MAX, ID_MAX, JSON_ESCAPE_MAX, PROPOSAL_MAX, RESEND_MS, TOOLS } from "../../src/mcp.ts";
import { HIGH_WATER, MAX_QUEUED } from "../../src/websocket.ts";
import { Workspace } from "../../src/paths.ts";
import { IDE_CONNECTED, INITIALIZE, INITIALIZED, TOOLS_LIST, openDiff, texts, toolCall } from "../helpers/client.ts";
import { FakeDiagnostics, FakePeer, FakePresenter, MemLogger, SECRET, tmpWorkspace, type Tmp } from "../helpers/fakes.ts";

let t: Tmp;
let presenter: FakePresenter;
let diags: FakeDiagnostics;
let logger: MemLogger;
let bridge: Bridge;
let target: string;
const DOC = "line one\nhello world\nline three\n";

function connect(): { peer: FakePeer; conn: NonNullable<ReturnType<Bridge["attach"]>>; send: (m: unknown) => void } {
  const peer = new FakePeer();
  const conn = bridge.attach(peer);
  assert.ok(conn);
  return { peer, conn, send: (m) => bridge.receive(conn, JSON.stringify(m)) };
}

function ready(): ReturnType<typeof connect> {
  const c = connect();
  for (const m of [INITIALIZE, INITIALIZED, IDE_CONNECTED, TOOLS_LIST]) c.send(m);
  return c;
}

beforeEach(() => {
  t = tmpWorkspace();
  target = path.join(t.ws, "target.md");
  fs.writeFileSync(target, DOC);
  presenter = new FakePresenter();
  diags = new FakeDiagnostics();
  logger = new MemLogger();
  bridge = new Bridge({ workspace: new Workspace([t.ws]), presenter, diagnostics: diags, logger, version: "9.9.9" });
});
afterEach(() => t.cleanup());

describe("handshake as Claude Code 2.1.292 sends it", () => {
  it("answers initialize and tools/list, never ide_connected", () => {
    const states: string[] = [];
    bridge = new Bridge({
      workspace: new Workspace([t.ws]),
      presenter,
      diagnostics: diags,
      logger,
      onState: (s) => states.push(s),
    });
    const { peer } = ready();
    assert.equal(peer.sent.length, 2, "two requests, two answers; notifications unanswered");
    const init = peer.reply(0)!.result as Record<string, unknown>;
    assert.equal(init.protocolVersion, "2025-11-25");
    assert.deepEqual(init.capabilities, { tools: {} });
    assert.equal((init.serverInfo as { name: string }).name, "claude-sandbox-vscode");
    const tools = (peer.reply(1)!.result as { tools: { name: string }[] }).tools.map((x) => x.name);
    assert.deepEqual(tools.sort(), ["closeAllDiffTabs", "close_tab", "getDiagnostics", "openDiff"]);
    assert.equal(bridge.state, "connected");
    assert.deepEqual(states, ["connected"]);
  });
  it("offers an unknown protocol version our newest", () => {
    const { peer, send } = connect();
    send({ ...INITIALIZE, params: { protocolVersion: "1999-01-01" } });
    assert.equal((peer.reply(0)!.result as { protocolVersion: string }).protocolVersion, "2025-11-25");
  });
});

describe("rule 1: four tools, nothing that runs anything", () => {
  it("lists exactly openDiff, close_tab, closeAllDiffTabs, getDiagnostics", () => {
    assert.deepEqual(TOOLS.map((x) => x.name), ["openDiff", "close_tab", "closeAllDiffTabs", "getDiagnostics"]);
    assert.doesNotMatch(JSON.stringify(TOOLS), /executeCode/);
  });
  it("executeCode as a tool is -32602, as a method -32601; unknown methods -32601", () => {
    const { peer, send } = ready();
    send(toolCall(5, "executeCode", { code: "require('fs').writeFileSync('/tmp/pwned','')" }));
    assert.equal((peer.reply(5)!.error as { code: number }).code, -32602);
    for (const [id, method] of [
      [6, "executeCode"],
      [7, "getOpenEditors"],
      [8, "resources/read"],
      [9, "__proto__"],
      [10, "constructor"],
      [11, "toString"],
    ] as const) {
      send({ jsonrpc: "2.0", id, method, params: {} });
      assert.equal((peer.reply(id)!.error as { code: number }).code, -32601, method);
    }
    send({ jsonrpc: "2.0", id: 12, method: "ping" });
    assert.deepEqual(peer.reply(12)!.result, {});
  });
  it("bad JSON, non-objects and bad ids get JSON-RPC errors and the link stays up", () => {
    const { peer, conn } = ready();
    bridge.receive(conn, "{not json");
    bridge.receive(conn, "[1,2]");
    bridge.receive(conn, '{"jsonrpc":"2.0","id":{"x":1},"method":"ping"}');
    bridge.receive(conn, '{"jsonrpc":"2.0","id":3,"method":7}');
    bridge.receive(conn, "[".repeat(100000) + "]".repeat(100000));
    const codes = peer.sent.filter((m) => m.error).map((m) => (m.error as { code: number }).code);
    assert.deepEqual(codes, [-32700, -32600, -32600, -32600, -32600]);
    bridge.receive(conn, '{"jsonrpc":"2.0","id":4,"method":"ping"}');
    assert.deepEqual(peer.reply(4)!.result, {});
  });
});

describe("rule 2/3: openDiff", () => {
  it("shows a workspace file and answers FILE_SAVED with the edited text, writing nothing", () => {
    const { peer, send } = ready();
    send(openDiff(3, target, "line one\ngoodbye\n", "tab"));
    assert.equal(peer.reply(3), undefined, "Claude waits for the user");
    const v = presenter.shown[0]!;
    assert.deepEqual({ ...v, id: "" }, { id: "", file: target, title: "tab", old: DOC, proposed: "line one\ngoodbye\n", exists: true });
    assert.ok(bridge.decide(v.id, { kind: "accept", contents: "edited\n" }));
    assert.deepEqual(texts(peer.reply(3)), ["FILE_SAVED", "edited\n"]);
    assert.equal(fs.readFileSync(target, "utf8"), DOC);
    assert.equal(bridge.decide(v.id, { kind: "reject" }), false, "answered once");
  });
  it("reject answers DIFF_REJECTED; closing the tab answers DIFF_REJECTED, never TAB_CLOSED", () => {
    const { peer, send } = ready();
    send(openDiff(3, target, "x\n", "one"));
    send(openDiff(4, target, "y\n", "two"));
    bridge.decide(presenter.shown[0]!.id, { kind: "reject" });
    bridge.decide(presenter.shown[1]!.id, { kind: "closed" });
    assert.deepEqual(texts(peer.reply(3)), ["DIFF_REJECTED", "one"]);
    assert.deepEqual(texts(peer.reply(4)), ["DIFF_REJECTED", "two"]);
  });
  it("close_tab / closeAllDiffTabs answer waiting diffs TAB_CLOSED and close them; cancelled closes", () => {
    const { peer, send } = ready();
    send(openDiff(3, target, "x\n", "second"));
    send(toolCall(5, "close_tab", { tab_name: "second" }));
    assert.deepEqual(texts(peer.reply(4 + 1)), ["TAB_CLOSED"]);
    assert.deepEqual(texts(peer.reply(3)), ["TAB_CLOSED"]);
    send(openDiff(6, target, "y\n", "third"));
    send(toolCall(7, "closeAllDiffTabs", {}));
    assert.deepEqual(texts(peer.reply(6)), ["TAB_CLOSED"]);
    send(openDiff(8, target, "z\n", "fourth"));
    send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 8 } });
    assert.equal(presenter.closed.length, 3);
    assert.deepEqual(bridge.waitingDiffs(), []);
  });
  it("accepting unchanged sends the proposal exactly; LF edits go back with the proposal's CRLFs", () => {
    const { peer, send } = ready();
    send(openDiff(3, target, "a\r\nb\r\n", "crlf"));
    bridge.decide(presenter.shown[0]!.id, { kind: "accept", contents: "a\nb\n" });
    assert.deepEqual(texts(peer.reply(3)), ["FILE_SAVED", "a\r\nb\r\n"]);
    send(openDiff(4, target, "a\r\nb\r\n", "crlf2"));
    bridge.decide(presenter.shown[1]!.id, { kind: "accept", contents: "a\nc\n" });
    assert.deepEqual(texts(peer.reply(4)), ["FILE_SAVED", "a\r\nc\r\n"]);
    send(openDiff(5, target, "a\nb\n", "lf"));
    bridge.decide(presenter.shown[2]!.id, { kind: "accept" });
    assert.deepEqual(texts(peer.reply(5)), ["FILE_SAVED", "a\nb\n"]);
  });
  it("a new file is shown as new", () => {
    const { send } = ready();
    send(openDiff(3, path.join(t.ws, "sub", "new.md"), "# New\n", "new"));
    assert.equal(presenter.shown[0]!.exists, false);
    assert.equal(presenter.shown[0]!.old, "");
  });
  it("refuses paths outside, .git, symlinks out, two different files; reads nothing", () => {
    fs.symlinkSync(t.secret, path.join(t.ws, "link.md"));
    fs.mkdirSync(path.join(t.ws, ".git"));
    fs.writeFileSync(path.join(t.ws, ".git", "config"), "[core]\n");
    fs.writeFileSync(path.join(t.ws, "other.md"), "o\n");
    const { peer, send } = ready();
    let id = 10;
    for (const p of [t.secret, path.join(t.ws, "link.md"), path.join(t.ws, ".git", "config"), `${t.ws}/../outside/secret.md`, "relative.md", t.ws, "/etc/passwd"]) {
      send(openDiff(id, p, "x\n"));
      const r = peer.reply(id++)!;
      assert.equal((r.result as { isError: boolean }).isError, true, p);
    }
    send(toolCall(30, "openDiff", { old_file_path: target, new_file_path: path.join(t.ws, "other.md"), new_file_contents: "x", tab_name: "t" }));
    assert.match(texts(peer.reply(30))[0]!, /one file at a time/);
    send(toolCall(31, "openDiff", { old_file_path: 1 }));
    assert.equal((peer.reply(31)!.error as { code: number }).code, -32602);
    assert.equal(presenter.shown.length, 0);
    assert.doesNotMatch(JSON.stringify(peer.sent), new RegExp(SECRET));
  });
  it(`at most ${DIFFS_MAX} wait at once, checked before the path`, () => {
    const { peer, send } = ready();
    for (let i = 0; i < DIFFS_MAX; i++) send(openDiff(100 + i, target, `${i}\n`, `t${i}`));
    const orig = Workspace.prototype.readInside;
    let reads = 0;
    Workspace.prototype.readInside = function (...a) {
      reads++;
      return orig.apply(this, a);
    };
    try {
      send(openDiff(99, target, "x"));
      assert.match(texts(peer.reply(99))[0]!, /too many/);
    } finally {
      Workspace.prototype.readInside = orig;
    }
    assert.equal(reads, 0, "refused before reading");
    assert.equal(presenter.shown.length, DIFFS_MAX);
  });
  it("closing the link rejects waiting diffs", () => {
    const { peer, send } = ready();
    send(openDiff(3, target, "x\n", "tab"));
    bridge.close();
    assert.deepEqual(texts(peer.reply(3)), ["DIFF_REJECTED", "tab"]);
    assert.ok(peer.dropped);
    assert.equal(bridge.attach(new FakePeer()), null);
  });
});

describe("connections", () => {
  it("one linked session: a second is refused while the first is open, accepted after it goes", () => {
    const a = ready();
    a.send(openDiff(3, target, "x\n"));
    assert.equal(bridge.attach(new FakePeer()), null);
    assert.ok(!a.peer.dropped, "the first keeps its link");
    assert.deepEqual(presenter.closed, []);
    assert.ok(bridge.linked);
    bridge.detach(a.conn);
    assert.equal(bridge.state, "waiting");
    assert.deepEqual(presenter.closed, [presenter.shown[0]!.id], "its diffs close, unanswered");
    assert.equal(bridge.decide(presenter.shown[0]!.id, { kind: "accept" }), false, "a stale tab answers nothing");
    const b = ready();
    assert.equal(bridge.state, "connected");
    bridge.detach(b.conn);
    assert.equal(bridge.state, "waiting");
  });

  it("workspace folders changed: paths are checked against the new set", () => {
    const other = path.join(t.dir, "other");
    fs.mkdirSync(other);
    const file = path.join(other, "o.md");
    fs.writeFileSync(file, "o\n");
    const { peer, send } = ready();
    send(openDiff(3, file, "x\n"));
    assert.equal((peer.reply(3)!.result as { isError?: boolean }).isError, true, "not a folder yet");
    bridge.setFolders([t.ws, other, path.join(t.dir, "gone")]);
    send(openDiff(4, file, "x\n"));
    assert.equal(presenter.shown.at(-1)?.file, file);
    bridge.setFolders([other]);
    send(openDiff(5, target, "x\n"));
    assert.equal((peer.reply(5)!.result as { isError?: boolean }).isError, true, "a folder removed");
    assert.deepEqual(bridge.workspace.folders, [other]);
  });
});

describe("rule 4: getDiagnostics", () => {
  it("returns only workspace files' diagnostics", () => {
    const d = { message: "m", severity: "Error", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } };
    diags.entries = [
      { uri: "file://" + target, fsPath: target, diagnostics: [d] },
      { uri: "file://" + t.secret, fsPath: t.secret, diagnostics: [{ ...d, message: SECRET }] },
    ];
    const { peer, send } = ready();
    send(toolCall(3, "getDiagnostics", {}));
    const all = JSON.parse(texts(peer.reply(3))[0]!) as Record<string, unknown>[];
    assert.deepEqual(all, [{ uri: "file://" + target, diagnostics: [d] }], "no host-side fsPath");
    send(toolCall(4, "getDiagnostics", { uri: "file://" + t.secret }));
    assert.deepEqual(texts(peer.reply(4)), ["[]"]);
    send(toolCall(5, "getDiagnostics", { uri: "file://" + target }));
    assert.equal(JSON.parse(texts(peer.reply(5))[0]!).length, 1);
    send(toolCall(6, "getDiagnostics", { uri: "http://evil/" }));
    assert.deepEqual(texts(peer.reply(6)), ["[]"]);
    assert.doesNotMatch(JSON.stringify(peer.sent), new RegExp(SECRET));
    assert.ok(!diags.asked.includes(t.secret), "never asked about an outside file");
  });
});

describe("rule 5: selection_changed", () => {
  it("is sent for workspace files (twice after ide_connected), ordered, with a selection object", async () => {
    bridge.select(target, { line: 2, character: 4 }, { line: 1, character: 0 }, "hello world\nline");
    const { peer } = ready();
    const want = {
      text: "hello world\nline",
      filePath: target,
      fileUrl: "file://" + target,
      selection: { start: { line: 1, character: 0 }, end: { line: 2, character: 4 }, isEmpty: false },
    };
    assert.deepEqual(peer.notes("selection_changed"), [want]);
    await sleep(RESEND_MS + 100);
    assert.deepEqual(peer.notes("selection_changed"), [want, want]);
  });
  it("outside the workspace: a cleared selection, no filePath, nothing of the text", () => {
    const { peer } = ready();
    bridge.select(target, { line: 0, character: 0 }, { line: 0, character: 4 }, "line");
    fs.symlinkSync(t.secret, path.join(t.ws, "link.md"));
    bridge.select(t.secret, { line: 0, character: 0 }, { line: 0, character: 3 }, SECRET);
    bridge.select(path.join(t.ws, "link.md"), { line: 0, character: 0 }, { line: 0, character: 3 }, SECRET);
    const zero = { line: 0, character: 0 };
    assert.deepEqual(peer.notes("selection_changed").slice(1), [{ text: "", selection: { start: zero, end: zero, isEmpty: true } }]);
    assert.doesNotMatch(JSON.stringify(peer.sent), new RegExp(SECRET));
  });
});

describe("rule 6: the ping barrier an ask waits on", () => {
  it("resolves true on Claude's answer to that id, in order after the selection", async () => {
    const { peer, send } = ready();
    bridge.select(target, { line: 1, character: 0 }, { line: 2, character: 0 }, "hello world\n");
    const p = bridge.ping(1000);
    const req = peer.sent.at(-1)!;
    assert.equal(req.method, "ping");
    assert.match(String(req.id), new RegExp(`^${PING_PREFIX}`));
    const order = peer.sent.map((m) => m.method);
    assert.ok(order.lastIndexOf("selection_changed") < order.lastIndexOf("ping"));
    send({ jsonrpc: "2.0", id: "other", result: {} }); // not ours: ignored
    send({ jsonrpc: "2.0", id: req.id, result: {} });
    assert.equal(await p, true);
  });
  it("false with no answer in time, an error answer, a lost connection, or no session", async () => {
    assert.equal(await bridge.ping(10), false, "no session");
    const { peer, send, conn } = ready();
    assert.equal(await bridge.ping(20), false, "no answer");
    const p = bridge.ping(1000);
    send({ jsonrpc: "2.0", id: peer.sent.at(-1)!.id, error: { code: -1, message: "no" } });
    assert.equal(await p, false, "an error");
    const q = bridge.ping(5000);
    bridge.detach(conn);
    assert.equal(await q, false, "detached");
  });
});

describe("rule 5: at_mentioned", () => {
  it("only for workspace files, with 0-based lines, never Enter", () => {
    assert.equal(bridge.mention(target), false, "no session");
    fs.mkdirSync(path.join(t.ws, ".git"));
    fs.writeFileSync(path.join(t.ws, ".git", "config"), "");
    const { peer } = ready();
    assert.equal(bridge.mention(target, { start: 1, end: 2 }), true);
    assert.equal(bridge.mention(target), true);
    assert.equal(bridge.mention(t.secret), false);
    assert.equal(bridge.mention(path.join(t.ws, ".git", "config")), false);
    assert.deepEqual(peer.notes("at_mentioned"), [{ filePath: target, lineStart: 1, lineEnd: 2 }, { filePath: target }]);
  });
});

describe("rule 8: hostile JSON", () => {
  it("__proto__ / constructor payloads pollute nothing and are read as own keys only", () => {
    const { peer, conn } = ready();
    bridge.receive(conn, '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"__proto__":{"name":"openDiff"},"name":"getDiagnostics","arguments":{"__proto__":{"uri":"file:///etc/passwd"}}}}');
    assert.deepEqual(texts(peer.reply(3)), ["[]"]);
    bridge.receive(conn, `{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"openDiff","arguments":{"__proto__":{"old_file_path":"${target}","new_file_contents":"x","tab_name":"t"}}}}`);
    assert.equal((peer.reply(4)!.error as { code: number }).code, -32602, "inherited arguments are not arguments");
    bridge.receive(conn, '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"constructor","arguments":{}}}');
    assert.equal((peer.reply(5)!.error as { code: number }).code, -32602);
    bridge.receive(conn, `{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"openDiff","arguments":{"old_file_path":"${target}","new_file_contents":"x","tab_name":"__proto__"}}}`);
    bridge.receive(conn, '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"close_tab","arguments":{"tab_name":"__proto__"}}}');
    assert.deepEqual(texts(peer.reply(6)), ["TAB_CLOSED"]);
    assert.equal(({} as Record<string, unknown>).name, undefined);
    assert.equal(({} as Record<string, unknown>).uri, undefined);
  });
  it("what Claude sends is logged escaped", () => {
    const { send } = connect();
    send({ jsonrpc: "2.0", method: "ide_connected", params: { pid: "\u001b]0;PWNED\u0007\u001b[2K\n[ide] forged" } });
    send({ jsonrpc: "2.0", id: 9, method: "\u001b[31mred\u2028x" });
    assert.doesNotMatch(logger.text, /[\u0000-\u0009\u000b-\u001f\u2028]/);
    assert.match(logger.text, /\\u001b/);
  });
});

describe("rule 8: the largest answer (FILE_SAVED) always fits under the output cap", () => {
  it("PROPOSAL_MAX is derived from MAX_QUEUED: worst-case escaping, the envelope and HIGH_WATER fit", () => {
    assert.ok(PROPOSAL_MAX * JSON_ESCAPE_MAX + ENVELOPE_MAX + HIGH_WATER <= MAX_QUEUED);
    assert.ok(PROPOSAL_MAX >= 4 * 1024 * 1024, "room for a large source file");
    // JSON.stringify never writes a byte of UTF-8 text as more than JSON_ESCAPE_MAX bytes
    const chars = [...Array(0x80).keys()].map((c) => String.fromCharCode(c));
    chars.push("\u0080", "\u2028", "\uffff", "\ud800", "\udfff", "\ud83d\ude00");
    for (const c of chars) {
      assert.ok(JSON.stringify(c).length - 2 <= JSON_ESCAPE_MAX * Buffer.byteLength(c), JSON.stringify(c));
    }
  });
  it("a proposal of PROPOSAL_MAX control characters, with the longest id, is answered within the cap", () => {
    const { peer, send } = ready();
    const id = "\u0001".repeat(ID_MAX);
    send({ ...openDiff(0, target, "\u0001".repeat(PROPOSAL_MAX)), id });
    const v = presenter.shown[0]!;
    assert.ok(bridge.decide(v.id, { kind: "accept" }));
    const reply = peer.reply(id)!;
    assert.equal(texts(reply)[0], "FILE_SAVED");
    assert.ok(Buffer.byteLength(JSON.stringify(reply)) + 10 <= MAX_QUEUED - HIGH_WATER);
  });
  it("a larger proposal is refused before anything is read; a longer string id is invalid", () => {
    const { peer, send } = ready();
    send(openDiff(3, target, "x".repeat(PROPOSAL_MAX + 1)));
    assert.equal(presenter.shown.length, 0);
    assert.equal((peer.reply(3)!.result as { isError?: boolean }).isError, true);
    send({ jsonrpc: "2.0", id: "x".repeat(ID_MAX + 1), method: "ping" });
    assert.equal((peer.reply(null)!.error as { code: number }).code, -32600);
  });
  it("text the user made larger than PROPOSAL_MAX is not sent: an error answer, not FILE_SAVED", () => {
    const { peer, send } = ready();
    send(openDiff(3, target, "small\n"));
    assert.ok(bridge.decide(presenter.shown[0]!.id, { kind: "accept", contents: "y".repeat(PROPOSAL_MAX + 1) }));
    const r = peer.reply(3)!;
    assert.equal((r.result as { isError?: boolean }).isError, true);
    assert.notEqual(texts(r)[0], "FILE_SAVED");
    assert.ok(Buffer.byteLength(JSON.stringify(r)) < 4096);
  });
});
