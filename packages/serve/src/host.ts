import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import {
  buildFaceOpCall,
  computeCombineEdit,
  computeTransformEdit,
  describeCombineFailure,
  describeTransformFailure,
  renderViewerHtml,
  computeParamEdit,
  type FaceOpResultMessage,
  type ParamCommitResult,
  type ViewerAssetUrls,
  type WebviewToExt,
} from "@shapeitup/shared";
import { clearSidecarParam } from "@shapeitup/shared/sidecar";

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
  /**
   * Content this host just wrote. The watcher fires on our own write, and
   * without this we would bundle and push a rebuild of the code we just
   * produced. Matched on CONTENT rather than a timer: a time window is either
   * too short on a slow disk or long enough to swallow a real edit that
   * arrived from the editor a moment later.
   */
  private selfWrite: { path: string; content: string } | null = null;

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
      if (this.isOwnWrite(path.join(dir, String(name)))) return;
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

  /**
   * Write a committed slider value into the source.
   *
   * The file is re-read here rather than trusting anything the viewer sent:
   * offsets are computed against the bytes we are about to overwrite, so an
   * edit that arrived from the editor, an agent, or a `git checkout` in the
   * meantime is picked up instead of silently clobbered. If the value stopped
   * being a plain literal in that time, the commit declines.
   *
   * No rebuild follows a successful write. The viewer that sent the commit is
   * already rendering that exact value — it applied the same number as a worker
   * override on release — so a rebuild would spend an execution to produce
   * identical geometry. (A second viewer attached to the same file therefore
   * stays stale until the next real edit. Multi-viewer is not a workflow we
   * support yet; when it is, broadcast to the others rather than to everyone.)
   */
  /**
   * True when this watcher event is the echo of our own write.
   *
   * Compares CONTENT, and clears the latch on the first match so a later,
   * genuine edit that happens to restore the same bytes is not swallowed too.
   */
  private isOwnWrite(changed: string): boolean {
    const pending = this.selfWrite;
    if (!pending) return false;
    if (path.resolve(changed) !== pending.path) return false;
    let onDisk: string;
    try {
      onDisk = fs.readFileSync(pending.path, "utf-8");
    } catch {
      return false;
    }
    if (onDisk !== pending.content) return false;
    this.selfWrite = null;
    return true;
  }

  private async commitParam(name: string, value: number): Promise<ParamCommitResult> {
    const fail = (reason: string): ParamCommitResult => ({
      type: "param-commit-result",
      name,
      value,
      ok: false,
      reason,
    });

    const file = this.currentFile;
    if (!file) return fail("no file open");

    let source: string;
    let statBefore: fs.Stats;
    try {
      statBefore = fs.statSync(file);
      source = fs.readFileSync(file, "utf-8");
    } catch (e: any) {
      return fail(`could not read ${path.basename(file)}: ${e?.message ?? e}`);
    }

    const result = computeParamEdit(source, name, value);
    if (!result.ok) {
      // `unchanged` is a success from the user's point of view — the file
      // already says what they asked for — so it isn't reported as a failure.
      if (result.reason === "unchanged") {
        return { type: "param-commit-result", name, value, ok: true };
      }
      return fail(result.reason);
    }

    const next =
      source.slice(0, result.edit.start) + result.edit.text + source.slice(result.edit.end);

    try {
      // Re-stat immediately before writing. This only closes the read→write
      // window; a change from before the read is already handled by having
      // computed the edit against the text we just read.
      if (fs.statSync(file).mtimeMs !== statBefore.mtimeMs) {
        return fail("file changed while writing — nothing was saved");
      }
      this.selfWrite = { path: path.resolve(file), content: next };
      fs.writeFileSync(file, next, "utf-8");
    } catch (e: any) {
      this.selfWrite = null;
      return fail(`could not write ${path.basename(file)}: ${e?.message ?? e}`);
    }

    // The file is the durable artifact; a `tune_params --persist` pin is a
    // scratch overlay that only the MCP tools read. Leaving it would mean the
    // number the user just committed is silently overridden in every export.
    const clearedSidecar = clearSidecarParam(file, name);
    this.log(
      `commit ${name}=${result.edit.text} → ${path.basename(file)}` +
        (clearedSidecar ? " (dropped a persisted override)" : ""),
    );
    return { type: "param-commit-result", name, value, ok: true, clearedSidecar };
  }

  /**
   * Apply a face operation picked in the viewer to the `.shape.ts` on disk.
   *
   * Shares the read → compute → re-stat → write shape with `commitParam`, and
   * for the same reason: this host writes the file directly rather than through
   * an editor, so the only protection against clobbering a concurrent change is
   * to check the mtime it read against the mtime it is about to overwrite.
   *
   * Unlike a parameter commit this can also fail BEFORE touching the file — the
   * face may not be one an `inPlane` selector can name, or the source may not
   * be shaped the way the writer requires. Those are reported as prose, because
   * the string goes straight into the viewer's status line.
   */
  private async commitFaceOp(msg: FaceOpMessage): Promise<FaceOpResultMessage> {
    const fail = (reason: string): FaceOpResultMessage => ({
      type: "face-op-result",
      requestId: msg.requestId,
      ok: false,
      reason,
    });

    const file = this.currentFile;
    if (!file) return fail("no file open");

    let source: string;
    let statBefore: fs.Stats;
    try {
      statBefore = fs.statSync(file);
      source = fs.readFileSync(file, "utf-8");
    } catch (e: any) {
      return fail(`could not read ${path.basename(file)}: ${e?.message ?? e}`);
    }

    const built = buildFaceOpCall(source, msg);
    if (!built.ok) return fail(built.reason);

    let next = source;
    // Descending, so each edit's offsets still describe the text they were
    // computed against.
    for (const e of [...built.edits].sort((a, b) => b.start - a.start)) {
      next = next.slice(0, e.start) + e.text + next.slice(e.end);
    }

    try {
      if (fs.statSync(file).mtimeMs !== statBefore.mtimeMs) {
        return fail("file changed while writing — nothing was saved");
      }
      // NOT marked as a self-write, unlike a parameter commit. A committed
      // slider needs no rebuild because the viewer is already rendering that
      // number as a worker override; a face operation changes GEOMETRY that
      // exists nowhere but the file, so the watcher's reload is the only thing
      // that will ever show it. Suppressing the echo here left the model on
      // screen looking exactly as it did before the edit landed.
      fs.writeFileSync(file, next, "utf-8");
    } catch (e: any) {
      return fail(`could not write ${path.basename(file)}: ${e?.message ?? e}`);
    }

    this.log(
      `${msg.op} ${msg.distance} mm on ${msg.target.kind} of ` +
        `${msg.partName ?? "shape"} → ${path.basename(file)}` +
        (built.addedImport ? " (added the shapeitup import)" : ""),
    );
    return {
      type: "face-op-result",
      requestId: msg.requestId,
      ok: true,
      applied: built.applied,
      addedImport: built.addedImport,
    };
  }

  /**
   * Apply a combine to the `.shape.ts`.
   *
   * Same read → compute → re-stat → write shape as `commitFaceOp`, and the same
   * deliberate omission: this is NOT marked as a self-write, because the change
   * is geometry that exists nowhere but the file. Suppressing the watcher echo
   * would leave the model on screen looking exactly as it did before.
   */
  private async commitCombine(msg: CombineMessage): Promise<FaceOpResultMessage> {
    const fail = (reason: string): FaceOpResultMessage => ({
      type: "face-op-result",
      kind: "combine",
      requestId: msg.requestId,
      ok: false,
      reason,
    });

    const file = this.currentFile;
    if (!file) return fail("no file open");

    let source: string;
    let statBefore: fs.Stats;
    try {
      statBefore = fs.statSync(file);
      source = fs.readFileSync(file, "utf-8");
    } catch (e: any) {
      return fail(`could not read ${path.basename(file)}: ${e?.message ?? e}`);
    }

    const built = computeCombineEdit(source, {
      op: msg.op,
      targetName: msg.targetName,
      toolNames: msg.toolNames,
      keepTools: msg.keepTools,
    });
    if (!built.ok) return fail(describeCombineFailure(built.reason, built.detail));

    let next = source;
    for (const e of [...built.edits].sort((a, b) => b.start - a.start)) {
      next = next.slice(0, e.start) + e.text + next.slice(e.end);
    }

    try {
      if (fs.statSync(file).mtimeMs !== statBefore.mtimeMs) {
        return fail("file changed while writing — nothing was saved");
      }
      fs.writeFileSync(file, next, "utf-8");
    } catch (e: any) {
      return fail(`could not write ${path.basename(file)}: ${e?.message ?? e}`);
    }

    this.log(
      `${msg.op} ${msg.toolNames.join(", ")} into ${msg.targetName} → ${path.basename(file)}` +
        (built.removed.length ? ` (removed ${built.removed.join(", ")})` : "") +
        (built.hoisted.length ? ` (hoisted ${built.hoisted.join(", ")})` : "") +
        (built.addedImport ? " (added the shapeitup import)" : ""),
    );
    return {
      type: "face-op-result",
      kind: "combine",
      requestId: msg.requestId,
      ok: true,
      applied: built.applied,
      addedImport: built.addedImport,
    };
  }

  /**
   * Apply a move / turn to the `.shape.ts`.
   *
   * Third sibling of `commitFaceOp` and `commitCombine`, with the same
   * read → compute → re-stat → write shape and the same deliberate omission of
   * the self-write marker: the geometry exists nowhere but the file, so the
   * watcher's reload is the only thing that will show it.
   */
  private async commitTransform(msg: TransformMessage): Promise<FaceOpResultMessage> {
    const fail = (reason: string): FaceOpResultMessage => ({
      type: "face-op-result",
      kind: "transform",
      requestId: msg.requestId,
      ok: false,
      reason,
    });

    const file = this.currentFile;
    if (!file) return fail("no file open");

    let source: string;
    let statBefore: fs.Stats;
    try {
      statBefore = fs.statSync(file);
      source = fs.readFileSync(file, "utf-8");
    } catch (e: any) {
      return fail(`could not read ${path.basename(file)}: ${e?.message ?? e}`);
    }

    const built = computeTransformEdit(source, {
      partName: msg.partName,
      rotate: msg.rotate,
      translate: msg.translate,
      copyAs: msg.copyAs,
    });
    if (!built.ok) {
      // A name clash reports the NAME, not the body that was dragged.
      const detail = built.reason === "name-taken" ? msg.copyAs : msg.partName;
      return fail(describeTransformFailure(built.reason, detail));
    }

    let next = source;
    for (const e of [...built.edits].sort((a, b) => b.start - a.start)) {
      next = next.slice(0, e.start) + e.text + next.slice(e.end);
    }

    try {
      if (fs.statSync(file).mtimeMs !== statBefore.mtimeMs) {
        return fail("file changed while writing — nothing was saved");
      }
      fs.writeFileSync(file, next, "utf-8");
    } catch (e: any) {
      return fail(`could not write ${path.basename(file)}: ${e?.message ?? e}`);
    }

    this.log(
      `${built.copiedAs ? `copied ${msg.partName} as ${built.copiedAs}` : `moved ${msg.partName}`}` +
        ` → ${path.basename(file)}: ${built.applied}` +
        (built.parenthesised ? " (bracketed the expression)" : "") +
        (built.hoistedAs ? ` (hoisted to ${built.hoistedAs})` : ""),
    );
    return {
      type: "face-op-result",
      kind: "transform",
      requestId: msg.requestId,
      ok: true,
      applied: built.applied,
    };
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
      if (msg?.type === "param-changed" && msg.params) {
        for (const [name, value] of Object.entries(msg.params)) {
          if (typeof value !== "number") continue;
          void this.commitParam(name, value).then((r) => {
            if (!r.ok) this.log(`commit ${name} declined: ${r.reason}`);
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(r));
          });
        }
        return;
      }
      if (msg?.type === "face-op") {
        const req = parseFaceOp(msg);
        if (!req) {
          this.log("face-op ignored: malformed message");
          return;
        }
        void this.commitFaceOp(req).then((r) => {
          if (!r.ok) this.log(`${req.op} declined: ${r.reason}`);
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(r));
        });
        return;
      }
      if (msg?.type === "combine") {
        const req = parseCombine(msg);
        if (!req) {
          this.log("combine ignored: malformed message");
          return;
        }
        void this.commitCombine(req).then((r) => {
          if (!r.ok) this.log(`${req.op} declined: ${r.reason}`);
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(r));
        });
        return;
      }
      if (msg?.type === "transform") {
        const req = parseTransform(msg);
        if (!req) {
          this.log("transform ignored: malformed message");
          return;
        }
        void this.commitTransform(req).then((r) => {
          if (!r.ok) this.log(`transform declined: ${r.reason}`);
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(r));
        });
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

