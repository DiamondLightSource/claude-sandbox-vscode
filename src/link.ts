// One IDE link: a token, a Unix socket in its (first) folder, the MCP bridge on the
// one upgraded connection, and the --settings that make the sandboxed Claude Code relay to
// the socket and write its own lock file. No vscode import: tests drive it with fakes.

import { randomBytes, randomInt } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Listener } from "./listener.ts";
import { esc, type Logger } from "./log.ts";
import { Bridge, type DiagnosticsSource, type DiffPresenter, type LinkState } from "./mcp.ts";
import { Workspace } from "./paths.ts";
import { linkSettings, PORT_MAX, PORT_MIN, type LinkSettings } from "./settings.ts";
import type { WsConnection, WsOptions } from "./websocket.ts";
import * as dirfd from "./dirfd.ts";

export function socketName(port: number): string {
  return `.claude-sandbox-vscode-${port}.sock`;
}

export interface LinkOptions {
  folders: readonly string[];
  presenter: DiffPresenter;
  diagnostics: DiagnosticsSource;
  logger: Logger;
  version?: string;
  onState?: (state: LinkState) => void;
  /** Test seams. */
  pickPort?: () => number;
  maxHandshakes?: number;
  handshakeMs?: number;
  ws?: WsOptions;
}

export class LinkUnavailable extends Error {}

export class IdeLink {
  readonly port: number;
  readonly token: string;
  readonly socketPath: string;
  readonly settings: LinkSettings;
  readonly bridge: Bridge;
  private readonly listener: Listener;
  private readonly current: { ws: WsConnection | null };

  private constructor(
    port: number,
    token: string,
    socketPath: string,
    settings: LinkSettings,
    bridge: Bridge,
    listener: Listener,
    current: { ws: WsConnection | null },
  ) {
    this.port = port;
    this.token = token;
    this.socketPath = socketPath;
    this.settings = settings;
    this.bridge = bridge;
    this.listener = listener;
    this.current = current;
  }

  static async start(o: LinkOptions): Promise<IdeLink> {
    if (!dirfd.supported()) throw new LinkUnavailable("The IDE link needs Linux (/proc/self/fd and O_NOFOLLOW).");
    if (o.folders.length === 0) throw new LinkUnavailable("The IDE link needs a workspace folder.");
    const workspace = new Workspace(o.folders);
    const root = workspace.folders[0]!;
    const token = randomBytes(32).toString("hex");
    const bridge = new Bridge({
      workspace,
      presenter: o.presenter,
      diagnostics: o.diagnostics,
      logger: o.logger,
      ...(o.version !== undefined ? { version: o.version } : {}),
      ...(o.onState !== undefined ? { onState: o.onState } : {}),
    });
    // the one linked connection (null when none): while it is open, others are refused
    const current: { ws: WsConnection | null } = { ws: null };
    const pick = o.pickPort ?? (() => randomInt(PORT_MIN, PORT_MAX));
    for (let attempt = 0; attempt < 20; attempt++) {
      const port = pick();
      const sock = path.join(root, socketName(port));
      // anything at that name (a planted symlink included) means another port
      if (lexists(sock)) continue;
      // fails before listening on a path that could not go into a hook command
      const settings = linkSettings(port, token, sock, workspace.folders);
      let listener: Listener;
      try {
        listener = await Listener.listen({
          socketPath: sock,
          token,
          logger: o.logger,
          ...(o.maxHandshakes !== undefined ? { maxHandshakes: o.maxHandshakes } : {}),
          ...(o.handshakeMs !== undefined ? { handshakeMs: o.handshakeMs } : {}),
          ...(o.ws !== undefined ? { ws: o.ws } : {}),
          busy: () => current.ws !== null || bridge.linked,
          onUpgrade: (ws, early) => {
            const conn = bridge.attach({ send: (t) => ws.sendText(t), drop: () => ws.close(1001) });
            if (conn === null) {
              ws.close(1013);
              return;
            }
            current.ws = ws;
            ws.start(
              {
                onText: (t) => bridge.receive(conn, t),
                onClose: () => {
                  if (current.ws === ws) current.ws = null;
                  bridge.detach(conn);
                },
              },
              early,
            );
          },
        });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") continue;
        throw new LinkUnavailable(`The IDE link cannot listen: ${esc(String(err))}`);
      }
      o.logger.info(`[ide] listening on ${esc(sock)}`);
      return new IdeLink(port, token, sock, settings, bridge, listener, current);
    }
    throw new LinkUnavailable("The IDE link found no free port.");
  }

  get workspace(): Workspace {
    return this.bridge.workspace;
  }

  /** The window's workspace folders changed (the lock's workspaceFolders stay as they were). */
  setFolders(folders: readonly string[]): void {
    this.bridge.setFolders(folders);
  }

  /** Whether a Claude session is linked (an upgraded connection is open). */
  get linked(): boolean {
    return this.current.ws !== null;
  }

  /** Bytes waiting to be sent to the linked session. */
  get queued(): number {
    return this.current.ws?.queued ?? 0;
  }

  /** End the link: waiting diffs rejected, connections dropped, the socket removed. */
  async close(): Promise<void> {
    this.bridge.close();
    // libuv unlinks the socket by the exact path it bound when the server closes; the host
    // deletes nothing else in the (jail-writable) workspace
    await this.listener.close();
  }
}

function lexists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}
