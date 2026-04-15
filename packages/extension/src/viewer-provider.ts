import * as vscode from "vscode";
import * as esbuild from "esbuild-wasm";
import * as path from "path";
import type { ExportFormat } from "@shapeitup/shared";

let esbuildInitialized = false;

async function ensureEsbuild() {
  if (!esbuildInitialized) {
    const wasmPath = path.join(
      path.dirname(require.resolve("esbuild-wasm/package.json")),
      "esbuild.wasm"
    );
    await esbuild.initialize({ wasmURL: vscode.Uri.file(wasmPath).toString() });
    esbuildInitialized = true;
  }
}

export class ViewerProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private panel?: vscode.WebviewPanel;
  private context: vscode.ExtensionContext;
  private output: vscode.OutputChannel;
  private pendingExportResolve?: (data: ArrayBuffer) => void;
  private pendingScreenshotResolve?: (dataUrl: string) => void;
  private isReady = false;
  private pendingScript?: { js: string; fileName: string };
  private lastScreenshotPath?: string;

  constructor(context: vscode.ExtensionContext, output: vscode.OutputChannel) {
    this.context = context;
    this.output = output;
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;
    this.isReady = false;
    this.configureWebview(webviewView.webview);
  }

  openPanel(context: vscode.ExtensionContext) {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }

    this.isReady = false;
    this.panel = vscode.window.createWebviewPanel(
      "shapeitup.preview",
      "ShapeItUp Preview",
      vscode.ViewColumn.Beside,
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
    });
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
        <button id="btn-step" title="Export STEP">&#x21e9; STEP</button>
        <button id="btn-stl" title="Export STL">&#x21e9; STL</button>
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
      wasmUrl: "${wasmFile}"
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
    }
  }

  private getActiveWebview(): vscode.Webview | undefined {
    return this.panel?.webview ?? this.view?.webview;
  }

  async executeScript(document: vscode.TextDocument) {
    const webview = this.getActiveWebview();
    if (!webview) {
      this.output.appendLine("[warn] No active webview to send script to");
      return;
    }

    const code = document.getText();
    this.output.appendLine(`[exec] Bundling ${document.fileName}`);

    try {
      await ensureEsbuild();
      // Use esbuild.build (not transform) to resolve local imports between .shape.ts files
      const result = await esbuild.build({
        entryPoints: [document.fileName],
        bundle: true,
        write: false,
        format: "esm",
        target: "es2022",
        external: ["replicad"], // worker handles replicad imports
        platform: "browser",
      });

      const js = result.outputFiles[0].text;
      const msg = { js, fileName: document.fileName };

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
    }
  }

  async requestExport(format: ExportFormat): Promise<ArrayBuffer | undefined> {
    const webview = this.getActiveWebview();
    if (!webview) return undefined;

    return new Promise((resolve) => {
      this.pendingExportResolve = resolve;
      webview.postMessage({ type: "request-export", format });
      setTimeout(() => {
        if (this.pendingExportResolve === resolve) {
          this.pendingExportResolve = undefined;
          resolve(undefined);
        }
      }, 30000);
    });
  }

  /** Capture a screenshot and save to disk. Returns the file path. */
  async captureScreenshot(outputDir?: string): Promise<string | undefined> {
    const webview = this.getActiveWebview();
    if (!webview) return undefined;

    const dataUrl = await new Promise<string | undefined>((resolve) => {
      this.pendingScreenshotResolve = resolve;
      webview.postMessage({ type: "request-screenshot" });
      setTimeout(() => {
        if (this.pendingScreenshotResolve === resolve) {
          this.pendingScreenshotResolve = undefined;
          resolve(undefined);
        }
      }, 10000);
    });

    if (!dataUrl) return undefined;

    // Convert data URL to buffer and save
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
    const buffer = Buffer.from(base64, "base64");

    const dir = outputDir || this.context.globalStorageUri.fsPath;
    const filePath = path.join(dir, "shapeitup-preview.png");

    await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir));
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(filePath),
      new Uint8Array(buffer)
    );

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
