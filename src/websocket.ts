// A server-side WebSocket (RFC 6455) over a node:net socket, hand-written so the code at the
// trust boundary is all ours. Only what Claude Code needs: text messages, ping/pong, close.
// No extensions are ever negotiated (permessage-deflate is refused by not echoing it), so a
// frame with an RSV bit set is a protocol error. Limits (trust boundary rule 8): a message is
// at most `maxMessage` bytes, checked from the frame header before any payload is buffered
// (so one incomplete frame never holds more than that); output is under backpressure (reading
// pauses while more than `highWater` bytes wait to be sent) and capped (`maxQueued`: past it
// the connection is dropped); and a ping every `pingMs` drops a client that has sent no frame
// since the previous one.

import { createHash, timingSafeEqual } from "node:crypto";
import type { Socket } from "node:net";

export const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
export const MAX_MESSAGE = 16 * 1024 * 1024;
export const MAX_HEADER = 16 * 1024;
export const DRAIN_MS = 2000;
export const HIGH_WATER = 1024 * 1024;
export const MAX_QUEUED = 32 * 1024 * 1024;
export const PING_MS = 30_000;

export const OP_CONT = 0x0;
export const OP_TEXT = 0x1;
export const OP_BIN = 0x2;
export const OP_CLOSE = 0x8;
export const OP_PING = 0x9;
export const OP_PONG = 0xa;

/** One unmasked, unfragmented server frame. */
export function encodeFrame(opcode: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const n = payload.length;
  let head: Buffer;
  if (n < 126) {
    head = Buffer.from([0x80 | opcode, n]);
  } else if (n < 0x10000) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(n, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(n), 2);
  }
  return Buffer.concat([head, payload]);
}

export function acceptKey(key: string): string {
  return createHash("sha1").update(key + WS_GUID).digest("base64");
}

/** Constant-time comparison of a presented token with ours (any lengths). */
export function tokenMatches(given: string, ours: string): boolean {
  const a = createHash("sha256").update(given, "utf8").digest();
  const b = createHash("sha256").update(ours, "utf8").digest();
  return timingSafeEqual(a, b) && given.length === ours.length;
}

// ---------------------------------------------------------------- handshake

export interface UpgradeRequest {
  method: string;
  path: string;
  version: string;
  /** Header values by lower-cased name, in the order sent. Null-prototype: never `__proto__`. */
  headers: Record<string, string[]>;
}

/** Parse the head of an HTTP request (everything before the blank line), or null. */
export function parseRequestHead(head: string): UpgradeRequest | null {
  const lines = head.split("\r\n");
  const m = /^([A-Z]+) (\S+) (HTTP\/1\.[01])$/.exec(lines[0] ?? "");
  if (!m) return null;
  const headers: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  for (const line of lines.slice(1)) {
    if (line === "") continue;
    const i = line.indexOf(":");
    if (i <= 0) return null;
    const name = line.slice(0, i).trim().toLowerCase();
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) return null;
    const value = line.slice(i + 1).trim();
    (headers[name] ??= []).push(value);
  }
  return { method: m[1]!, path: m[2]!, version: m[3]!, headers };
}

export type HandshakeResult =
  | { ok: true; response: string }
  | { ok: false; status: number; reason: string };

/** Check an upgrade request against our token; the 101 response, or why it is refused. */
export function checkUpgrade(req: UpgradeRequest, token: string): HandshakeResult {
  const h = req.headers;
  const one = (name: string): string => h[name]?.[0] ?? "";
  if (req.method !== "GET" || req.path !== "/") {
    return { ok: false, status: 404, reason: "not served here" };
  }
  const auth = h["x-claude-code-ide-authorization"] ?? [];
  // exactly one token header: two (even both right) are refused
  if (auth.length !== 1 || !tokenMatches(auth[0]!, token)) {
    return { ok: false, status: 401, reason: "missing or wrong X-Claude-Code-Ide-Authorization" };
  }
  const key = one("sec-websocket-key");
  const conn = one("connection").split(",").map((t) => t.trim().toLowerCase());
  if (
    one("upgrade").toLowerCase() !== "websocket" ||
    !conn.includes("upgrade") ||
    one("sec-websocket-version") !== "13" ||
    !/^[A-Za-z0-9+/]{22}==$/.test(key)
  ) {
    return { ok: false, status: 400, reason: "expected a WebSocket upgrade" };
  }
  const protocols = (h["sec-websocket-protocol"] ?? []).flatMap((v) => v.split(",").map((p) => p.trim()));
  // no Sec-WebSocket-Extensions: permessage-deflate, which Claude offers, is refused
  const response =
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n` +
    (protocols.includes("mcp") ? "Sec-WebSocket-Protocol: mcp\r\n" : "") +
    "\r\n";
  return { ok: true, response };
}

export function refusal(status: number, reason: string): string {
  const text: Record<number, string> = {
    400: "Bad Request",
    401: "Unauthorized",
    404: "Not Found",
    409: "Conflict",
    431: "Request Header Fields Too Large",
  };
  const body = reason + "\n";
  return (
    `HTTP/1.1 ${status} ${text[status] ?? "Error"}\r\nContent-Type: text/plain; charset=utf-8\r\n` +
    `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
  );
}

