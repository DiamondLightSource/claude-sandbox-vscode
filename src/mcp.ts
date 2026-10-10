// Claude Code's IDE protocol: MCP (JSON-RPC 2.0), one message per WebSocket text frame.
// Ported from md-collab-editor's IdeBridge. Everything that arrives is hostile (trust
// boundary): only four tools exist (rule 1), openDiff reads only files the path policy
// allows (rule 2), the extension never writes a file (rule 3), diagnostics and selections
// only for workspace files and their peers' (rules 4, 5), and parsed JSON is only ever read through `own()`,
// never merged into objects (rule 8).
//
// Protocol notes (Claude Code 2.1.280 / 2.1.292):
// - On connect, within ~10 ms: initialize (id 0), notifications/initialized, ide_connected
//   {pid} (a notification: never answered), tools/list (id 1).
// - selection_changed must always carry a `selection` object (Claude ignores one without),
//   and Claude only listens a moment after ide_connected: the selection is sent twice.
// - An openDiff answer of TAB_CLOSED that does not answer a close_tab is an ACCEPT of the
//   proposal unchanged, so closing a diff tab answers DIFF_REJECTED. FILE_SAVED with the
//   file's own text counts as a rejection.
// - One linked session: while a connection is open, another is refused (a standalone Claude
//   that finds the lock cannot take the linked session's place); a reconnect after it closes
//   is accepted. The listener refuses it before the upgrade; attach() refuses it again.
//   Observed with 2.1.292: `/ide` choosing the IDE it is connected to opens no connection
//   (it reports "Connected" with the old one kept); None closes it, and choosing ours again
//   reconnects; a second Claude refused with 409 shows "Failed to connect" and does not retry.
// - Output sizes: the largest answer is FILE_SAVED with the accepted text, so the text is
//   capped (PROPOSAL_MAX, derived from the output cap) so that answer always fits under
//   MAX_QUEUED, even JSON-escaped at its worst and with HIGH_WATER queued already.

import { isObj, own } from "./json.ts";
import { esc, type Logger } from "./log.ts";
import { peerRoot, Workspace } from "./paths.ts";
import { HIGH_WATER, MAX_QUEUED } from "./websocket.ts";

/** JSON.stringify writes a byte of UTF-8 text as at most 6 (a control character: \u00XX). */
export const JSON_ESCAPE_MAX = 6;
/** A string JSON-RPC id is at most this long (Claude's are numbers). */
export const ID_MAX = 256;
/** Room for an answer's envelope around the text: jsonrpc, the id (escaped), result, frame head. */
export const ENVELOPE_MAX = 4096;
/**
 * The most bytes (UTF-8) of text an openDiff proposal, or the text the user accepts, may have:
 * what fits in the output cap (MAX_QUEUED) when escaped at its worst, behind HIGH_WATER bytes
 * already queued (reading the client stops past that), with the envelope around it.
 */
export const PROPOSAL_MAX = Math.floor((MAX_QUEUED - HIGH_WATER - ENVELOPE_MAX) / JSON_ESCAPE_MAX);

const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];
export const DIFFS_MAX = 16;
export const RESEND_MS = 500;
/** How long an ask waits for Claude to answer its ping. */
export const PING_MS = 2000;
/** Our request ids (pings), never a number: Claude's own requests to us use numbers. */
export const PING_PREFIX = "csv-ping-";

const INSTRUCTIONS =
  "You are attached to VS Code through claude-sandbox-vscode. When the user has text selected " +
  "in the editor, the selection is attached to their prompt. Proposed edits may be shown to " +
  "the user as a diff in VS Code, where they accept or reject them.";

const str = { type: "string" } as const;
export const TOOLS = [
  {
    name: "openDiff",
    description: "Show a proposed change to a file in VS Code as a diff, and wait for the user to accept or reject it",
    inputSchema: {
      type: "object",
      properties: {
        old_file_path: { ...str, description: "The file's absolute path" },
        new_file_path: { ...str, description: "The same path" },
        new_file_contents: { ...str, description: "The whole file as proposed" },
        tab_name: { ...str, description: "The diff's title" },
      },
      required: ["old_file_path", "new_file_contents", "tab_name"],
    },
  },
  {
    name: "close_tab",
    description: "Close a diff opened with openDiff",
    inputSchema: { type: "object", properties: { tab_name: str }, required: ["tab_name"] },
  },
  {
    name: "closeAllDiffTabs",
    description: "Close every diff opened with openDiff",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "getDiagnostics",
    description: "Diagnostics (errors, warnings) for a file URI in the workspace, or for every workspace file",
    inputSchema: { type: "object", properties: { uri: str } },
  },
];

