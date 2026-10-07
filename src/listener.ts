// The Unix-socket listener (trust boundary rule 8): anything in the jail can reach the socket,
// so at most `maxHandshakes` connections may be mid-handshake at once (more are closed at
// once), each has `handshakeMs` to send its upgrade (lifted after the 101), the request head
// is capped, and only a WebSocket upgrade on / with the right X-Claude-Code-Ide-Authorization
// is served. One linked session: while `busy()` an upgrade with the right token is refused
// (409), so at most one upgraded connection exists.

import * as fs from "node:fs";
import * as net from "node:net";
import { esc, type Logger } from "./log.ts";
import { checkUpgrade, MAX_HEADER, parseRequestHead, refusal, WsConnection, type WsOptions } from "./websocket.ts";

export const HANDSHAKES_MAX = 4;
export const HANDSHAKE_MS = 10_000;
export const SUN_PATH_MAX = 107;

export interface ListenerOptions {
  socketPath: string;
  token: string;
  logger: Logger;
  onUpgrade(ws: WsConnection, early: Buffer): void;
  /** A session is linked already: refuse the upgrade. */
  busy?(): boolean;
  maxHandshakes?: number;
  handshakeMs?: number;
  ws?: WsOptions;
}

export class Listener {
  readonly server: net.Server;
  private readonly o: ListenerOptions;
  private handshaking = 0;
  private readonly sockets = new Set<net.Socket>();

  private constructor(server: net.Server, o: ListenerOptions) {
    this.server = server;
    this.o = o;
  }

  /** Listen on `socketPath` (mode 0600; EADDRINUSE if anything is there already). */
  static async listen(o: ListenerOptions): Promise<Listener> {
    if (Buffer.byteLength(o.socketPath) > SUN_PATH_MAX) {
      throw new Error(`the socket path would be longer than ${SUN_PATH_MAX} bytes (move the workspace to a shorter path): ${o.socketPath}`);
    }
    const server = net.createServer({ allowHalfOpen: false, pauseOnConnect: false });
    const l = new Listener(server, o);
    server.on("connection", (s) => l.accept(s));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      // the socket file takes its mode from the umask at bind(), which listen() does now:
      // 0600 from the start, never chmod'ed later through a path the jail could swap
      const old = process.umask(0o177);
      try {
        server.listen({ path: o.socketPath }, () => {
          server.off("error", reject);
          resolve();
        });
      } finally {
        process.umask(old);
      }
    });
    const st = fs.lstatSync(o.socketPath);
    if (!st.isSocket() || (st.mode & 0o777) !== 0o600) {
      server.close();
      throw new Error("the socket was not created 0600");
    }
    server.on("error", (err) => o.logger.info(`[ide] listener error: ${esc(String(err))}`));
    return l;
  }

  private accept(sock: net.Socket): void {
    if (this.handshaking >= (this.o.maxHandshakes ?? HANDSHAKES_MAX)) {
      sock.destroy();
      return;
    }
    this.handshaking++;
    let counted = true;
    const release = (): void => {
      if (counted) this.handshaking--;
      counted = false;
    };
    this.sockets.add(sock);
    sock.once("close", () => {
      release();
      this.sockets.delete(sock);
    });
    sock.on("error", () => sock.destroy());
    let head = Buffer.alloc(0);
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        sock.destroy();
      }
    }, this.o.handshakeMs ?? HANDSHAKE_MS);
    timer.unref();
    const refuse = (status: number, reason: string): void => {
      done = true;
      clearTimeout(timer);
      sock.removeListener("data", onData);
      this.o.logger.info(`[ide] refused a connection: ${reason}`);
      sock.end(refusal(status, reason));
      setTimeout(() => sock.destroy(), 1000).unref();
    };
    const onData = (chunk: Buffer): void => {
      if (done) return;
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) {
        if (head.length > MAX_HEADER) refuse(431, "request head too large");
        return;
      }
      if (end > MAX_HEADER) {
        refuse(431, "request head too large");
        return;
      }
      const req = parseRequestHead(head.subarray(0, end).toString("latin1"));
      if (req === null) {
        refuse(400, "not an HTTP request");
        return;
      }
      const result = checkUpgrade(req, this.o.token);
      if (!result.ok) {
        refuse(result.status, result.reason);
        return;
      }
      if (this.o.busy?.() === true) {
        refuse(409, "another Claude session is linked to this window");
        return;
      }
      done = true;
      clearTimeout(timer);
      release();
      sock.removeListener("data", onData);
      sock.write(result.response);
      const ws = new WsConnection(sock, this.o.ws);
      this.o.onUpgrade(ws, head.subarray(end + 4));
    };
    sock.on("data", onData);
  }

  /** Connections still in their handshake. */
  get handshakes(): number {
    return this.handshaking;
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