// ---------------------------------------------------------------- frames

export class ProtocolError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export type FrameEvent =
  | { type: "message"; opcode: number; data: Buffer }
  | { type: "ping"; data: Buffer }
  | { type: "pong" }
  | { type: "close"; data: Buffer };

/**
 * Incremental frame parser for frames from a client. `push` returns the events the new bytes
 * complete, and throws ProtocolError (with the close code) for anything RFC 6455 forbids,
 * a message over the limit (1009, decided from the header alone) or text that is not UTF-8
 * (1007).
 */
export class FrameParser {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private parts: Buffer[] | null = null;
  private partOp = 0;
  private partLen = 0;
  private readonly maxMessage: number;

  constructor(maxMessage = MAX_MESSAGE) {
    this.maxMessage = maxMessage;
  }

  private peek(n: number): Buffer {
    if (this.chunks.length === 1 || this.chunks[0]!.length >= n) return this.chunks[0]!.subarray(0, n);
    const joined = Buffer.concat(this.chunks, this.buffered);
    this.chunks = [joined];
    return joined.subarray(0, n);
  }

  private take(n: number): Buffer {
    if (n === 0) return Buffer.alloc(0); // an empty payload, maybe with nothing left buffered
    const out = Buffer.from(this.peek(n));
    let left = n;
    while (left > 0) {
      const c = this.chunks[0]!;
      if (c.length <= left) {
        this.chunks.shift();
        left -= c.length;
      } else {
        this.chunks[0] = c.subarray(left);
        left = 0;
      }
    }
    this.buffered -= n;
    return out;
  }

  push(chunk: Buffer): FrameEvent[] {
    if (chunk.length) {
      this.chunks.push(chunk);
      this.buffered += chunk.length;
    }
    const events: FrameEvent[] = [];
    for (;;) {
      if (this.buffered < 2) return events;
      const h = this.peek(2);
      const b0 = h[0]!;
      const b1 = h[1]!;
      const fin = (b0 & 0x80) !== 0;
      const op = b0 & 0x0f;
      if (b0 & 0x70) throw new ProtocolError(1002, "reserved bits set (no extension was negotiated)");
      if (!(b1 & 0x80)) throw new ProtocolError(1002, "client frames must be masked");
      let len = b1 & 0x7f;
      let headLen = 2;
      if (len === 126) {
        if (this.buffered < 4) return events;
        len = this.peek(4).readUInt16BE(2);
        headLen = 4;
      } else if (len === 127) {
        if (this.buffered < 10) return events;
        const big = this.peek(10).readBigUInt64BE(2);
        if (big > BigInt(this.maxMessage)) throw new ProtocolError(1009, "message too big");
        len = Number(big);
        headLen = 10;
      }
      if (op >= 0x8) {
        if (!fin || len > 125) throw new ProtocolError(1002, "bad control frame");
      } else if ((op === OP_CONT ? this.partLen : 0) + len > this.maxMessage) {
        throw new ProtocolError(1009, "message too big");
      }
      if (this.buffered < headLen + 4 + len) return events;
      this.take(headLen);
      const key = this.take(4);
      const payload = this.take(len);
      for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ key[i & 3]!;
      switch (op) {
        case OP_CLOSE:
          if (len === 1) throw new ProtocolError(1002, "bad close payload");
          events.push({ type: "close", data: payload.subarray(0, 2) });
          return events;
        case OP_PING:
          events.push({ type: "ping", data: payload });
          break;
        case OP_PONG:
          events.push({ type: "pong" });
          break;
        case OP_CONT:
          if (this.parts === null) throw new ProtocolError(1002, "continuation without a start");
          this.parts.push(payload);
          this.partLen += len;
          if (fin) {
            const data = Buffer.concat(this.parts, this.partLen);
            const opcode = this.partOp;
            this.parts = null;
            this.partLen = 0;
            events.push(this.message(opcode, data));
          }
          break;
        case OP_TEXT:
        case OP_BIN:
          if (this.parts !== null) throw new ProtocolError(1002, "new message inside a fragmented one");
          if (fin) {
            events.push(this.message(op, payload));
          } else {
            this.parts = [payload];
            this.partOp = op;
            this.partLen = len;
          }
          break;
        default:
          throw new ProtocolError(1002, "unknown opcode");
      }
    }
  }

  private message(opcode: number, data: Buffer): FrameEvent {
    if (opcode === OP_TEXT) {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(data);
      } catch {
        throw new ProtocolError(1007, "text that is not UTF-8");
      }
    }
    return { type: "message", opcode, data };
  }
}

// ---------------------------------------------------------------- connection

