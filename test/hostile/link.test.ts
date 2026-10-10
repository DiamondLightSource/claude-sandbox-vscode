// A hostile client on the real socket, with the real token: everything in the jail can do
// this. Nothing outside the workspace may be read or written, and the link must survive.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { type IdeLink, type LinkOptions, socketName } from "../../src/link.ts";
import type { Workspace } from "../../src/paths.ts";
import { HIGH_WATER, MAX_MESSAGE, MAX_QUEUED } from "../../src/websocket.ts";
import { Client, clientFrame, isError, openDiff, texts, toolCall } from "../helpers/client.ts";
import { FakePresenter, MemLogger, SECRET, snapshot, type Tmp, tmpWorkspace } from "../helpers/fakes.ts";
import { startTestLink } from "../helpers/link.ts";

let t: Tmp;
let link: IdeLink;
let presenter: FakePresenter;
let logger: MemLogger;
let before: { outside: Record<string, string>; ws: Record<string, string> };
const HANDSHAKE_MS = 400;
const DOC = "line one\nhello world\n";

async function start(pickPort?: () => number, extra: Partial<LinkOptions> = {}): Promise<IdeLink> {
  presenter = new FakePresenter();
  logger = new MemLogger();
  return startTestLink(t.ws, {
    presenter,
    logger,
    handshakeMs: HANDSHAKE_MS,
    ...(pickPort ? { pickPort } : {}),
    ...extra,
  });
}

/** Wait until the link has noticed every client has gone (one session at a time). */
async function unlinked(): Promise<void> {
  const deadline = Date.now() + 5000;
  while (link.linked && Date.now() < deadline) await sleep(10);
  assert.ok(!link.linked, "the previous session is still linked");
}

function wsSnapshot(): Record<string, string> {
  const s = snapshot(t.ws);
  delete s[link.socketPath];
  return s;
}

async function claude(): Promise<Client> {
  const c = await Client.open(link.socketPath, link.token);
  assert.equal(c.status, 101);
  await c.handshake();
  return c;
}

/** The link still serves a well-behaved Claude. */
async function survives(): Promise<void> {
  await unlinked();
  const c = await claude();
  const r = await c.call({ jsonrpc: "2.0", id: 999, method: "ping" });
  assert.deepEqual(r?.result, {});
  c.end();
}

beforeEach(async () => {
  t = tmpWorkspace();
  fs.writeFileSync(path.join(t.ws, "target.md"), DOC);
  fs.mkdirSync(path.join(t.ws, ".git"));
  fs.writeFileSync(path.join(t.ws, ".git", "config"), "[core]\n");
  fs.symlinkSync(t.secret, path.join(t.ws, "link.md"));
  fs.symlinkSync(t.outside, path.join(t.ws, "outdir"));
  link = await start();
  before = { outside: snapshot(t.outside), ws: wsSnapshot() };
});

afterEach(async () => {
  await link.close();
  assert.deepEqual(snapshot(t.outside), before.outside, "nothing outside the workspace changed");
  t.cleanup();
});

function assertNoLeak(...clients: Client[]): void {
  for (const c of clients) assert.doesNotMatch(JSON.stringify(c.msgs()), new RegExp(SECRET));
  assert.equal(presenter.shown.length, 0, "no diff was shown");
  assert.deepEqual(wsSnapshot(), before.ws, "the workspace was not written");
}