type FaceOpMessage = Extract<WebviewToExt, { type: "face-op" }>;

/**
 * Validate a `face-op` off the wire.
 *
 * This host's messages arrive over a WebSocket from a page, so the payload is
 * untrusted in the ordinary way any network input is: the fields have to be
 * CHECKED, not asserted. The one that matters most is `distance` — it flows
 * into generated source, and a NaN or an Infinity there would write a line
 * that cannot be parsed back.
 */
function parseFaceOp(msg: Record<string, any>): FaceOpMessage | null {
  const triple = (v: any): v is [number, number, number] =>
    Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));

  if (
    msg.op !== "extrude" &&
    msg.op !== "fillet" &&
    msg.op !== "chamfer" &&
    msg.op !== "shell"
  ) {
    return null;
  }
  if (typeof msg.requestId !== "number" || !Number.isFinite(msg.requestId)) return null;
  if (typeof msg.distance !== "number" || !Number.isFinite(msg.distance)) return null;
  if (msg.partName !== null && typeof msg.partName !== "string") return null;

  const t = msg.target;
  if (!t) return null;
  let target: FaceOpMessage["target"];
  if (t.kind === "edge") {
    if (!triple(t.point)) return null;
    target = { kind: "edge", point: t.point };
  } else if (t.kind === "face") {
    const face = t.face;
    if (!face || typeof face.kind !== "string" || !triple(face.center)) return null;
    if (face.normal !== undefined && !triple(face.normal)) return null;
    target = {
      kind: "face",
      face: {
        kind: face.kind,
        center: face.center,
        ...(face.normal ? { normal: face.normal } : {}),
      },
    };
  } else {
    return null;
  }

  return {
    type: "face-op",
    requestId: msg.requestId,
    op: msg.op,
    partName: msg.partName,
    target,
    distance: msg.distance,
  };
}