// ---------------------------------------------------------------- interfaces to VS Code

export interface Position {
  line: number;
  character: number;
}

/** A proposed edit for the UI: `old` is the file on disk ("" when it does not exist). */
export interface DiffView {
  id: string;
  file: string;
  title: string;
  old: string;
  proposed: string;
  exists: boolean;
}

export type Decision = { kind: "accept"; contents?: string } | { kind: "reject" } | { kind: "closed" };

export interface DiffPresenter {
  /** Show a proposal; the UI answers later with bridge.decide(id, ...). */
  show(view: DiffView): void;
  /** Close it without an answer (Claude closed it, or its connection went). */
  close(id: string): void;
}

export interface FileDiagnostics {
  uri: string;
  fsPath: string;
  diagnostics: {
    message: string;
    severity: string;
    range: { start: Position; end: Position };
    source?: string;
    code?: string;
  }[];
}

export interface DiagnosticsSource {
  /** Diagnostics for one file (an fsPath already checked by the bridge), or for all files. */
  get(fsPath?: string): FileDiagnostics[];
}

/** One connection from Claude, as the bridge sees it. */
export interface Peer {
  send(text: string): boolean;
  drop(): void;
}

// ---------------------------------------------------------------- helpers

type Msg = Record<string, unknown>;

function rpcResult(id: unknown, result: unknown): Msg {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: unknown, code: number, message: string): Msg {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function toolText(texts: string[], isError = false): Msg {
  const out: Msg = { content: texts.map((text) => ({ type: "text", text })) };
  if (isError) out.isError = true;
  return out;
}

function validId(id: unknown): boolean {
  return (
    id === null || (typeof id === "string" && id.length <= ID_MAX) || (typeof id === "number" && Number.isFinite(id))
  );
}

// ---------------------------------------------------------------- the bridge

interface Conn {
  peer: Peer;
  ready: boolean;
}

interface Waiting {
  id: string;
  conn: Conn;
  rpc: unknown;
  title: string;
  file: string;
  proposed: string;
}

interface Selection {
  text: string;
  filePath?: string;
  fileUrl?: string;
  selection: { start: Position; end: Position; isEmpty: boolean };
}

export type LinkState = "waiting" | "connected" | "off";

export interface BridgeOptions {
  /** Replaced by setFolders. */
  workspace: Workspace;
  /** Test seam: the home folders no peer may be in ($HOME and the passwd entry's). */
  home?: readonly string[];
  presenter: DiffPresenter;
  diagnostics: DiagnosticsSource;
  logger: Logger;
  version?: string;
  onState?: (state: LinkState) => void;
}

export class Bridge {
  private readonly o: BridgeOptions;
  private conn: Conn | null = null;
  private readonly diffs = new Map<string, Waiting>();
  private selection: Selection | null = null;
  private nextDiff = 1;
  private nextPing = 1;
  private readonly pings = new Map<string, { conn: Conn; done: (ok: boolean) => void }>();
  private readonly salt = Math.random().toString(16).slice(2, 10);
  private readable: Workspace;
  state: LinkState = "waiting";

  constructor(options: BridgeOptions) {
    this.o = { ...options };
    this.readable = this.withPeers(this.o.workspace);
  }

  private withPeers(ws: Workspace): Workspace {
    const roots = ws.folders.map((f) => peerRoot(f, this.o.home)).filter((r) => r !== null);
    return new Workspace([...ws.folders, ...roots.filter((r) => Workspace.resolvable(r))]);
  }

  private setState(s: LinkState): void {
    if (this.state === s) return;
    this.state = s;
    this.o.onState?.(s);
  }

  private sendTo(conn: Conn, msg: Msg): boolean {
    return conn.peer.send(JSON.stringify(msg));
  }

  // -- connections

  /** Claude connected (token checked). Null, and the caller closes it, while another is open. */
  attach(peer: Peer): Conn | null {
    if (this.state === "off") return null;
    if (this.conn !== null) {
      this.o.logger.info("[ide] refused a second connection: one Claude session is linked already");
      return null;
    }
    const conn: Conn = { peer, ready: false };
    this.conn = conn;
    return conn;
  }

  get linked(): boolean {
    return this.conn !== null;
  }

  get workspace(): Workspace {
    return this.o.workspace;
  }

  /**
   * The workspace folders and the folders holding them and their peers (rules 4, 5): the files
   * selections, mentions and diagnostics cover, and so the ones an ask sends over the link.
   */
  get reads(): Workspace {
    return this.readable;
  }

  /** The window's folders changed: paths are checked against the new set from now on. */
  setFolders(folders: readonly string[]): void {
    // a folder that cannot be resolved (already gone) is left out
    this.o.workspace = new Workspace(folders.filter((f) => Workspace.resolvable(f)));
    this.readable = this.withPeers(this.o.workspace);
  }

  detach(conn: Conn): void {
    if (this.conn !== conn) return;
    this.conn = null;
    this.endPings(conn);
    // its diffs can no longer be answered
    this.dropDiffs((d) => d.conn === conn);
    if (this.state === "connected") this.setState("waiting");
    this.o.logger.info("[ide] Claude Code disconnected");
  }

  /** Remove the waiting diffs `pick` selects and close their tabs; returns them, unanswered. */
  private dropDiffs(pick: (d: Waiting) => boolean): Waiting[] {
    const hit = [...this.diffs.values()].filter(pick);
    for (const d of hit) {
      this.diffs.delete(d.id);
      this.o.presenter.close(d.id);
    }
    return hit;
  }

  /** End the link: waiting diffs are answered DIFF_REJECTED and closed. */
  close(): void {
    if (this.state === "off") return;
    this.state = "off";
    this.o.onState?.("off");
    const conn = this.conn;
    this.conn = null;
    if (conn !== null) this.endPings(conn);
    for (const d of this.dropDiffs(() => true)) {
      if (d.conn === conn) this.sendTo(d.conn, rpcResult(d.rpc, toolText(["DIFF_REJECTED", d.title])));
    }
    conn?.peer.drop();
  }

  waitingDiffs(): string[] {
    return [...this.diffs.keys()];
  }

  // -- messages from Claude

  receive(conn: Conn, text: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      this.sendTo(conn, rpcError(null, -32700, "parse error"));
      return;
    }
    if (!isObj(msg)) {
      this.sendTo(conn, rpcError(null, -32600, "expected one JSON-RPC message"));
      return;
    }
    const method = own(msg, "method");
    const hasId = Object.hasOwn(msg, "id");
    const rid = own(msg, "id");
    if (method === undefined) {
      // an answer to a request of ours: only pings are sent, under ids of our own
      const ping = typeof rid === "string" ? this.pings.get(rid) : undefined;
      if (ping !== undefined && ping.conn === conn) ping.done(own(msg, "result") !== undefined);
      return;
    }
    if (typeof method !== "string") {
      if (hasId) this.sendTo(conn, rpcError(validId(rid) ? rid : null, -32600, "invalid request"));
      return;
    }
    const p = own(msg, "params");
    const params: Msg = isObj(p) ? p : {};
    if (!hasId) {
      try {
        this.notification(conn, method, params);
      } catch (err) {
        this.o.logger.info(`[ide] error in notification ${esc(method)}: ${esc(String(err))}`);
      }
      return;
    }
    if (!validId(rid)) {
      this.sendTo(conn, rpcError(null, -32600, "invalid id"));
      return;
    }
    let out: Msg | null;
    try {
      out = this.request(conn, rid, method, params);
    } catch (err) {
      this.o.logger.info(`[ide] error in ${esc(method)}: ${esc(String(err))}`);
      out = rpcError(rid, -32603, "internal error");
    }
    if (out !== null) this.sendTo(conn, out);
  }

  private notification(conn: Conn, method: string, params: Msg): void {
    if (method === "notifications/initialized" || method === "ide_connected") {
      if (this.conn !== conn) return;
      conn.ready = true;
      this.setState("connected");
      if (method === "ide_connected") {
        this.o.logger.info(`[ide] Claude Code connected (pid ${esc(own(params, "pid"), 60)}, in the jail)`);
        const sel = this.selection;
        if (sel !== null) {
          // Claude listens for selections only a moment after connecting: send it twice
          this.sendTo(conn, notify("selection_changed", sel));
          const t = setTimeout(() => {
            if (this.conn === conn && this.selection === sel) this.sendTo(conn, notify("selection_changed", sel));
          }, RESEND_MS);
          t.unref();
        }
      }
    } else if (method === "notifications/cancelled") {
      const rid = own(params, "requestId");
      this.dropDiffs((d) => d.conn === conn && d.rpc === rid);
    } else {
      this.o.logger.info(`[ide] ignored notification ${esc(method, 80)}`);
    }
  }

  private request(conn: Conn, rid: unknown, method: string, params: Msg): Msg | null {
    switch (method) {
      case "initialize": {
        const want = own(params, "protocolVersion");
        return rpcResult(rid, {
          protocolVersion: typeof want === "string" && PROTOCOLS.includes(want) ? want : PROTOCOLS[0],
          capabilities: { tools: {} },
          serverInfo: { name: "claude-sandbox-vscode", version: this.o.version ?? "dev" },
          instructions: INSTRUCTIONS,
        });
      }
      case "tools/list":
        return rpcResult(rid, { tools: TOOLS });
      case "ping":
        return rpcResult(rid, {});
      case "tools/call": {
        const args = own(params, "arguments");
        return this.call(conn, rid, own(params, "name"), isObj(args) ? args : {});
      }
      default:
        this.o.logger.info(`[ide] unknown method ${esc(method, 80)}`);
        return rpcError(rid, -32601, "method not found");
    }
  }

  private call(conn: Conn, rid: unknown, name: unknown, args: Msg): Msg | null {
    switch (name) {
      case "getDiagnostics":
        return rpcResult(rid, toolText([JSON.stringify(this.diagnostics(own(args, "uri")))]));
      case "openDiff":
        return this.openDiff(conn, rid, args);
      case "close_tab":
      case "closeAllDiffTabs": {
        const title = own(args, "tab_name");
        const hit = this.dropDiffs((d) => d.conn === conn && (name === "closeAllDiffTabs" || d.title === title));
        // Claude closed it itself (it was answered in the terminal): this changes nothing
        for (const d of hit) this.sendTo(conn, rpcResult(d.rpc, toolText(["TAB_CLOSED"])));
        return rpcResult(rid, toolText(["TAB_CLOSED"]));
      }
      default:
        this.o.logger.info(`[ide] unknown tool ${esc(name, 80)}`);
        return rpcError(rid, -32602, "unknown tool");
    }
  }

  /** Diagnostics for workspace and peer files only, without the host-side fsPath (rule 4). */
  private diagnostics(uri: unknown): { uri: string; diagnostics: FileDiagnostics["diagnostics"] }[] {
    const ws = this.reads;
    let entries: FileDiagnostics[];
    if (uri === undefined || uri === null || uri === "") {
      entries = this.o.diagnostics.get();
    } else {
      const r = ws.resolveUri(uri);
      if (!r.ok) return [];
      entries = this.o.diagnostics.get(r.real);
    }
    // only files inside a workspace folder or a peer, whatever the source returned
    return entries.filter((e) => ws.resolve(e.fsPath).ok).map((e) => ({ uri: e.uri, diagnostics: e.diagnostics }));
  }

  private openDiff(conn: Conn, rid: unknown, args: Msg): Msg | null {
    const old = own(args, "old_file_path");
    const nw = own(args, "new_file_path") ?? old;
    const contents = own(args, "new_file_contents");
    const title = own(args, "tab_name");
    if (
      typeof old !== "string" ||
      typeof nw !== "string" ||
      typeof contents !== "string" ||
      typeof title !== "string"
    ) {
      return rpcError(rid, -32602, "openDiff needs old_file_path, new_file_contents and tab_name");
    }
    const refuse = (why: string): Msg => {
      this.o.logger.info(`[ide] openDiff ${esc(old)} not shown: ${why}`);
      return rpcResult(rid, toolText([why], true));
    };
    // first, so a refusal reads nothing
    if (this.diffs.size >= DIFFS_MAX) return refuse("too many changes are waiting in VS Code");
    if (Buffer.byteLength(contents) > PROPOSAL_MAX)
      return refuse(`VS Code shows changes of at most ${PROPOSAL_MAX} bytes`);
    const ws = this.o.workspace;
    const a = ws.resolve(old);
    if (!a.ok) return refuse(`VS Code shows changes to workspace files only (${a.why})`);
    const b = ws.resolve(nw);
    if (!b.ok || b.real !== a.real) return refuse("VS Code shows changes to one file at a time");
    const disk = ws.readInside(a.real, a.folder); // never through a symlink swapped in since
    if (disk.kind === "refused") return refuse(`VS Code cannot show that file (${disk.why})`);
    if (this.conn !== conn) return null; // it has gone: no one to answer
    const id = `${this.salt}-${this.nextDiff++}`;
    const d: Waiting = { id, conn, rpc: rid, title, file: a.real, proposed: contents };
    this.diffs.set(id, d);
    this.o.logger.info(`[ide] showing a proposed change to ${esc(a.real)}`);
    this.o.presenter.show({ id, file: a.real, title, old: disk.text, proposed: contents, exists: disk.exists });
    return null;
  }

  /**
   * The user's answer to diff `id`. Accept sends Claude the text to write (FILE_SAVED; the
   * extension never writes it); Reject, or closing the tab, sends DIFF_REJECTED (a bare
   * TAB_CLOSED would be an accept). False if `id` is not waiting.
   */
  decide(id: string, decision: Decision): boolean {
    const d = this.diffs.get(id);
    if (d === undefined) return false;
    this.diffs.delete(id);
    let reply: Msg;
    if (decision.kind === "accept") {
      let final = typeof decision.contents === "string" ? decision.contents : d.proposed;
      const lf = d.proposed.replace(/\r\n?/g, "\n");
      if (final === lf || final === d.proposed) {
        final = d.proposed; // unchanged: exactly as Claude proposed it
      } else if (d.proposed.includes("\r\n") && !final.includes("\r")) {
        final = final.replace(/\n/g, "\r\n"); // back to the proposal's line ends
      }
      // the user's own edits can make it larger than any proposal: past the cap it cannot be
      // sent (the link would be dropped), so Claude is told, and nothing is accepted
      reply =
        Buffer.byteLength(final) > PROPOSAL_MAX
          ? toolText([`The accepted file is larger than ${PROPOSAL_MAX} bytes and was not sent.`], true)
          : toolText(["FILE_SAVED", final]);
    } else {
      reply = toolText(["DIFF_REJECTED", d.title]);
    }
    this.sendTo(d.conn, rpcResult(d.rpc, reply));
    this.o.logger.info(`[ide] ${decision.kind === "accept" ? "accepted" : "rejected"} the change to ${esc(d.file)}`);
    return true;
  }

  // -- to Claude

  private live(): Conn | null {
    return this.conn?.ready ? this.conn : null;
  }

  /**
   * The editor's selection. Sent (and remembered) only for a file inside a workspace folder or
   * a peer of one (peerRoot); anywhere else Claude is told to forget the last one: an empty range with no filePath.
   */
  select(fsPath: string, start: Position, end: Position, text: string): void {
    const r = this.reads.resolve(fsPath, { allowGit: true });
    if (!r.ok) {
      this.clearSelection();
      return;
    }
    const [s, e] = before(end, start) ? [end, start] : [start, end];
    const params: Selection = {
      text,
      filePath: fsPath,
      fileUrl: fileUrl(fsPath),
      selection: { start: s, end: e, isEmpty: s.line === e.line && s.character === e.character },
    };
    this.selection = params;
    const conn = this.live();
    if (conn) this.sendTo(conn, notify("selection_changed", params));
  }

  /**
   * Ping Claude and wait for its answer: it answers in order, so it has then handled everything
   * sent before (the selection an ask relies on). False if no session is linked or it does not
   * answer within `ms`.
   */
  ping(ms = PING_MS): Promise<boolean> {
    const conn = this.live();
    if (conn === null) return Promise.resolve(false);
    const id = `${PING_PREFIX}${this.salt}-${this.nextPing++}`;
    return new Promise<boolean>((resolve) => {
      const done = (ok: boolean): void => {
        clearTimeout(timer);
        this.pings.delete(id);
        resolve(ok);
      };
      const timer = setTimeout(() => done(false), ms);
      this.pings.set(id, { conn, done });
      if (!this.sendTo(conn, { jsonrpc: "2.0", id, method: "ping" })) done(false);
    });
  }

  private endPings(conn: Conn): void {
    for (const p of [...this.pings.values()]) if (p.conn === conn) p.done(false);
  }

  /**
   * Put an @-mention of a workspace file (and lines, 0-based, inclusive) into Claude's prompt:
   * at_mentioned, never Enter. Only for a file inside a workspace folder or a peer (not .git); false
   * otherwise, or when no session is linked.
   */
  mention(fsPath: string, lines?: { start: number; end: number }): boolean {
    const r = this.reads.resolve(fsPath);
    const conn = this.live();
    if (!r.ok || conn === null) return false;
    const params: Msg = { filePath: fsPath };
    if (lines !== undefined) {
      params.lineStart = lines.start;
      params.lineEnd = lines.end;
    }
    return this.sendTo(conn, notify("at_mentioned", params));
  }

  clearSelection(): boolean {
    if (this.selection === null) return false;
    this.selection = null;
    const conn = this.live();
    if (!conn) return false;
    const zero = { line: 0, character: 0 };
    return this.sendTo(
      conn,
      notify("selection_changed", { text: "", selection: { start: zero, end: zero, isEmpty: true } }),
    );
  }
}

function before(a: Position, b: Position): boolean {
  return a.line < b.line || (a.line === b.line && a.character < b.character);
}

function notify(method: string, params: unknown): Msg {
  return { jsonrpc: "2.0", method, params };
}

function fileUrl(p: string): string {
  return "file://" + p.split("/").map(encodeURIComponent).join("/");
}