describe("rule 8: the socket and the handshake", () => {
  it("is 0600, echoes mcp, refuses permessage-deflate", async () => {
    assert.equal(fs.lstatSync(link.socketPath).mode & 0o777, 0o600);
    const c = await Client.open(link.socketPath, link.token);
    assert.equal(c.status, 101);
    assert.equal(c.headers["sec-websocket-protocol"], "mcp");
    assert.equal(c.headers["sec-websocket-extensions"], undefined);
    const [init, tools] = await c.handshake();
    assert.equal((init?.result as { protocolVersion: string }).protocolVersion, "2025-11-25");
    assert.equal((tools?.result as { tools: unknown[] }).tools.length, 4);
    assert.equal(link.bridge.state, "connected");
    // a compressed frame (RSV1), as if deflate had been agreed: a protocol error
    c.raw(clientFrame(1, Buffer.from([0x4b, 0x04, 0x00]), { rsv: 4 }));
    await c.until(() => c.closed);
    assert.deepEqual(c.closeCodes(), [1002]);
    await survives();
  });

  it("refuses a bad, missing or doubled token, other paths, garbage and huge heads", async () => {
    for (const bad of [null, "", "x".repeat(64), link.token.slice(1), link.token + "0", link.token.toUpperCase()]) {
      const c = await Client.open(link.socketPath, bad);
      assert.equal(c.status, 401, String(bad));
      await c.until(() => c.closed);
    }
    const dup = await Client.connect(link.socketPath);
    dup.raw(
      "GET / HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n" +
        `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nX-Claude-Code-Ide-Authorization: ${link.token}\r\n` +
        `X-Claude-Code-Ide-Authorization: ${link.token}\r\n\r\n`,
    );
    await dup.until(() => dup.closed);
    assert.equal(dup.status, 401);
    for (const [line, want] of [
      ["GET /api HTTP/1.1", 404],
      ["POST / HTTP/1.1", 404],
      ["GET / HTTP/1.1", 400],
      ["\x16\x03\x01 tls", 400],
    ] as const) {
      const c = await Client.connect(link.socketPath);
      c.raw(`${line}\r\nX-Claude-Code-Ide-Authorization: ${link.token}\r\n\r\n`);
      await c.until(() => c.closed);
      assert.equal(c.status, want, line);
    }
    const huge = await Client.connect(link.socketPath);
    huge.raw("GET / HTTP/1.1\r\nX: " + "a".repeat(20000));
    await huge.until(() => huge.closed);
    assert.equal(huge.status, 431);
    assert.doesNotMatch(logger.text, new RegExp(link.token), "the token is never logged");
    await survives();
  });

  it("at most 4 connections in their handshake; idle ones are dropped after the handshake timeout", async () => {
    const idle: Client[] = [];
    for (let i = 0; i < 4; i++) idle.push(await Client.connect(link.socketPath));
    await sleep(50);
    const t0 = Date.now();
    const extra = await Client.connect(link.socketPath);
    await extra.until(() => extra.closed, 1000);
    assert.ok(extra.closed && Date.now() - t0 < HANDSHAKE_MS, "over the cap: closed at once");
    for (const c of idle) {
      await c.until(() => c.closed, HANDSHAKE_MS * 5);
      assert.ok(c.closed, "slow handshake dropped");
    }
    // a byte at a time, never finishing the head: dropped all the same
    const slow = await Client.connect(link.socketPath);
    const drip = setInterval(() => slow.raw("G"), 50);
    await slow.until(() => slow.closed, HANDSHAKE_MS * 5);
    clearInterval(drip);
    assert.ok(slow.closed);
    // once upgraded, Claude may be quiet as long as it likes
    const c = await claude();
    await sleep(HANDSHAKE_MS * 2);
    assert.deepEqual((await c.call({ jsonrpc: "2.0", id: 5, method: "ping" }))?.result, {});
    c.end();
  });

  it("closes 1009 on a frame claiming more than 16 MiB, reading none of it", async () => {
    const c = await claude();
    c.raw(clientFrame(1, Buffer.alloc(0), { length: MAX_MESSAGE + 1 }).subarray(0, 10));
    await c.until(() => c.closed);
    assert.deepEqual(c.closeCodes(), [1009]);
    const d = await claude();
    d.raw(clientFrame(1, Buffer.from("x"), { mask: false }));
    await d.until(() => d.closed);
    assert.deepEqual(d.closeCodes(), [1002]);
    await survives();
  });

  // Real Claude Code 2.1.292 (docs/design.md "Scope"): `/ide` choosing the connected IDE opens
  // no connection; None then ours reconnects (the "accepted once it closes" path); a second
  // Claude gets this 409, reports "Failed to connect" and does not retry.
  it("one linked session: a second is refused while the first is open, accepted once it closes", async () => {
    const a = await claude();
    const b = await Client.open(link.socketPath, link.token);
    assert.equal(b.status, 409);
    await b.until(() => b.closed);
    assert.ok(b.closed);
    assert.deepEqual((await a.call({ jsonrpc: "2.0", id: 7, method: "ping" }))?.result, {}, "the first keeps working");
    assert.equal(link.bridge.state, "connected");
    a.end();
    await unlinked();
    const c = await claude();
    assert.deepEqual((await c.call({ jsonrpc: "2.0", id: 8, method: "ping" }))?.result, {});
    c.end();
  });

  it("a client that stops reading cannot grow the host's memory (backpressure, then the cap)", async () => {
    const c = await claude();
    c.sock.pause(); // never reads a reply again
    const ping = clientFrame(1, Buffer.from('{"jsonrpc":"2.0","id":1,"method":"ping"}'));
    const batch = Buffer.concat(Array<Buffer>(2000).fill(ping));
    let most = 0;
    const sample = setInterval(() => (most = Math.max(most, link.queued)), 1);
    let stalled = false;
    const deadline = Date.now() + 4000;
    try {
      while (Date.now() < deadline && !c.closed) {
        most = Math.max(most, link.queued);
        if (!c.sock.write(batch)) {
          const drained = await Promise.race([
            new Promise<boolean>((r) => c.sock.once("drain", () => r(true))),
            sleep(500).then(() => false),
          ]);
          if (!drained) {
            stalled = true; // the host stopped reading us
            break;
          }
        }
        await new Promise((r) => setImmediate(r));
      }
    } finally {
      clearInterval(sample);
    }
    assert.ok(stalled || c.closed, "the host keeps reading a client that does not read");
    assert.ok(most <= HIGH_WATER + 1024 * 1024, `the host queued ${most} bytes`);
    assert.ok(most <= MAX_QUEUED);
    c.end();
    await survives();
  });

  it("a hard cap on what waits to be sent: past it the client is dropped", async () => {
    await link.close();
    link = await start(undefined, { ws: { maxQueued: 256 * 1024 } });
    const c = await claude();
    c.sock.pause();
    // a large openDiff answer to a client that does not read
    c.send(openDiff(3, path.join(t.ws, "target.md"), "x".repeat(4 * 1024 * 1024)));
    await c.until(() => presenter.shown.length === 1);
    link.bridge.decide(presenter.shown[0]!.id, { kind: "accept" });
    await unlinked();
    assert.equal(link.queued, 0);
    c.end();
    await survives();
  });

  it("pings every pingMs; a client that answers nothing is dropped, one that pongs stays", async () => {
    await link.close();
    const PING = 100;
    link = await start(undefined, { ws: { pingMs: PING } });
    const mute = await claude();
    await mute.until(() => mute.closed, PING * 10);
    assert.ok(mute.closed, "dropped after a ping went unanswered");
    assert.ok(
      mute.frames.some((f) => f.op === 9),
      "it was pinged",
    );
    await unlinked();
    const live = await claude();
    live.autoPong = true;
    await sleep(PING * 6);
    assert.ok(!live.closed);
    assert.ok(live.frames.filter((f) => f.op === 9).length >= 3);
    assert.deepEqual((await live.call({ jsonrpc: "2.0", id: 9, method: "ping" }))?.result, {});
    live.end();
  });

  it("a slow reader is not dropped for pongs we did not read while its reading was paused", async () => {
    await link.close();
    const PING = 300;
    link = await start(undefined, { ws: { pingMs: PING } });
    const c = await claude();
    c.autoPong = true;
    c.sock.pause();
    c.send(openDiff(3, path.join(t.ws, "target.md"), "x".repeat(4 * 1024 * 1024)));
    const shown = Date.now() + 5000;
    while (presenter.shown.length === 0 && Date.now() < shown) await sleep(10);
    link.bridge.decide(presenter.shown[0]!.id, { kind: "accept" });
    assert.ok(link.queued > HIGH_WATER, "the host stopped reading it (backpressure)");
    // one chunk (64 KiB) every 25 ms: several ping periods to take the answer
    const t0 = Date.now();
    const drip = setInterval(() => {
      c.sock.once("data", () => c.sock.pause());
      c.sock.resume();
    }, 25);
    try {
      await c.until(() => c.closed || c.msgs().some((m) => m.id === 3), 20_000);
    } finally {
      clearInterval(drip);
    }
    c.sock.resume();
    assert.ok(Date.now() - t0 > PING * 3, "it took several ping periods");
    assert.ok(!c.closed, "dropped while it was reading");
    assert.equal(texts(c.msgs().find((m) => m.id === 3))[0], "FILE_SAVED");
    assert.deepEqual((await c.call({ jsonrpc: "2.0", id: 9, method: "ping" }))?.result, {});
    c.end();
  });
});

