import type { AppId, ExportFormat } from "./types.js";

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

/**
 * Bundled WASM assets sent from the extension host to the webview so the
 * worker can skip its 1.2MB loader fetch + .wasm fetch on every (re)spawn.
 *
 * Both fields are raw bytes the worker uses verbatim:
 *   - `loaderJs`   — Emscripten loader JS text (eval'd via `new Function()`).
 *   - `wasmBytes`  — Raw WASM binary (passed to Emscripten as `wasmBinary`).
 *
 * The extension reads these once on activation (see wasm-cache.ts) and serves
 * them in response to `request-wasm-assets`. Manifold is optional — older
 * VSIX builds may not ship it.
 */
export interface WasmAssetBundle {
  loaderJs: string;
  wasmBytes: Uint8Array;
}

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
  | ParamCommitResult
  | FaceOpResultMessage
  | { type: "request-export"; format: ExportFormat }
  | { type: "request-screenshot"; width?: number; height?: number }
  | { type: "viewer-command"; command: string; [key: string]: any }
  | { type: "set-theme"; background: string }
  // Reply to a webview-side `request-wasm-assets`. Both occt and manifold may
  // be omitted if the extension cache is cold or the asset file is missing —
  // the worker falls back to URL fetch in that case.
  | {
      type: "wasm-assets";
      occt?: WasmAssetBundle;
      manifold?: WasmAssetBundle;
    };

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

/**
 * Outcome of a `param-changed` commit, host → viewer.
 *
 * A commit can decline for reasons the viewer can't know up front — the file
 * changed underneath, the value stopped being a plain literal — so the viewer
 * needs to hear about it rather than assume the write landed. `reason` is the
 * `ParamEditFailure` string, plus the host-only cases.
 */
export interface ParamCommitResult {
  type: "param-commit-result";
  name: string;
  value: number;
  ok: boolean;
  /** Absent when ok. */
  reason?: string;
  /**
   * True when the commit also dropped a `tune_params --persist` pin for this
   * parameter. Worth surfacing: the user's number would otherwise have been
   * silently overridden in every export.
   */
  clearedSidecar?: boolean;
}

/**
 * Outcome of a `face-op` or `combine` commit, host → viewer.
 *
 * Shared by both because the outcome really is the same shape: a request id, a
 * yes or no, the line that was written, and prose when the answer was no.
 *
 * Separate from ParamCommitResult because the failure surface is different in
 * kind: a parameter commit can only fail on ONE number it already located,
 * while a face operation can fail because the selector could not be built,
 * because the part could not be found in the source, or because the file is
 * shaped in a way the editor deliberately refuses to guess about.
 */
export interface FaceOpResultMessage {
  type: "face-op-result";
  /** Which command this answers. Absent means the face operations, for compatibility. */
  kind?: "face-op" | "combine";
  /** Echoed back so a stale reply cannot be attributed to a newer request. */
  requestId: number;
  ok: boolean;
  /** The line written, for the status area. Absent when the commit declined. */
  applied?: string;
  /** Absent when ok. Prose, not an enum — this reaches the user directly. */
  reason?: string;
  /** True when an `import { … } from "shapeitup"` was added alongside. */
  addedImport?: boolean;
}