type CombineMessage = Extract<WebviewToExt, { type: "combine" }>;

/**
 * Validate a `combine` off the wire.
 *
 * Sibling of {@link parseFaceOp}, and untrusted for the same reason. The field
 * that matters here is the name list: the names are looked up in the source,
 * so a non-string would reach the scanner as `undefined` and match whichever
 * entry happened to have no `name`.
 */
function parseCombine(msg: Record<string, any>): CombineMessage | null {
  if (msg.op !== "join" && msg.op !== "cut" && msg.op !== "intersect") return null;
  if (typeof msg.requestId !== "number" || !Number.isFinite(msg.requestId)) return null;
  if (typeof msg.targetName !== "string" || msg.targetName.length === 0) return null;
  if (!Array.isArray(msg.toolNames) || msg.toolNames.length === 0) return null;
  if (!msg.toolNames.every((n: any) => typeof n === "string" && n.length > 0)) return null;
  if (msg.keepTools !== undefined && typeof msg.keepTools !== "boolean") return null;

  return {
    type: "combine",
    requestId: msg.requestId,
    op: msg.op,
    targetName: msg.targetName,
    toolNames: msg.toolNames,
    keepTools: msg.keepTools === true,
  };
}

type TransformMessage = Extract<WebviewToExt, { type: "transform" }>;