describe("rules 1, 2, 4, 8 over the wire", () => {
  it("openDiff and getDiagnostics outside the workspace read nothing", async () => {
    const c = await claude();
    const paths = [
      t.secret,
      `${t.ws}/../../outside/secret.md`,
      `${t.ws}/outdir/secret.md`,
      `${t.ws}/link.md`,
      `${t.ws}/.git/config`,
      `${t.ws}/.git/hooks/pre-commit`,
      `${t.ws}/sub/../../../outside/secret.md`,
      "/etc/passwd",
      "../outside/secret.md",
      "outside/secret.md",
      t.ws,
      `${t.ws}/target.md\0`,
    ];
    let id = 10;
    for (const p of paths) {
      const r = await c.call(openDiff(id++, p, "x\n"));
      assert.ok(isError(r), p);
      assert.notDeepEqual(texts(r)[0], "FILE_SAVED");
      const d = await c.call(toolCall(id++, "getDiagnostics", { uri: "file://" + p }));
      assert.deepEqual(texts(d), ["[]"], p);
    }
    assertNoLeak(c);
    c.end();
    await survives();
  });

  it("a symlink swapped in after the check is refused (file and folder)", async () => {
    fs.mkdirSync(path.join(t.ws, "sub"));
    fs.writeFileSync(path.join(t.ws, "sub", "b.md"), "b\n");
    fs.writeFileSync(path.join(t.outside, "b.md"), SECRET);
    before = { outside: snapshot(t.outside), ws: wsSnapshot() };
    const ws = link.workspace;
    const orig = ws.readInside.bind(ws);
    let swap: (() => void) | undefined;
    (ws as { readInside: Workspace["readInside"] }).readInside = (real, folder) =>
      orig(real, folder, { beforeOpen: () => swap?.() });
    const c = await claude();
    const target = path.join(t.ws, "target.md");
    swap = () => {
      fs.renameSync(target, target + ".old");
      fs.symlinkSync(t.secret, target);
    };
    assert.ok(isError(await c.call(openDiff(3, target, "x\n"))));
    swap = () => {
      fs.renameSync(path.join(t.ws, "sub"), path.join(t.ws, "sub.old"));
      fs.symlinkSync(t.outside, path.join(t.ws, "sub"));
    };
    assert.ok(isError(await c.call(openDiff(4, path.join(t.ws, "sub", "b.md"), "x\n"))));
    assert.doesNotMatch(JSON.stringify(c.msgs()), new RegExp(SECRET));
    assert.equal(presenter.shown.length, 0);
    c.end();
  });

  it("executeCode, unknown methods and __proto__/constructor payloads", async () => {
    const c = await claude();
    assert.equal(((await c.call(toolCall(3, "executeCode", { code: "1" })))?.error as { code: number }).code, -32602);
    for (const [i, m] of ["executeCode", "getOpenEditors", "__proto__", "constructor", "hasOwnProperty"].entries()) {
      const r = await c.call({ jsonrpc: "2.0", id: 20 + i, method: m, params: {} });
      assert.equal((r?.error as { code: number }).code, -32601, m);
    }
    c.sendText(
      `{"jsonrpc":"2.0","id":40,"method":"tools/call","params":{"name":"openDiff","arguments":{"__proto__":{"old_file_path":"${t.secret}"},"constructor":{"prototype":{"polluted":1}},"new_file_contents":"x","tab_name":"t"}}}`,
    );
    assert.equal(((await c.reply(40))?.error as { code: number }).code, -32602);
    c.sendText('{"__proto__":{"polluted":1},"jsonrpc":"2.0","id":41,"method":"ping"}');
    assert.deepEqual((await c.reply(41))?.result, {});
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    c.sendText("[".repeat(200000) + "]".repeat(200000));
    c.sendText("{nope");
    await c.until(() => c.msgs().filter((m) => m.error).length >= 7);
    assertNoLeak(c);
    c.end();
    await survives();
  });

  it("an accepted diff is answered FILE_SAVED and the file is not written (rule 3)", async () => {
    const c = await claude();
    const target = path.join(t.ws, "target.md");
    c.send(openDiff(3, target, "new text\n", "tab"));
    await c.until(() => presenter.shown.length === 1);
    assert.equal(presenter.shown[0]!.old, DOC);
    link.bridge.decide(presenter.shown[0]!.id, { kind: "accept" });
    assert.deepEqual(texts(await c.reply(3)), ["FILE_SAVED", "new text\n"]);
    c.send(openDiff(4, target, "other\n", "tab2"));
    await c.until(() => presenter.shown.length === 2);
    link.bridge.decide(presenter.shown[1]!.id, { kind: "closed" });
    assert.deepEqual(texts(await c.reply(4)), ["DIFF_REJECTED", "tab2"]);
    assert.equal(fs.readFileSync(target, "utf8"), DOC);
    c.end();
  });
});