// Webview → Extension Host
export type WebviewToExt =
  | { type: "export-data"; format: ExportFormat; data: ArrayBuffer }
  /** The split-export counterpart of `export-data`; the host writes one file per item. */
  | {
      type: "export-split-data";
      format: ExportFormat;
      items: Array<{ name: string; data: ArrayBuffer }>;
    }
  | { type: "screenshot-data"; dataUrl: string }
  | { type: "error"; message: string; line?: number; fileName?: string; operation?: string; stack?: string }
  | { type: "status"; message: string }
  /** `split: true` asks for one file per part instead of a single document. */
  | { type: "toolbar-export"; format: ExportFormat; split?: boolean }
  | { type: "toolbar-open-in-app"; appId: AppId }
  /** Handshake: the viewer finished rendering both screenshot frames. */
  | { type: "screenshot-ready" }
  /**
   * Non-fatal: a `focusPart` / `hideParts` name matched no loaded part. The
   * host buffers these so the active render_preview call can surface them.
   */
  | { type: "part-warning"; message: string }
  /**
   * Everything the host wants to know about a completed render. Only `stats` is
   * read today; the rest is diagnostic payload the MCP side has historically
   * grown into, so it is declared rather than left to `any`.
   */
  | {
      type: "render-success";
      stats: string;
      partCount: number;
      partNames: string[];
      boundingBox: { x: number; y: number; z: number };
      currentParams: Record<string, number>;
      timings?: Record<string, number>;
      warnings?: string[];
      properties?: {
        parts: Array<{
          name: string;
          volume?: number;
          surfaceArea?: number;
          centerOfMass?: [number, number, number];
        }>;
        totalVolume?: number;
        totalSurfaceArea?: number;
        centerOfMass?: [number, number, number];
      };
    }
  | { type: "param-changed"; params: Record<string, number> }
  /**
   * Apply an operation to a picked face, writing it into the `.shape.ts`.
   *
   * `extrude` pushes or pulls the face itself; `fillet` and `chamfer` act on
   * the edges around it. All three are driven by the same picked face because
   * one plane predicate names the face and its boundary equally well.
   *
   * The viewer sends the FACE, not a finder: synthesising the selector needs
   * the file's declared parameters in order to bind an offset to a name, and
   * the host is the side that has the file. `partName` is null for a script
   * that returns a bare shape rather than a named list.
   */
  | {
      type: "face-op";
      requestId: number;
      op: "extrude" | "fillet" | "chamfer";
      partName: string | null;
      /**
       * A face drives all three operations. A single edge can only be
       * rounded — "extrude an edge" has no meaning — and is named by a point
       * that lies on it, because `containsPoint` is the only predicate that
       * reliably isolates one edge.
       */
      target:
        | {
            kind: "face";
            face: {
              kind: string;
              center: [number, number, number];
              normal?: [number, number, number];
            };
          }
        | { kind: "edge"; point: [number, number, number] };
      /** Signed for extrude; a positive radius / setback for the other two. */
      distance: number;
    }
  /**
   * Combine two or more bodies — Fusion 360's Modify → Combine, written into
   * the `.shape.ts`.
   *
   * Unlike `face-op` this needs no synthesised selector: bodies already have
   * names in the file, and a name is the most durable handle there is. So the
   * viewer sends names, and the host does the rewrite.
   *
   * The target keeps its entry, its name and its colour. Each tool's entry is
   * removed unless `keepTools` — which is exactly Fusion's checkbox, expressed
   * as the presence or absence of a line in the file rather than as hidden
   * feature state.
   */
  | {
      type: "combine";
      requestId: number;
      op: "join" | "cut" | "intersect";
      targetName: string;
      toolNames: string[];
      keepTools?: boolean;
    }
  | { type: "ready" }
  // Webview asks the extension for the cached OCCT (+ optional Manifold) bytes
  // on worker init. The extension replies with a `wasm-assets` message
  // (ExtToWebview). Sent once per worker (re)spawn.
  | { type: "request-wasm-assets" };

/**
 * A face operation applied to the result of `main()` WITHOUT writing it to the
 * file — the live preview behind the drag arrow.
 *
 * Sent as part of an `execute`, so it costs one OCCT run and no re-bundle:
 * the operation is the outermost call in the generated source too, so applying
 * it after `main()` returns produces the same geometry the committed edit
 * would. The numbers are pre-resolved — a `plane` and an `offset`, not a
 * parameter name — because at preview time the parameters already hold the
 * values the selector would evaluate to.
 */
export interface PreviewFaceOp {
  op: "extrude" | "fillet" | "chamfer";
  /** Null for a script returning a bare shape. */
  partName: string | null;
  target:
    | { kind: "face"; plane: string; offset: number }
    | { kind: "edge"; point: [number, number, number] };
  distance: number;
  /**
   * Ask the worker for the largest radius this operation can actually take,
   * found by probing OCCT. Requested once when the operation is armed, not on
   * every drag step. Meaningless for `extrude`, which has no such limit.
   */
  probeLimit?: boolean;
}

/**
 * A combine applied to the result of `main()` WITHOUT writing it to the file.
 *
 * The same trick as {@link PreviewFaceOp}, and honest for the same reason: the
 * committed edit puts the call at the outermost position of the target's
 * `shape:` expression, so applying it to the finished parts list produces the
 * geometry the file would.
 *
 * Names rather than geometry, because that is what the committed edit uses
 * too — there is no selector to resolve and nothing to go stale between the
 * preview and the write.
 */
export interface PreviewCombine {
  op: "join" | "cut" | "intersect";
  targetName: string;
  toolNames: string[];
  /** Leave the tool bodies in the list. Fusion's "Keep Tools". */
  keepTools?: boolean;
}

/** What a previewed combine measured about itself. Mirrors core's CombineStats. */
export interface CombineStatsMessage {
  op: "join" | "cut" | "intersect";
  /** mm³, or undefined when OCCT could not measure. */
  targetVolume?: number;
  resultVolume?: number;
  /** The material the operation moved. */
  deltaVolume?: number;
  /** A join in which at least one tool merged nothing — it never touched. */
  disjoint?: boolean;
  /** Which tools those were, as positions in the `toolNames` that were sent. */
  disjointTools?: number[];
  /** Nothing left: an empty intersect, or a cut that ate the whole target. */
  empty?: boolean;
}

