import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { renderViewerHtml, type ViewerAssetUrls } from "@shapeitup/shared";

const MIME: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/**
 * Asset URLs must be ABSOLUTE, not page-relative.
 *
 * The OCCT worker runs from a blob: URL, so relative URLs inside
 * `__SHAPEITUP_CONFIG__` resolve against the blob context rather than the page
 * and every fetch dies with "Failed to fetch OCCT loader". The webview host
 * never hit this because `asWebviewUri()` always returns absolute URIs.
 */
function absoluteAssets(origin: string): ViewerAssetUrls {
  const u = (f: string) => new URL(f, origin).href;
  return {
    viewerJs: u("viewer.js"),
    workerJs: u("worker.js"),
    wasmLoaderJs: u("replicad_single.js"),
    wasmFile: u("replicad_single.wasm"),
    manifoldLoaderJs: u("manifold.js"),
    manifoldWasmFile: u("manifold.wasm"),
    mujocoLoaderJs: u("mujoco.js"),
    mujocoWasmFile: u("mujoco.wasm"),
  };
}

/**
 * The complete set of files a viewer page can request. Serving is allowlisted
 * to these names — the host resolves each one independently, so they do not
 * have to live in the same directory.
 */
export const VIEWER_ASSET_NAMES = [
  "viewer.js",
  "worker.js",
  "replicad_single.js",
  "replicad_single.wasm",
  "manifold.js",
  "manifold.wasm",
  "mujoco.js",
  "mujoco.wasm",
] as const;

export type ViewerAssetName = (typeof VIEWER_ASSET_NAMES)[number];

/**
 * Maps an asset name to an absolute path on disk, or undefined when it is not
 * available (MuJoCo is genuinely optional).
 *
 * A resolver rather than a directory because the two hosts lay assets out
 * differently: the VSIX co-locates everything in `dist/`, while an npm install
 * has the browser bundles in the package and the WASM under node_modules,
 * where npm already installed them as ordinary dependencies. Copying ~7 MB of
 * gzipped WASM into the tarball to flatten that would be pure duplication.
 */
export type ViewerAssetResolver = (name: ViewerAssetName) => string | undefined;

/** Resolver for the simple case: every asset sits in one directory. */
export function directoryAssetResolver(dir: string): ViewerAssetResolver {
  return (name) => {
    const p = path.join(dir, name);
    return fs.existsSync(p) ? p : undefined;
  };
}

export interface ViewerHostOptions {
  /** Locates each browser asset. See `directoryAssetResolver` for the flat case. */
  resolveAsset: ViewerAssetResolver;
  /**
   * Bundles a `.shape.ts` into a single ESM module.
   *
   * Injected rather than imported so this module never pulls in an esbuild
   * flavour: the CLI passes the native `bundleShapeFile`, the MCP server passes
   * its `esbuild-wasm` one. Both build from `shapeBundleOptions`.
   */
  bundle: (absPath: string) => Promise<string>;
  /** 0 lets the OS choose. */
  port?: number;
  /** Called for viewer→host messages the host doesn't handle itself. */
  onViewerMessage?: (msg: Record<string, any>) => void;
  log?: (line: string) => void;
}

/**
 * Serves the viewer bundle over HTTP and drives it over a WebSocket.
 *
 * The viewer package is host-agnostic: inside VSCode it talks to the extension
 * over the webview bridge, and here it talks to us over a socket. Both hosts
 * speak the same `ExtToWebview` message shapes, so nothing downstream of the
 * transport knows the difference.
 */
export class ViewerHost {
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private currentFile: string | null = null;
  private watcher: fs.FSWatcher | null = null;
  private debounce: NodeJS.Timeout | undefined;
  private boundPort = 0;

  constructor(private readonly opts: ViewerHostOptions) {}

  get port(): number {
    return this.boundPort;
  }

  get url(): string {
    return `http://127.0.0.1:${this.boundPort}/`;
  }

  /** Viewers currently holding an open socket. */
  get clientCount(): number {
    return this.clients.size;
  }

  get file(): string | null {
    return this.currentFile;
  }

  private log(line: string) {
    this.opts.log?.(line);
  }

