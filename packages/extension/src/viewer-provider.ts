import * as vscode from "vscode";
import * as esbuild from "esbuild-wasm";
import * as path from "path";
import * as fs from "fs";
import { BUNDLE_EXTERNALS, type ExportFormat } from "@shapeitup/shared";
import type { DetectedApp } from "./app-detector";
import { getDetectedApps } from "./app-detector";
import { getCachedWasmAssets } from "./wasm-cache";

let esbuildInitPromise: Promise<void> | null = null;

async function ensureEsbuild() {
  if (!esbuildInitPromise) {
    esbuildInitPromise = esbuild.initialize({});
  }
  await esbuildInitPromise;
}

/**
 * Scan the ENTRY source for imports of `main` / `params` from sibling .shape(.ts)
 * files and throw a clear user-facing error before esbuild runs. The worker's
 * executor strips `export { main as default }` from .shape.ts bundles, so these
 * imports silently fail with esbuild's generic "No matching export" — confusing
 * for both humans and AI agents. Only the entry is scanned: utility modules that
 * happen to export a symbol called `main` from non-`.shape` files are untouched.
 */
function preflightShapeImports(sourceCode: string, filePath: string): void {
  const re = /import\s*\{([^}]+)\}\s*from\s*['"](\.[^'"]*\.shape(?:\.ts)?)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sourceCode)) !== null) {
    const imported = m[1];
    const source = m[2];
    const names = imported
      .split(",")
      .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
      .filter((s) => s.length > 0);
    const bad = names.filter((n) => n === "main" || n === "params");
    if (bad.length > 0) {
      throw new Error(
        `Cannot import ${bad.map((n) => `'${n}'`).join(" / ")} from '${source}' in ${filePath}.\n\n` +
        `ShapeItUp reserves 'main' and 'params' as runtime entry points — the renderer invokes them, ` +
        `but other scripts cannot import them (the executor strips their exports before bundling).\n\n` +
        `To reuse logic across scripts, export a named factory function:\n\n` +
        `  // in ${source}:\n` +
        `  export function makeEnclosure(opts) { /* ... */ }\n\n` +
        `  // in ${filePath}:\n` +
        `  import { makeEnclosure } from '${source}';\n` +
        `  export default function main() { return makeEnclosure({ ... }); }\n`
      );
    }
  }
}

interface BundleCacheEntry {
  /** Bundled JS output text. */
  js: string;
  /** Text of the entry file at the time of caching (matches document.getText()). */
  entryContent: string;
  /** Normalized absolute path of the entry file (the map key). */
  entryPath: string;
  /** Absolute input path -> mtimeMs for every file esbuild pulled in. */
  inputMtimes: Record<string, number>;
}

/**
 * Scan source for local `import ... from './...'` and `import './...'` statements,
 * returning the array of relative specifiers. Used by checkBundleCache to detect
 * new imports not yet tracked in `inputMtimes` (new-import bug fix).
 */
function extractLocalImportSpecifiers(source: string): string[] {
  const re = /\bfrom\s+['"](\.[^'"]+)['"]/g;
  const sideEffect = /\bimport\s+['"](\.[^'"]+)['"]/g;
  const specs: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) specs.push(m[1]);
  while ((m = sideEffect.exec(source)) !== null) specs.push(m[1]);
  return specs;
}

/**
 * Walk esbuild's `metafile.inputs` graph starting at the entry's metafile key,
 * chasing `imports[].path` recursively so transitive dependencies are tracked
 * alongside direct ones. Without this walk, editing a file like `constants.ts`
 * (imported by `body.shape.ts`, imported by the entry) wouldn't invalidate the
 * entry's bundle cache because esbuild lists `constants.ts` under
 * `body.shape.ts`'s imports — not the entry's. Returns absolute paths,
 * excludes the entry file itself (already covered by entryContent equality).
 */
function collectBundleInputsRecursive(
  metafileInputs: Record<string, { imports?: Array<{ path?: string }> }>,
  entryKey: string,
  absWorkingDir: string,
  entryAbsPath: string,
): string[] {
  const out = new Set<string>();
  const visited = new Set<string>();
  const toAbs = (p: string): string => (path.isAbsolute(p) ? p : path.resolve(absWorkingDir, p));
  const isEntry = (abs: string): boolean => abs.toLowerCase() === entryAbsPath.toLowerCase();

  const walk = (nodeKey: string): void => {
    if (visited.has(nodeKey)) return;
    visited.add(nodeKey);
    const node = metafileInputs[nodeKey];
    if (!node) return;
    for (const imp of node.imports ?? []) {
      if (!imp?.path) continue;
      const childKey = imp.path;
      const childAbs = toAbs(childKey);
      if (!isEntry(childAbs)) out.add(childAbs);
      walk(childKey);
    }
  };

  walk(entryKey);
  return [...out];
}

