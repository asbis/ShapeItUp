/**
 * WebSocket-based subscriber bus — the MCP server's authoritative event
 * channel to any live VSCode extension instances. Replaces the old
 * file-based `mcp-command.json` / `mcp-result.json` bridge.
 *
 * Model:
 *   - The MCP server binds a WS listener on 127.0.0.1:0 (OS-assigned port).
 *   - It advertises the chosen port via a heartbeat file
 *     (`mcp-server-heartbeat-<pid>.json`) in globalStorage alongside the
 *     extension's own heartbeats.
 *   - VSCode extension instances read that file on activation, connect, and
 *     send `{ type: "hello", workspaceRoots: [...] }`.
 *   - The bus exposes fire-and-forget `publishEvent` for UI-sync events
 *     (set-render-mode, toggle-dimensions, open-shape) and `publishAndAwait`
 *     for events that require an ack.
 *
 * No subscriber = `publishEvent` returns `{ delivered: 0 }` without hanging;
 * callers treat that as "informational, no error".
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { WebSocketServer, WebSocket } from "ws";

/**
 * Heartbeat file written by this process so extensions can discover the port.
 * Sibling to the extension's own `shapeitup-heartbeat-<pid>.json` so they
 * share the same discovery directory.
 */
export interface McpServerHeartbeat {
  pid: number;
  port: number;
  timestamp: number;
  version: string;
}

interface SubscriberState {
  ws: WebSocket;
  workspaceRoots: string[];
  /** Latched once we receive a `hello` message. */
  hasHello: boolean;
}

export interface PublishOptions {
  /** Only deliver to subscribers whose workspaceRoots include this. */
  targetWorkspaceRoot?: string;
}

export interface PublishAwaitOptions extends PublishOptions {
  /** Default 15 s. */
  timeoutMs?: number;
}

export interface PublishResult {
  delivered: number;
}

export interface PublishAwaitResult {
  delivered: number;
  ok?: boolean;
  error?: string;
}

function normalizePath(p: string): string {
  // Windows is case-insensitive; compare case-folded so `C:\Foo` and `c:\foo`
  // are considered equal. Trailing separators get dropped so `C:\foo\` and
  // `C:\foo` match.
  return path.resolve(p).toLowerCase().replace(/[\\/]+$/, "");
}

function workspaceRootMatches(
  roots: string[],
  target: string,
): boolean {
  const t = normalizePath(target);
  return roots.some((r) => normalizePath(r) === t);
}

export class SubscriberBus {
  private wss: WebSocketServer | null = null;
  private subscribers = new Set<SubscriberState>();
  private heartbeatFile: string | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private nonceCounter = 0;
  private pendingAwait = new Map<
    string,
    { resolve: (r: PublishAwaitResult) => void; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(
    private readonly globalStorageDir: string,
    private readonly serverVersion: string,
  ) {}

  /**
   * Start the listener. Resolves with the chosen port. Idempotent if already
   * started (returns existing port).
   */
  async start(): Promise<number> {
    if (this.wss) {
      const addr = this.wss.address();
      if (addr && typeof addr === "object") return addr.port;
    }
    await new Promise<void>((resolve, reject) => {
      try {
        fs.mkdirSync(this.globalStorageDir, { recursive: true });
      } catch (e) {
        // best effort — the write below will surface the real failure
      }
      const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      wss.once("listening", () => {
        this.wss = wss;
        this.attachHandlers(wss);
        resolve();
      });
      wss.once("error", reject);
    });
    const port = (this.wss!.address() as { port: number }).port;
    this.writeHeartbeat(port);
    // Refresh heartbeat every 2 s to match the extension's cadence so
    // consumers applying a freshness window see a consistent signal.
    this.heartbeatTimer = setInterval(() => this.writeHeartbeat(port), 2000);
    // Best-effort: if the process exits normally, drop the file.
    const cleanup = () => this.stop();
    process.once("SIGTERM", cleanup);
    process.once("SIGINT", cleanup);
    process.once("beforeExit", cleanup);
    return port;
  }

  /**
   * Stop the listener and remove the heartbeat file. Idempotent.
   */
  stop(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const [, pend] of this.pendingAwait) {
      clearTimeout(pend.timer);
      pend.resolve({ delivered: 0, error: "bus-closed" });
    }
    this.pendingAwait.clear();
    for (const sub of this.subscribers) {
      try { sub.ws.close(); } catch {}
    }
    this.subscribers.clear();
    if (this.wss) {
      try { this.wss.close(); } catch {}
      this.wss = null;
    }
    if (this.heartbeatFile) {
      try { fs.unlinkSync(this.heartbeatFile); } catch {}
      this.heartbeatFile = null;
    }
  }