describe("rule 7: the socket name", () => {
  it("a symlink or file planted at the socket path is left alone and another port is used", async () => {
    await link.close();
    const ports = [23401, 23401, 23402, 23403];
    fs.symlinkSync(t.secret, path.join(t.ws, socketName(23401)));
    fs.writeFileSync(path.join(t.ws, socketName(23402)), "planted");
    const l2 = await start(() => ports.shift()!);
    try {
      assert.equal(l2.port, 23403);
      assert.ok(fs.lstatSync(path.join(t.ws, socketName(23401))).isSymbolicLink());
      assert.equal(fs.readFileSync(path.join(t.ws, socketName(23402)), "utf8"), "planted");
      assert.equal(fs.readFileSync(t.secret, "utf8"), SECRET + "\n");
    } finally {
      await l2.close();
    }
    assert.ok(!fs.existsSync(path.join(t.ws, socketName(23403))), "our socket goes with the link");
    fs.unlinkSync(path.join(t.ws, socketName(23401)));
    fs.unlinkSync(path.join(t.ws, socketName(23402)));
    link = await start();
  });

  it("a non-socket client (TCP-style garbage) cannot crash the listener", async () => {
    const s = net.connect({ path: link.socketPath });
    await new Promise((r) => s.once("connect", r));
    s.on("error", () => undefined);
    s.resume();
    s.write(Buffer.alloc(70000, 0xff));
    await new Promise((r) => s.once("close", r));
    await survives();
  });
});