// Webview → Worker
export type WebviewToWorker =
  | {
      type: "init";
      // URL-fallback fields (used when the extension didn't ship cached bytes).
      wasmLoaderUrl?: string;
      wasmUrl?: string;
      manifoldLoaderUrl?: string;
      manifoldWasmUrl?: string;
      // Cached-bytes fast path. When present, the worker eval's `loaderJs`
      // directly and passes `wasmBytes` to the Emscripten module factory as
      // `wasmBinary` — skipping the cold fetch + parse on every (re)spawn.
      occt?: WasmAssetBundle;
      manifold?: WasmAssetBundle;
    }
  | {
      type: "execute";
      js: string;
      paramOverrides?: Record<string, number>;
      // See the matching field on `execute-script` (ExtToWebview). The worker
      // forwards this into `core.execute` as-is; undefined means "use core's
      // auto-degrade heuristic", which is the pre-P3-10 default.
      meshQuality?: "preview" | "final";
      /** See {@link PreviewFaceOp} — a face operation applied without writing it. */
      previewOp?: PreviewFaceOp;
      /** See {@link PreviewCombine} — a combine applied without writing it. */
      previewCombine?: PreviewCombine;
    }
  | { type: "export"; format: ExportFormat };

/**
 * Geometry of one B-Rep face, index-aligned with the `[start, count]` pairs in
 * `TessellatedPart.faceGroups`. Mirrors `FaceInfo` in @shapeitup/core — the
 * duplication is the same one TessellatedPart already lives with, so that the
 * viewer can typecheck against @shapeitup/shared alone.
 */
export interface FaceInfo {
  /** OCCT surface type: "PLANE", "CYLINDRE", "SPHERE", "BSPLINE_SURFACE", … */
  kind: string;
  center: [number, number, number];
  /** Unit outward normal; absent when OCCT could not evaluate one. */
  normal?: [number, number, number];
  /** mm². */
  area?: number;
}

/**
 * The material a previewed operation adds or removes, tessellated for display.
 *
 * Blue for added, red for removed — the convention a CAD user already reads
 * without being told. Only produced where the delta solid falls out of the
 * operation for free; see `FaceOpOptions.onDelta` in @shapeitup/core for why
 * the rounding operations do not get one.
 */
export interface PreviewDelta {
  mode: "added" | "removed";
  vertices: Float32Array;
  normals: Float32Array;
  triangles: Uint32Array;
}

// A single tessellated part
export interface TessellatedPart {
  name: string;
  color: string | null;
  vertices: Float32Array;
  normals: Float32Array;
  triangles: Uint32Array;
  edgeVertices: Float32Array;
  /**
   * `[start, count, …]` spans of `triangles`, in index units — one pair per
   * face. Present only for OCCT B-Rep parts. See the fuller note in
   * @shapeitup/core's tessellate.ts, including why replicad's `faceId` is
   * dropped on the way through.
   */
  faceGroups?: Uint32Array;
  /** One entry per pair in `faceGroups`, same order. */
  faceInfo?: FaceInfo[];
  /** `[start, count, …]` spans of `edgeVertices`, in POINT units (3 floats each). */
  edgeGroups?: Uint32Array;
  // Geometric properties computed from the original OCCT shape (not the mesh).
  // Optional because measurement can fail on degenerate geometry.
  volume?: number;
  surfaceArea?: number;
  centerOfMass?: [number, number, number];
}

// Parameter definition extracted from script
export interface ParamDef {
  name: string;
  /** The value the model was BUILT with — declared value plus any override. */
  value: number;
  /**
   * What the FILE declares, when an override is in force and the two differ.
   * Absent when they are the same.
   *
   * The viewer needs this to preview a generated selector honestly: the host
   * synthesises against the file, so a parameter dragged to 10 in a session
   * where the file still says 6 must not be previewed as a match.
   */
  declared?: number;
  /**
   * Increment for one wheel notch or arrow press in the viewer. Derived from
   * the value the FILE declares, so overriding a 0.5 default to 12 keeps the
   * fine 0.1 step — the parameter is still a fine one.
   */
  step?: number;
  label?: string;
}

// Worker → Webview
export type WorkerToWebview =
  | { type: "ready" }
  /** The material a previewed operation adds or removes. See {@link PreviewDelta}. */
  | { type: "preview-delta"; delta: PreviewDelta }
  /** The largest radius the armed operation can take, measured against OCCT. */
  | { type: "preview-limit"; max: number }
  /** What a previewed combine measured. See {@link CombineStatsMessage}. */
  | { type: "preview-combine"; stats: CombineStatsMessage }
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
      /**
       * Raw `export const sim = {...}` motion-simulation authoring block, or
       * undefined when the script declares none. The viewer resolves it against
       * the rendered parts (via @shapeitup/sim) to drive kinematic playback.
       * Left as `unknown` here so @shapeitup/shared stays dependency-free.
       */
      sim?: unknown;
    }
  | { type: "export-result"; format: ExportFormat; data: ArrayBuffer }
  /**
   * One buffer per part, for "export each component to its own file". Sent by
   * `handleExportSplit`; every `data` is transferred, not copied.
   */
  | {
      type: "export-split-result";
      format: ExportFormat;
      items: Array<{ name: string; data: ArrayBuffer }>;
    }
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
