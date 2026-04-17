import type { ExportFormat } from "./types.js";

// Extension Host → Webview
export type ExtToWebview =
  | { type: "execute-script"; js: string; fileName: string; paramOverrides?: Record<string, number> }
  | { type: "request-export"; format: ExportFormat }
  | { type: "request-screenshot"; width?: number; height?: number }
  | { type: "viewer-command"; command: string; [key: string]: any }
  | { type: "set-theme"; background: string };

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
  | { type: "execute"; js: string; paramOverrides?: Record<string, number> }
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
  | {
      type: "mesh-result";
      parts: TessellatedPart[];
      params: ParamDef[];
      execTimeMs: number;
      tessTimeMs: number;
      timings?: Record<string, number>;
      warnings?: string[];
    }
  | { type: "export-result"; format: ExportFormat; data: ArrayBuffer }
  | {
      type: "error";
      message: string;
      stack?: string;
      operation?: string;
    };