  /**
   * Fire-and-forget event publish. Returns the number of subscribers the
   * event was delivered to (may be 0).
   */
  publishEvent(
    event: string,
    payload: Record<string, any>,
    opts: PublishOptions = {},
  ): PublishResult {
    const targets = this.pickTargets(opts.targetWorkspaceRoot);
    const msg = JSON.stringify({ event, ...payload });
    let delivered = 0;
    for (const sub of targets) {
      try {
        sub.ws.send(msg);
        delivered++;
      } catch {
        // Drop dead sockets; the 'close' handler will clean up.
      }
    }
    return { delivered };
  }

  /**
   * Publish with a correlation id and wait for a matching `{ _id, ok }` reply
   * from any subscriber. If no subscriber is connected that matches the
   * filter, resolves immediately with `{ delivered: 0 }` so the caller can
   * fall back to another path.
   *
   * Only ONE reply is awaited — if multiple subscribers reply, later replies
   * are ignored. In practice publishAwait events are routed with
   * `targetWorkspaceRoot` so there's at most one intended recipient.
   */
  publishAndAwait(
    event: string,
    payload: Record<string, any>,
    opts: PublishAwaitOptions = {},
  ): Promise<PublishAwaitResult> {
    const targets = this.pickTargets(opts.targetWorkspaceRoot);
    if (targets.length === 0) {
      return Promise.resolve({ delivered: 0 });
    }
    const _id = this.nextNonce();
    const msg = JSON.stringify({ event, _id, ...payload });
    const timeoutMs = opts.timeoutMs ?? 15_000;

    let delivered = 0;
    for (const sub of targets) {
      try {
        sub.ws.send(msg);
        delivered++;
      } catch {}
    }
    if (delivered === 0) {
      return Promise.resolve({ delivered: 0 });
    }

    return new Promise<PublishAwaitResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingAwait.delete(_id);
        resolve({ delivered, error: "timeout" });
      }, timeoutMs);
      this.pendingAwait.set(_id, {
        resolve: (r) => resolve({ delivered, ok: r.ok, error: r.error }),
        timer,
      });
    });
  }

  /**
   * Return all workspace roots advertised by currently-connected subscribers
   * (de-duplicated, case-folded on Windows). Useful for path-resolution
   * defaults — when exactly one subscriber is connected, the MCP server can
   * treat its workspace root as the preferred default directory.
   */
  getSubscriberWorkspaceRoots(): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const sub of this.subscribers) {
      if (!sub.hasHello) continue;
      for (const root of sub.workspaceRoots) {
        const key = normalizePath(root);
        if (!seen.has(key)) {
          seen.add(key);
          out.push(root);
        }
      }
    }
    return out;
  }

  /**
   * Testing helper: how many subscribers have completed the hello handshake.
   */
  getSubscriberCount(): number {
    let n = 0;
    for (const sub of this.subscribers) if (sub.hasHello) n++;
    return n;
  }

  private pickTargets(targetWorkspaceRoot?: string): SubscriberState[] {
    const out: SubscriberState[] = [];
    for (const sub of this.subscribers) {
      if (!sub.hasHello) continue;
      if (targetWorkspaceRoot && !workspaceRootMatches(sub.workspaceRoots, targetWorkspaceRoot)) {
        continue;
      }
      out.push(sub);
    }
    return out;
  }

  private attachHandlers(wss: WebSocketServer): void {
    wss.on("connection", (ws) => {
      const state: SubscriberState = { ws, workspaceRoots: [], hasHello: false };
      this.subscribers.add(state);

      ws.on("message", (data) => {
        let parsed: any;
        try {
          parsed = JSON.parse(data.toString("utf-8"));
        } catch {
          return;
        }
        if (parsed && parsed.type === "hello") {
          const roots = Array.isArray(parsed.workspaceRoots)
            ? parsed.workspaceRoots.filter((r: unknown): r is string => typeof r === "string")
            : [];
          state.workspaceRoots = roots;
          state.hasHello = true;
          return;
        }
        if (parsed && typeof parsed._id === "string") {
          const pend = this.pendingAwait.get(parsed._id);
          if (pend) {
            this.pendingAwait.delete(parsed._id);
            clearTimeout(pend.timer);
            pend.resolve({
              delivered: 1,
              ok: parsed.ok === true,
              error: typeof parsed.error === "string" ? parsed.error : undefined,
            });
          }
        }
      });

      const drop = () => {
        this.subscribers.delete(state);
      };
      ws.on("close", drop);
      ws.on("error", drop);
    });
  }

  private writeHeartbeat(port: number): void {
    try {
      this.heartbeatFile = path.join(
        this.globalStorageDir,
        `mcp-server-heartbeat-${process.pid}.json`,
      );
      const payload: McpServerHeartbeat = {
        pid: process.pid,
        port,
        timestamp: Date.now(),
        version: this.serverVersion,
      };
      fs.writeFileSync(this.heartbeatFile, JSON.stringify(payload));
    } catch {
      // best-effort; discovery will just fail silently
    }
  }

  private nextNonce(): string {
    return `${process.pid}-${Date.now().toString(36)}-${++this.nonceCounter}`;
  }
}