export interface WsHandlers {
  onText(text: string): void;
  onClose(): void;
}

export interface WsOptions {
  maxMessage?: number;
  /** Stop reading the client while more than this many bytes wait to be sent to it. */
  highWater?: number;
  /** Drop the client when more than this many bytes wait to be sent to it. */
  maxQueued?: number;
  /** Ping this often; a client that sent no frame (a pong counts) since the last ping is dropped. */
  pingMs?: number;
}

/** An upgraded connection: frames in through FrameParser, text frames out. */
export class WsConnection {
  private readonly socket: Socket;
  private readonly parser: FrameParser;
  private readonly highWater: number;
  private readonly maxQueued: number;
  private readonly pingMs: number;
  private handlers: WsHandlers | null = null;
  private pending: Buffer[] = [];
  private closed = false;
  private notified = false;
  private heard = true;
  private pinger: NodeJS.Timeout | undefined;

  constructor(socket: Socket, o: WsOptions = {}) {
    this.socket = socket;
    this.parser = new FrameParser(o.maxMessage ?? MAX_MESSAGE);
    this.highWater = o.highWater ?? HIGH_WATER;
    this.maxQueued = o.maxQueued ?? MAX_QUEUED;
    this.pingMs = o.pingMs ?? PING_MS;
    socket.on("data", (chunk: Buffer) => this.receive(chunk));
    // backpressure: reading resumes once what we queued has gone
    socket.on("drain", () => {
      if (!this.closed && !socket.destroyed) socket.resume();
    });
    socket.on("close", () => this.finish());
    socket.on("error", () => this.finish());
  }

  /** Start delivering messages (bytes that arrived before this are delivered now). */
  start(handlers: WsHandlers, early?: Buffer): void {
    this.handlers = handlers;
    if (early && early.length) this.pending.push(early);
    const queued = this.pending;
    this.pending = [];
    for (const b of queued) this.receive(b);
    if (this.closed || this.socket.destroyed) {
      this.finish();
      return;
    }
    this.pinger = setInterval(() => this.ping(), this.pingMs);
    this.pinger.unref();
  }

  /** Bytes waiting to be sent to the client. */
  get queued(): number {
    return this.socket.writableLength;
  }

  private ping(): void {
    if (this.closed) return;
    if (!this.heard) {
      this.destroy(); // nothing since the last ping, not even its pong
      return;
    }
    this.heard = false;
    this.write(encodeFrame(OP_PING));
  }

  get alive(): boolean {
    return !this.closed && !this.socket.destroyed;
  }

  private receive(chunk: Buffer): void {
    if (this.closed) return;
    if (this.handlers === null) {
      this.pending.push(chunk);
      return;
    }
    let events: FrameEvent[];
    try {
      events = this.parser.push(chunk);
    } catch (err) {
      this.fail(err instanceof ProtocolError ? err.code : 1011);
      return;
    }
    if (events.length) this.heard = true;
    for (const ev of events) {
      if (this.closed) return;
      switch (ev.type) {
        case "message":
          if (ev.opcode === OP_TEXT) {
            try {
              this.handlers.onText(ev.data.toString("utf8"));
            } catch {
              // a handler bug never takes the connection down
            }
          }
          break;
        case "ping":
          this.write(encodeFrame(OP_PONG, ev.data));
          break;
        case "pong":
          break;
        case "close":
          this.write(encodeFrame(OP_CLOSE, ev.data)); // echo its status code
          this.closed = true;
          this.socket.end();
          this.finish();
          return;
      }
    }
  }

  private write(frame: Buffer): boolean {
    if (this.closed || this.socket.destroyed) return false;
    const flowing = this.socket.write(frame);
    const q = this.socket.writableLength;
    if (q > this.maxQueued) {
      this.destroy(); // a client that does not read cannot grow our memory
      return false;
    }
    // read no more requests until it drains ('drain' follows a write that returned false)
    if (!flowing && q > this.highWater) this.socket.pause();
    return true;
  }

  sendText(text: string): boolean {
    return this.write(encodeFrame(OP_TEXT, Buffer.from(text, "utf8")));
  }

  /** Close with `code`: no frame follows; the client gets DRAIN_MS to read it and go. */
  close(code = 1000): void {
    if (this.closed) return;
    const p = Buffer.alloc(2);
    p.writeUInt16BE(code);
    this.write(encodeFrame(OP_CLOSE, p));
    this.closed = true;
    this.socket.end();
    const t = setTimeout(() => this.socket.destroy(), DRAIN_MS);
    t.unref();
    this.finish();
  }

  private fail(code: number): void {
    this.close(code);
  }

  /** Drop at once, without a close frame. */
  destroy(): void {
    this.closed = true;
    this.socket.destroy();
    this.finish();
  }

  private finish(): void {
    this.closed = true;
    clearInterval(this.pinger);
    if (this.notified || this.handlers === null) return;
    this.notified = true;
    this.handlers.onClose();
  }
}
