// A WebSocket client for the tests, able to send what a real client never would: unmasked
// frames, RSV bits, lengths that lie, raw bytes.

import { randomBytes } from "node:crypto";
import * as net from "node:net";

export const CLAUDE_HEADERS: Record<string, string> = {
  "Sec-WebSocket-Protocol": "mcp",
  "Sec-WebSocket-Extensions": "permessage-deflate; client_max_window_bits",
  "User-Agent": "claude-code/2.1.292 (cli)",
};

export interface Frame {
  op: number;
  payload: Buffer;
}

export interface FrameOpts {
  fin?: boolean;
  rsv?: number;
  mask?: boolean;
  /** Claim this payload length in the header (the payload sent is still `payload`). */
  length?: number;
}

export function clientFrame(op: number, payload: Buffer, o: FrameOpts = {}): Buffer {
  const n = o.length ?? payload.length;
  const b0 = ((o.fin ?? true) ? 0x80 : 0) | ((o.rsv ?? 0) << 4) | op;
  const maskBit = (o.mask ?? true) ? 0x80 : 0;
  let head: Buffer;
  if (n < 126) head = Buffer.from([b0, maskBit | n]);
  else if (n < 0x10000) {
    head = Buffer.alloc(4);
    head[0] = b0;
    head[1] = maskBit | 126;
    head.writeUInt16BE(n, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = b0;
    head[1] = maskBit | 127;
    head.writeBigUInt64BE(BigInt(n), 2);
  }
  if (!(o.mask ?? true)) return Buffer.concat([head, payload]);
  const key = randomBytes(4);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] = body[i]! ^ key[i & 3]!;
  return Buffer.concat([head, key, body]);
}

export class Client {
  readonly sock: net.Socket;
  status = 0;
  head = "";
  headers: Record<string, string> = {};
  frames: Frame[] = [];
  closed = false;
  /** Answer the server's pings, as a real client does. */
  autoPong = false;
  private buf = Buffer.alloc(0);
  private upgraded = false;

  private constructor(sock: net.Socket) {
    this.sock = sock;
    sock.on("data", (c: Buffer) => this.onData(c));
    sock.on("close", () => {
      this.closed = true;
    });
    sock.on("error", () => undefined);
  }

  /** Connect to a Unix socket path, or to 127.0.0.1:<port> (as Claude in the jail does). */
  static connect(target: string | number): Promise<Client> {
    return new Promise((resolve, reject) => {
      const s = typeof target === "number" ? net.connect({ host: "127.0.0.1", port: target }) : net.connect({ path: target });
      s.once("connect", () => resolve(new Client(s)));
      s.once("error", reject);
    });
  }

  /** Connect and upgrade as Claude Code does; resolves once the status line is read. */
  static async open(path: string | number, token: string | null, extra: Record<string, string> = {}): Promise<Client> {
    const c = await Client.connect(path);
    const h: Record<string, string> = {
      Host: "127.0.0.1",
      Upgrade: "websocket",
      Connection: "Upgrade",
      "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
      "Sec-WebSocket-Version": "13",
      ...CLAUDE_HEADERS,
      ...extra,
    };
    if (token !== null) h["X-Claude-Code-Ide-Authorization"] = token;
    c.raw("GET / HTTP/1.1\r\n" + Object.entries(h).map(([k, v]) => `${k}: ${v}\r\n`).join("") + "\r\n");
    await c.until(() => c.status !== 0 || c.closed, 5000);
    return c;
  }

