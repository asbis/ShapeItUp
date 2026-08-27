/**
 * Viewer page template — shared by the VSCode webview host and the standalone
 * HTTP server (`@shapeitup/serve`).
 *
 * Extracted verbatim from `viewer-provider.ts` so the two hosts can never
 * drift. Everything host-specific is a parameter:
 *   - asset URLs (webview URIs vs. plain relative paths)
 *   - CSP source + script nonce (webviews require a nonce; http origins don't)
 *   - extra connect-src / worker-src entries (the http host needs ws: and 'self')
 */

export interface ViewerAssetUrls {
  viewerJs: string;
  workerJs: string;
  wasmLoaderJs: string;
  wasmFile: string;
  manifoldLoaderJs: string;
  manifoldWasmFile: string;
  mujocoLoaderJs: string;
  mujocoWasmFile: string;
}

export interface ViewerHtmlOptions {
  assets: ViewerAssetUrls;
  /** `webview.cspSource` for VSCode; `'self'` for the http server. */
  cspSource: string;
  /** Required by the VSCode webview CSP; omit for the http server. */
  nonce?: string;
  /** Extra `connect-src` entries, e.g. `ws://127.0.0.1:1234`. */
  connectSrc?: string;
  /** Extra `worker-src` entries, e.g. `'self'`. */
  workerSrc?: string;
}

/** Default asset URLs for a server that exposes `dist/` at the page root. */
export const RELATIVE_VIEWER_ASSETS: ViewerAssetUrls = {
  viewerJs: "viewer.js",
  workerJs: "worker.js",
  wasmLoaderJs: "replicad_single.js",
  wasmFile: "replicad_single.wasm",
  manifoldLoaderJs: "manifold.js",
  manifoldWasmFile: "manifold.wasm",
  mujocoLoaderJs: "mujoco.js",
  mujocoWasmFile: "mujoco.wasm",
};