export class ViewerProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private panel?: vscode.WebviewPanel;
  private context: vscode.ExtensionContext;
  private output: vscode.OutputChannel;
  private pendingExportResolve?: (data: ArrayBuffer) => void;
  private pendingScreenshotResolve?: (dataUrl: string) => void;
  private isReady = false;
  private pendingScript?: { js: string; fileName: string; paramOverrides?: Record<string, number>; meshQuality?: "preview" | "final" };
  private lastScreenshotPath?: string;
  private lastExecutedFile?: string;
  // P1 fix: capture the most recent webview-worker error so the render-preview
  // handler can surface it to MCP instead of silently proceeding to capture
  // a stale screenshot of the previous successful render. Consume-once: the
  // render-preview command drains this via takeLastRenderError() and clears
  // it. Armed/cleared per armPendingRender() call.
  private lastRenderError?: { message: string; stack?: string; operation?: string; timestamp: number; fileName?: string };
  // Buffer for per-part visibility warnings surfaced by the viewer while a
  // screenshot is being prepared. The render-preview handler clears this
  // before dispatching and drains it into the MCP result afterwards.
  private partWarnings: string[] = [];

  // Bug C: handshake so the render-preview command can wait for the actual
  // webview-side render to complete (render-success message from the worker)
  // instead of polling a status file that was written by the MCP engine BEFORE
  // executeScript was even dispatched. `armPendingRender()` is called right
  // before executeScript; `awaitNextRender(timeoutMs)` is called AFTER to
  // block until the worker finishes tessellating and the viewer reports back.
  private pendingRenderResolve?: () => void;
  private pendingRenderReject?: (err: Error) => void;
  private pendingRenderPromise?: Promise<void>;

  // T6.A: handshake for prepare-screenshot → screenshot-ready round-trip.
  // Arm BEFORE dispatching prepare-screenshot; await replaces the 500ms sleep.
  private pendingScreenshotReadyResolve?: () => void;
  private pendingScreenshotReadyReject?: (err: Error) => void;
  private pendingScreenshotReadyPromise?: Promise<void>;

  constructor(context: vscode.ExtensionContext, output: vscode.OutputChannel) {
    this.context = context;
    this.output = output;
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;
    this.isReady = false;
    this.configureWebview(webviewView.webview);
    webviewView.onDidDispose(() => {
      this.view = undefined;
      this.isReady = false;
      this.clearPending("view disposed");
    });
  }

  openPanel(context: vscode.ExtensionContext, opts?: { preserveFocus?: boolean }) {
    if (this.panel) {
      if (!opts?.preserveFocus) {
        this.panel.reveal(vscode.ViewColumn.Beside);
      }
      return;
    }

    this.isReady = false;
    this.panel = vscode.window.createWebviewPanel(
      "shapeitup.preview",
      "ShapeItUp Preview",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: !!opts?.preserveFocus },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, "dist"),
        ],
      }
    );

    this.configureWebview(this.panel.webview);

    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.isReady = false;
      this.clearPending("panel disposed");
    });
  }

  /**
   * Ensure a webview exists and is ready. Auto-opens a preview panel if none
   * is present (e.g., when an MCP agent calls render_preview before the user
   * has opened the viewer). Waits up to `timeoutMs` for the worker to report
   * ready. Called from captureScreenshot/executeScript.
   */
  async ensureWebview(timeoutMs = 15000): Promise<vscode.Webview | undefined> {
    const existing = this.getActiveWebview();
    if (existing && this.isReady) return existing;

    if (!existing) {
      this.output.appendLine("[webview] No active webview — auto-opening preview panel");
      this.openPanel(this.context, { preserveFocus: true });
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.isReady) {
        const wv = this.getActiveWebview();
        if (wv) return wv;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    this.output.appendLine(`[webview] Timed out waiting for webview ready after ${timeoutMs}ms`);
    return undefined;
  }

  /**
   * Resolve any pending screenshot/export promises so commands in flight fail
   * fast instead of waiting for their full timeout when the webview goes away.
   */
  private clearPending(reason: string) {
    if (this.pendingScreenshotResolve) {
      this.output.appendLine(`[viewer] Clearing pending screenshot: ${reason}`);
      this.pendingScreenshotResolve(undefined as any);
      this.pendingScreenshotResolve = undefined;
    }
    if (this.pendingExportResolve) {
      this.output.appendLine(`[viewer] Clearing pending export: ${reason}`);
      this.pendingExportResolve(undefined as any);
      this.pendingExportResolve = undefined;
    }
  }

  private configureWebview(webview: vscode.Webview) {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "dist"),
      ],
    };

    const distUri = vscode.Uri.joinPath(this.context.extensionUri, "dist");
    const viewerJs = webview.asWebviewUri(
      vscode.Uri.joinPath(distUri, "viewer.js")
    );
    const workerJs = webview.asWebviewUri(
      vscode.Uri.joinPath(distUri, "worker.js")
    );
    const wasmLoaderJs = webview.asWebviewUri(
      vscode.Uri.joinPath(distUri, "replicad_single.js")
    );
    const wasmFile = webview.asWebviewUri(
      vscode.Uri.joinPath(distUri, "replicad_single.wasm")
    );
    const manifoldLoaderJs = webview.asWebviewUri(
      vscode.Uri.joinPath(distUri, "manifold.js")
    );
    const manifoldWasmFile = webview.asWebviewUri(
      vscode.Uri.joinPath(distUri, "manifold.wasm")
    );

    const nonce = getNonce();

    webview.html = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="
    default-src 'none';
    script-src 'nonce-${nonce}' 'unsafe-eval' 'wasm-unsafe-eval' ${webview.cspSource};
    style-src 'unsafe-inline';
    connect-src ${webview.cspSource} blob:;
    worker-src blob:;
    child-src blob:;
  ">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; overflow: hidden; background: #1e1e1e; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }

    /* Layout: parts browser on left, canvas fills rest */
    #app { display: flex; width: 100%; height: 100%; }

    /* Parts browser panel (Fusion 360 style) */
    #parts-panel {
      width: 0; min-width: 0; background: #252526; border-right: 1px solid #3c3c3c;
      display: flex; flex-direction: column; overflow: hidden;
      transition: width 0.15s ease, min-width 0.15s ease;
    }
    #parts-panel.open { width: 180px; min-width: 180px; }
    #parts-header {
      padding: 8px 10px; font-size: 11px; font-weight: 600; color: #ccc;
      border-bottom: 1px solid #3c3c3c; text-transform: uppercase; letter-spacing: 0.5px;
      display: flex; justify-content: space-between; align-items: center;
    }
    #parts-header .count { font-weight: 400; color: #888; }
    #parts-list {
      flex: 1; overflow-y: auto; padding: 2px 0;
    }
    #parts-list::-webkit-scrollbar { width: 6px; }
    #parts-list::-webkit-scrollbar-thumb { background: #555; border-radius: 3px; }
    .part-item {
      display: flex; align-items: center; gap: 6px;
      padding: 3px 10px; cursor: pointer; font-size: 12px; color: #ccc;
      user-select: none;
    }
    .part-item:hover { background: #2a2d2e; }
    .part-item.hidden { opacity: 0.4; }
    .part-swatch {
      width: 10px; height: 10px; border-radius: 2px; flex-shrink: 0;
      border: 1px solid rgba(255,255,255,0.15);
    }
    .part-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .part-eye {
      width: 16px; height: 16px; flex-shrink: 0; opacity: 0.6;
      display: flex; align-items: center; justify-content: center; font-size: 13px;
    }
    .part-item:hover .part-eye { opacity: 1; }

    /* Canvas area */
    #viewport { flex: 1; position: relative; overflow: hidden; }
    #canvas-container { width: 100%; height: 100%; }
    canvas { display: block; width: 100% !important; height: 100% !important; }

    /* Top toolbar */
    #toolbar {
      position: absolute; top: 8px; right: 8px; z-index: 20;
      display: flex; gap: 3px; background: rgba(37,37,38,0.9);
      padding: 3px; border-radius: 5px; border: 1px solid #3c3c3c;
      backdrop-filter: blur(8px);
    }
    #toolbar button {
      background: transparent; border: 1px solid transparent; color: #aaa;
      font-family: inherit; font-size: 11px; padding: 4px 8px;
      border-radius: 3px; cursor: pointer;
    }
    #toolbar button:hover { background: #3c3c3c; color: #fff; }
    #toolbar button:active { background: #505050; }
    #toolbar button.active { background: #0e639c; color: #fff; border-color: #1177bb; }
    #toolbar .sep { width: 1px; background: #3c3c3c; margin: 2px 1px; }

    /* Export dropdown */
    .menu-wrapper { position: relative; }
    .dropdown-menu {
      display: none;
      position: absolute;
      top: calc(100% + 4px);
      right: 0;
      min-width: 180px;
      background: rgba(37,37,38,0.98);
      border: 1px solid #3c3c3c;
      border-radius: 4px;
      padding: 3px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
      backdrop-filter: blur(8px);
      z-index: 30;
    }
    .menu-wrapper.open .dropdown-menu { display: block; }
    .dropdown-menu button {
      display: block; width: 100%; text-align: left;
      background: transparent; border: 1px solid transparent; color: #ddd;
      font-family: inherit; font-size: 11px; padding: 5px 10px;
      border-radius: 3px; cursor: pointer;
    }
    .dropdown-menu button:hover { background: #0e639c; color: #fff; }
    .dropdown-menu .menu-sep {
      height: 1px; background: #3c3c3c; margin: 4px 2px;
    }
    .dropdown-menu .menu-heading {
      font-size: 10px; color: #888; text-transform: uppercase;
      padding: 4px 10px 2px; letter-spacing: 0.5px;
    }

    /* Left toolbar (view controls) */
    #view-toolbar {
      position: absolute; top: 8px; left: 8px; z-index: 20;
      display: flex; gap: 3px; background: rgba(37,37,38,0.9);
      padding: 3px; border-radius: 5px; border: 1px solid #3c3c3c;
      backdrop-filter: blur(8px);
    }
    #view-toolbar button {
      background: transparent; border: 1px solid transparent; color: #aaa;
      font-family: inherit; font-size: 13px; padding: 3px 6px;
      border-radius: 3px; cursor: pointer; line-height: 1;
    }
    #view-toolbar button:hover { background: #3c3c3c; color: #fff; }
    #view-toolbar button.active { background: #0e639c; color: #fff; }

    /* ViewCube */
    #viewcube {
      position: absolute; bottom: 40px; right: 10px; z-index: 20;
      display: flex; flex-direction: column; gap: 2px;
      background: rgba(37,37,38,0.85); padding: 4px; border-radius: 5px;
      border: 1px solid #3c3c3c;
    }
    #viewcube button {
      background: transparent; border: none; color: #999; cursor: pointer;
      font-size: 10px; padding: 3px 6px; border-radius: 2px; font-family: inherit;
    }
    #viewcube button:hover { background: #3c3c3c; color: #fff; }

    /* Parameters panel (bottom of parts panel) */
    #params-panel {
      border-top: 1px solid #3c3c3c; padding: 0; max-height: 0; overflow: hidden;
      transition: max-height 0.2s ease;
    }
    #params-panel.open { max-height: 400px; overflow-y: auto; padding-bottom: 4px; }
    #params-header {
      padding: 8px 10px; font-size: 11px; font-weight: 600; color: #ccc;
      border-bottom: 1px solid #3c3c3c; text-transform: uppercase; letter-spacing: 0.5px;
      cursor: pointer;
    }
    #params-header:hover { background: #2a2d2e; }
    .param-row {
      padding: 4px 10px; display: flex; flex-direction: column; gap: 2px;
    }
    .param-label {
      display: flex; justify-content: space-between; font-size: 11px; color: #aaa;
    }
    .param-label .param-value { color: #4fc1ff; font-family: monospace; }
    .param-slider {
      -webkit-appearance: none; width: 100%; height: 4px; border-radius: 2px;
      background: #3c3c3c; outline: none;
    }
    .param-slider::-webkit-slider-thumb {
      -webkit-appearance: none; width: 12px; height: 12px; border-radius: 50%;
      background: #0e639c; cursor: pointer; border: 1px solid #1177bb;
    }
    .param-slider::-webkit-slider-thumb:hover { background: #1177bb; }

    /* Section plane slider */
    #section-controls {
      position: absolute; bottom: 40px; left: 10px; z-index: 20;
      background: rgba(37,37,38,0.9); padding: 6px 10px; border-radius: 5px;
      border: 1px solid #3c3c3c; display: none; width: 160px;
    }
    #section-controls.open { display: block; }
    #section-controls label { font-size: 10px; color: #aaa; display: block; margin-bottom: 3px; }
    #section-controls select, #section-controls input[type=range] {
      width: 100%; font-size: 11px;
    }
    #section-controls select {
      background: #3c3c3c; color: #ccc; border: 1px solid #555;
      padding: 2px; border-radius: 3px;
    }

    /* Measurement overlay */
    #measure-info {
      position: absolute; top: 40px; left: 50%; transform: translateX(-50%);
      background: rgba(37,37,38,0.95); color: #4fc1ff; font-family: monospace;
      font-size: 12px; padding: 4px 12px; border-radius: 4px;
      border: 1px solid #0e639c; z-index: 25; display: none; white-space: nowrap;
    }

    /* Status bar */
    #statusbar {
      position: absolute; bottom: 0; left: 0; right: 0; z-index: 15;
      background: rgba(37,37,38,0.9); border-top: 1px solid #3c3c3c;
      padding: 3px 10px; display: flex; justify-content: space-between;
      font-size: 11px; color: #888;
    }
    #filename { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #999; }
    #status { white-space: nowrap; }

    #loading {
      position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
      color: #666; font-size: 13px; z-index: 30;
    }
  </style>
