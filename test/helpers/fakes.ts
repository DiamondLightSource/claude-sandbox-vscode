// Fakes for the VS Code side, and temp workspaces.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Logger } from "../../src/log.ts";
import type { DiagnosticsSource, DiffPresenter, DiffView, FileDiagnostics, Peer } from "../../src/mcp.ts";

export class FakePresenter implements DiffPresenter {
  shown: DiffView[] = [];
  closed: string[] = [];
  show(view: DiffView): void {
    this.shown.push(view);
  }
  close(id: string): void {
    this.closed.push(id);
  }
}

export class FakeDiagnostics implements DiagnosticsSource {
  entries: FileDiagnostics[] = [];
  asked: (string | undefined)[] = [];
  get(fsPath?: string): FileDiagnostics[] {
    this.asked.push(fsPath);
    return fsPath === undefined ? this.entries : this.entries.filter((e) => e.fsPath === fsPath);
  }
}

export class MemLogger implements Logger {
  lines: string[] = [];
  info(m: string): void {
    this.lines.push(m);
  }
  get text(): string {
    return this.lines.join("\n");
  }
}

export class FakePeer implements Peer {
  sent: Record<string, unknown>[] = [];
  dropped = false;
  send(text: string): boolean {
    this.sent.push(JSON.parse(text) as Record<string, unknown>);
    return true;
  }
  drop(): void {
    this.dropped = true;
  }
  reply(id: unknown): Record<string, unknown> | undefined {
    return this.sent.find((m) => m.id === id && !("method" in m));
  }
  notes(method: string): unknown[] {
    return this.sent.filter((m) => m.method === method).map((m) => m.params);
  }
}

export interface Tmp {
  dir: string;
  ws: string;
  outside: string;
  secret: string;
  cleanup(): void;
}

export const SECRET = "TOP-SECRET-OUTSIDE-THE-WORKSPACE";

/** A temp dir holding a workspace `ws/` and a sibling `outside/` with a secret file. */
export function tmpWorkspace(): Tmp {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "csv-")));
  const ws = path.join(dir, "ws");
  const outside = path.join(dir, "outside");
  fs.mkdirSync(ws);
  fs.mkdirSync(outside);
  const secret = path.join(outside, "secret.md");
  fs.writeFileSync(secret, SECRET + "\n");
  return { dir, ws, outside, secret, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Every file under `dir` with its content and mtime, to show nothing changed. */
export function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const st = fs.lstatSync(p);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out[p] = `${st.mtimeMs}:${st.mode}:${fs.readFileSync(p, "utf8")}`;
      else out[p] = `${e.isSymbolicLink() ? "link:" + fs.readlinkSync(p) : "other"}:${st.mtimeMs}`;
    }
  };
  walk(dir);
  return out;
}

/** Every .ts file under `dir`. */
export function tsFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => path.join(e.parentPath, e.name));
}