export function renderViewerHtml(opts: ViewerHtmlOptions): string {
  const a = opts.assets;
  const cspSource = opts.cspSource;
  const nonceAttr = opts.nonce ? ` nonce="${opts.nonce}"` : "";
  const scriptSrcToken = opts.nonce ? `'nonce-${opts.nonce}'` : "'self'";
  const connectExtra = opts.connectSrc ?? "";
  const workerExtra = opts.workerSrc ?? "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="
    default-src 'none';
    script-src ${scriptSrcToken} 'unsafe-eval' 'wasm-unsafe-eval' ${cspSource};
    style-src 'unsafe-inline';
    connect-src ${cspSource} blob: ${connectExtra};
    worker-src blob: ${workerExtra};
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

    /* ViewCube — 3×2 grid of axis views (top/bottom, front/back, right/left)
       plus a full-width Iso row. Gives one-click access to every side so
       users don't need to drag past the pole to see the underside. */
    #viewcube {
      position: absolute; bottom: 40px; right: 10px; z-index: 20;
      display: grid; grid-template-columns: 1fr 1fr; gap: 2px;
      background: rgba(37,37,38,0.85); padding: 4px; border-radius: 5px;
      border: 1px solid #3c3c3c;
    }
    #viewcube button {
      background: transparent; border: none; color: #999; cursor: pointer;
      font-size: 10px; padding: 3px 6px; border-radius: 2px; font-family: inherit;
      min-width: 44px;
    }
    #viewcube button:hover { background: #3c3c3c; color: #fff; }
    #viewcube button.vc-iso { grid-column: 1 / span 2; }

    /* Parameters panel (bottom of parts panel) */
    #params-panel {
      border-top: 1px solid #3c3c3c; padding: 0; max-height: 0; overflow: hidden;
      transition: max-height 0.2s ease;
    }
    #params-panel.open { max-height: 400px; overflow-y: auto; padding-bottom: 6px; }
    #params-list { padding-top: 3px; }
    #params-header {
      padding: 7px 10px; font-size: 11px; font-weight: 600; color: #ccc;
      border-bottom: 1px solid #3c3c3c; text-transform: uppercase; letter-spacing: 0.5px;
      cursor: pointer;
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
    }
    #params-header:hover { background: #2a2d2e; }
    /* The switch sits inside a header that toggles the panel, so it has to stop
       its own clicks from collapsing the thing it lives in. */
    #params-save {
      display: flex; align-items: center; gap: 5px;
      font-weight: 400; text-transform: none; letter-spacing: 0;
      color: #888; cursor: pointer; white-space: nowrap;
    }
    #params-save:hover { color: #ccc; }
    #params-save input { margin: 0; cursor: pointer; accent-color: #4fc1ff; }
    #params-save.on { color: #4fc1ff; }
    #params-status {
      /* Directly under the header and sticky: a decline is unreadable if a long
         parameter list can scroll it off the bottom of the panel. */
      position: sticky; top: 0; z-index: 1; background: #252526;
      padding: 0 10px; font-size: 10px; color: #888; min-height: 0;
      transition: min-height 0.15s ease;
    }
    #params-status.show { min-height: 16px; padding-bottom: 4px; }
    #params-status.warn { color: #e5a03c; }
    /* One line per parameter: name left, editable value right.
       Quiet by default — seven bright numbers in a column is noise, and none of
       them is more important than the model. Colour and chrome arrive on hover,
       which is also when the field becomes interactive. */
    .param-row {
      display: flex; align-items: center; justify-content: space-between;
      gap: 10px; padding: 0 10px 0 12px; min-height: 22px;
      border-left: 2px solid transparent;
    }
    .param-row:hover { background: #2a2d2e; border-left-color: #37373d; }
    .param-row:focus-within { background: #2a2d2e; border-left-color: #0e639c; }
    .param-name {
      font-size: 11px; color: #9d9d9d; letter-spacing: 0.1px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      /* The label half is deliberately inert: it is where the wheel still
         scrolls the panel, since the field itself takes the wheel on hover. */
      cursor: default;
    }
    .param-row:hover .param-name,
    .param-row:focus-within .param-name { color: #d4d4d4; }
    .param-input {
      flex: 0 0 auto; width: 58px; padding: 2px 5px;
      background: transparent; border: 1px solid transparent; border-radius: 3px;
      color: #b9bcc0; text-align: right;
      font-family: "SF Mono", Menlo, Consolas, monospace; font-size: 11px;
      /* Digits stay column-aligned as values change width. */
      font-variant-numeric: tabular-nums;
      /* The standard "scroll or drag me vertically" signal. Doing the work the
         tooltip would otherwise have to, without a glyph cluttering the row. */
      cursor: ns-resize;
      transition: background-color 0.1s ease, border-color 0.1s ease, color 0.1s ease;
    }
    /* No box on hover. The value stays plain text you can just scroll — the
       row highlight and the accent colour already say which one you are on,
       and a field appearing under the cursor makes a quiet list feel like a
       form. The box arrives only on focus, when you are typing and need to see
       exactly what you are editing. */
    .param-row:hover .param-input { color: #4fc1ff; }
    /* Must out-specify the hover rule above (0,3,0) — you are always hovering
       the field you just clicked into, so a plain .param-input:focus (0,2,0)
       lost, and the box never appeared when it was needed most. NOTE: no
       backticks in this block; the whole stylesheet is a template literal. */
    .param-input:focus,
    .param-row:hover .param-input:focus {
      outline: none; cursor: text;
      background: #1a1a1a; border-color: #0e639c; color: #7fd0ff;
    }
    .param-input.invalid,
    .param-row:hover .param-input.invalid { border-color: #cc8a3c; color: #e5a03c; }
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

    /* Motion-simulation timeline panel (docked bottom-center, above the statusbar) */
    #sim-panel {
      position: absolute; bottom: 30px; left: 50%; transform: translateX(-50%); z-index: 22;
      display: none; flex-direction: column; gap: 6px;
      background: rgba(37,37,38,0.95); border: 1px solid #3c3c3c; border-radius: 6px;
      padding: 8px 12px; min-width: 440px; max-width: 72vw;
      box-shadow: 0 4px 16px rgba(0,0,0,0.45); backdrop-filter: blur(8px);
    }
    #sim-panel.open { display: flex; }
    #sim-title { font-size: 10px; font-weight: 600; color: #888; text-transform: uppercase; letter-spacing: 0.5px; }
    #sim-transport { display: flex; align-items: center; gap: 8px; }
    #sim-play {
      background: #0e639c; color: #fff; border: 1px solid #1177bb; border-radius: 3px;
      font-family: inherit; font-size: 11px; padding: 4px 10px; cursor: pointer; white-space: nowrap;
    }
    #sim-play:hover { background: #1177bb; }
    #sim-scrub { flex: 1; }
    #sim-speed { background: #3c3c3c; color: #ccc; border: 1px solid #555; border-radius: 3px; font-size: 11px; padding: 2px; }
    #sim-time { font-size: 11px; color: #aaa; white-space: nowrap; min-width: 118px; text-align: right; }
    #sim-log {
      max-height: 92px; overflow-y: auto; font-size: 11px; line-height: 1.5; color: #ccc;
      border-top: 1px solid #3c3c3c; padding-top: 5px;
    }
    #sim-log::-webkit-scrollbar { width: 6px; }
    #sim-log::-webkit-scrollbar-thumb { background: #555; border-radius: 3px; }
    #sim-log .sim-head { color: #888; margin-bottom: 2px; }
    #sim-log .sim-row { padding: 1px 0; }
    #sim-log .sim-seek { cursor: pointer; }
    #sim-log .sim-seek:hover { color: #fff; }
    #sim-log .sim-pass { color: #4caf50; }
    #sim-log .sim-fail { color: #ff6b6b; }
    #toolbar button:disabled { opacity: 0.35; cursor: default; }
    #toolbar button:disabled:hover { background: transparent; color: #aaa; }

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
        <div id="params-header">
          <span>Parameters</span>
          <label id="params-save" title="Write a value into the .shape.ts when you release a slider">
            <input type="checkbox" id="params-save-toggle">
            <span>Save to file</span>
          </label>
        </div>
        <div id="params-status" aria-live="polite"></div>
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
        <button id="btn-sim" title="Motion simulation timeline (needs an 'export const sim' block)" disabled>Sim</button>
        <div class="sep"></div>
        <div id="export-menu-wrapper" class="menu-wrapper">
          <button id="btn-export" title="Export or open in another app">&#x21e9; Export &#9662;</button>
          <div id="export-menu" class="dropdown-menu">
            <button data-action="export-step">Save as STEP…</button>
            <button data-action="export-stl">Save as STL…</button>
            <button data-action="export-3mf">Save as 3MF (Bambu / Orca)…</button>
            <div class="menu-sep" role="separator"></div>
            <div class="menu-heading">Separate file per part</div>
            <button data-action="export-split-step">STEP — one file per part…</button>
            <button data-action="export-split-stl">STL — one file per part…</button>
            <button data-action="export-split-3mf">3MF — one file per part…</button>
            <div id="export-menu-apps"></div>
          </div>
        </div>
      </div>

      <div id="viewcube">
        <button id="vc-iso" class="vc-iso" title="Isometric view (1)">Iso</button>
        <button id="vc-top" title="Top view — looking down -Z (4)">Top</button>
        <button id="vc-bottom" title="Bottom view — looking up +Z (7)">Bottom</button>
        <button id="vc-front" title="Front view — looking along +Y (2)">Front</button>
        <button id="vc-back" title="Back view — looking along -Y (5)">Back</button>
        <button id="vc-right" title="Right view — looking along -X (3)">Right</button>
        <button id="vc-left" title="Left view — looking along +X (6)">Left</button>
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

      <div id="sim-panel">
        <div id="sim-title">Motion simulation</div>
        <div id="sim-transport">
          <button id="sim-play">&#9654; Play</button>
          <input type="range" id="sim-scrub" class="param-slider" min="0" max="1000" value="0">
          <select id="sim-speed">
            <option value="0.1">0.1&times;</option>
            <option value="0.25">0.25&times;</option>
            <option value="0.5">0.5&times;</option>
            <option value="1" selected>1&times;</option>
          </select>
          <span id="sim-time"></span>
        </div>
        <div id="sim-log"></div>
      </div>

      <div id="statusbar">
        <span id="filename"></span>
        <span id="status"></span>
      </div>
      <div id="loading">Loading ShapeItUp...</div>
    </div>
  </div>
  <script${nonceAttr}>
    window.__SHAPEITUP_CONFIG__ = {
      workerUrl: "${a.workerJs}",
      wasmLoaderUrl: "${a.wasmLoaderJs}",
      wasmUrl: "${a.wasmFile}",
      manifoldLoaderUrl: "${a.manifoldLoaderJs}",
      manifoldWasmUrl: "${a.manifoldWasmFile}",
      mujocoLoaderUrl: "${a.mujocoLoaderJs}",
      mujocoWasmUrl: "${a.mujocoWasmFile}"
    };
  </script>
  <script${nonceAttr} src="${a.viewerJs}"></script>
</body>
</html>`;
}