</head>
<body>
  <div id="app">
    <div id="parts-panel">
      <div id="parts-header">Components <span class="count" id="parts-count"></span></div>
      <div id="parts-list"></div>
      <div id="params-panel">
        <div id="params-header">Parameters</div>
        <div id="params-list"></div>
      </div>
    </div>
    <div id="viewport">
      <div id="canvas-container"></div>

      <div id="view-toolbar">
        <button id="btn-parts" title="Toggle parts browser">&#9776;</button>
      </div>

      <div id="toolbar">
        <button id="btn-fit" title="Fit to view">Fit</button>
        <button id="btn-edges" class="active" title="Toggle edges">Edges</button>
        <button id="btn-wire" title="Toggle wireframe">Wire</button>
        <button id="btn-dims" title="Toggle dimensions">Dims</button>
        <button id="btn-section" title="Section/clip plane">Section</button>
        <button id="btn-measure" title="Click-to-measure mode">Measure</button>
        <div class="sep"></div>
        <div id="export-menu-wrapper" class="menu-wrapper">
          <button id="btn-export" title="Export or open in another app">&#x21e9; Export &#9662;</button>
          <div id="export-menu" class="dropdown-menu">
            <button data-action="export-step">Save as STEP…</button>
            <button data-action="export-stl">Save as STL…</button>
            <div id="export-menu-apps"></div>
          </div>
        </div>
      </div>

      <div id="viewcube">
        <button id="vc-top" title="Top view">Top</button>
        <button id="vc-front" title="Front view">Front</button>
        <button id="vc-right" title="Right view">Right</button>
        <button id="vc-iso" title="Isometric view">Iso</button>
      </div>

      <div id="section-controls">
        <label>Axis</label>
        <select id="section-axis">
          <option value="x">X (Right)</option>
          <option value="y">Y (Forward)</option>
          <option value="z" selected>Z (Up)</option>
        </select>
        <label style="margin-top:4px">Position</label>
        <input type="range" id="section-pos" class="param-slider" min="0" max="100" value="50">
        <div style="font-size:10px;color:#4fc1ff;text-align:center" id="section-value">50%</div>
      </div>

      <div id="measure-info"></div>

      <div id="statusbar">
        <span id="filename"></span>
        <span id="status"></span>
      </div>
      <div id="loading">Loading ShapeItUp...</div>
    </div>
  </div>
  <script nonce="${nonce}">
    window.__SHAPEITUP_CONFIG__ = {
      workerUrl: "${workerJs}",
      wasmLoaderUrl: "${wasmLoaderJs}",
      wasmUrl: "${wasmFile}",
      manifoldLoaderUrl: "${manifoldLoaderJs}",
      manifoldWasmUrl: "${manifoldWasmFile}"
    };
  </script>
  <script nonce="${nonce}" src="${viewerJs}"></script>