  async start(): Promise<number> {
    if (this.server) return this.boundPort;
    // MuJoCo is optional; the rest must be present or the page can't boot.
    const missing = VIEWER_ASSET_NAMES.filter(
      (n) => !n.startsWith("mujoco") && !this.opts.resolveAsset(n),
    );
    if (missing.length) {
      throw new Error(`viewer assets not found: ${missing.join(", ")} — run \`pnpm build\``);
    }

    const server = http.createServer((req, res) => this.handleHttp(req, res));
    const wss = new WebSocketServer({ server, path: "/ws" });
    wss.on("connection", (ws) => this.handleSocket(ws));

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.opts.port ?? 0, "127.0.0.1", () => resolve());
    });

    this.server = server;
    this.wss = wss;
    this.boundPort = (server.address() as { port: number }).port;
    this.log(`listening on ${this.url}`);
    return this.boundPort;
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    for (const ws of this.clients) {
      try { ws.close(); } catch {}
    }
    this.clients.clear();
    try { this.wss?.close(); } catch {}
    try { this.server?.close(); } catch {}
    this.wss = null;
    this.server = null;
  }

  /** Broadcast a raw `ExtToWebview` message to every connected viewer. */
  broadcast(msg: Record<string, any>): number {
    const text = JSON.stringify(msg);
    let n = 0;
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(text);
        n++;
      }
    }
    return n;
  }

  /** Same shape the extension's `sendViewerCommand` produces. */
  sendViewerCommand(command: string, params: Record<string, any> = {}): number {
    return this.broadcast({ type: "viewer-command", command, ...params });
  }

  /**
   * Point the viewer at a file: bundle it, push it, and start watching its
   * directory for edits. Safe to call repeatedly — re-targeting swaps the
   * watcher over.
   */
  async setFile(filePath: string): Promise<void> {
    const abs = path.resolve(filePath);
    if (!fs.existsSync(abs)) throw new Error(`no such file: ${abs}`);
    const changed = this.currentFile !== abs;
    this.currentFile = abs;
    if (changed) this.watchDir(path.dirname(abs));
    await this.push("open");
  }

  private watchDir(dir: string) {
    this.watcher?.close();
    // Watching the DIRECTORY (not the file) survives the write-then-rename
    // dance editors do on save, which would otherwise orphan a file watch.
    this.watcher = fs.watch(dir, (_e, name) => {
      if (!name || !String(name).endsWith(".shape.ts")) return;
      clearTimeout(this.debounce);
      this.debounce = setTimeout(() => void this.push(`changed: ${name}`), 150);
    });
  }

  private async push(reason: string): Promise<void> {
    const file = this.currentFile;
    if (!file) return;
    try {
      const js = await this.opts.bundle(file);
      const n = this.broadcast({
        type: "execute-script",
        js,
        fileName: path.basename(file),
      });
      this.log(`${reason} → ${path.basename(file)} (${js.length} B) to ${n} viewer(s)`);
    } catch (e: any) {
      const message = String(e?.message ?? e);
      this.log(`bundle failed: ${message}`);
      this.sendViewerCommand("error", { message });
    }
  }

  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const nonce = crypto.randomBytes(16).toString("base64");
      const html = renderViewerHtml({
        assets: absoluteAssets(url.origin),
        cspSource: "'self'",
        // The page carries one inline bootstrap <script>; keep the nonce
        // rather than widening script-src to 'unsafe-inline'.
        nonce,
        connectSrc: "'self' ws://127.0.0.1:* ws://localhost:*",
        workerSrc: "'self'",
      });
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(html);
      return;
    }

    // Allowlisted by exact name — no path joining, so traversal is impossible
    // by construction rather than by a prefix check.
    const rel = decodeURIComponent(url.pathname.replace(/^\//, ""));
    if (!(VIEWER_ASSET_NAMES as readonly string[]).includes(rel)) {
      res.writeHead(404).end("not found");
      return;
    }
    const file = this.opts.resolveAsset(rel as ViewerAssetName);
    if (!file || !fs.existsSync(file)) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    fs.createReadStream(file).pipe(res);
  }

  private handleSocket(ws: WebSocket) {
    this.clients.add(ws);
    this.log(`viewer connected (${this.clients.size} total)`);
    ws.on("close", () => this.clients.delete(ws));
    ws.on("error", () => this.clients.delete(ws));

    ws.on("message", (raw) => {
      let msg: Record<string, any>;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }

      if (msg?.type === "ready") {
        void this.push("viewer ready");
        return;
      }
      if (msg?.type === "request-wasm-assets") {
        // The extension answers this from a pre-read cache to save the worker
        // a fetch. We have no cache and need none — the assets are same-origin
        // static files — so reply empty and let the worker fetch `wasmUrl`
        // itself. The reply is mandatory: the viewer blocks on
        // "Loading ShapeItUp..." until one arrives.
        ws.send(JSON.stringify({ type: "wasm-assets" }));
        return;
      }
      this.opts.onViewerMessage?.(msg);
    });
  }
}
