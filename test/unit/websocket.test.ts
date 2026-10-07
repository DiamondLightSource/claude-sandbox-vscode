import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  acceptKey,
  checkUpgrade,
  encodeFrame,
  FrameParser,
  parseRequestHead,
  ProtocolError,
  tokenMatches,
  type UpgradeRequest,
} from "../../src/websocket.ts";
import { clientFrame } from "../helpers/client.ts";

const TOKEN = "a".repeat(64);

function req(extra: Record<string, string[]> = {}, method = "GET", path = "/"): UpgradeRequest {
  const headers = Object.assign(Object.create(null) as Record<string, string[]>, {
    upgrade: ["websocket"],
    connection: ["Upgrade"],
    "sec-websocket-key": ["dGhlIHNhbXBsZSBub25jZQ=="],
    "sec-websocket-version": ["13"],
    "x-claude-code-ide-authorization": [TOKEN],
    ...extra,
  });
  return { method, path, version: "HTTP/1.1", headers };
}

function codeOf(fn: () => unknown): number {
  try {
    fn();
  } catch (e) {
    if (e instanceof ProtocolError) return e.code;
    throw e;
  }
  return 0;
}

describe("handshake", () => {
  it("computes the RFC 6455 accept key", () => {
    assert.equal(acceptKey("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  });

  it("parses a request head into null-prototype headers", () => {
    const r = parseRequestHead("GET / HTTP/1.1\r\nHost: x\r\n__proto__: y\r\nA: 1\r\na: 2");
    assert.ok(r);
    assert.equal(Object.getPrototypeOf(r.headers), null);
    assert.deepEqual(r.headers.a, ["1", "2"]);
    assert.deepEqual(r.headers.__proto__, ["y"]);
    assert.equal(parseRequestHead("garbage"), null);
    assert.equal(parseRequestHead("GET / HTTP/1.1\r\nno colon"), null);
  });

  it("answers 101, echoes mcp, never offers an extension", () => {
    const r = checkUpgrade(
      req({ "sec-websocket-protocol": ["mcp"], "sec-websocket-extensions": ["permessage-deflate; client_max_window_bits"] }),
      TOKEN,
    );
    assert.ok(r.ok);
    assert.match(r.response, /^HTTP\/1\.1 101 /);
    assert.match(r.response, /\r\nSec-WebSocket-Protocol: mcp\r\n/);
    assert.match(r.response, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/);
    assert.doesNotMatch(r.response, /Extensions/i);
    const plain = checkUpgrade(req(), TOKEN);
    assert.ok(plain.ok);
    assert.doesNotMatch(plain.response, /Sec-WebSocket-Protocol/);
  });

  it("refuses a wrong, missing or doubled token, other paths and non-upgrades", () => {
    for (const bad of [[], [""], ["b".repeat(64)], [TOKEN.slice(1)], [TOKEN + "0"], [TOKEN.toUpperCase()], [TOKEN, TOKEN]]) {
      const r = checkUpgrade(req({ "x-claude-code-ide-authorization": bad }), TOKEN);
      assert.ok(!r.ok && r.status === 401, JSON.stringify(bad));
    }
    const p = checkUpgrade(req({}, "GET", "/api"), TOKEN);
    assert.ok(!p.ok && p.status === 404);
    const m = checkUpgrade(req({}, "POST"), TOKEN);
    assert.ok(!m.ok && m.status === 404);
    const u = checkUpgrade(req({ upgrade: ["h2c"] }), TOKEN);
    assert.ok(!u.ok && u.status === 400);
    const v = checkUpgrade(req({ "sec-websocket-version": ["8"] }), TOKEN);
    assert.ok(!v.ok && v.status === 400);
  });

  it("compares tokens in constant time for any lengths", () => {
    assert.ok(tokenMatches(TOKEN, TOKEN));
    assert.ok(!tokenMatches("", TOKEN));
    assert.ok(!tokenMatches(TOKEN + TOKEN, TOKEN));
  });
});

describe("frames", () => {
  it("encodes all three length forms", () => {
    assert.deepEqual([...encodeFrame(1, Buffer.from("hi"))], [0x81, 2, 104, 105]);
    const mid = encodeFrame(1, Buffer.alloc(300));
    assert.equal(mid[1], 126);
    assert.equal(mid.readUInt16BE(2), 300);
    const big = encodeFrame(2, Buffer.alloc(70000));
    assert.equal(big[1], 127);
    assert.equal(big.readBigUInt64BE(2), 70000n);
  });

  it("parses masked text, split anywhere, and joins fragments", () => {
    const p = new FrameParser();
    const f = clientFrame(1, Buffer.from('{"a":1}'));
    const out = [...f].flatMap((b) => p.push(Buffer.from([b])));
    assert.equal(out.length, 1);
    assert.ok(out[0]!.type === "message" && out[0]!.data.toString() === '{"a":1}');
    const q = new FrameParser();
    const ev = q.push(
      Buffer.concat([
        clientFrame(1, Buffer.from("ab"), { fin: false }),
        clientFrame(9, Buffer.from("p")),
        clientFrame(0, Buffer.from("cd")),
      ]),
    );
    assert.deepEqual(
      ev.map((e) => e.type),
      ["ping", "message"],
    );
    assert.ok(ev[1]!.type === "message" && ev[1]!.data.toString() === "abcd");
  });

  it("parses empty frames at the end of the input (an empty pong, ping or close)", () => {
    for (const op of [10, 9, 8, 1]) {
      const ev = new FrameParser().push(clientFrame(op, Buffer.alloc(0)));
      assert.equal(ev.length, 1, String(op));
    }
  });

  it("stops at a close frame", () => {
    const p = new FrameParser();
    const close = Buffer.alloc(2);
    close.writeUInt16BE(1000);
    const ev = p.push(Buffer.concat([clientFrame(8, close), clientFrame(1, Buffer.from("x"))]));
    assert.deepEqual(
      ev.map((e) => e.type),
      ["close"],
    );
    assert.equal(codeOf(() => new FrameParser().push(clientFrame(8, Buffer.from([3])))), 1002);
  });

  it("refuses RSV bits (no permessage-deflate), unmasked frames and bad control frames", () => {
    assert.equal(codeOf(() => new FrameParser().push(clientFrame(1, Buffer.from("x"), { rsv: 4 }))), 1002);
    assert.equal(codeOf(() => new FrameParser().push(clientFrame(1, Buffer.from("x"), { mask: false }))), 1002);
    assert.equal(codeOf(() => new FrameParser().push(clientFrame(9, Buffer.alloc(126)))), 1002);
    assert.equal(codeOf(() => new FrameParser().push(clientFrame(9, Buffer.alloc(1), { fin: false }))), 1002);
    assert.equal(codeOf(() => new FrameParser().push(clientFrame(3, Buffer.alloc(1)))), 1002);
    assert.equal(codeOf(() => new FrameParser().push(clientFrame(0, Buffer.alloc(1)))), 1002);
    assert.equal(
      codeOf(() => new FrameParser().push(Buffer.concat([clientFrame(1, Buffer.from("a"), { fin: false }), clientFrame(1, Buffer.from("b"))]))),
      1002,
    );
  });

  it("refuses an oversized message from its header alone (1009)", () => {
    assert.equal(codeOf(() => new FrameParser(100).push(clientFrame(1, Buffer.alloc(0), { length: 101 }).subarray(0, 4))), 1009);
    assert.equal(codeOf(() => new FrameParser().push(clientFrame(1, Buffer.alloc(0), { length: 2 ** 53 }).subarray(0, 10))), 1009);
    const p = new FrameParser(100);
    p.push(clientFrame(1, Buffer.alloc(60), { fin: false }));
    assert.equal(codeOf(() => p.push(clientFrame(0, Buffer.alloc(41)))), 1009);
  });

  it("refuses text that is not UTF-8 (1007)", () => {
    assert.equal(codeOf(() => new FrameParser().push(clientFrame(1, Buffer.from([0xff, 0xfe])))), 1007);
  });
});