</body>
</html>`;

    webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
  }

  private handleMessage(msg: any) {
    switch (msg.type) {
      case "ready":
        this.output.appendLine("[viewer] Ready — WASM loaded");
        this.isReady = true;
        // Push the list of detected 3D apps so the viewer can render the
        // "Open in …" dropdown items.
        this.sendInstalledApps(getDetectedApps());
        // If a script was queued while we were loading, execute it now
        if (this.pendingScript) {
          this.output.appendLine(
            `[viewer] Sending queued script: ${this.pendingScript.fileName}`
          );
          const webview = this.getActiveWebview();
          webview?.postMessage({
            type: "execute-script",
            ...this.pendingScript,
          });
          this.pendingScript = undefined;
        }
        break;
      case "error":
        this.output.appendLine(`[error] ${msg.message}`);
        this.output.show(true);
        vscode.window.showErrorMessage(`ShapeItUp: ${msg.message}`);
        // Intentionally do NOT write shapeitup-status.json here. The MCP
        // engine is authoritative for status — the extension's webview is a
        // second instance of the same compile, and a failure here (often a
        // divergent esbuild bundler) would clobber the engine's success
        // status (see Bug #2).
        // P1 fix: capture worker error state BEFORE rejecting the pending
        // render. The render-preview handler reads this via
        // takeLastRenderError() after awaitNextRender's rejection bubbles
        // up, and uses it to suppress the stale-PNG screenshot path.
        this.lastRenderError = {
          message: typeof msg.message === "string" ? msg.message : String(msg.message ?? ""),
          stack: typeof msg.stack === "string" ? msg.stack : undefined,
          operation: typeof msg.operation === "string" ? msg.operation : undefined,
          timestamp: Date.now(),
          fileName: typeof msg.fileName === "string" ? msg.fileName : this.lastExecutedFile,
        };
        // Defence-in-depth: write a sibling status file so the MCP server
        // can surface the error even if the command-file round trip never
        // completes (e.g. the extension host crashed after dispatching).
        // Deliberately does NOT clobber shapeitup-status.json — see the
        // comment block above about the engine being authoritative.
        this.writeViewerErrorFile(this.lastRenderError);
        // Bug C: unblock any awaitNextRender() caller so the render-preview
        // command doesn't just hang on its 8s timeout after a viewer error.
        this.rejectPendingRender(`viewer error: ${msg.message}`);
        break;
      case "render-success":
        this.output.appendLine(`[render] ${msg.stats}`);
        // Intentionally do NOT write shapeitup-status.json here. The MCP
        // engine is authoritative for status; writing from the webview
        // path risks overwriting the engine's record with fields derived
        // from a different bundler/worker instance.
        // Bug C: signal any awaitNextRender() caller that the webview-side
        // render (tessellation + scene update) actually finished — this is
        // the handshake the render-preview handler needs before it can safely
        // frame the camera and capture the screenshot.
        this.resolvePendingRender();
        break;
      case "status":
        this.output.appendLine(`[status] ${msg.message}`);
        break;
      case "toolbar-export":
        // Triggered from the in-viewer buttons
        if (msg.format === "step") {
          vscode.commands.executeCommand("shapeitup.exportSTEP");
        } else {
          vscode.commands.executeCommand("shapeitup.exportSTL");
        }
        break;
      case "toolbar-open-in-app":
        vscode.commands.executeCommand("shapeitup.openInApp", msg.appId);
        break;
      case "export-data":
        if (this.pendingExportResolve) {
          this.pendingExportResolve(msg.data);
          this.pendingExportResolve = undefined;
        }
        break;
      case "screenshot-data":
        if (this.pendingScreenshotResolve) {
          this.pendingScreenshotResolve(msg.dataUrl);
          this.pendingScreenshotResolve = undefined;
        }
        break;
      case "screenshot-ready":
        // T6.A: viewer signals that prepare-screenshot has finished rendering
        // both frames. Resolve the handshake so armPendingScreenshot /
        // awaitScreenshotReady callers can proceed immediately.
        if (this.pendingScreenshotReadyResolve) {
          this.pendingScreenshotReadyResolve();
          this.pendingScreenshotReadyResolve = undefined;
          this.pendingScreenshotReadyReject = undefined;
          this.pendingScreenshotReadyPromise = undefined;
        }
        break;
      case "part-warning":
        // Non-fatal: a focusPart/hideParts name didn't match any loaded part.
        // Log it and buffer it so the active render-preview call can surface it
        // to the MCP response.
        if (typeof msg.message === "string") {
          this.output.appendLine(`[warn] ${msg.message}`);
          this.partWarnings.push(msg.message);
        }
        break;
      case "request-wasm-assets":
        // Webview asks for cached OCCT (+ Manifold) bytes on every (re)spawn
        // of the worker. We serve from the in-memory cache populated on
        // activation (see extension.ts → getCachedWasmAssets). On error,
        // reply with an empty payload so the webview falls back to URL
        // fetch instead of hanging on its 2s timeout.
        this.serveWasmAssets();
        break;
    }
  }

  /**
   * Reply to a `request-wasm-assets` message. Reads from the extension-host
   * cache (warm after activation) and posts the bytes back to the active
   * webview. Failures degrade gracefully — the worker has a URL fallback.
   */
  private async serveWasmAssets(): Promise<void> {
    const webview = this.getActiveWebview();
    if (!webview) return;
    const distDir = path.join(this.context.extensionUri.fsPath, "dist");
    try {
      const assets = await getCachedWasmAssets(distDir);
      webview.postMessage({
        type: "wasm-assets",
        occt: assets.occt,
        manifold: assets.manifold,
      });
    } catch (err: any) {
      this.output.appendLine(
        `[wasm-cache] serve failed (${err?.message ?? err}) — viewer will fall back to URL fetch`,
      );
      // Reply with an empty payload so the webview's 2s timeout doesn't fire.
      webview.postMessage({ type: "wasm-assets" });
    }
  }

  /** Clear the per-part visibility warning buffer (called before a render). */
  resetPartWarnings() {
    this.partWarnings = [];
  }

  /**
   * Bug C: arm a pending-render promise BEFORE dispatching executeScript so
   * awaitNextRender() can reliably catch render-success even for fast renders
   * that complete before the caller gets a chance to await. Replaces any
   * previously-armed promise (which is rejected — its caller was waiting on
   * a render that's been superseded).
   */
  armPendingRender(): void {
    // P1 fix: clear any stale worker-error state from a previous render.
    // Without this, takeLastRenderError() could return an error produced by
    // the prior render and mis-attribute it to the render we're about to
    // start.
    this.lastRenderError = undefined;
    if (this.pendingRenderReject) {
      this.pendingRenderReject(new Error("render superseded by new executeScript"));
    }
    this.pendingRenderPromise = new Promise<void>((resolve, reject) => {
      this.pendingRenderResolve = resolve;
      this.pendingRenderReject = reject;
    });
    // Swallow unhandled rejections on superseded promises — callers who care
    // attach their own .catch via awaitNextRender.
    this.pendingRenderPromise.catch(() => {});
  }

  /**
   * P1 fix: consume-once accessor for the most recent webview-worker error.
   * Returns the error payload and clears it so repeat callers don't see a
   * stale error. Called by the render-preview command handler after
   * awaitNextRender rejects, so the MCP response can include the real worker
   * failure instead of silently capturing a screenshot of the previous
   * successful render.
   */
  takeLastRenderError(): { message: string; stack?: string; operation?: string; timestamp: number; fileName?: string } | undefined {
    const err = this.lastRenderError;
    this.lastRenderError = undefined;
    return err;
  }

  /**
   * Expose webview-ready state so the heartbeat payload can report whether
   * the viewer is mounted AND its worker finished WASM init. Used by
   * getViewerStatus() on the MCP side to distinguish "extension running,
   * viewer loading" from "extension running, viewer ready to render".
   */
  get viewerReady(): boolean {
    return this.isReady && !!this.getActiveWebview();
  }

  /**
   * P1 fix: write a sibling JSON status file next to shapeitup-status.json
   * when the webview worker reports an error. The MCP server reads this if
   * its timestamp is newer than shapeitup-status.json's, surfacing
   * webview-only errors that the extension-host path never got to see.
   *
   * Deliberately writes to shapeitup-viewer-error.json — the existing
   * `writeStatusFile` comment explains why clobbering shapeitup-status.json
   * from the webview path is unsafe (divergent bundlers can overwrite a
   * successful engine record with a spurious "failure").
   */
  private writeViewerErrorFile(err: { message: string; stack?: string; operation?: string; timestamp: number; fileName?: string }): void {
    try {
      const dir = this.context.globalStorageUri.fsPath;
      fs.mkdirSync(dir, { recursive: true });
      const p = path.join(dir, "shapeitup-viewer-error.json");
      fs.writeFileSync(
        p,
        JSON.stringify({
          message: err.message,
          stack: err.stack,
          operation: err.operation,
          timestamp: err.timestamp,
          fileName: err.fileName,
        }),
      );
    } catch {
      // Best effort — observability, not load-bearing.
    }
  }

  /**
   * Wait for the next `render-success` (or `error`) message from the webview.
   * Rejects on timeout. Returns immediately if no render is armed (caller
   * forgot to call armPendingRender first — treat as no-op).
   */
  async awaitNextRender(timeoutMs: number): Promise<void> {
    if (!this.pendingRenderPromise) return;
    const p = this.pendingRenderPromise;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingRenderReject) {
          this.pendingRenderReject(
            new Error(`awaitNextRender: timed out after ${timeoutMs}ms`)
          );
        }
        reject(new Error(`awaitNextRender: timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      p.then(
        () => { clearTimeout(timer); resolve(); },
        (err) => { clearTimeout(timer); reject(err); }
      );
    });
  }

  /** Resolve a pending render promise (called by render-success handler). */
  private resolvePendingRender(): void {
    if (this.pendingRenderResolve) {
      this.pendingRenderResolve();
    }
    this.pendingRenderResolve = undefined;
    this.pendingRenderReject = undefined;
    this.pendingRenderPromise = undefined;
  }

  /** Reject a pending render promise (called by error handler). */
  private rejectPendingRender(reason: string): void {
    if (this.pendingRenderReject) {
      this.pendingRenderReject(new Error(reason));
    }
    this.pendingRenderResolve = undefined;
    this.pendingRenderReject = undefined;
    this.pendingRenderPromise = undefined;
  }

  /**
   * T6.A: arm a pending screenshot-ready promise BEFORE dispatching
   * prepare-screenshot. Mirrors armPendingRender — arm first so the
   * handshake catches even a synchronous/fast viewer response.
   */
  armPendingScreenshot(): void {
    if (this.pendingScreenshotReadyReject) {
      this.pendingScreenshotReadyReject(new Error("screenshot superseded"));
    }
    this.pendingScreenshotReadyPromise = new Promise<void>((resolve, reject) => {
      this.pendingScreenshotReadyResolve = resolve;
      this.pendingScreenshotReadyReject = reject;
    });
    this.pendingScreenshotReadyPromise.catch(() => {});
  }

  /**
   * T6.A: wait for the viewer's `screenshot-ready` postMessage. Rejects on
   * timeout (caller proceeds with today's graceful-degradation behavior).
   */
  async awaitScreenshotReady(timeoutMs: number): Promise<void> {
    if (!this.pendingScreenshotReadyPromise) return;
    const p = this.pendingScreenshotReadyPromise;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingScreenshotReadyReject) {
          this.pendingScreenshotReadyReject(
            new Error(`awaitScreenshotReady: timed out after ${timeoutMs}ms`)
          );
        }
        reject(new Error(`awaitScreenshotReady: timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      p.then(
        () => { clearTimeout(timer); resolve(); },
        (err) => { clearTimeout(timer); reject(err); }
      );
    });
  }

  /** Drain the buffered per-part visibility warnings. */
  drainPartWarnings(): string[] {
    const out = this.partWarnings;
    this.partWarnings = [];
    return out;
  }

  private getActiveWebview(): vscode.Webview | undefined {
    return this.panel?.webview ?? this.view?.webview;
  }

  private executing = false;

  /**
   * In-memory cache of bundled `.shape.ts` outputs, keyed by the normalized
   * absolute path of the entry file. Avoids re-running esbuild.build() when
   * neither the entry file nor any of its transitive imports have changed.
   * Lives for the extension session; never persisted to disk.
   */
  private bundleCache = new Map<string, BundleCacheEntry>();

  /**
   * Last bundle actually handed to the viewer. Single entry, not a per-file
   * map — we only dedup when the incoming bundle matches what's CURRENTLY
   * on screen. If the user navigates A → B → A, the third event must
   * re-render A even though its bundle is byte-identical to step 1's, because
   * the viewer is now showing B.
   */
  private lastDispatched: { path: string; code: string; overrides: string } | null = null;

  /**
   * Decide whether `entry` is still fresh for `liveCode` (the entry file's
   * current in-memory text). Returns `null` if the cache is reusable, or a
   * short human-readable reason string if it must be invalidated. Any fs
   * error is treated as an invalidation (safer to rebundle than to serve a
   * stale bundle because a stat failed).
   */
  private checkBundleCache(entry: BundleCacheEntry, liveCode: string): string | null {
    if (entry.entryContent !== liveCode) {
      return "entry file content changed in-memory";
    }
    try {
      for (const [inputPath, recordedMtime] of Object.entries(entry.inputMtimes)) {
        const stat = fs.statSync(inputPath);
        if (Math.abs(stat.mtimeMs - recordedMtime) > 1) {
          return `input mtime changed: ${inputPath}`;
        }
      }
    } catch (e: any) {
      return `stat failed: ${e?.message ?? String(e)}`;
    }
    // New-import bug fix: detect local imports in the live entry source that are
    // not tracked in inputMtimes. If the user added `import './newfile.ts'` since
    // the last bundle, the new file was never in the cache and we must miss.
    const entryDir = path.dirname(entry.entryPath);
    const localSpecs = extractLocalImportSpecifiers(liveCode);
    for (const spec of localSpecs) {
      const candidates = [spec, `${spec}.ts`, `${spec}.shape.ts`].map((s) =>
        path.isAbsolute(s) ? s : path.resolve(entryDir, s),
      );
      const tracked = Object.keys(entry.inputMtimes);
      const inCache = candidates.some((c) =>
        tracked.some((t) => t.toLowerCase() === c.toLowerCase()),
      );
      if (!inCache) {
        return `new local import not in cache: ${spec}`;
      }
    }
    return null;
  }

  async executeScript(
    document: vscode.TextDocument,
    paramOverrides?: Record<string, number>,
    meshQuality?: "preview" | "final",
  ) {
    const webview = this.getActiveWebview();
    if (!webview) {
      this.output.appendLine("[warn] No active webview to send script to");
      return;
    }

    // Prevent concurrent executions (IPC + auto-preview can both trigger)
    if (this.executing) return;
    this.executing = true;

    const code = document.getText();

    try {
      await ensureEsbuild();
      // Use esbuild.build to resolve local imports between .shape.ts files
      // Normalize the path: resolve, forward slashes, uppercase drive letter
      const normalizedPath = path.resolve(document.fileName)
        .split(path.sep).join("/")
        .replace(/^([a-z]):/, (_, l) => l.toUpperCase() + ":");

      const resolveDir = path.dirname(normalizedPath);

      let js: string;
      const cached = this.bundleCache.get(normalizedPath);
      const invalidReason = cached ? this.checkBundleCache(cached, code) : "no cache entry";

      if (cached && invalidReason === null) {
        js = cached.js;
        this.output.appendLine(`[exec] Cache hit for ${document.fileName}`);
      } else {
        this.output.appendLine(`[exec] Cache miss (${invalidReason}), rebundling ${document.fileName}`);
        // Preflight: catch `import { main, params } from './other.shape'` before
        // esbuild emits its generic "No matching export" — the executor strips
        // those exports, so a custom error with the factory-function workaround
        // is far more actionable.
        preflightShapeImports(code, normalizedPath);
        // Multi-file .shape.ts disambiguation (synthetic-wrapper approach).
        //
        // Earlier implementation used an esbuild `footer.js` that stamped
        // `main` / `params` onto globalThis. That form was ambiguous when the
        // entry imported a sibling `.shape.ts` whose `export default main` got
        // hoisted under the bare name `main` — the footer would then pick the
        // WRONG one (see P5). The synthetic-wrapper pattern mirrors the MCP
        // engine (packages/mcp-server/src/engine.ts around line 953): we feed
        // esbuild a tiny stdin module that namespace-imports the user's entry,
        // then assigns the entry's default/params to globals. The
        // `__shapeitup_entry__.default` reference is structurally unambiguous,
        // so renames inside the bundle can't break it.
        //
        // The sentinel __SHAPEITUP_ENTRY_SENTINEL__ tells the executor this
        // marker was set by a trusted wrapper (vs leaked from a prior
        // execution). The wrapper also clears the three globals in a try/catch
        // so a subsequent execution can't read a stale entry.
        const entryImportPath = normalizedPath.replace(/\\/g, "/");
        const syntheticEntry =
          `import * as __shapeitup_entry__ from ${JSON.stringify(entryImportPath)};\n` +
          `try { globalThis.__SHAPEITUP_ENTRY_MAIN__ = __shapeitup_entry__.default; } catch (e) {}\n` +
          `try { globalThis.__SHAPEITUP_ENTRY_PARAMS__ = __shapeitup_entry__.params; } catch (e) {}\n` +
          `try { globalThis.__SHAPEITUP_ENTRY_SENTINEL__ = true; } catch (e) {}\n` +
          `export default __shapeitup_entry__.default;\n` +
          `export const params = __shapeitup_entry__.params;\n` +
          `export const material = __shapeitup_entry__.material;\n` +
          `export const config = __shapeitup_entry__.config;\n`;
        const result = await esbuild.build({
          stdin: {
            contents: syntheticEntry,
            resolveDir,
            // Must differ from `normalizedPath` — if it matched the user's
            // file path, esbuild would try to treat the stdin as the same
            // module it's trying to `import * from …` and short-circuit the
            // bundle (both `default` and `params` come back undefined).
            sourcefile: path.join(resolveDir, "__shapeitup_wrapper__.ts"),
            loader: "ts",
          },
          bundle: true,
          write: false,
          format: "esm",
          target: "es2022",
          external: [...BUNDLE_EXTERNALS],
          platform: "browser",
          absWorkingDir: resolveDir,
          metafile: true,
          // With the synthetic wrapper the user's file is resolved by its
          // full `.shape.ts` absolute path. esbuild dispatches on the FULL
          // extension, so map `.shape.ts` and `.shape` explicitly to TS.
          loader: { ".shape.ts": "ts", ".shape": "ts" },
          // `sourcemap: "inline"` appends `//# sourceMappingURL=data:...` to
          // the bundle. V8 uses that (together with the `//# sourceURL=`
          // directive the core executor emits) to resolve user-script stack
          // frames to `bracket.shape.ts:12:14` instead of
          // `Object.<anonymous>:48:52`. Zero extra runtime deps — V8 does
          // all the mapping.
          sourcemap: "inline",
          logLevel: "silent",
        });

        // Treat "Could not resolve" warnings as hard errors — a missing local
        // import silently tree-shakes when the symbol is unused, masking typos.
        const resolutionErrors = result.warnings.filter((w) =>
          w.text.includes("Could not resolve")
        );
        if (resolutionErrors.length > 0) {
          const msg = resolutionErrors.map((w) => w.text).join("\n");
          throw new Error(`Unresolved imports:\n${msg}`);
        }
        // Filter out "Import 'X' will always be undefined" warnings for the
        // optional names the synthetic wrapper re-exports (`config`, `material`,
        // `params`). These fire on every file that doesn't declare one of them
        // — which is most — and the re-export pattern is deliberate.
        const OPTIONAL_REEXPORT_NAMES = /Import "(config|material|params)" will always be undefined/;
        // Surface other (non-fatal) warnings in the output channel.
        for (const w of result.warnings) {
          if (OPTIONAL_REEXPORT_NAMES.test(w.text)) continue;
          this.output.appendLine(`[warn] ${w.text}`);
        }

        js = result.outputFiles[0].text;

        // Record mtime for every LOCAL import esbuild discovered so we can
        // invalidate next time if any of them changes on disk. Walks
        // `inputs[entry].imports[].path` recursively so TRANSITIVE
        // dependencies land in inputMtimes alongside direct ones (without
        // this, editing `constants.ts` two levels deep wouldn't invalidate
        // the root entry's cache and stale JS would run). Explicitly skips
        // the entry file: its freshness is already handled by the
        // entryContent equality check, and mtime can flicker on Windows
        // (editor touches, indexers) without content changing — double-
        // checking here causes spurious cache misses.
        const inputMtimes: Record<string, number> = {};
        try {
          const metafileInputs = result.metafile?.inputs ?? {};
          // With the synthetic-wrapper entry the metafile's entry key is the
          // wrapper's relative path (esbuild normalises it against
          // absWorkingDir). Locate it by its unique `__shapeitup_wrapper__`
          // marker rather than string-matching a computed relative form,
          // because Windows/POSIX path joins diverge.
          const wrapperKey = Object.keys(metafileInputs).find((k) =>
            k.toLowerCase().includes("__shapeitup_wrapper__"),
          );
          const absInputs = wrapperKey
            ? collectBundleInputsRecursive(metafileInputs, wrapperKey, resolveDir, normalizedPath)
            : // Fallback to a flat walk if we can't locate the wrapper key
              // (shouldn't happen with the synthetic entry above, but keep as
              // a safety net so a future refactor doesn't silently lose
              // invalidation coverage).
              Object.keys(metafileInputs)
                .filter((p) => !p.toLowerCase().includes("__shapeitup_wrapper__"))
                .map((p) => (path.isAbsolute(p) ? p : path.resolve(resolveDir, p)))
                .filter((abs) => abs.toLowerCase() !== document.fileName.toLowerCase()
                  && abs.toLowerCase() !== normalizedPath.toLowerCase());
          for (const abs of absInputs) {
            try {
              inputMtimes[abs] = fs.statSync(abs).mtimeMs;
            } catch {
              // If we can't stat an input at bundle time, omit it — the next
              // run will see a mismatch (entry in cache but file missing) and
              // fall through to rebundle.
            }
          }
        } catch {
          // Metafile walk failed entirely — leave inputMtimes empty so any
          // future call falls back to checking only the entry content.
        }

        this.bundleCache.set(normalizedPath, {
          js,
          entryContent: code,
          entryPath: normalizedPath,
          inputMtimes,
        });
      }

      // Prepend a `//# sourceURL=file:///...` pragma so V8 attributes user-
      // script stack frames to the real .shape.ts. The core executor picks
      // this up at `new Function()` time and lifts it to the top of the
      // wrapper source — couldn't thread a filename through `core.execute()`
      // directly (owned by another agent). Paired with the inline sourcemap
      // esbuild now embeds, stacks read like `bracket.shape.ts:12:14`
      // instead of `Object.<anonymous>:48:52`.
      const jsWithSourceURL = `//# sourceURL=file:///${normalizedPath.replace(/^\/+/, "")}\n${js}`;

      const msg: {
        js: string;
        fileName: string;
        paramOverrides?: Record<string, number>;
        meshQuality?: "preview" | "final";
      } = { js: jsWithSourceURL, fileName: document.fileName };
      // Ephemeral param overrides used by MCP's tune_params + any caller that
      // wants the viewer to render with non-default values without touching
      // the file on disk. Undefined means "use the script's declared defaults".
      if (paramOverrides && Object.keys(paramOverrides).length > 0) {
        msg.paramOverrides = paramOverrides;
      }
      // P3-10: forward MCP-supplied meshQuality verbatim. Undefined leaves
      // core.execute's auto-degrade heuristic in charge (≥15 parts → preview).
      if (meshQuality) {
        msg.meshQuality = meshQuality;
      }

      this.lastExecutedFile = document.fileName;

      // Dedupe: tab-switch + file-watcher + save often fire in quick succession
      // for the SAME file with identical content — the worker would just
      // re-tessellate the same input. But only dedup against what's actually
      // on-screen; navigating away and back must re-render even if the bundle
      // matches a previous dispatch of that file.
      //
      // Exception: if a pendingRenderPromise is armed (render-preview flow),
      // dedup would silence the only signal the caller is waiting for — the
      // webview wouldn't post render-success because no re-render happened,
      // awaitNextRender times out at 8s, and the screenshot captures stale
      // geometry. Always re-dispatch when something is awaiting a render.
      const overridesKey = paramOverrides ? JSON.stringify(paramOverrides) : "";
      if (
        this.isReady &&
        this.lastDispatched &&
        this.lastDispatched.path === normalizedPath &&
        this.lastDispatched.code === js &&
        this.lastDispatched.overrides === overridesKey &&
        !this.pendingRenderPromise
      ) {
        this.output.appendLine(`[exec] Dedup: identical bundle already dispatched for ${document.fileName}`);
        return;
      }
      this.lastDispatched = { path: normalizedPath, code: js, overrides: overridesKey };

      if (this.isReady) {
        this.output.appendLine(`[exec] Sending to viewer (${js.length} chars)`);
        webview.postMessage({ type: "execute-script", ...msg });
      } else {
        // Worker still loading WASM — queue the script
        this.output.appendLine("[exec] Worker not ready yet, queuing script");
        this.pendingScript = msg;
      }
    } catch (e: any) {
      this.output.appendLine(`[error] Bundle failed: ${e.message}`);
      vscode.window.showErrorMessage(`ShapeItUp bundle error: ${e.message}`);
      // Intentionally do NOT write shapeitup-status.json here. The MCP
      // engine's bundler is authoritative; the extension's esbuild-wasm
      // bundle is just to drive the visible webview, and divergence from
      // the MCP-side bundle (e.g. missing `external`) would otherwise
      // clobber a valid engine success status (see Bug #2).
    } finally {
      this.executing = false;
    }
  }

  /** Push the list of detected 3D apps to the viewer so it can render the "Open in …" dropdown. */
  sendInstalledApps(apps: DetectedApp[]) {
    const webview = this.getActiveWebview();
    if (!webview) return;
    // Strip execPath — the webview doesn't need it and it's nicer not to leak paths.
    const payload = apps.map((a) => ({
      id: a.id,
      name: a.name,
      preferredFormat: a.preferredFormat,
    }));
    webview.postMessage({ type: "installed-apps", apps: payload });
  }

  async requestExport(format: ExportFormat): Promise<ArrayBuffer | undefined> {
    const webview = this.getActiveWebview();
    if (!webview) {
      this.output.appendLine("[export] No active webview — aborting");
      return undefined;
    }

    // If a previous export is still in flight, cancel it so the new one isn't
    // silently dropped (pendingExportResolve is single-slot).
    if (this.pendingExportResolve) {
      this.clearPending("superseded by new export");
    }

    return new Promise((resolve) => {
      this.pendingExportResolve = resolve;
      webview.postMessage({ type: "request-export", format });
      setTimeout(() => {
        if (this.pendingExportResolve === resolve) {
          this.pendingExportResolve = undefined;
          this.output.appendLine(`[export] Timeout after 30s — worker did not reply`);
          resolve(undefined);
        }
      }, 30000);
    });
  }

  /**
   * Capture a screenshot and save to disk. Returns the file path.
   * `width`/`height` temporarily resize the WebGL canvas so the output is
   * decoupled from the user's window size — important for AI consumers that
   * need a predictable resolution.
   *
   * When `outputPath` is provided, the PNG is written to that exact path and
   * the same path is returned verbatim. This is the trusted path used by the
   * MCP render-preview flow (fix for Bug #1/#12 — the old synthesis from
   * `this.lastExecutedFile` could be stale because executeScript is fired
   * without await). When absent, the legacy filename synthesis is preserved.
   */
  async captureScreenshot(
    outputDir?: string,
    cameraAngle?: string,
    width?: number,
    height?: number,
    outputPath?: string
  ): Promise<string | undefined> {
    const webview = await this.ensureWebview();
    if (!webview) {
      this.output.appendLine("[screenshot] No active webview — aborting");
      return undefined;
    }

    if (this.pendingScreenshotResolve) {
      this.clearPending("superseded by new screenshot");
    }

    const dataUrl = await new Promise<string | undefined>((resolve) => {
      this.pendingScreenshotResolve = resolve;
      webview.postMessage({ type: "request-screenshot", width, height });
      setTimeout(() => {
        if (this.pendingScreenshotResolve === resolve) {
          this.pendingScreenshotResolve = undefined;
          this.output.appendLine("[screenshot] Timeout after 10s — webview did not reply");
          resolve(undefined);
        }
      }, 10000);
    });

    if (!dataUrl) return undefined;

    // Convert data URL to buffer and save
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
    const buffer = Buffer.from(base64, "base64");

    let filePath: string;
    let dir: string;
    if (outputPath) {
      // Trusted caller (MCP render-preview) — pin the path exactly.
      filePath = outputPath;
      dir = path.dirname(outputPath);
      // Drift check: if the webview's last-executed shape doesn't match what
      // MCP told us to write, log a warning so it's detectable in the output
      // channel. This is the exact signature of the Bug #1 race — when it
      // fires, we now still write the right PNG (because MCP pinned it),
      // but the user gets a breadcrumb.
      const mcpBase = path.basename(outputPath);
      const lastBase = this.lastExecutedFile
        ? path.basename(this.lastExecutedFile, ".shape.ts")
        : "";
      if (lastBase && !mcpBase.includes(lastBase)) {
        this.output.appendLine(
          `[screenshot] drift: MCP requested ${mcpBase} but lastExecutedFile is ${this.lastExecutedFile} — honoring MCP path`
        );
      }
    } else {
      dir = outputDir || this.context.globalStorageUri.fsPath;
      const shapeName = this.lastExecutedFile
        ? path.basename(this.lastExecutedFile, '.shape.ts')
        : 'unknown';
      // Include camera angle in filename to avoid parallel call collisions
      const angleSuffix = cameraAngle ? `-${cameraAngle}` : "";
      filePath = path.join(dir, `shapeitup-preview-${shapeName}${angleSuffix}.png`);
    }
    const latestPath = path.join(dir, "shapeitup-preview.png");

    await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir));
    const bufferArr = new Uint8Array(buffer);
    await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), bufferArr);
    await vscode.workspace.fs.writeFile(vscode.Uri.file(latestPath), bufferArr);

    this.lastScreenshotPath = filePath;
    this.output.appendLine(`[screenshot] Saved to ${filePath}`);
    return filePath;
  }

  getLastScreenshotPath(): string | undefined {
    return this.lastScreenshotPath;
  }

  /** Send a command to the viewer webview */
  sendViewerCommand(command: string, params?: any) {
    const webview = this.getActiveWebview();
    if (webview) {
      webview.postMessage({ type: "viewer-command", command, ...params });
    }
  }

  /** Write render status to a file the MCP server can read */
  private writeStatusFile(status: any) {
    try {
      const fs = require("fs");
      const dir = this.context.globalStorageUri.fsPath;
      fs.mkdirSync(dir, { recursive: true });
      const statusPath = path.join(dir, "shapeitup-status.json");
      fs.writeFileSync(
        statusPath,
        JSON.stringify({
          ...status,
          timestamp: new Date().toISOString(),
        })
      );
    } catch {
      // Ignore write failures
    }
  }
}

function getNonce(): string {
  let text = "";
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
