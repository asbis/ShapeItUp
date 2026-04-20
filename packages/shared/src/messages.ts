import type { ExportFormat } from "./types.js";

/**
 * Shared esbuild externals for runtime `.shape.ts` bundling. Both the MCP
 * engine (`esbuild`, Node) and the VSCode extension (`esbuild-wasm`, extension
 * host) must use the SAME externals list so a script that bundles cleanly in
 * one process also bundles cleanly in the other. Bug #2 was caused by the two
 * sides drifting — the webview-side bundler failed to resolve "shapeitup"
 * while MCP succeeded, and the webview's failure status clobbered MCP's
 * authoritative success status.
 *
 * Lives in @shapeitup/shared (not @shapeitup/core) so the extension can import
 * it without pulling the OCCT pipeline into the extension bundle.
 */
export const BUNDLE_EXTERNALS = ["replicad", "shapeitup"] as const;

// Extension Host → Webview
export type ExtToWebview =
  | {
      type: "execute-script";
      js: string;
      fileName: string;
      paramOverrides?: Record<string, number>;
      // P3-10: optional tessellation-quality knob plumbed end-to-end from MCP's
      // render_preview → extension host → viewer webview → worker → core. The
      // webview MUST forward this verbatim when dispatching the worker-side
      // `execute` — dropping it silently collapses "preview" renders to the
      // default "final" tessellation and negates the MCP caller's intent.
      meshQuality?: "preview" | "final";
    }
  | { type: "request-export"; format: ExportFormat }
  | { type: "request-screenshot"; width?: number; height?: number }
  | { type: "viewer-command"; command: string; [key: string]: any }
  | { type: "set-theme"; background: string };

/**
 * Parameters for the MCP `render-preview` IPC command written to
 * `mcp-command.json`. Kept as a loose shape (all fields optional) for backward
 * compatibility with older extension/MCP versions — both ends read by name.
 *
 * `outputPath` was added to fix a trust bug where the extension synthesized
 * a screenshot filename from stale webview state. When provided, the
 * extension MUST write the PNG to this exact path and return it verbatim.
 */
export interface RenderPreviewCommand {
  filePath?: string;
  outputPath?: string;
  renderMode?: "ai" | "dark";
  showDimensions?: boolean;
  showAxes?: boolean;
  cameraAngle?: string;
  width?: number;
  height?: number;
  focusPart?: string;
  hideParts?: string[];
  params?: Record<string, number>;
  // P3-10: MCP-supplied tessellation quality. Forwarded extension → viewer
  // webview → worker → core.execute. Absent means "let core auto-degrade
  // based on part count" (the pre-P3-10 default).
  meshQuality?: "preview" | "final";
}

// Webview → Extension Host
export type WebviewToExt =
  | { type: "export-data"; format: ExportFormat; data: ArrayBuffer }
  | { type: "screenshot-data"; dataUrl: string }
  | { type: "error"; message: string; line?: number; fileName?: string }
  | { type: "status"; message: string }
  | { type: "toolbar-export"; format: ExportFormat }
  | { type: "param-changed"; params: Record<string, number> }
  | { type: "ready" };

// Webview → Worker
export type WebviewToWorker =
  | { type: "init"; wasmUrl: string }
  | {
      type: "execute";
      js: string;
      paramOverrides?: Record<string, number>;
      // See the matching field on `execute-script` (ExtToWebview). The worker
      // forwards this into `core.execute` as-is; undefined means "use core's
      // auto-degrade heuristic", which is the pre-P3-10 default.
      meshQuality?: "preview" | "final";
    }
  | { type: "export"; format: ExportFormat };

// A single tessellated part
export interface TessellatedPart {
  name: string;
  color: string | null;
  vertices: Float32Array;
  normals: Float32Array;
  triangles: Uint32Array;
  edgeVertices: Float32Array;
  // Geometric properties computed from the original OCCT shape (not the mesh).
  // Optional because measurement can fail on degenerate geometry.
  volume?: number;
  surfaceArea?: number;
  centerOfMass?: [number, number, number];
}

// Parameter definition extracted from script
export interface ParamDef {
  name: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  label?: string;
}

// Worker → Webview
export type WorkerToWebview =
  | { type: "ready" }
  // Streaming mesh protocol: mesh-start announces the batch and its params so
  // the viewer can clear the scene and update sliders immediately. Each
  // mesh-part delivers one fully-tessellated part with its mesh buffers as
  // Transferables — the viewer adds it to the scene as soon as it arrives.
  // mesh-done carries timings + warnings and triggers the final aggregate
  // update (bbox, mass totals, extension notification).
  | { type: "mesh-start"; totalParts: number }
  | {
      type: "mesh-part";
      index: number;
      total: number;
      part: TessellatedPart;
    }
  | {
      type: "mesh-done";
      params: ParamDef[];
      execTimeMs: number;
      tessTimeMs: number;
      timings?: Record<string, number>;
      warnings?: string[];
      /**
       * False when BRepCheck flagged one or more parts as invalid. Absent or
       * true otherwise. When false, affected parts had volume/area omitted —
       * the render headline should read "COMPLETED WITH GEOMETRY ERRORS"
       * rather than "SUCCESS" (see Bug #4).
       */
      geometryValid?: boolean;
    }
  | { type: "export-result"; format: ExportFormat; data: ArrayBuffer }
  | {
      type: "error";
      message: string;
      stack?: string;
      operation?: string;
    }
  // Sent alongside an "error" when the WASM heap is corrupted (e.g.
  // "memory access out of bounds"). The viewer terminates the worker and
  // spawns a fresh one on the next execute — forwarding the same signal
  // up to the extension host lets viewer-provider log that a restart
  // occurred so it's visible to the user.
  | { type: "needs-worker-restart"; reason: string };