/**
 * Global bus singleton — created lazily on first access so the MCP bootstrap
 * path can start the listener without importing the class.
 */
let busSingleton: SubscriberBus | null = null;

export function getSubscriberBus(globalStorageDir: string, serverVersion: string): SubscriberBus {
  if (!busSingleton) {
    busSingleton = new SubscriberBus(globalStorageDir, serverVersion);
  }
  return busSingleton;
}

/**
 * Locate the standard globalStorage dir used by both the extension and the
 * MCP server. This mirrors the path embedded in tools.ts — kept in sync so a
 * new process doesn't drift from the existing heartbeat discovery path.
 */
export function defaultGlobalStorageDir(): string {
  const home = os.homedir();
  return path.join(
    home,
    process.platform === "win32"
      ? "AppData/Roaming/Code/User/globalStorage/shapeitup.shapeitup-vscode"
      : ".config/Code/User/globalStorage/shapeitup.shapeitup-vscode",
  );
}

/**
 * Testing helper — read a peer MCP server's heartbeat file (ours or another
 * process's) and return whichever heartbeat is freshest. A stale heartbeat
 * (older than 10 s) is treated as missing.
 */
export function readMcpServerHeartbeat(globalStorageDir: string): McpServerHeartbeat | null {
  try {
    if (!fs.existsSync(globalStorageDir)) return null;
    let freshest: McpServerHeartbeat | null = null;
    const now = Date.now();
    for (const name of fs.readdirSync(globalStorageDir)) {
      if (!name.startsWith("mcp-server-heartbeat-") || !name.endsWith(".json")) continue;
      try {
        const raw = fs.readFileSync(path.join(globalStorageDir, name), "utf-8");
        const hb = JSON.parse(raw) as McpServerHeartbeat;
        if (
          typeof hb?.pid === "number" &&
          typeof hb?.port === "number" &&
          typeof hb?.timestamp === "number" &&
          now - hb.timestamp < 10_000
        ) {
          if (!freshest || hb.timestamp > freshest.timestamp) freshest = hb;
        }
      } catch {}
    }
    return freshest;
  } catch {
    return null;
  }
}
