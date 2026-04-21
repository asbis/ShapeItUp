export interface ShapeMesh {
  vertices: Float32Array;
  normals: Float32Array;
  triangles: Uint32Array;
}

export interface EdgeMesh {
  vertices: Float32Array;
}

export type ExportFormat = "step" | "stl";

// --- Installed-app detection ------------------------------------------------
// Canonical types for the `list_installed_apps` MCP tool and the extension's
// "open in external app" command. The MCP server ports its own copy of the
// detection logic (so it works without VSCode) but shares the shape of the
// result with the extension here, so consumers on either side see the same
// fields. The extension currently keeps a private copy of the same types for
// backward-compat with pre-standalone builds.

export type AppId =
  | "prusaslicer"
  | "cura"
  | "bambustudio"
  | "orcaslicer"
  | "freecad"
  | "fusion360";

export type ExportFormatForApp = "step" | "stl";

export interface DetectedApp {
  id: AppId;
  name: string;
  /** Preferred export format. STEP for CAD + modern slicers; STL fallback for Cura. */
  preferredFormat: ExportFormatForApp;
  /** Absolute path to the executable. Undefined when the app is launched via URL scheme only. */
  execPath?: string;
  /** If set, the app is opened via this URL scheme instead of spawning the binary. %FILE% gets replaced. */
  urlScheme?: string;
}