/**
 * Validate a `transform` off the wire.
 *
 * The numbers matter most here: they go straight into generated source, and a
 * NaN or an Infinity would write a call that cannot be parsed back.
 */
function parseTransform(msg: Record<string, any>): TransformMessage | null {
  const triple = (v: any): v is [number, number, number] =>
    Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));

  if (typeof msg.requestId !== "number" || !Number.isFinite(msg.requestId)) return null;
  if (typeof msg.partName !== "string" || msg.partName.length === 0) return null;

  let rotate: TransformMessage["rotate"];
  if (msg.rotate !== undefined) {
    const r = msg.rotate;
    if (!r || typeof r.angle !== "number" || !Number.isFinite(r.angle)) return null;
    if (!triple(r.axis)) return null;
    if (r.pivot !== "origin" && r.pivot !== "self") return null;
    rotate = { angle: r.angle, axis: r.axis, pivot: r.pivot };
  }
  if (msg.translate !== undefined && !triple(msg.translate)) return null;
  if (!rotate && !msg.translate) return null;
  if (msg.copyAs !== undefined && (typeof msg.copyAs !== "string" || !msg.copyAs)) return null;

  return {
    type: "transform",
    requestId: msg.requestId,
    partName: msg.partName,
    ...(rotate ? { rotate } : {}),
    ...(msg.translate ? { translate: msg.translate } : {}),
    ...(msg.copyAs ? { copyAs: msg.copyAs } : {}),
  };
}
