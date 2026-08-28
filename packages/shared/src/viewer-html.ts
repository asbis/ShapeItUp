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
    /* Browser tree. Indentation and a twisty per level, the way every CAD
       browser does it — a body is a node you can open, not just a name. */
    .tree-row {
      display: flex; align-items: center; gap: 5px;
      padding: 2px 10px 2px 6px; cursor: pointer; font-size: 12px; color: #ccc;
      user-select: none; min-height: 20px;
    }
    .tree-row:hover { background: #2a2d2e; }
    .tree-twisty {
      width: 11px; flex-shrink: 0; text-align: center;
      font-size: 9px; color: #7a7a7a; line-height: 1;
    }
    .tree-row:hover .tree-twisty { color: #ccc; }
    .tree-branch { color: #d4d4d4; }
    .tree-count {
      color: #7a7a7a; font-size: 11px;
      font-variant-numeric: tabular-nums;
    }
    .tree-children .tree-row { padding-left: 16px; }
    .tree-props { padding: 1px 8px 4px 32px; }
    .tree-prop {
      display: flex; justify-content: space-between; gap: 8px;
      font-size: 10.5px; color: #8a8a8a; padding: 1px 0; white-space: nowrap;
    }
    .tree-prop > span:first-child { flex: 0 0 auto; }
    .tree-prop-val {
      color: #b9bcc0; font-family: "SF Mono", Menlo, Consolas, monospace;
      font-variant-numeric: tabular-nums;
      overflow: hidden; text-overflow: ellipsis; text-align: right;
    }
    .tree-prop.stacked { display: block; }
    .tree-prop.stacked .tree-prop-val { display: block; text-align: left; padding-top: 1px; }
    .tree-hint {
      font-size: 10px; color: #6f6f6f; font-style: italic;
      padding-top: 3px; white-space: normal; line-height: 1.35;
    }
    .part-item {
      display: flex; align-items: center; gap: 5px;
      cursor: pointer; font-size: 12px; color: #ccc;
      user-select: none;
    }
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
    .tree-row:hover .part-eye { opacity: 1; }
    .part-eye:hover { color: #4fc1ff; opacity: 1; }

    /* Canvas area */
    #viewport { flex: 1; position: relative; overflow: hidden; }
    #canvas-container { width: 100%; height: 100%; }
    canvas { display: block; width: 100% !important; height: 100% !important; }

    /* Top toolbar */
    /* Ribbon-style command bar: glyph over label, grouped by what the commands
       do, each group captioned. Undifferentiated text buttons made every
       command look equally likely; grouping is what lets you find one without
       reading all eight. */
    #toolbar {
      position: absolute; top: 8px; right: 8px; z-index: 20;
      display: flex; align-items: stretch;
      background: rgba(37,37,38,0.92);
      padding: 4px 3px 2px; border-radius: 6px; border: 1px solid #3c3c3c;
      backdrop-filter: blur(8px);
      box-shadow: 0 2px 10px rgba(0,0,0,0.35);
      /* Anchored right, so a ribbon wider than the viewport used to run off
         the LEFT edge and take Fit and the display toggles with it — the
         groups you reach for most, silently unreachable in a narrow pane.
         Now it scrolls instead. */
      max-width: calc(100% - 16px);
      overflow-x: auto;
      scrollbar-width: thin;
    }
    #toolbar::-webkit-scrollbar { height: 5px; }
    #toolbar::-webkit-scrollbar-thumb { background: #4a4a4e; border-radius: 3px; }
    #toolbar::-webkit-scrollbar-track { background: transparent; }
    /* A group must not shrink to fit — squeezed captions and clipped icons are
       worse than a scrollbar. */
    .tb-group { flex: 0 0 auto; }
    .tb-group { display: flex; flex-direction: column; align-items: center; padding: 0 5px; }
    .tb-group + .tb-group { border-left: 1px solid #383838; }
    .tb-row { display: flex; gap: 1px; }
    .tb-caption {
      font-size: 8px; letter-spacing: 0.09em; text-transform: uppercase;
      color: #6b6b6b; margin-top: 2px; user-select: none;
    }
    #toolbar button {
      display: flex; flex-direction: column; align-items: center; gap: 2px;
      min-width: 44px; padding: 4px 4px 3px;
      background: transparent; border: 1px solid transparent; border-radius: 4px;
      color: #b0b0b0; font-family: inherit; font-size: 9.5px; cursor: pointer;
      line-height: 1;
    }
    #toolbar button svg {
      width: 17px; height: 17px; fill: none; stroke: currentColor;
      stroke-width: 1.3; stroke-linecap: round; stroke-linejoin: round;
    }
    #toolbar button:hover:not(:disabled) { background: #37373d; color: #f0f0f0; }
    #toolbar button:active:not(:disabled) { background: #4a4a52; }
    #toolbar button.active { background: #0e639c; color: #fff; border-color: #1177bb; }
    #toolbar button:disabled { color: #5a5a5a; cursor: default; }
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
    /* ViewCube hit surface.
       The cube itself is drawn by WebGL into this exact rectangle of the main
       canvas; this div only catches the pointer. It has to, because the canvas
       underneath belongs to OrbitControls — without something above it, every
       press on the cube would start spinning the model instead.
       Kept in sync with VIEW_CUBE_SIZE / VIEW_CUBE_MARGIN in the viewer. */
    #viewcube {
      position: absolute; right: 10px; bottom: 96px; z-index: 20;
      width: 108px; height: 108px; touch-action: none;
    }
    #vc-home {
      position: absolute; right: 118px; bottom: 180px; z-index: 21;
      width: 24px; height: 24px; padding: 0; line-height: 1;
      background: rgba(37,37,38,0.85); border: 1px solid #3c3c3c;
      border-radius: 4px; color: #9aa2ac; cursor: pointer; font-size: 13px;
    }
    #vc-home:hover { background: #3c3c3c; color: #fff; border-color: #4a4a4e; }

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

    /* Selection bar — one line, the way a CAD context toolbar is one line.
       Top-centre rather than following the cursor: a panel that chases the
       pointer is unreadable while you are still choosing a face.
       72px clears the command ribbon above it (measured at 64.5px tall);
       #measure-info sits higher, at 40px, but the two can never be on screen
       together — entering measure mode clears the selection. */
    #face-info, #combine-info, #move-info {
      position: absolute; top: 72px; left: 50%; transform: translateX(-50%);
      z-index: 23; display: none; max-width: calc(100% - 32px);
      background: rgba(37,37,38,0.96); border: 1px solid #3c3c3c;
      border-radius: 4px; box-shadow: 0 4px 14px rgba(0,0,0,0.35);
      font-size: 11px; color: #ccc;
    }
    #face-info.visible, #combine-info.visible, #move-info.visible { display: block; }
    .fi-main {
      display: flex; align-items: center; gap: 8px;
      padding: 4px 5px 4px 9px; white-space: nowrap;
    }
    .fi-kind { color: #e8e8e8; font-weight: 600; }
    .fi-meta { color: #8a8a8a; font-variant-numeric: tabular-nums; }
    .fi-meta b { color: #4fc1ff; font-weight: 400; }
    .fi-rule { width: 1px; align-self: stretch; background: #3c3c3c; margin: 0 1px; }
    #face-info button, #combine-info button, #move-info button {
      background: transparent; border: 1px solid transparent; color: #bbb;
      border-radius: 3px; padding: 3px 7px; font-size: 11px; cursor: pointer;
    }
    #face-info button:hover, #combine-info button:hover, #move-info button:hover { background: #3d3d41; color: #fff; border-color: #4a4a4e; }
    #face-info button:disabled, #combine-info button:disabled, #move-info button:disabled { opacity: 0.3; cursor: default; }
    #face-info button:disabled:hover, #combine-info button:disabled:hover, #move-info button:disabled:hover { background: transparent; color: #bbb; border-color: transparent; }
    #fi-apply, #ci-apply, #mi-apply { background: #0e639c; border-color: #1177bb; color: #fff; }
    #fi-apply:hover, #ci-apply:hover, #mi-apply:hover { background: #1177bb; border-color: #1a8ad4; }
    #fi-dist {
      width: 52px; background: #1e1e1e; border: 1px solid #4a4a4e; color: #4fc1ff;
      border-radius: 3px; padding: 3px 5px; font-size: 11px; text-align: right;
      font-family: inherit; font-variant-numeric: tabular-nums;
    }
    #fi-dist:focus { outline: none; border-color: #0e639c; }
    .fi-unit { color: #6f6f6f; }
    .fi-op { color: #e8e8e8; font-weight: 600; }
    /* The generated line, shown before it is written. This is the whole
       contract of the feature: you see the code you are about to commit. */
    #fi-preview {
      display: none; border-top: 1px solid #333; padding: 4px 9px 5px;
      max-width: 100%;
    }
    #face-info.extruding #fi-preview { display: block; }

    /* The Combine bar. Same chrome as the selection bar — it is the same kind
       of object, a one-line context toolbar — but it never coexists with it:
       arming Combine clears the face selection, because a body operation and a
       face operation would be reading the same click differently. */
    #ci-preview {
      border-top: 1px solid #333; padding: 4px 9px 5px; max-width: 100%;
    }
    #ci-code {
      font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
      font-size: 10px; color: #7ea36f; white-space: nowrap;
      overflow-x: auto; max-width: 100%;
    }
    #ci-notes { display: flex; flex-wrap: wrap; gap: 4px 10px; margin-top: 3px; font-size: 10px; color: #8a8a8a; }
    #ci-notes .warn { color: #e0b060; }
    #combine-info select {
      background: #1e1e1e; border: 1px solid #4a4a4e; color: #4fc1ff;
      border-radius: 3px; padding: 2px 4px; font-size: 11px; font-family: inherit;
      max-width: 130px;
    }
    #combine-info select:focus { outline: none; border-color: #0e639c; }
    .ci-label { color: #8a8a8a; }
    /* One chip per selected tool body, each with its own remove control —
       so a mis-click costs one click to undo rather than restarting the
       whole selection. */
    .ci-chip {
      display: inline-flex; align-items: center; gap: 3px;
      background: #33383f; border: 1px solid #4a5560; border-radius: 9px;
      padding: 1px 3px 1px 7px; color: #d6e4f0; margin-right: 3px;
    }
    .ci-chip button {
      padding: 0 3px !important; line-height: 1; color: #8fa6b8 !important;
      border: none !important; background: none !important;
    }
    .ci-chip button:hover { color: #fff !important; background: none !important; }
    #ci-keep { display: inline-flex; align-items: center; gap: 3px; color: #8a8a8a; cursor: pointer; }
    #ci-keep input { accent-color: #0e639c; margin: 0; }

    /* The Move / Rotate bar. Third of the same kind of object, so it borrows
       the same chrome; what is its own is the numeric row, which is three
       fields rather than one and wants tighter spacing than the others. */
    #mi-preview {
      border-top: 1px solid #333; padding: 4px 9px 5px; max-width: 100%;
    }
    #mi-code {
      font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
      font-size: 10px; color: #7ea36f; white-space: nowrap;
      overflow-x: auto; max-width: 100%;
    }
    #mi-notes { display: flex; flex-wrap: wrap; gap: 4px 10px; margin-top: 3px; font-size: 10px; color: #8a8a8a; }
    #mi-notes .warn { color: #e0b060; }
    #move-info select {
      background: #1e1e1e; border: 1px solid #4a4a4e; color: #4fc1ff;
      border-radius: 3px; padding: 2px 4px; font-size: 11px; font-family: inherit;
      max-width: 130px;
    }
    #move-info select:focus { outline: none; border-color: #0e639c; }
    #move-info input[type="text"] {
      width: 52px; background: #1e1e1e; border: 1px solid #4a4a4e; color: #4fc1ff;
      border-radius: 3px; padding: 3px 5px; font-size: 11px; text-align: right;
      font-family: inherit; font-variant-numeric: tabular-nums;
    }
    #move-info input[type="text"]:focus { outline: none; border-color: #0e639c; }
    /* The axis letter in front of each field. Dimmed and narrow: it is a label
       on a number, not a heading. */
    .mi-axis { color: #6f6f6f; margin-left: 3px; }
    .mi-label { color: #8a8a8a; }
    #mi-copy { display: inline-flex; align-items: center; gap: 3px; color: #8a8a8a; cursor: pointer; }
    #mi-copy input { accent-color: #0e639c; margin: 0; }
    /* The call itself never wraps — a line of code broken mid-token is harder
       to read than one you scroll. */
    #fi-code {
      font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
      font-size: 10px; color: #7ea36f; white-space: nowrap;
      overflow-x: auto; max-width: 100%;
    }
    /* The notes DO wrap, on their own line. They were previously appended to
       the code line, where the horizontal scroll hid them — and the hidden
       half was the brittleness warning, the one thing that must not be. */
    #fi-notes {
      margin-top: 3px; font-size: 10px; color: #8a8a8a;
      white-space: normal; line-height: 1.4;
    }
    #fi-notes:empty { display: none; }
    #fi-notes .warn { color: #d3a04a; }
    #fi-notes span { margin-right: 10px; }

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
        <div class="tb-group">
          <div class="tb-row">
            <button id="btn-fit" title="Fit model to view">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4"/></svg>
              <span>Fit</span>
            </button>
          </div>
          <div class="tb-caption">View</div>
        </div>

        <div class="tb-group">
          <div class="tb-row">
            <button id="btn-edges" class="active" title="Show model edges">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.6 14 5v6l-6 3.4L2 11V5z"/><path d="M8 1.6V8m0 0 6-3M8 8l-6-3"/></svg>
              <span>Edges</span>
            </button>
            <button id="btn-wire" title="Wireframe">
              <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.2" y="5.2" width="8.6" height="8.6"/><path d="M5.2 2.2h8.6v8.6M2.2 5.2l3-3M10.8 5.2l3-3M10.8 13.8l3-3"/></svg>
              <span>Wire</span>
            </button>
            <button id="btn-dims" title="Bounding-box dimensions">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3.5v9M13 3.5v9M3 8h10"/><path d="M5 6.4 3.2 8 5 9.6M11 6.4 12.8 8 11 9.6"/></svg>
              <span>Dims</span>
            </button>
          </div>
          <div class="tb-caption">Display</div>
        </div>

        <div class="tb-group">
          <div class="tb-row">
            <button id="btn-section" title="Section / clip plane">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.6 14 5v6l-6 3.4L2 11V5z"/><path d="M1.4 9.6 14.6 5.2"/></svg>
              <span>Section</span>
            </button>
            <button id="btn-measure" title="Click two points to measure">
              <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4" cy="12" r="1.7"/><circle cx="12" cy="4" r="1.7"/><path d="M5.2 10.8 10.8 5.2"/></svg>
              <span>Measure</span>
            </button>
            <button id="btn-sim" title="Motion simulation timeline (needs an 'export const sim' block)" disabled>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.4v9.2L13 8z"/><path d="M2.4 3.4v9.2"/></svg>
              <span>Sim</span>
            </button>
          </div>
          <div class="tb-caption">Inspect</div>
        </div>

        <div class="tb-group">
          <div class="tb-row">
            <button id="btn-join" title="Merge bodies into one \u2014 Fusion's Combine / Join" disabled>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.4 3.4a4.6 4.6 0 1 0 0 9.2 4.6 4.6 0 1 0 0-9.2"/><path d="M9.6 3.4a4.6 4.6 0 1 1 0 9.2 4.6 4.6 0 1 1 0-9.2"/></svg>
              <span>Join</span>
            </button>
            <button id="btn-cut" title="Subtract bodies from one \u2014 Fusion's Combine / Cut" disabled>
              <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="6.4" cy="8" r="4.6"/><circle cx="9.6" cy="8" r="4.6" stroke-dasharray="1.7 1.5"/></svg>
              <span>Cut</span>
            </button>
            <button id="btn-intersect" title="Keep only the volume the bodies share \u2014 Fusion's Combine / Intersect" disabled>
              <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="6.4" cy="8" r="4.6"/><circle cx="9.6" cy="8" r="4.6"/><path d="M8 3.9a4.6 4.6 0 0 0 0 8.2 4.6 4.6 0 0 0 0-8.2" fill="currentColor" stroke="none"/></svg>
              <span>Intersect</span>
            </button>
          </div>
          <div class="tb-caption">Combine</div>
        </div>

        <div class="tb-group">
          <div class="tb-row">
            <button id="btn-move" title="Drag a body along the axes \u2014 Fusion's Move/Copy" disabled>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8v12.4M1.8 8h12.4"/><path d="M8 1.8 6.2 3.6M8 1.8l1.8 1.8M8 14.2l-1.8-1.8M8 14.2l1.8-1.8M1.8 8l1.8-1.8M1.8 8l1.8 1.8M14.2 8l-1.8-1.8M14.2 8l-1.8 1.8"/></svg>
              <span>Move</span>
            </button>
            <button id="btn-rotate" title="Turn a body about an axis \u2014 Fusion's Move/Copy, rotate" disabled>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.2 8a5.2 5.2 0 1 1-1.9-4"/><path d="M13.4 1.4v2.8h-2.8"/></svg>
              <span>Rotate</span>
            </button>
          </div>
          <div class="tb-caption">Position</div>
        </div>

        <div class="tb-group">
          <div class="tb-row">
            <div id="export-menu-wrapper" class="menu-wrapper">
              <button id="btn-export" title="Export, or open in another app">
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8v7.6m0 0 3-3m-3 3-3-3"/><path d="M2.6 11.2v2.6h10.8v-2.6"/></svg>
                <span>Export</span>
              </button>
              <div id="export-menu" class="dropdown-menu">
                <button data-action="export-step">Save as STEP&#8230;</button>
                <button data-action="export-stl">Save as STL&#8230;</button>
                <button data-action="export-3mf">Save as 3MF (Bambu / Orca)&#8230;</button>
                <div class="menu-sep" role="separator"></div>
                <div class="menu-heading">Separate file per part</div>
                <button data-action="export-split-step">STEP &#8212; one file per part&#8230;</button>
                <button data-action="export-split-stl">STL &#8212; one file per part&#8230;</button>
                <button data-action="export-split-3mf">3MF &#8212; one file per part&#8230;</button>
                <div id="export-menu-apps"></div>
              </div>
            </div>
          </div>
          <div class="tb-caption">Output</div>
        </div>
      </div>

      <button id="vc-home" title="Home \u2014 isometric view (1)">&#8962;</button>
      <div id="viewcube" title="Click a face, edge or corner for that view. Drag to orbit."></div>

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

      <div id="face-info">
        <div class="fi-main">
          <span class="fi-kind" id="fi-kind"></span>
          <span class="fi-meta" id="fi-meta"></span>
          <span class="fi-rule"></span>
          <span id="fi-tools">
            <button id="fi-extrude" title="Push or pull this face along its normal">Extrude</button>
            <button id="fi-fillet" title="Round the edges around this face">Fillet</button>
            <button id="fi-chamfer" title="Bevel the edges around this face">Chamfer</button>
            <button id="fi-shell" title="Hollow the body, leaving this face open">Shell</button>
            <button id="fi-lookat" title="Orient the camera down this face's normal">Look at</button>
          </span>
          <span id="fi-form" hidden>
            <span class="fi-op" id="fi-op"></span>
            <input id="fi-dist" type="text" inputmode="decimal" value="5">
            <span class="fi-unit">mm</span>
            <button id="fi-apply" title="Write this into the file">Apply</button>
            <button id="fi-back" title="Back to the tools">&#8592;</button>
          </span>
          <button id="fi-clear" title="Clear selection (Esc)">&#10005;</button>
        </div>
        <div id="fi-preview">
          <div id="fi-code"></div>
          <div id="fi-notes"></div>
        </div>
      </div>

      <div id="combine-info">
        <div class="fi-main">
          <span class="fi-op" id="ci-op"></span>
          <span class="ci-label">Target</span>
          <select id="ci-target" title="The body that survives, keeping its name and colour"></select>
          <span class="ci-label">Tools</span>
          <span id="ci-chips"></span>
          <select id="ci-add" title="Add a tool body \u2014 or click one in the view"></select>
          <label id="ci-keep" title="Fusion's Keep Tools: leave the tool bodies in the parts list">
            <input type="checkbox" id="ci-keep-toggle">
            <span>Keep tools</span>
          </label>
          <span class="fi-rule"></span>
          <button id="ci-apply" title="Write this into the file">Apply</button>
          <button id="ci-cancel" title="Cancel (Esc)">&#10005;</button>
        </div>
        <div id="ci-preview">
          <div id="ci-code"></div>
          <div id="ci-notes"></div>
        </div>
      </div>

      <div id="move-info">
        <div class="fi-main">
          <span class="fi-op" id="mi-op"></span>
          <span class="mi-label">Body</span>
          <select id="mi-body" title="The body the handle moves"></select>
          <span id="mi-translate">
            <span class="mi-axis">X</span><input id="mi-x" type="text" inputmode="decimal" value="0">
            <span class="mi-axis">Y</span><input id="mi-y" type="text" inputmode="decimal" value="0">
            <span class="mi-axis">Z</span><input id="mi-z" type="text" inputmode="decimal" value="0">
            <span class="fi-unit">mm</span>
          </span>
          <span id="mi-rotate" hidden>
            <input id="mi-angle" type="text" inputmode="decimal" value="0">
            <span class="fi-unit">\u00B0</span>
            <span class="mi-label">about</span>
            <select id="mi-axis" title="The axis to turn about">
              <option value="x">X</option>
              <option value="y">Y</option>
              <option value="z" selected>Z</option>
            </select>
            <span class="mi-label">at</span>
            <select id="mi-pivot" title="Where the turn happens">
              <option value="self" selected>body centre</option>
              <option value="origin">world origin</option>
            </select>
          </span>
          <label id="mi-copy" title="Fusion's Create Copy: leave the body where it is and add the moved result as a new one">
            <input type="checkbox" id="mi-copy-toggle">
            <span>Copy</span>
          </label>
          <span class="fi-rule"></span>
          <button id="mi-reset" title="Put the body back where the file has it">Reset</button>
          <button id="mi-apply" title="Write this into the file">Apply</button>
          <button id="mi-cancel" title="Cancel (Esc)">&#10005;</button>
        </div>
        <div id="mi-preview">
          <div id="mi-code"></div>
          <div id="mi-notes"></div>
        </div>
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