  raw(data: string | Buffer): void {
    this.sock.write(data);
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    if (!this.upgraded) {
      const end = this.buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      this.head = this.buf.subarray(0, end).toString("latin1");
      const lines = this.head.split("\r\n");
      this.status = Number(/^HTTP\/1\.[01] (\d+)/.exec(lines[0] ?? "")?.[1] ?? -1);
      for (const l of lines.slice(1)) {
        const i = l.indexOf(":");
        this.headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
      }
      this.buf = this.buf.subarray(end + 4);
      this.upgraded = true;
      if (this.status !== 101) this.buf = Buffer.alloc(0);
    }
    for (;;) {
      if (this.buf.length < 2) break;
      let n = this.buf[1]! & 0x7f;
      let off = 2;
      if (n === 126) {
        if (this.buf.length < 4) break;
        n = this.buf.readUInt16BE(2);
        off = 4;
      } else if (n === 127) {
        if (this.buf.length < 10) break;
        n = Number(this.buf.readBigUInt64BE(2));
        off = 10;
      }
      if (this.buf.length < off + n) break;
      const frame = { op: this.buf[0]! & 0x0f, payload: Buffer.from(this.buf.subarray(off, off + n)) };
      this.frames.push(frame);
      if (frame.op === 9 && this.autoPong && !this.closed) this.raw(clientFrame(10, frame.payload));
      this.buf = this.buf.subarray(off + n);
    }
  }

  /** Wait until `pred` holds (checked on every frame and every 10 ms), or the timeout. */
  until(pred: () => boolean, timeoutMs = 5000): Promise<boolean> {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const tick = (): void => {
        if (pred()) resolve(true);
        else if (Date.now() >= deadline) resolve(false);
        else setTimeout(tick, 10);
      };
      tick();
    });
  }

  send(msg: unknown): void {
    this.sendText(JSON.stringify(msg));
  }

  sendText(text: string): void {
    this.raw(clientFrame(1, Buffer.from(text, "utf8")));
  }

  msgs(): Record<string, unknown>[] {
    return this.frames.filter((f) => f.op === 1).map((f) => JSON.parse(f.payload.toString("utf8")) as Record<string, unknown>);
  }

  closeCodes(): number[] {
    return this.frames.filter((f) => f.op === 8).map((f) => (f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005));
  }

  async reply(id: unknown, timeoutMs = 5000): Promise<Record<string, unknown> | undefined> {
    const find = (): Record<string, unknown> | undefined =>
      this.msgs().find((m) => m.id === id && !("method" in m));
    await this.until(() => find() !== undefined, timeoutMs);
    return find();
  }

  async call(msg: Record<string, unknown>, timeoutMs = 5000): Promise<Record<string, unknown> | undefined> {
    this.send(msg);
    return this.reply(msg.id, timeoutMs);
  }

  /** Claude Code 2.1.292's opening frames; returns [initialize reply, tools/list reply]. */
  async handshake(): Promise<[Record<string, unknown> | undefined, Record<string, unknown> | undefined]> {
    this.send(INITIALIZE);
    this.send(INITIALIZED);
    this.send(IDE_CONNECTED);
    this.send(TOOLS_LIST);
    return [await this.reply(0), await this.reply(1)];
  }

  end(): void {
    this.sock.destroy();
  }
}

export const INITIALIZE = {
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: { roots: { listChanged: true }, elicitation: {} },
    clientInfo: { name: "claude-code", title: "Claude Code", version: "2.1.292" },
  },
  jsonrpc: "2.0",
  id: 0,
};
export const INITIALIZED = { jsonrpc: "2.0", method: "notifications/initialized" };
export const IDE_CONNECTED = { jsonrpc: "2.0", method: "ide_connected", params: { pid: 1230101 } };
export const TOOLS_LIST = { method: "tools/list", jsonrpc: "2.0", id: 1 };

export function toolCall(id: number, name: string, args: unknown): Record<string, unknown> {
  return { method: "tools/call", params: { name, arguments: args, _meta: { progressToken: id } }, jsonrpc: "2.0", id };
}

export function openDiff(id: number, path: string, contents: string, tab = "✻ [Claude Code] target.md ⧉"): Record<string, unknown> {
  return toolCall(id, "openDiff", { old_file_path: path, new_file_path: path, new_file_contents: contents, tab_name: tab });
}

export function texts(reply: Record<string, unknown> | undefined): string[] {
  const r = reply?.result as { content?: { text: string }[] } | undefined;
  return (r?.content ?? []).map((c) => c.text);
}

export function isError(reply: Record<string, unknown> | undefined): boolean {
  return (reply?.result as { isError?: boolean } | undefined)?.isError === true;
}
