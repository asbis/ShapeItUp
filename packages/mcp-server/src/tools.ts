import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, unlinkSync, renameSync } from "fs";
import { join, resolve, basename, dirname, isAbsolute } from "path";
import { homedir } from "os";
import {
  executeShapeFile,
  exportLastToFile,
  getCore,
  getLastFileName,
  type EngineStatus,
  type ShapeProperties,
} from "./engine.js";

/**
 * Shared globalStorage dir with the VSCode extension. Both processes write and
 * read `shapeitup-status.json` here, so MCP-driven renders and extension-driven
 * renders stay interchangeable. This is the only place we "touch" VSCode: it's
 * a file location, not a runtime dependency.
 */
const GLOBAL_STORAGE = join(
  homedir(),
  process.platform === "win32"
    ? "AppData/Roaming/Code/User/globalStorage/shapeitup.shapeitup-vscode"
    : ".config/Code/User/globalStorage/shapeitup.shapeitup-vscode"
);

// --- File-based IPC to the extension (optional, best-effort) ---
// Only used for UI-sync commands: set_render_mode, toggle_dimensions,
// list_installed_apps, open-in-app. If VSCode isn't running these report that
// honestly — everything else works without VSCode.

const ID_PREFIX = `${process.pid}-${Date.now().toString(36)}-`;
let commandCounter = 0;

// Extend-while-alive grace for waitForResult: if the nominal timeout expires
// but the extension heartbeat is still fresh, grant ONE additional window of
// this length before giving up. Matches the reality of cold OCCT renders —
// the extension is still working, MCP just needs to be patient. Granted at
// most once per waitForResult call, so a truly stuck render eventually fails.
const WAIT_GRACE_MS = 30_000;

// Set by waitForResult on the failing path so the caller can distinguish
// "extension crashed / disappeared" from "extension is alive but render is
// slower than the budget". Reset to null on every successful resolution.
// Module-level rather than a return-shape change to keep the diff minimal
// across the several callers (list_installed_apps, open-in-app, export_shape,
// preview_finder, render_preview).
let lastWaitTimeoutReason: "dead" | "slow" | null = null;

function nextCommandId(): string {
  return ID_PREFIX + (++commandCounter);
}

function sendExtensionCommand(command: string, params: Record<string, any> = {}): string | undefined {
  try {
    mkdirSync(GLOBAL_STORAGE, { recursive: true });
    const cmdFile = join(GLOBAL_STORAGE, "mcp-command.json");
    const _id = nextCommandId();
    writeFileSync(cmdFile, JSON.stringify({ command, _id, ...params }));
    return _id;
  } catch {
    return undefined;
  }
}

function readExtensionResult(): any {
  try {
    const resultFile = join(GLOBAL_STORAGE, "mcp-result.json");
    if (existsSync(resultFile)) {
      const data = readFileSync(resultFile, "utf-8");
      return JSON.parse(data);
    }
  } catch {}
  return null;
}

function readHeartbeat(): { timestamp?: number; workspaceRoots?: string[] } | null {
  try {
    const hb = join(GLOBAL_STORAGE, "shapeitup-heartbeat.json");
    if (!existsSync(hb)) return null;
    return JSON.parse(readFileSync(hb, "utf-8"));
  } catch {
    return null;
  }
}

function isExtensionAlive(): boolean {
  const hb = readHeartbeat();
  if (!hb) return false;
  return Date.now() - (hb.timestamp ?? 0) < 5000;
}

/**
 * Where should a `create_shape` / `list_shapes` call default to when the caller
 * doesn't pass a directory? `process.cwd()` is wrong: when VSCode or Claude
 * Code spawns the MCP stdio child, cwd is wherever node was launched from
 * (commonly the extension's install dir or the user's home), so files "leak"
 * outside the user's workspace. The VSCode extension writes its
 * workspaceRoots into the heartbeat — prefer the first one when fresh, and
 * fall back to cwd only if the extension isn't running at all.
 */
function getDefaultDirectory(): string {
  const hb = readHeartbeat();
  if (hb && Date.now() - (hb.timestamp ?? 0) < 5000) {
    const root = hb.workspaceRoots?.[0];
    if (root) return root;
  }
  return process.cwd();
}

/**
 * Resolve a user-supplied `filePath` argument to an absolute path. Absolute
 * inputs pass through `resolve` unchanged; relative inputs anchor against
 * `getDefaultDirectory()` (the active VSCode workspace root, or cwd when the
 * extension isn't running) instead of `process.cwd()`. Plain `resolve(filePath)`
 * is wrong here: when VSCode/Claude Code spawns the MCP stdio child, cwd is
 * the extension's install dir — so a relative "bracket.shape.ts" handed to
 * modify/read/delete/open would miss the file the agent just created in the
 * workspace.
 */
function resolveShapePath(filePath: string): string {
  if (isAbsolute(filePath)) return resolve(filePath);
  return resolve(getDefaultDirectory(), filePath);
}

async function waitForResult(commandId: string, timeoutMs: number): Promise<any> {
  const start = Date.now();
  let aliveChecks = 0;
  let deadline = start + timeoutMs;
  let graceGranted = false;
  lastWaitTimeoutReason = null;
  while (true) {
    if (Date.now() >= deadline) {
      // Deadline reached. If the extension still looks alive AND we haven't
      // already extended once, grant a single grace window — a cold OCCT
      // render on complex geometry can legitimately overshoot the initial
      // budget while the extension is still making progress.
      if (!graceGranted && isExtensionAlive()) {
        graceGranted = true;
        deadline += WAIT_GRACE_MS;
        continue;
      }
      // Give up. Record why so the caller can shape the user-facing message.
      lastWaitTimeoutReason = isExtensionAlive() ? "slow" : "dead";
      return null;
    }
    await new Promise((r) => setTimeout(r, 100));
    const result = readExtensionResult();
    if (result && result._id === commandId) {
      lastWaitTimeoutReason = null;
      return result;
    }
    // Cheap early exit: if the extension died mid-wait there's no point
    // holding open the full timeout. Only relevant BEFORE grace is granted;
    // once we've extended, we stop short-circuiting on liveness since the
    // heartbeat writer itself could be briefly delayed on a slow machine.
    if (!graceGranted && ++aliveChecks % 10 === 0 && !isExtensionAlive()) {
      lastWaitTimeoutReason = "dead";
      return null;
    }
  }
}

function extensionOfflineError(tool: string) {
  return {
    content: [{
      type: "text" as const,
      text: `${tool} requires the ShapeItUp VSCode extension to be running (it's a viewer-state command). Open VSCode with the extension installed, then retry.\n(No heartbeat at ${join(GLOBAL_STORAGE, "shapeitup-heartbeat.json")})`,
    }],
    isError: true,
  };
}

/**
 * Best-effort: when an MCP operation changes the current shape, poke the
 * extension so its live viewer re-renders the same file. Fires and forgets —
 * if VSCode isn't running, nothing happens and MCP still succeeds.
 */
function notifyExtensionOfShape(filePath: string): void {
  if (isExtensionAlive()) {
    sendExtensionCommand("open-shape", { filePath });
  }
}

function formatStatusText(status: EngineStatus): string {
  if (!status.success) {
    const hint = status.hint ? `\nHint: ${status.hint}` : "";
    const operation = status.operation ? `\nFailed operation: ${status.operation}` : "";
    // Include the first few lines of the stack — enough to show which Replicad
    // / OCCT call blew up without dumping an unreadable wall of text. Agents
    // need this to know whether to back off the fillet, simplify geometry, etc.
    const stack = status.stack
      ? `\nStack (top frames):\n${status.stack.split("\n").slice(0, 6).map((l) => `  ${l.trim()}`).filter((l) => l.trim().length > 2).join("\n")}`
      : "";
    return `Render FAILED\nError: ${status.error}${hint}${operation}${stack}\nFile: ${status.fileName || "unknown"}\nTip: call get_preview to view the last successful render for visual comparison (the PNG is NOT overwritten on failure).\nTime: ${status.timestamp}`;
  }
  const parts = status.partNames?.length ? `\nParts: ${status.partNames.join(", ")}` : "";
  const paramEntries = status.currentParams ? Object.entries(status.currentParams) : [];
  const currentParams = paramEntries.length
    ? `\nCurrent params: ${paramEntries.map(([k, v]) => `${k}=${v}`).join(", ")}`
    : "";
  const timingEntries = status.timings
    ? Object.entries(status.timings).sort((a, b) => b[1] - a[1]).slice(0, 8)
    : [];
  const timings = timingEntries.length
    ? `\nTop operations (ms): ${timingEntries.map(([k, v]) => `${k}=${Math.round(v)}`).join(", ")}`
    : "";
  const warnings = Array.isArray(status.warnings) && status.warnings.length
    ? `\nGeometry warnings:\n - ${status.warnings.join("\n - ")}`
    : "";
  const properties = formatProperties(status.properties);
  const bbox = status.boundingBox
    ? `\nBounding box: ${status.boundingBox.x} x ${status.boundingBox.y} x ${status.boundingBox.z} mm`
    : "";
  const material = status.material
    ? `\nMaterial: ${status.material.name ? status.material.name + ", " : ""}density ${status.material.density} g/cm³`
    : "";
  return `Render SUCCESS\nFile: ${status.fileName || "unknown"}\nStats: ${status.stats}${parts}${bbox}${material}${properties}${currentParams}${timings}${warnings}\nTime: ${status.timestamp}`;
}

/**
 * Shared helper used by `preview_finder` and `render_preview` to emit the
 * synthetic `.shape.ts` wrapper that feeds into the extension's render-preview
 * pipeline. The wrapper re-exports the user's `params` so sliders still work,
 * re-invokes their `main()` to produce the parts, picks the target part, then
 * hands it to the worker-injected `highlightFinder(shape, finder)` helper
 * (which paints pink spheres at each match; see packages/core/src/executor.ts).
 *
 * Both callers resolve partName → index *before* calling this — keeping the
 * wrapper itself free of any MCP-side state (no parts list to consult) and
 * making the rendered template purely mechanical. The helper does NOT write
 * the file; callers are responsible for writing + unlinking so they can wrap
 * the whole render call in try/finally.
 */
function buildFinderWrapperScript(
  sourcePath: string,
  finderExpr: string,
  partSelector: { index: number }
): string {
  const userBase = basename(sourcePath).replace(/\.shape\.ts$/, "");
  // Escape the finder expression for safe embedding in the template literal
  // below. Same escapes preview_finder used to apply inline.
  const escapedFinder = finderExpr
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${");
  return `import * as __user__ from "./${userBase}.shape";
import { EdgeFinder, FaceFinder } from "replicad";

export const params: Record<string, number> = ((__user__ as any).params ?? {});

export default function main(p: Record<string, number>) {
  const userMain: any = (__user__ as any).default;
  if (typeof userMain !== "function") {
    throw new Error("Source file has no default export");
  }
  const result = userMain.length > 0 ? userMain(p) : userMain();
  const arr = Array.isArray(result) ? result : [{ shape: result, name: "shape" }];
  const target: any = arr[${partSelector.index}];
  const shape = (target && target.shape) ? target.shape : target;
  const finder: any = (${escapedFinder});
  return (highlightFinder as any)(shape, finder);
}
`;
}

export function registerTools(server: McpServer) {
  server.tool(
    "create_shape",
    "Create a new .shape.ts CAD script file and execute it. Fails if file already exists — use modify_shape to update existing files.",
    {
      name: z.string().describe("File name without extension (e.g., 'bracket')"),
      code: z.string().describe("TypeScript source code using Replicad API"),
      directory: z.string().optional().describe("Directory to create the file in (defaults to the active VSCode workspace root, or cwd if no extension is running)"),
      overwrite: z.boolean().optional().describe("Set to true to overwrite an existing file (default: false)"),
    },
    async ({ name, code, directory, overwrite }) => {
      // If `directory` is relative, anchor it to the workspace root (not cwd)
      // for the same reason resolveShapePath exists; absolute values pass through.
      const dir = directory
        ? (isAbsolute(directory) ? resolve(directory) : resolve(getDefaultDirectory(), directory))
        : getDefaultDirectory();
      const filePath = join(dir, `${name}.shape.ts`);

      if (!code.trim() || !code.includes("function")) {
        return {
          content: [{ type: "text" as const, text: `Invalid code: must contain at least a function definition.` }],
          isError: true,
        };
      }

      if (existsSync(filePath) && !overwrite) {
        return {
          content: [{ type: "text" as const, text: `File already exists: ${filePath}\nUse modify_shape to update it, or pass overwrite: true to replace it.` }],
          isError: true,
        };
      }

      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, code, "utf-8");

      const { status } = await executeShapeFile(filePath, GLOBAL_STORAGE);
      notifyExtensionOfShape(filePath);

      const prefix = `${overwrite ? "Overwrote" : "Created"} ${filePath}\n`;
      return {
        content: [{ type: "text" as const, text: prefix + formatStatusText(status) }],
        isError: !status.success,
      };
    }
  );

  server.tool(
    "open_shape",
    "Execute an existing .shape.ts file and (if VSCode is open) also bring it up in the viewer.",
    {
      filePath: z.string().describe("Path to the .shape.ts file to execute. Relative paths resolve against the active VSCode workspace root."),
    },
    async ({ filePath }) => {
      const absPath = resolveShapePath(filePath);
      if (!existsSync(absPath)) {
        return {
          content: [{ type: "text" as const, text: `File not found: ${absPath}` }],
          isError: true,
        };
      }

      const { status } = await executeShapeFile(absPath, GLOBAL_STORAGE);
      notifyExtensionOfShape(absPath);

      return {
        content: [{ type: "text" as const, text: formatStatusText(status) }],
        isError: !status.success,
      };
    }
  );

  server.tool(
    "modify_shape",
    "Overwrite an existing .shape.ts file with new code and execute it.",
    {
      filePath: z.string().describe("Path to the .shape.ts file. Relative paths resolve against the active VSCode workspace root."),
      code: z.string().describe("New TypeScript source code"),
    },
    async ({ filePath, code }) => {
      const absPath = resolveShapePath(filePath);
      if (!existsSync(absPath)) {
        return {
          content: [{ type: "text" as const, text: `File not found: ${absPath}` }],
          isError: true,
        };
      }
      writeFileSync(absPath, code, "utf-8");

      const { status } = await executeShapeFile(absPath, GLOBAL_STORAGE);
      notifyExtensionOfShape(absPath);

      const prefix = `Updated ${absPath}\n`;
      return {
        content: [{ type: "text" as const, text: prefix + formatStatusText(status) }],
        isError: !status.success,
      };
    }
  );

  server.tool(
    "read_shape",
    "Read the contents of a .shape.ts file",
    {
      filePath: z.string().describe("Path to the .shape.ts file. Relative paths resolve against the active VSCode workspace root."),
    },
    async ({ filePath }) => {
      const absPath = resolveShapePath(filePath);
      if (!existsSync(absPath)) {
        return {
          content: [{ type: "text" as const, text: `File not found: ${absPath}` }],
          isError: true,
        };
      }
      const content = readFileSync(absPath, "utf-8");
      return { content: [{ type: "text" as const, text: content }] };
    }
  );

  server.tool(
    "delete_shape",
    "Delete a .shape.ts file",
    {
      filePath: z.string().describe("Path to the .shape.ts file to delete. Relative paths resolve against the active VSCode workspace root."),
    },
    async ({ filePath }) => {
      const absPath = resolveShapePath(filePath);
      if (!existsSync(absPath)) {
        return {
          content: [{ type: "text" as const, text: `File not found: ${absPath}` }],
          isError: true,
        };
      }
      if (!absPath.endsWith(".shape.ts")) {
        return {
          content: [{ type: "text" as const, text: `Refusing to delete non-.shape.ts file: ${absPath}` }],
          isError: true,
        };
      }
      const { unlinkSync } = require("fs");
      unlinkSync(absPath);
      return { content: [{ type: "text" as const, text: `Deleted ${absPath}` }] };
    }
  );

  server.tool(
    "export_shape",
    "Export the last executed shape to STEP or STL. Optionally pass `filePath` to execute and export a specific file in one call. For multi-part assemblies, pass `partName` to export a single named part instead of the whole assembly.",
    {
      format: z.enum(["step", "stl"]).describe("'step' for CNC/manufacturing or CAD, 'stl' for 3D printing"),
      outputPath: z.string().optional().describe("Output file path. Auto-derived from the source .shape.ts filename if omitted."),
      filePath: z.string().optional().describe("Optional .shape.ts path to execute first. Defaults to the last-executed shape."),
      partName: z.string().optional().describe("For multi-part assemblies: export only the part whose name matches exactly (e.g., 'bolt'). If omitted, the full assembly is exported."),
      openIn: z
        .enum(["prusaslicer", "cura", "bambustudio", "orcaslicer", "freecad", "fusion360"])
        .optional()
        .describe("If set, open the exported file in this app after saving. Requires VSCode + the extension."),
    },
    async ({ format, outputPath, filePath, partName, openIn }) => {
      // Figure out which file we're exporting. Precedence: explicit arg →
      // in-process last file → status file's fileName (set by VSCode/prior runs).
      let source: string | undefined = filePath ? resolveShapePath(filePath) : getLastFileName();
      if (!source) {
        try {
          const status = JSON.parse(readFileSync(join(GLOBAL_STORAGE, "shapeitup-status.json"), "utf-8"));
          if (status.fileName) source = status.fileName;
        } catch {}
      }
      if (!source) {
        return {
          content: [{ type: "text" as const, text: "Nothing to export — call create_shape, open_shape, or modify_shape first, or pass filePath." }],
          isError: true,
        };
      }

      // Always re-execute — guarantees correctness even if something mutated
      // OCCT state between the last render and now.
      const { status } = await executeShapeFile(source, GLOBAL_STORAGE);
      if (!status.success) {
        return {
          content: [{ type: "text" as const, text: `Cannot export — render failed.\n${formatStatusText(status)}` }],
          isError: true,
        };
      }

      // If the caller asked for a specific part, validate up front and fail
      // with a helpful list of available names before we touch the filesystem.
      const availablePartNames = status.partNames ?? [];
      if (partName !== undefined && !availablePartNames.includes(partName)) {
        return {
          content: [{
            type: "text" as const,
            text: `No part named "${partName}" in ${source}. Available parts: ${availablePartNames.join(", ") || "(none)"}`,
          }],
          isError: true,
        };
      }

      // Default output path: include the part name in the file name so
      // single-part exports don't collide with full-assembly exports.
      const defaultSuffix = partName ? `.${partName}.${format}` : `.${format}`;
      const savePath = outputPath || source.replace(/\.shape\.ts$/, defaultSuffix);
      try {
        await exportLastToFile(format, savePath, partName);
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `Export failed: ${e?.message ?? e}` }],
          isError: true,
        };
      }

      const fileSize = statSync(savePath).size;
      const sizeStr = fileSize > 1024 * 1024
        ? `${(fileSize / 1024 / 1024).toFixed(1)}MB`
        : `${Math.round(fileSize / 1024)}KB`;

      // open-in-app still needs the VSCode extension for app detection +
      // launching. Best-effort — never fails the export itself.
      let openLine = "";
      if (openIn) {
        if (!isExtensionAlive()) {
          openLine = `\nOpen-in skipped: VSCode extension not running. Launch the file manually: ${savePath}`;
        } else {
          const cmdId = sendExtensionCommand("open-in-app", { appId: openIn, exportPath: savePath });
          if (cmdId) {
            const result = await waitForResult(cmdId, 15000);
            if (result?.openedIn) openLine = `\nOpened in: ${result.openedIn}`;
            else if (result?.error) openLine = `\nOpen-in warning: ${result.error}`;
          }
        }
      }

      // Describe what was exported. Single-part exports (either because
      // partName was specified or the script only returned one part) show the
      // part name; full multi-part exports list the assembly contents.
      let contentsLine: string;
      if (partName) {
        contentsLine = `\nPart: ${partName} (single part from ${availablePartNames.length}-part assembly)`;
      } else if (availablePartNames.length > 1) {
        contentsLine = `\nParts: ${availablePartNames.join(", ")}`;
      } else if (availablePartNames.length === 1) {
        contentsLine = `\nPart: ${availablePartNames[0]}`;
      } else {
        contentsLine = "";
      }

      return {
        content: [{ type: "text" as const, text: `Exported to: ${savePath}\nFormat: ${format.toUpperCase()}\nSize: ${sizeStr}\nSource: ${source}${contentsLine}${openLine}` }],
      };
    }
  );

  server.tool(
    "list_installed_apps",
    "List 3D apps detected on the user's machine (PrusaSlicer, Cura, Bambu Studio, OrcaSlicer, FreeCAD, Fusion 360). Requires VSCode extension — it owns the filesystem scanning logic.",
    {},
    async () => {
      if (!isExtensionAlive()) return extensionOfflineError("list_installed_apps");
      const cmdId = sendExtensionCommand("list-installed-apps", {});
      if (!cmdId) {
        return { content: [{ type: "text" as const, text: "Failed to send command to extension" }], isError: true };
      }
      const result = await waitForResult(cmdId, 15000);
      if (!result) {
        return { content: [{ type: "text" as const, text: "list_installed_apps timed out after 15s." }], isError: true };
      }
      const apps: Array<{ id: string; name: string; preferredFormat: string }> = result.apps || [];
      if (apps.length === 0) {
        return { content: [{ type: "text" as const, text: "No compatible 3D apps detected on this machine." }] };
      }
      const lines = apps.map((a) => `- ${a.id} (${a.name}) — preferred format: ${a.preferredFormat.toUpperCase()}`);
      return {
        content: [{ type: "text" as const, text: `Detected apps (pass the id to export_shape's openIn parameter):\n${lines.join("\n")}` }],
      };
    }
  );

  server.tool(
    "list_shapes",
    "Find all .shape.ts files in a directory",
    {
      directory: z.string().optional().describe("Directory to search (defaults to the active VSCode workspace root, or cwd if no extension is running)"),
      recursive: z.boolean().optional().describe("Search subdirectories recursively (default: true). Set to false for top-level only."),
    },
    async ({ directory, recursive }) => {
      const usedDefault = !directory;
      const dir = resolve(directory || getDefaultDirectory());
      if (!existsSync(dir)) {
        return {
          content: [{ type: "text" as const, text: `Directory not found: ${dir}` }],
          isError: true,
        };
      }
      const depth = recursive === false ? 1 : 3;
      const files = findShapeFiles(dir, depth);
      // Always surface which directory was actually searched — when no
      // `directory` is passed, agents otherwise can't tell whether we used
      // the workspace root (extension alive) or process.cwd() (fallback).
      const source = usedDefault
        ? isExtensionAlive() ? " (default: active VSCode workspace)" : " (default: cwd — extension not running)"
        : "";
      const header = `Searched: ${dir}${source}\nFound: ${files.length} .shape.ts file${files.length === 1 ? "" : "s"}`;
      const body = files.length > 0 ? `\n\n${files.join("\n")}` : "";
      return {
        content: [{
          type: "text" as const,
          text: header + body,
        }],
      };
    }
  );

  server.tool(
    "validate_script",
    "Check syntax of a .shape.ts script (syntax only — does not verify imports or runtime behavior).",
    {
      code: z.string().describe("TypeScript source code to validate"),
    },
    async ({ code }) => {
      try {
        let stripped = code;
        stripped = stripped.replace(/^import\s+[\s\S]*?from\s*["'][^"']*["']\s*;?\s*$/gm, "");
        stripped = stripped.replace(/^import\s+["'][^"']*["']\s*;?\s*$/gm, "");
        stripped = stripped.replace(/^export\s+(default\s+)?/gm, "");
        stripped = stripped.replace(/:\s*typeof\s+\w+/g, "");
        stripped = stripped.replace(/(\w)\s*:\s*(?:string|number|boolean|any|void|never|unknown|null|undefined)(?:\[\])?\s*(?=[,)])/g, "$1");
        stripped = stripped.replace(/\bas\s+\w+/g, "");
        stripped = stripped.replace(/^(interface|type)\s+\w+[^=].*$/gm, "");
        stripped = stripped.replace(/(<\w[\w,\s]*>)\s*\(/g, "(");
        new Function(stripped);

        const knownMethods = new Set([
          "drawRectangle", "drawRoundedRectangle", "drawCircle", "drawEllipse", "drawPolysides", "drawText", "draw",
          "sketchCircle", "sketchRectangle", "makeCylinder", "makeSphere", "makeBox", "makeEllipsoid",
          "extrude", "revolve", "loftWith", "sweepSketch",
          "fuse", "cut", "intersect",
          "fillet", "chamfer", "shell", "draft",
          "translate", "translateX", "translateY", "translateZ", "rotate", "mirror", "scale",
          "sketchOnPlane", "sketchOnFace",
          "mesh", "meshEdges",
          "close", "hLine", "vLine", "lineTo", "line", "sagittaArcTo", "tangentArcTo", "threePointsArcTo",
          "cubicBezierCurveTo", "smoothSplineTo", "closeWithMirror", "done",
          "localGC", "exportSTEP",
        ]);
        const methodCallPattern = /\.(\w+)\s*\(/g;
        const unknownMethods = new Set<string>();
        let match;
        while ((match = methodCallPattern.exec(code)) !== null) {
          if (!knownMethods.has(match[1])) unknownMethods.add(match[1]);
        }

        // --- Semantic checks (pitfall linter) -----------------------------
        // Regex-only, conservative. These warnings are hints, not failures:
        // the script may be intentional, and we prefer false-negatives to
        // false-positives. isError stays false regardless.
        const semanticWarnings: string[] = [];

        // 1. sketchCircle/sketchRectangle already return a Sketch — chaining
        //    .sketchOnPlane() on top throws at runtime. Easy to confuse with
        //    the draw* family since the names rhyme.
        const sketchMisChain = /\b(sketchCircle|sketchRectangle)\s*\([^)]*\)\s*\.\s*sketchOnPlane\s*\(/;
        if (sketchMisChain.test(code)) {
          semanticWarnings.push(
            "`sketchCircle`/`sketchRectangle` already return a Sketch — remove the `.sketchOnPlane()` call (pass `{ plane: ... }` as config to the sketch* function instead)."
          );
        }

        // 2. draw*(...).(...).extrude() without an intervening sketchOnPlane/
        //    sketchOnFace. Tolerate 2D ops (fuse, cut, offset, translate,
        //    rotate, mirror) in the chain — those are all legal on Drawings.
        //    Match is deliberately non-greedy and bounded to a single chain
        //    expression (method calls with balanced-ish parens).
        const drawExtrudePattern = /\b(drawRectangle|drawRoundedRectangle|drawCircle|drawEllipse|drawPolysides|drawText)\s*\(([^()]|\([^()]*\))*\)((?:\s*\.\s*(?:fuse|cut|intersect|offset|translate|rotate|mirror)\s*\(([^()]|\([^()]*\))*\))*)\s*\.\s*extrude\s*\(/;
        if (drawExtrudePattern.test(code)) {
          semanticWarnings.push(
            "Drawings must be placed on a plane before extruding — add `.sketchOnPlane(\"XY\")` between the draw call and `.extrude()`."
          );
        }

        // 3. Non-uniform .scale(). Replicad's shape.scale is uniform-only.
        //    Flag array arg OR multiple numeric args (comma-separated).
        const scaleArrayPattern = /\.\s*scale\s*\(\s*\[/;
        const scaleMultiArgPattern = /\.\s*scale\s*\(\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*[,)]/;
        if (scaleArrayPattern.test(code) || scaleMultiArgPattern.test(code)) {
          semanticWarnings.push(
            "`shape.scale()` is uniform-only — pass a single number. For non-uniform scaling use `makeEllipsoid(rx, ry, rz)` or draw the target shape in 2D."
          );
        }

        // 4. draw() pen-builder chain missing .close()/.done() before
        //    .sketchOnPlane() or .extrude(). Match `draw(` (not drawXxx —
        //    the (?![a-zA-Z]) guard ensures we don't catch drawRectangle),
        //    followed by any chain of method calls up to the first
        //    sketchOnPlane/extrude. Warn if that chain contains no
        //    close/done/closeWithMirror call.
        const penChainPattern = /\bdraw\s*\((?![a-zA-Z])([^()]|\([^()]*\))*\)((?:\s*\.\s*[a-zA-Z_]\w*\s*\(([^()]|\([^()]*\))*\))*?)\s*\.\s*(sketchOnPlane|extrude)\s*\(/g;
        let penMatch: RegExpExecArray | null;
        while ((penMatch = penChainPattern.exec(code)) !== null) {
          const chainMiddle = penMatch[2] || "";
          if (!/\.\s*(close|closeWithMirror|done)\s*\(/.test(chainMiddle)) {
            semanticWarnings.push(
              "A `draw()` pen chain needs `.close()` (for extrudable regions) or `.done()` (for open sweep paths) before sketching/extruding."
            );
            break; // one warning is enough
          }
        }

        // 5. Fillet/chamfer radius sanity check against observed dimensions.
        //    Collect numeric literals from shape-factory calls and extrude
        //    distances. Take min > 0 as "smallest significant" dimension.
        //    Warn if any fillet/chamfer radius literal exceeds half of that.
        const dims: number[] = [];
        const extractNums = (s: string) => {
          const nums: number[] = [];
          const re = /-?\d+(?:\.\d+)?/g;
          let m: RegExpExecArray | null;
          while ((m = re.exec(s)) !== null) {
            const v = parseFloat(m[0]);
            if (isFinite(v) && v > 0) nums.push(v);
          }
          return nums;
        };
        const dimFnPattern = /\b(drawRectangle|drawRoundedRectangle|drawCircle|drawEllipse|sketchCircle|sketchRectangle|makeBox|makeCylinder|makeSphere|makeEllipsoid)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;
        let dimMatch: RegExpExecArray | null;
        while ((dimMatch = dimFnPattern.exec(code)) !== null) {
          dims.push(...extractNums(dimMatch[2]));
        }
        const extrudePattern = /\.\s*extrude\s*\(\s*(-?\d+(?:\.\d+)?)/g;
        let eMatch: RegExpExecArray | null;
        while ((eMatch = extrudePattern.exec(code)) !== null) {
          const v = parseFloat(eMatch[1]);
          if (isFinite(v) && v > 0) dims.push(v);
        }
        if (dims.length > 0) {
          const smallest = Math.min(...dims);
          const filletChamferPattern = /\.\s*(fillet|chamfer)\s*\(\s*(-?\d+(?:\.\d+)?)/g;
          let fcMatch: RegExpExecArray | null;
          const flagged = new Set<string>();
          while ((fcMatch = filletChamferPattern.exec(code)) !== null) {
            const r = parseFloat(fcMatch[2]);
            if (!isFinite(r) || r <= 0) continue;
            if (r > smallest * 0.5) {
              const key = `${fcMatch[1]}:${r}:${smallest}`;
              if (flagged.has(key)) continue;
              flagged.add(key);
              semanticWarnings.push(
                `Fillet/chamfer radius ${r} may be too large for the smallest feature dimension (${smallest}) — OpenCascade often fails on radii larger than half the edge length.`
              );
            }
          }
        }

        // 6. .fuse(/.cut( inside a for-loop body — classic "slow pattern".
        //    Walk the raw code, track brace depth from the `for (...)` header
        //    to the matching `}`, and flag fuse/cut within.
        const forPattern = /\bfor\s*\([^)]*\)\s*\{/g;
        let forMatch: RegExpExecArray | null;
        let loopBoolSuggested = false;
        while ((forMatch = forPattern.exec(code)) !== null) {
          let depth = 1;
          let i = forMatch.index + forMatch[0].length;
          const start = i;
          while (i < code.length && depth > 0) {
            const ch = code[i];
            if (ch === "{") depth++;
            else if (ch === "}") depth--;
            i++;
          }
          const body = code.slice(start, i);
          if (/\.\s*(fuse|cut)\s*\(/.test(body)) {
            loopBoolSuggested = true;
            break;
          }
        }
        if (loopBoolSuggested) {
          semanticWarnings.push(
            "Multiple 3D `fuse`/`cut` inside a loop is slow — consider combining in 2D first (with `drawing.fuse()` / `drawing.cut()`) then a single `.extrude()` at the end. See the `booleans` category in get_api_reference."
          );
        }

        // --- Assemble response --------------------------------------------
        const baseText = unknownMethods.size > 0
          ? `Syntax OK. Warning: unknown method(s) found: ${Array.from(unknownMethods).map(m => `.${m}()`).join(", ")}.`
          : "Syntax OK";
        const warningBlock = semanticWarnings.length > 0
          ? `\nSemantic warnings:\n${semanticWarnings.map(w => ` - ${w}`).join("\n")}`
          : "";
        return { content: [{ type: "text" as const, text: baseText + warningBlock }] };
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `Syntax error: ${e.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "preview_shape",
    "Execute a .shape.ts snippet WITHOUT writing it to the user's workspace — ideal for trying boolean-chain variations, sketch tweaks, or debugging steps while iterating. The snippet must have an `export default` main() returning a Shape3D or an array of parts (same contract as create_shape). The code is written to a throwaway temp file, executed through the same engine as create_shape, and deleted afterwards. By default the temp file lives in an isolated globalStorage path — local `./` imports cannot resolve from there. Pass `workingDir` (usually `.` or the workspace root) to have the temp file written there instead, which enables relative imports like `./bolt.shape` to resolve against your workspace. Set captureScreenshot:true to also render a PNG (requires the VSCode extension).",
    {
      code: z.string().describe("Full .shape.ts source — must include an `export default` main() function returning a Shape3D or array of parts. Pair with `workingDir` to enable local `./` imports."),
      workingDir: z.string().optional().describe("Directory to write the temp snippet file in. When set, relative imports (`./foo.shape`) resolve against this directory. Defaults to a private globalStorage path (isolated; relative imports won't work). Pass the workspace root — usually `.` or an absolute path — to make `./foo.shape` imports from your assembly work."),
      captureScreenshot: z.boolean().optional().describe("If true, also capture a PNG screenshot via the VSCode extension. Default: false. Requires the extension to be running."),
      focusPart: z.string().optional().describe("For multi-part assemblies only: name of a single part to display exclusively in the screenshot — all other parts are hidden. No-op on single-part shapes. Takes precedence over hideParts when both are supplied. The interactive viewer's part visibility is restored after the screenshot."),
      hideParts: z.array(z.string()).optional().describe("For multi-part assemblies only: list of part names to hide in the screenshot. Other parts remain visible. Ignored if focusPart is also set. The interactive viewer's part visibility is restored after the screenshot."),
    },
    async ({ code, workingDir, captureScreenshot, focusPart, hideParts }) => {
      // Cheap pre-flight: reject obvious non-starters before touching the engine.
      // Matches the lightweight check create_shape does — full parse happens in esbuild.
      if (!code || !code.trim()) {
        return {
          content: [{ type: "text" as const, text: "preview_shape: `code` is empty. Provide a full .shape.ts snippet with an `export default` main()." }],
          isError: true,
        };
      }
      if (!code.includes("function") && !/=>/.test(code)) {
        return {
          content: [{ type: "text" as const, text: "preview_shape: snippet must contain at least a function definition (regular or arrow). Did you forget the `export default function main(...)` wrapper?" }],
          isError: true,
        };
      }

      // Decide where the temp file lives. Default: isolated globalStorage path
      // — nothing leaks into the user's tree, but relative imports can't
      // resolve. Opt-in: caller passes `workingDir`, which anchors relative
      // imports via esbuild's resolveDir (engine uses dirname(absPath)).
      // pid+timestamp avoids collisions across concurrent calls in either dir.
      let tempPath: string;
      let usingWorkingDir = false;
      if (workingDir !== undefined) {
        // Reuse the same resolution rule as every other filePath arg: absolute
        // inputs pass through, relatives anchor against the active workspace
        // root (not cwd, which is wrong for stdio children). `.` therefore
        // means "the workspace root", which is the most useful default value
        // for the agent to pass.
        const resolvedDir = resolveShapePath(workingDir);
        if (!existsSync(resolvedDir)) {
          return {
            content: [{
              type: "text" as const,
              text: `preview_shape: workingDir does not exist: ${resolvedDir}. Pass a path to an existing directory (usually the workspace root) — preview_shape will not auto-create directories.`,
            }],
            isError: true,
          };
        }
        let st;
        try {
          st = statSync(resolvedDir);
        } catch (e: any) {
          return {
            content: [{
              type: "text" as const,
              text: `preview_shape: failed to stat workingDir ${resolvedDir}: ${e?.message ?? e}`,
            }],
            isError: true,
          };
        }
        if (!st.isDirectory()) {
          return {
            content: [{
              type: "text" as const,
              text: `preview_shape: workingDir is not a directory: ${resolvedDir}. Pass a directory path, not a file.`,
            }],
            isError: true,
          };
        }

        // Opportunistic cleanup of stale snippet files from prior runs that
        // died before the finally-unlink could fire (e.g. hard kill). Capped
        // to files older than an hour so we never nuke a concurrent in-flight
        // snippet. Best-effort; errors are swallowed.
        try {
          const oneHourMs = 60 * 60 * 1000;
          const now = Date.now();
          for (const entry of readdirSync(resolvedDir)) {
            if (!entry.startsWith(".shapeitup-snippet-") || !entry.endsWith(".shape.ts")) continue;
            const full = join(resolvedDir, entry);
            try {
              const est = statSync(full);
              if (now - est.mtimeMs > oneHourMs) unlinkSync(full);
            } catch {}
          }
        } catch {}

        // Leading dot keeps it out of most editor tree views; ts+pid suffix
        // prevents concurrent-call collisions.
        tempPath = join(resolvedDir, `.shapeitup-snippet-${Date.now()}-${process.pid}.shape.ts`);
        usingWorkingDir = true;
      } else {
        mkdirSync(join(GLOBAL_STORAGE, "preview-snippets"), { recursive: true });
        tempPath = join(
          GLOBAL_STORAGE,
          "preview-snippets",
          `snippet-${Date.now()}-${process.pid}.shape.ts`
        );
      }

      const wantScreenshot = captureScreenshot === true;
      let screenshotLine = "";
      let screenshotWarning = "";

      try {
        try {
          writeFileSync(tempPath, code, "utf-8");
        } catch (e: any) {
          // Permission / EROFS / disk full on the chosen dir. Surface it
          // clearly rather than crashing — same status-text convention as the
          // other soft failures in this tool.
          return {
            content: [{
              type: "text" as const,
              text: `preview_shape: failed to write temp snippet at ${tempPath}: ${e?.message ?? e}. Check that the directory is writable.`,
            }],
            isError: true,
          };
        }

        // Same path as create_shape — consistent status output + hints for free.
        const { status } = await executeShapeFile(tempPath, GLOBAL_STORAGE);

        // Screenshot branch: only when requested AND engine run succeeded AND the
        // extension is alive. The temp file MUST survive long enough for the
        // viewer to read it back, so we defer the unlink into the finally below.
        if (wantScreenshot && status.success) {
          if (!isExtensionAlive()) {
            screenshotWarning = "\n(Screenshot skipped: VSCode extension is not running.)";
          } else {
            const cmdId = sendExtensionCommand("render-preview", {
              filePath: tempPath,
              renderMode: "ai",
              showDimensions: true,
              cameraAngle: "isometric",
              width: 1280,
              height: 960,
              focusPart,
              hideParts,
            });
            if (!cmdId) {
              screenshotWarning = "\n(Screenshot skipped: failed to send command to extension.)";
            } else {
              const result = await waitForResult(cmdId, 60_000);
              if (!result) {
                const reason = lastWaitTimeoutReason === "slow"
                  ? "extension is alive but render exceeded 60s"
                  : "extension stopped responding";
                screenshotWarning = `\n(Screenshot skipped: ${reason}.)`;
              } else if (result.error) {
                screenshotWarning = `\n(Screenshot skipped: ${result.error})`;
              } else if (result.screenshotPath) {
                const partsLine = focusPart
                  ? `\nParts: ${focusPart} (focused)`
                  : hideParts && hideParts.length > 0
                    ? `\nParts hidden: ${hideParts.join(", ")}`
                    : "";
                const partWarnLine = Array.isArray(result.partWarnings) && result.partWarnings.length > 0
                  ? `\nPart warnings: ${result.partWarnings.join("; ")}`
                  : "";
                screenshotLine = `\nScreenshot: ${result.screenshotPath}${partsLine}${partWarnLine}`;
              }
            }
          }
        }

        const header = usingWorkingDir
          ? `Snippet executed (not saved to disk)\nSnippet written to: ${tempPath}\n`
          : "Snippet executed (not saved to disk)\n";
        const body = formatStatusText(status) + screenshotLine + screenshotWarning;
        return {
          content: [{ type: "text" as const, text: header + body }],
          // A failed render is a tool error (the snippet didn't work). A missing
          // screenshot when render succeeded is just a warning — not isError.
          isError: !status.success,
        };
      } finally {
        // Always clean up the temp file — engine failures, screenshot timeouts,
        // and thrown exceptions all funnel through here.
        try { unlinkSync(tempPath); } catch {}
      }
    }
  );

  server.tool(
    "tune_params",
    "Re-execute an existing .shape.ts with ephemeral `params` overrides WITHOUT modifying the file — the file on disk is untouched. Returns the same stats as get_render_status (volume, surface area, bounding box, timings, warnings) so agents can binary-search a design constraint (target volume, bounding box, mass, fit tolerance) before committing the winning value with modify_shape. Pass `captureScreenshot: true` to also render a PNG of the tuned configuration via the VSCode extension.",
    {
      filePath: z.string().describe("Path to the .shape.ts file. Relative paths resolve against the active VSCode workspace root."),
      params: z.record(z.string(), z.number()).describe("Map of param name → override value. Only listed params are overridden; others fall back to the file's declared defaults. Values must be numbers."),
      captureScreenshot: z.boolean().optional().describe("If true, also capture a PNG screenshot of the tuned configuration via the VSCode extension. Default: false. Requires the extension to be running."),
    },
    async ({ filePath, params, captureScreenshot }) => {
      const absPath = resolveShapePath(filePath);
      if (!existsSync(absPath)) {
        return {
          content: [{ type: "text" as const, text: `File not found: ${absPath}` }],
          isError: true,
        };
      }
      if (!absPath.endsWith(".shape.ts")) {
        return {
          content: [{ type: "text" as const, text: `tune_params only operates on .shape.ts files: ${absPath}` }],
          isError: true,
        };
      }

      // Summary of the overrides for the response header. Render this even on
      // failure so the agent can see what it just tried.
      const entries = Object.entries(params);
      const paramsSummary = entries.length > 0
        ? entries.map(([k, v]) => `${k}=${v}`).join(", ")
        : "(none)";

      const { status } = await executeShapeFile(absPath, GLOBAL_STORAGE, params);

      // Warn about keys that aren't declared in the script's `params` object.
      // The engine silently accepts unknown keys (they just don't do anything);
      // flagging them at the MCP layer is how the agent learns about a typo.
      const declaredKeys = status.currentParams ? Object.keys(status.currentParams) : [];
      const requestedKeys = Object.keys(params);
      const ignoredKeys = requestedKeys.filter((k) => !declaredKeys.includes(k));
      const warningLines: string[] = [];
      if (status.success && declaredKeys.length === 0 && requestedKeys.length > 0) {
        warningLines.push(
          "Note: this script doesn't declare any params — tune_params had no effect. Add `export const params = { ... }` to the file to make it tunable."
        );
      } else if (ignoredKeys.length > 0) {
        warningLines.push(
          `Note: ignored unknown param${ignoredKeys.length === 1 ? "" : "s"} (not declared in script's params): ${ignoredKeys.join(", ")}. Declared: ${declaredKeys.join(", ") || "(none)"}`
        );
      }

      const header = `Tuned (file NOT modified) with: ${paramsSummary}\n`;
      const warningBlock = warningLines.length > 0 ? warningLines.join("\n") + "\n" : "";
      let responseText = header + warningBlock + formatStatusText(status);

      // Optional screenshot branch — only meaningful on a successful render
      // AND when the extension is running. Mirrors the preview_shape pattern
      // (warning, not isError, when the screenshot can't be produced).
      if (captureScreenshot === true && status.success) {
        if (!isExtensionAlive()) {
          responseText += "\n(Screenshot skipped: VSCode extension is not running.)";
        } else {
          const cmdId = sendExtensionCommand("render-preview", {
            filePath: absPath,
            renderMode: "ai",
            showDimensions: true,
            cameraAngle: "isometric",
            width: 1280,
            height: 960,
            // Forwarded to the extension host, which threads it through
            // executeScript → viewer → worker so the PNG matches the tuned
            // configuration we just stat'd, not the file's defaults.
            params,
          });
          if (!cmdId) {
            responseText += "\n(Screenshot skipped: failed to send command to extension.)";
          } else {
            const result = await waitForResult(cmdId, 60_000);
            if (!result) {
              const reason = lastWaitTimeoutReason === "slow"
                ? "extension is alive but render exceeded 60s"
                : "extension stopped responding";
              responseText += `\n(Screenshot skipped: ${reason}.)`;
            } else if (result.error) {
              responseText += `\n(Screenshot skipped: ${result.error})`;
            } else if (result.screenshotPath) {
              responseText += `\nScreenshot: ${result.screenshotPath}`;
            }
          }
        }
      }

      return {
        content: [{ type: "text" as const, text: responseText }],
        isError: !status.success,
      };
    }
  );

  server.tool(
    "get_api_reference",
    "Get Replicad API reference. Call without category to list available categories, pass `search` to find the most relevant sections across all categories, or pass `signaturesOnly: true` to get just the method signatures (token-efficient lookup).",
    {
      category: z
        .enum(["overview", "drawing", "sketching", "solids", "booleans", "modifications", "transforms", "finders", "export", "examples", "stdlib"])
        .optional()
        .describe("API category. Omit to see the list of available categories."),
      search: z.string().optional().describe("Keyword / phrase to search for across all categories. Returns the most relevant sections instead of one full category. Can be combined with `category` to search within a single category."),
      signaturesOnly: z.boolean().optional().describe("Return only method signatures (lines with `→` or top-level function/method declarations) from the requested category. Strips examples and prose for a compact lookup. Requires `category`."),
    },
    async ({ category, search, signaturesOnly }) => {
      if (search && search.trim().length > 0) {
        return { content: [{ type: "text" as const, text: searchApiReference(search, category) }] };
      }
      if (!category) {
        return {
          content: [{
            type: "text" as const,
            text: "Available API reference categories:\n- overview (start here)\n- drawing (2D shapes)\n- sketching (2D → 3D)\n- solids (3D operations)\n- booleans (cut, fuse, intersect)\n- modifications (fillet, chamfer, shell)\n- transforms (translate, rotate, mirror)\n- finders (edge/face selection)\n- export (STEP, STL)\n- examples (complete worked examples)\n- stdlib (mechanical/3D-print helpers: holes, screws, bearings, extrusions, print hints)\n\nCall get_api_reference with a category name for detailed docs, or pass `search` to search across all categories.",
          }],
        };
      }
      const body = getApiReference(category);
      if (signaturesOnly) {
        return { content: [{ type: "text" as const, text: extractSignatures(body, category) }] };
      }
      return { content: [{ type: "text" as const, text: body }] };
    }
  );

  server.tool(
    "render_preview",
    "Capture a PNG screenshot of the current shape. Requires VSCode + the ShapeItUp extension to be running (the extension renders via its webview, which works regardless of window size — the canvas is temporarily resized to the requested resolution). Preview PNGs are written to `{workspace}/shapeitup-previews/` — Read the returned absolute path to view the image. For headless verification without VSCode, use get_render_status which returns volume, surface area, center of mass, and bounding box. Pass `finder` to paint pink highlight spheres on the matched edges/faces in the screenshot (for just a text match count with no PNG, use `preview_finder`).",
    {
      filePath: z.string().optional().describe("Optional .shape.ts to execute first. Defaults to the last-executed shape."),
      cameraAngle: z
        .enum(["isometric", "top", "bottom", "front", "right", "back", "left"])
        .optional()
        .describe("Camera angle preset (default: 'isometric')"),
      showDimensions: z.boolean().optional().describe("Overlay bounding-box dimensions (default: true)"),
      showAxes: z.boolean().optional().describe("Overlay X/Y/Z coordinate axes in the screenshot (default: false). Helpful for orienting symmetric or complex models."),
      renderMode: z.enum(["ai", "dark"]).optional().describe("'ai' for high-contrast light background (default), 'dark' for dark mode"),
      width: z.number().optional().describe("Output width in pixels (default 1280)"),
      height: z.number().optional().describe("Output height in pixels (default 960)"),
      timeoutMs: z
        .number()
        .int()
        .min(10000)
        .optional()
        .describe("Upper bound in milliseconds before giving up. Default 60000 (60s). Cold OCCT renders on complex geometry may need more. Values above ~180000 are rarely useful."),
      focusPart: z.string().optional().describe("For multi-part assemblies only: name of a single part to display exclusively in the screenshot — all other parts are hidden. No-op on single-part shapes. Takes precedence over hideParts when both are supplied. The interactive viewer's part visibility is restored after the screenshot."),
      hideParts: z.array(z.string()).optional().describe("For multi-part assemblies only: list of part names to hide in the screenshot. Other parts remain visible. Ignored if focusPart is also set. The interactive viewer's part visibility is restored after the screenshot."),
      finder: z.string().optional().describe("Optional EdgeFinder/FaceFinder expression, e.g. 'new EdgeFinder().inDirection(\"Z\")'. When provided, the rendered screenshot shows pink highlight spheres at each matched entity — same as preview_finder, but the PNG is saved alongside other render_previews (not ephemeral)."),
      partName: z.string().optional().describe("With `finder` on a multi-part assembly: apply the finder to the part whose name matches exactly. Wins over partIndex when both are given. Ignored when `finder` isn't set."),
      partIndex: z.number().int().nonnegative().optional().describe("With `finder` on a multi-part assembly: 0-based index of the part to apply the finder to (default: 0). Ignored when `finder` isn't set or `partName` is provided."),
    },
    async ({ filePath, cameraAngle, showDimensions, showAxes, renderMode, width, height, timeoutMs, focusPart, hideParts, finder, partName, partIndex }) => {
      // Resolve which file to render: explicit > engine's last-executed > status file.
      let source: string | undefined = filePath ? resolveShapePath(filePath) : getLastFileName();
      if (!source) {
        try {
          const status = JSON.parse(readFileSync(join(GLOBAL_STORAGE, "shapeitup-status.json"), "utf-8"));
          if (status.fileName) source = status.fileName;
        } catch {}
      }
      if (!source) {
        return {
          content: [{ type: "text" as const, text: "No shape to preview. Call create_shape, open_shape, or modify_shape first, or pass filePath." }],
          isError: true,
        };
      }

      if (!isExtensionAlive()) {
        return {
          content: [{
            type: "text" as const,
            text: `render_preview requires the VSCode extension to be running. Open VSCode with the ShapeItUp extension and retry.\n\nFor headless verification, use get_render_status — it returns volume, surface area, center of mass, and bounding box without needing a screenshot.`,
          }],
          isError: true,
        };
      }

      // --- Optional finder branch ---------------------------------------------
      // When `finder` is set, we don't ship the user's file to the extension as
      // usual; we generate a wrapper .shape.ts next to it that applies
      // highlightFinder() to the chosen part and render THAT. The wrapper is
      // cleaned up in a finally so we never leave droppings if the render
      // crashes. `buildFinderWrapperScript` is the shared helper also used by
      // preview_finder — keeping the wrapper contract in one place.
      let wrapperPath: string | undefined;
      let finderAppliedLine = "";
      let finderPartWarning: string | undefined;
      let renderFileArg = source;
      if (finder !== undefined && finder.trim().length > 0) {
        // Run the script once to resolve the target part + validate the finder
        // expression. Matches preview_finder: lets us produce clean error
        // messages ("no part named X", "finder failed to evaluate") *before*
        // burning a full extension render.
        const { status: preStatus, parts } = await executeShapeFile(source, GLOBAL_STORAGE);
        if (!preStatus.success || !parts || parts.length === 0) {
          return {
            content: [{ type: "text" as const, text: `Cannot render finder preview — script failed to render.\n${formatStatusText(preStatus)}` }],
            isError: true,
          };
        }

        let resolvedIdx: number;
        if (partName !== undefined) {
          if (parts.length === 1) {
            // Spec: single-part script + partName/partIndex passed → warn and
            // proceed (finder applies to the sole part).
            finderPartWarning = `partName='${partName}' ignored: script returned a single part ('${parts[0].name}'). Finder applied to it.`;
            resolvedIdx = 0;
          } else {
            const byName = parts.findIndex((p) => p.name === partName);
            if (byName < 0) {
              return {
                content: [{ type: "text" as const, text: `No part named "${partName}" in ${basename(source)}. Available parts: ${parts.map((p) => p.name).join(", ") || "(none)"}` }],
                isError: true,
              };
            }
            resolvedIdx = byName;
          }
        } else if (partIndex !== undefined) {
          if (parts.length === 1 && partIndex !== 0) {
            finderPartWarning = `partIndex=${partIndex} ignored: script returned a single part ('${parts[0].name}'). Finder applied to it.`;
            resolvedIdx = 0;
          } else if (partIndex >= parts.length) {
            return {
              content: [{ type: "text" as const, text: `partIndex ${partIndex} out of range — script returned ${parts.length} part${parts.length === 1 ? "" : "s"} (${parts.map((p) => p.name).join(", ")}).` }],
              isError: true,
            };
          } else {
            resolvedIdx = partIndex;
          }
        } else {
          resolvedIdx = 0;
        }

        // Pre-evaluate the finder expression with EdgeFinder/FaceFinder in
        // scope. Catches typos + undefined-method errors up-front so the MCP
        // response carries a clear message instead of a generic "script
        // failed" from the worker. Same sandbox pattern as preview_finder.
        try {
          const core = await getCore();
          const replicad: any = core.replicad();
          const EdgeFinder = replicad.EdgeFinder;
          const FaceFinder = replicad.FaceFinder;
          const fn = new Function("EdgeFinder", "FaceFinder", "replicad", `return (${finder});`);
          const finderObj = fn(EdgeFinder, FaceFinder, replicad);
          if (!finderObj || typeof finderObj.find !== "function") {
            return {
              content: [{ type: "text" as const, text: `Finder expression did not produce an EdgeFinder/FaceFinder (missing .find method).\nExpression: ${finder}` }],
              isError: true,
            };
          }
        } catch (e: any) {
          return {
            content: [{ type: "text" as const, text: `Finder expression failed to evaluate: ${e?.message ?? e}\nExpression: ${finder}` }],
            isError: true,
          };
        }

        // Emit the "(applied to part N: <name>)" line for multi-part assemblies
        // — matches the spec's guidance for the default-partIndex case.
        if (parts.length > 1) {
          finderAppliedLine = `\nFinder applied to part ${resolvedIdx}: ${parts[resolvedIdx].name}`;
        }

        const stamp = Date.now().toString(36);
        const dir = dirname(source);
        wrapperPath = join(dir, `.shapeitup-finder-preview-${stamp}.shape.ts`);
        try {
          const wrapperSource = buildFinderWrapperScript(source, finder, { index: resolvedIdx });
          writeFileSync(wrapperPath, wrapperSource, "utf-8");
        } catch (e: any) {
          // Couldn't even stage the wrapper — no cleanup needed since
          // writeFileSync didn't succeed.
          wrapperPath = undefined;
          return {
            content: [{ type: "text" as const, text: `Failed to stage finder wrapper file: ${e?.message ?? e}` }],
            isError: true,
          };
        }
        renderFileArg = wrapperPath;
      }

      try {
        const cmdId = sendExtensionCommand("render-preview", {
          filePath: renderFileArg,
          renderMode: renderMode || "ai",
          showDimensions: showDimensions !== false,
          showAxes: showAxes === true,
          cameraAngle: cameraAngle || "isometric",
          width: width || 1280,
          height: height || 960,
          focusPart,
          hideParts,
        });
        if (!cmdId) {
          return { content: [{ type: "text" as const, text: "Failed to send command to extension" }], isError: true };
        }

        // The viewer does: execute script → render at requested size → capture.
        // 60s default covers cold OCCT init + render on complex geometry. Callers
        // can raise this via the tool's `timeoutMs` argument; waitForResult will
        // also extend once more (WAIT_GRACE_MS) if the extension is still alive
        // at the deadline, so truly-slow-but-responsive renders don't spuriously
        // fail.
        const effectiveTimeout = timeoutMs ?? 60_000;
        const result = await waitForResult(cmdId, effectiveTimeout);
        if (!result) {
          // Distinguish the two failure modes. `lastWaitTimeoutReason` is set by
          // waitForResult on the failing path.
          const totalWaitMs = effectiveTimeout + (lastWaitTimeoutReason === "slow" ? WAIT_GRACE_MS : 0);
          const msg = lastWaitTimeoutReason === "slow"
            ? `render_preview timed out after ${totalWaitMs}ms. The extension is still responsive but the render is taking longer than ${totalWaitMs}ms — consider passing a larger \`timeoutMs\`.`
            : `render_preview timed out after ${effectiveTimeout}ms. The extension appears to have crashed or was closed.`;
          return {
            content: [{ type: "text" as const, text: msg }],
            isError: true,
          };
        }
        if (result.error) {
          return {
            content: [{ type: "text" as const, text: `Screenshot failed: ${result.error}` }],
            isError: true,
          };
        }

        // Pull the latest render status so the response includes geometric props.
        let statusText = "";
        try {
          const status: EngineStatus = JSON.parse(readFileSync(join(GLOBAL_STORAGE, "shapeitup-status.json"), "utf-8"));
          if (status.success) {
            statusText = `\nStats: ${status.stats}${formatProperties(status.properties)}`;
          }
        } catch {}

        const partsLine = focusPart
          ? `\nParts: ${focusPart} (focused — other parts hidden in screenshot)`
          : hideParts && hideParts.length > 0
            ? `\nParts hidden: ${hideParts.join(", ")}`
            : "";
        const partWarnLine = Array.isArray(result.partWarnings) && result.partWarnings.length > 0
          ? `\nPart warnings: ${result.partWarnings.join("; ")}`
          : "";
        const finderWarnLine = finderPartWarning ? `\nWarning: ${finderPartWarning}` : "";

        // For finder-wrapper renders, the extension names the PNG after the
        // wrapper (leading-dot ugly name). Rename it in place so the returned
        // path uses the user's shape basename — the screenshot still lives in
        // `{workspace}/shapeitup-previews/`, just with a human-readable name.
        // Best-effort: if rename fails, fall back to the raw extension path.
        let screenshotPath: string = result.screenshotPath;
        if (wrapperPath && screenshotPath && existsSync(screenshotPath)) {
          try {
            const userBase = basename(source).replace(/\.shape\.ts$/, "");
            const angle = cameraAngle || "isometric";
            const renamedPath = join(dirname(screenshotPath), `shapeitup-preview-${userBase}-finder-${angle}.png`);
            if (renamedPath !== screenshotPath) {
              renameSync(screenshotPath, renamedPath);
              screenshotPath = renamedPath;
            }
          } catch {
            // keep raw screenshotPath
          }
        }

        const finderLine = finder !== undefined && finder.trim().length > 0
          ? `\nFinder: ${finder}${finderAppliedLine}${finderWarnLine}`
          : "";

        return {
          content: [{
            type: "text" as const,
            text: `Screenshot saved to: ${screenshotPath}\nRender mode: ${renderMode || "ai"}, Camera: ${cameraAngle || "isometric"}, Axes: ${showAxes === true ? "ON" : "OFF"}, Size: ${width || 1280}x${height || 960}\nFile: ${source}${partsLine}${partWarnLine}${finderLine}${statusText}\nUse the Read tool to view this image. Or call the \`get_preview\` MCP tool to receive the PNG data inline without needing filesystem access.`,
          }],
        };
      } finally {
        if (wrapperPath) {
          try { unlinkSync(wrapperPath); } catch {}
        }
      }
    }
  );

  server.tool(
    "get_preview",
    "Return the latest (or a specified) ShapeItUp preview PNG as inline MCP image content — base64 bytes delivered directly in the tool response, no filesystem Read required. Use this when your sandbox ignores `shapeitup-previews/` (gitignored) or restricts filesystem reads. Does NOT trigger a render — call `render_preview` first if no preview exists yet.",
    {
      filePath: z.string().optional().describe("Optional absolute path to a PNG. Defaults to the most recent ShapeItUp preview."),
      cameraAngle: z
        .enum(["isometric", "top", "bottom", "front", "right", "back", "left"])
        .optional()
        .describe("Used only when filePath is omitted, to pick `shapeitup-preview-<shape>-<angle>.png` instead of the generic latest preview."),
    },
    async ({ filePath, cameraAngle }) => {
      // 1) Resolve target PNG. Precedence: explicit filePath → per-shape+angle
      // file in workspace previews dir → workspace "latest" → GLOBAL_STORAGE
      // pre-workspace-move fallback.
      let target: string | undefined;
      if (filePath) {
        target = resolveShapePath(filePath);
      } else {
        const wsRoot = getDefaultDirectory();
        const previewsDir = join(wsRoot, "shapeitup-previews");
        let shapeName: string | undefined;
        try {
          const status = JSON.parse(readFileSync(join(GLOBAL_STORAGE, "shapeitup-status.json"), "utf-8"));
          if (status.fileName) shapeName = basename(status.fileName).replace(/\.shape\.ts$/, "");
        } catch {}
        const candidates: string[] = [];
        if (shapeName && cameraAngle) candidates.push(join(previewsDir, `shapeitup-preview-${shapeName}-${cameraAngle}.png`));
        candidates.push(join(previewsDir, "shapeitup-preview.png"));
        candidates.push(join(GLOBAL_STORAGE, "shapeitup-preview.png"));
        target = candidates.find((p) => existsSync(p));
      }
      if (!target || !existsSync(target)) {
        return {
          content: [{ type: "text" as const, text: `No preview PNG found${target ? ` at ${target}` : ""}. Call render_preview first to generate one.` }],
          isError: true,
        };
      }
      try {
        const st = statSync(target);
        if (st.size > 10 * 1024 * 1024) {
          return {
            content: [{ type: "text" as const, text: `Preview PNG is ${(st.size / 1024 / 1024).toFixed(1)} MB (>10 MB limit for inline delivery). Call render_preview again with a smaller width/height.` }],
            isError: true,
          };
        }
        const buf = readFileSync(target);
        const data = buf.toString("base64");
        return {
          content: [
            { type: "image" as const, data, mimeType: "image/png" },
            { type: "text" as const, text: `Loaded: ${target}\nSize: ${(st.size / 1024).toFixed(1)} KB\nModified: ${st.mtime.toISOString()}` },
          ],
        };
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `Failed to read preview PNG at ${target}: ${e?.message ?? e}. Call render_preview to regenerate.` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "set_render_mode",
    "Switch the interactive VSCode viewer between dark and AI mode. Requires VSCode extension — this is a UI-only setting.",
    {
      mode: z.enum(["ai", "dark"]).describe("'ai' for high-contrast light mode, 'dark' for normal dark mode"),
    },
    async ({ mode }) => {
      if (!isExtensionAlive()) return extensionOfflineError("set_render_mode");
      const ok = !!sendExtensionCommand("set-render-mode", { mode });
      return {
        content: [{ type: "text" as const, text: ok ? `Render mode set to: ${mode}` : "Failed to send command" }],
        isError: !ok,
      };
    }
  );

  server.tool(
    "toggle_dimensions",
    "Show or hide dimension measurements on the VSCode viewer. Requires VSCode extension — UI-only setting. Omit `show` to toggle the current state.",
    {
      show: z
        .union([z.boolean(), z.enum(["true", "false"])])
        .optional()
        .describe("true to show dimensions, false to hide. Omit to toggle the current state. Also accepts 'true'/'false' strings for clients that stringify booleans."),
    },
    async ({ show }) => {
      if (!isExtensionAlive()) return extensionOfflineError("toggle_dimensions");
      const normalized: boolean | undefined =
        typeof show === "string" ? show === "true" : show;
      const ok = !!sendExtensionCommand("toggle-dimensions", { show: normalized });
      const stateLabel = normalized === undefined ? "toggled" : normalized ? "visible" : "hidden";
      return {
        content: [{ type: "text" as const, text: ok ? `Dimensions: ${stateLabel}` : "Failed to send command" }],
        isError: !ok,
      };
    }
  );

  server.tool(
    "get_render_status",
    "Get the result of the last shape render — whether it succeeded or failed, with stats, geometric properties (volume, area, center of mass, mass when material is exported), and bounding box. Reads the shared status file, which both MCP-driven and VSCode-driven renders write to. Includes currentParams — the resolved values of every exported param, so you don't need to re-read the file to inspect parameter state. For multi-part assemblies, returns per-part stats (name, volume, surface area, center of mass, bounding box, mass) — no separate list_parts tool needed.",
    {},
    async () => {
      const statusFile = join(GLOBAL_STORAGE, "shapeitup-status.json");
      if (!existsSync(statusFile)) {
        return {
          content: [{ type: "text" as const, text: "No render status available. Call create_shape, open_shape, or modify_shape first." }],
        };
      }
      try {
        const status: EngineStatus = JSON.parse(readFileSync(statusFile, "utf-8"));
        return {
          content: [{ type: "text" as const, text: formatStatusText(status) }],
          // Render failures are an expected state, not tool errors.
        };
      } catch {
        return {
          content: [{ type: "text" as const, text: "Could not read render status." }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "preview_finder",
    "Preview which edges/faces a Replicad EdgeFinder or FaceFinder matches on a shape — WITHOUT editing the user's script. Runs the given .shape.ts file, applies the finder to the resulting shape, and reports how many entities matched plus their locations. `EdgeFinder` and `FaceFinder` are implicitly in scope — pass a plain TS finder expression (same DSL you'd use in a fillet/chamfer/shell call), e.g. `new EdgeFinder().inDirection(\"Z\")` or `new FaceFinder().inPlane(\"XY\", 10)`. Supports the full finder DSL: `.and`, `.or`, `.not`, `.inDirection`, `.inPlane`, `.ofLength`, `.containsPoint`, etc. If the VSCode extension is running, also renders the highlighted preview in the viewer (pink spheres at each match); otherwise just returns the text report.",
    {
      filePath: z.string().describe("Path to the .shape.ts file whose shape the finder should be applied to"),
      finder: z.string().describe("TS expression producing an EdgeFinder or FaceFinder, e.g. 'new EdgeFinder().inDirection(\"Z\").ofLength(l => l > 10)'"),
      partIndex: z.number().int().nonnegative().optional().describe("If the script returns a multi-part assembly, which part's shape to apply the finder to (default: 0). Ignored when `partName` is also provided."),
      partName: z.string().optional().describe("For multi-part assemblies: apply the finder to the part whose name matches exactly (e.g., 'bolt'). Takes precedence over `partIndex` when both are provided."),
    },
    async ({ filePath, finder, partIndex, partName }) => {
      const absPath = resolveShapePath(filePath);
      if (!existsSync(absPath)) {
        return {
          content: [{ type: "text" as const, text: `File not found: ${absPath}` }],
          isError: true,
        };
      }

      // Step 1: execute the user's script to get the live OCCT parts.
      const { status, parts } = await executeShapeFile(absPath, GLOBAL_STORAGE);
      if (!status.success || !parts || parts.length === 0) {
        return {
          content: [{ type: "text" as const, text: `Cannot preview finder — script failed to render.\n${formatStatusText(status)}` }],
          isError: true,
        };
      }

      // Resolve the target part: partName (if provided) wins over partIndex.
      let idx: number;
      if (partName !== undefined) {
        idx = parts.findIndex((p) => p.name === partName);
        if (idx < 0) {
          return {
            content: [{ type: "text" as const, text: `No part named "${partName}" in ${basename(absPath)}. Available parts: ${parts.map((p) => p.name).join(", ") || "(none)"}` }],
            isError: true,
          };
        }
      } else {
        idx = partIndex ?? 0;
      }
      if (idx >= parts.length) {
        return {
          content: [{ type: "text" as const, text: `partIndex ${idx} out of range — script returned ${parts.length} part${parts.length === 1 ? "" : "s"} (${parts.map((p) => p.name).join(", ")}).` }],
          isError: true,
        };
      }
      const target = parts[idx];
      const shape = target.shape;

      // Step 2: evaluate the finder expression with EdgeFinder/FaceFinder in scope.
      const core = await getCore();
      const replicad: any = core.replicad();
      const EdgeFinder = replicad.EdgeFinder;
      const FaceFinder = replicad.FaceFinder;
      if (!EdgeFinder || !FaceFinder) {
        return {
          content: [{ type: "text" as const, text: "Internal error: replicad EdgeFinder/FaceFinder exports not available." }],
          isError: true,
        };
      }

      let finderObj: any;
      try {
        // Construct a sandboxed expression. The finder string is user-supplied TS
        // but we're already executing user-supplied TS via create_shape/etc., so
        // this is not a new trust boundary.
        const fn = new Function("EdgeFinder", "FaceFinder", "replicad", `return (${finder});`);
        finderObj = fn(EdgeFinder, FaceFinder, replicad);
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `Failed to evaluate finder expression: ${e?.message ?? e}\nExpression: ${finder}` }],
          isError: true,
        };
      }

      if (!finderObj || typeof finderObj.find !== "function") {
        return {
          content: [{ type: "text" as const, text: `Finder expression did not produce an EdgeFinder/FaceFinder (missing .find method).\nExpression: ${finder}` }],
          isError: true,
        };
      }

      const isFace = finderObj instanceof FaceFinder;
      const entityKind = isFace ? "face" : "edge";

      let matches: any[];
      try {
        matches = finderObj.find(shape) || [];
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `Finder .find() threw: ${e?.message ?? e}\nExpression: ${finder}` }],
          isError: true,
        };
      }

      // Step 3: build the text description — count + per-match location hints.
      const header = `Finder matched ${matches.length} ${entityKind}${matches.length === 1 ? "" : "s"} on part '${target.name}' of ${basename(absPath)}.`;
      const locationLines: string[] = [];
      const maxListed = 10;
      const fmt = (n: number) => (Math.abs(n) >= 1000 ? n.toFixed(0) : n.toFixed(2));
      for (let i = 0; i < Math.min(matches.length, maxListed); i++) {
        const m = matches[i];
        let pt: any;
        try {
          if (typeof m.pointAt === "function") pt = m.pointAt(0.5);
          else if (m.center) pt = m.center;
        } catch {}
        const px = pt?.x ?? (Array.isArray(pt) ? pt[0] : undefined);
        const py = pt?.y ?? (Array.isArray(pt) ? pt[1] : undefined);
        const pz = pt?.z ?? (Array.isArray(pt) ? pt[2] : undefined);
        const loc = (typeof px === "number" && typeof py === "number" && typeof pz === "number")
          ? `at (${fmt(px)}, ${fmt(py)}, ${fmt(pz)})`
          : "(location unavailable)";
        let extra = "";
        try {
          if (!isFace && typeof m.length === "number") extra = `, length=${fmt(m.length)}mm`;
        } catch {}
        locationLines.push(`  [${i}] ${entityKind} ${loc}${extra}`);
        try { m.delete?.(); } catch {}
      }
      if (matches.length > maxListed) {
        locationLines.push(`  ... ${matches.length - maxListed} more`);
      }

      if (matches.length === 0) {
        const zeroHint = `\nThe finder matched nothing — double-check the filters (e.g. plane offset, direction axis, length constraint). ${isFace ? "FaceFinder" : "EdgeFinder"} DSL: .inDirection('X'|'Y'|'Z'), .inPlane('XY'|'XZ'|'YZ', offset?), .ofLength(n|fn), .containsPoint([x,y,z]), .atAngleWith(dir, deg), .parallelTo(plane), .not(f), .either([f1, f2]).`;
        // No render-preview when there are no matches — the viewer would just
        // show the raw shape which is visually indistinguishable from "script
        // loaded fine".
        return {
          content: [{ type: "text" as const, text: header + zeroHint }],
        };
      }

      let text = `${header}\n${locationLines.join("\n")}`;

      // Step 4: optional highlighted preview in the VSCode viewer. Write a
      // synthetic wrapper .shape.ts next to the user's file (so local imports
      // resolve through esbuild's bundler), render-preview it, then clean up.
      if (isExtensionAlive()) {
        const stamp = Date.now().toString(36);
        const dir = dirname(absPath);
        const previewPath = join(dir, `.shapeitup-finder-preview-${stamp}.shape.ts`);
        const wrapperSource = buildFinderWrapperScript(absPath, finder, { index: idx });
        try {
          writeFileSync(previewPath, wrapperSource, "utf-8");
          const cmdId = sendExtensionCommand("render-preview", {
            filePath: previewPath,
            renderMode: "ai",
            showDimensions: false,
            cameraAngle: "isometric",
            width: 1280,
            height: 960,
          });
          if (cmdId) {
            const result = await waitForResult(cmdId, 30000);
            if (result?.screenshotPath) {
              text += `\n\nHighlighted preview: ${result.screenshotPath}\nUse the Read tool to view this image.`;
            } else if (result?.error) {
              text += `\n\n(Highlighted preview unavailable: ${result.error})`;
            }
          }
        } catch (e: any) {
          text += `\n\n(Highlighted preview skipped: ${e?.message ?? e})`;
        } finally {
          try { unlinkSync(previewPath); } catch {}
        }
      }

      return {
        content: [{ type: "text" as const, text }],
      };
    }
  );

  server.tool(
    "check_collisions",
    "Detects pairwise intersections between named parts in a multi-part assembly. AABB prefilter skips obviously-disjoint pairs; remaining pairs are tested with Replicad's 3D intersect (which can fail on complex curved solids — those pairs are reported as 'intersect failed' rather than silently ignored). Tolerance filters out numerical-noise contacts (default 0.001 mm³); very large assemblies (100+ parts) will be slow because work grows as N².",
    {
      filePath: z.string().describe("Path to the .shape.ts file to check for part collisions."),
      tolerance: z.number().optional().describe("Minimum intersection volume in mm³ to count as a collision. Defaults to 0.001 — filters out numerical-noise overlaps on touching-but-not-overlapping parts. Negative values are clamped to 0."),
    },
    async ({ filePath, tolerance }) => {
      const absPath = resolveShapePath(filePath);
      if (!existsSync(absPath)) {
        return {
          content: [{ type: "text" as const, text: `File not found: ${absPath}` }],
          isError: true,
        };
      }

      // Step 1: execute the script to get live OCCT parts. Failure here is
      // surfaced via formatStatusText so the agent sees the engine's own
      // error hint (fillet too large, wire not closed, etc.).
      const { status, parts } = await executeShapeFile(absPath, GLOBAL_STORAGE);
      if (!status.success || !parts) {
        return {
          content: [{ type: "text" as const, text: `Cannot check collisions — script failed to render.\n${formatStatusText(status)}` }],
          isError: true,
        };
      }

      if (parts.length < 2) {
        return {
          content: [{ type: "text" as const, text: "Collision check skipped — file contains a single part. Collisions only apply to multi-part assemblies." }],
        };
      }

      const tol = Math.max(0, typeof tolerance === "number" ? tolerance : 0.001);

      // Step 2: compute per-part AABBs from the tessellated vertex arrays.
      // Same math as engine.boundingBoxFromVertices but we keep the raw
      // min/max bounds instead of collapsing to width/height/depth — we need
      // them for overlap testing. A tiny epsilon on the overlap check keeps
      // perfectly-adjacent parts (shared face) out of the "maybe collide"
      // bucket cheaply. Parts with zero vertices get a null box and are
      // skipped with a warning.
      type Box = { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };
      const boxes: Array<Box | null> = parts.map((p) => {
        const v = p.vertices;
        if (!v || v.length < 3) return null;
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (let i = 0; i < v.length; i += 3) {
          if (v[i] < minX) minX = v[i];
          if (v[i] > maxX) maxX = v[i];
          if (v[i + 1] < minY) minY = v[i + 1];
          if (v[i + 1] > maxY) maxY = v[i + 1];
          if (v[i + 2] < minZ) minZ = v[i + 2];
          if (v[i + 2] > maxZ) maxZ = v[i + 2];
        }
        return { minX, minY, minZ, maxX, maxY, maxZ };
      });

      const AABB_EPS = 1e-6;
      const aabbsOverlap = (a: Box, b: Box): boolean =>
        a.maxX > b.minX + AABB_EPS && b.maxX > a.minX + AABB_EPS &&
        a.maxY > b.minY + AABB_EPS && b.maxY > a.minY + AABB_EPS &&
        a.maxZ > b.minZ + AABB_EPS && b.maxZ > a.minZ + AABB_EPS;

      // Duplicate-name detection — index prefix disambiguates in the report.
      const nameCounts = new Map<string, number>();
      for (const p of parts) nameCounts.set(p.name, (nameCounts.get(p.name) ?? 0) + 1);
      const labelFor = (i: number): string =>
        (nameCounts.get(parts[i].name) ?? 0) > 1 ? `part-${i}:${parts[i].name}` : parts[i].name;

      // Step 3: grab replicad for measureShapeVolumeProperties. Same pattern
      // as preview_finder.
      const core = await getCore();
      const replicad: any = core.replicad();
      const measureVol = replicad?.measureShapeVolumeProperties;

      const collisions: Array<{ a: string; b: string; volume: number }> = [];
      const failures: Array<{ a: string; b: string; error: string }> = [];
      const degenerateWarnings: string[] = [];
      let skippedByAABB = 0;
      let tested = 0;
      const totalPairs = (parts.length * (parts.length - 1)) / 2;

      for (let i = 0; i < parts.length; i++) {
        const boxI = boxes[i];
        if (!boxI) {
          // Record once per degenerate part, not once per pair — noise.
          if (!degenerateWarnings.some((w) => w.includes(`[${i}]`))) {
            degenerateWarnings.push(`  - ${labelFor(i)} [${i}] has no tessellated vertices — skipped from collision scan.`);
          }
          continue;
        }
        for (let j = i + 1; j < parts.length; j++) {
          const boxJ = boxes[j];
          if (!boxJ) continue; // degenerate; warning already recorded above

          if (!aabbsOverlap(boxI, boxJ)) {
            skippedByAABB++;
            continue;
          }

          tested++;

          // Step 4: attempt the 3D intersect. Per-pair try/catch — one failing
          // pair must not kill the scan. WASM handle hygiene: the overlap
          // solid (on success) goes through a finally that calls .delete()
          // with its own swallowing try/catch so cleanup can never throw.
          let overlapShape: any = null;
          try {
            overlapShape = parts[i].shape.intersect(parts[j].shape);
          } catch (e: any) {
            failures.push({ a: labelFor(i), b: labelFor(j), error: e?.message ?? String(e) });
            continue;
          }

          try {
            // Measure volume of the intersection solid. measureShapeVolumeProperties
            // can itself throw or return null for truly empty results — treat
            // a null/zero volume as "no collision" (intersect returned an
            // empty solid, the expected signal on non-overlapping inputs) but
            // a thrown error as a probe failure worth reporting.
            let volume = 0;
            let volProps: any = null;
            try {
              volProps = measureVol?.(overlapShape);
              if (volProps && typeof volProps.volume === "number") {
                volume = volProps.volume;
              }
            } catch (e: any) {
              failures.push({ a: labelFor(i), b: labelFor(j), error: `volume measurement failed: ${e?.message ?? e}` });
              continue;
            } finally {
              try { volProps?.delete?.(); } catch {}
            }

            if (volume > tol) {
              collisions.push({ a: labelFor(i), b: labelFor(j), volume });
            }
          } finally {
            // CRITICAL: always delete the overlap solid, even on measurement
            // failure, to avoid leaking WASM handles.
            try { overlapShape?.delete?.(); } catch {}
          }
        }
      }

      // Step 5: format the summary.
      const fmt = (n: number) => (Math.abs(n) >= 1000 ? n.toFixed(0) : n.toFixed(2));
      const header = `Collision check: ${parts.length} parts, ${tested} pair${tested === 1 ? "" : "s"} tested (${skippedByAABB} skipped by AABB prefilter), ${collisions.length} collision${collisions.length === 1 ? "" : "s"} found, ${failures.length} intersect call${failures.length === 1 ? "" : "s"} failed.`;

      const sections: string[] = [header];

      if (collisions.length > 0) {
        const lines = collisions.map((c) => `  - ${c.a} ↔ ${c.b}: ${fmt(c.volume)} mm³ overlap`);
        sections.push(`\nCollisions:\n${lines.join("\n")}`);
      }

      if (failures.length > 0) {
        const lines = failures.map((f) => `  - ${f.a} ↔ ${f.b}: ${f.error}`);
        sections.push(`\nIntersect failures (retry with mold-cut or report to developer):\n${lines.join("\n")}`);
      }

      if (degenerateWarnings.length > 0) {
        sections.push(`\nWarnings:\n${degenerateWarnings.join("\n")}`);
      }

      // Clean "all clear" message when nothing collided, nothing failed, and
      // at least one pair was actually tested (otherwise the AABB prefilter
      // skipped everything and "no collisions detected" would be misleading).
      if (collisions.length === 0 && failures.length === 0 && skippedByAABB < totalPairs) {
        return {
          content: [{ type: "text" as const, text: `No collisions detected (all ${tested} tested pair${tested === 1 ? "" : "s"} clear).${degenerateWarnings.length ? `\n\nWarnings:\n${degenerateWarnings.join("\n")}` : ""}` }],
        };
      }

      return {
        content: [{ type: "text" as const, text: sections.join("\n") }],
      };
    }
  );
}

function formatProperties(props: ShapeProperties | undefined): string {
  if (!props) return "";
  const fmt = (n: number) =>
    Math.abs(n) >= 1000 ? n.toFixed(0) : n.toFixed(2);
  const fmtPt = (p: [number, number, number]) =>
    `(${fmt(p[0])}, ${fmt(p[1])}, ${fmt(p[2])})`;

  const lines: string[] = [];
  if (typeof props.totalVolume === "number") {
    lines.push(`  volume: ${fmt(props.totalVolume)} mm³ (${fmt(props.totalVolume / 1000)} cm³)`);
  }
  if (typeof props.totalSurfaceArea === "number") {
    lines.push(`  surface area: ${fmt(props.totalSurfaceArea)} mm²`);
  }
  if (typeof props.totalMass === "number") {
    lines.push(`  mass: ${fmt(props.totalMass)} g`);
  }
  if (props.centerOfMass) {
    lines.push(`  center of mass: ${fmtPt(props.centerOfMass)} mm`);
  }
  if (props.parts && props.parts.length > 1) {
    for (const p of props.parts) {
      const bits: string[] = [];
      if (typeof p.volume === "number") bits.push(`V=${fmt(p.volume)}mm³`);
      if (typeof p.surfaceArea === "number") bits.push(`A=${fmt(p.surfaceArea)}mm²`);
      if (typeof p.mass === "number") bits.push(`mass=${fmt(p.mass)}g`);
      if (p.centerOfMass) bits.push(`CoM=${fmtPt(p.centerOfMass)}`);
      if (p.boundingBox) bits.push(`bbox=${fmt(p.boundingBox.x)}x${fmt(p.boundingBox.y)}x${fmt(p.boundingBox.z)}`);
      if (bits.length) lines.push(`  - ${p.name}: ${bits.join(", ")}`);
    }
  }
  return lines.length ? `\nGeometric properties:\n${lines.join("\n")}` : "";
}

function findShapeFiles(dir: string, depth = 3): string[] {
  if (depth <= 0) return [];
  const results: string[] = [];
  try {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isFile() && entry.endsWith(".shape.ts")) {
        results.push(full);
      } else if (stat.isDirectory()) {
        results.push(...findShapeFiles(full, depth - 1));
      }
    }
  } catch {}
  return results;
}

/**
 * Strip a category body down to signature-like lines: anything with a Replicad
 * arrow `→`, anything that looks like a function/method call (`name(args)`), and
 * inline-code signatures inside backticks. Drops prose, code fences, and blank
 * regions so agents doing quick API lookups don't pay for the full example text.
 * Headings are kept as section markers.
 */
function extractSignatures(body: string, category: string): string {
  const lines = body.split("\n");
  const kept: string[] = [];
  let inFence = false;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (/^```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) {
      // Keep signature-ish lines inside code fences (function decls, arrow types).
      if (/→|^\s*(?:export\s+)?(?:function|const|class|interface|type)\s+\w/.test(line)) {
        kept.push(line.trim());
      }
      continue;
    }
    if (/^#{1,4}\s/.test(line)) { kept.push(line); continue; }
    if (/→/.test(line)) { kept.push(line.trim()); continue; }
    // Plain signature-ish prose lines: bulleted or bare method calls.
    if (/^\s*[-*]?\s*`?\w[\w.]*\(/.test(line) && line.includes("(")) kept.push(line.trim());
  }
  const body2 = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return body2.length > 0
    ? `# ${category} — signatures only\n\n${body2}`
    : `# ${category} — signatures only\n\n(No signature-style lines found in this category; call get_api_reference without signaturesOnly for the full content.)`;
}

function getApiReference(category: string): string {
  const refs: Record<string, string> = {
    overview: `# ShapeItUp / Replicad API Overview

Files: *.shape.ts — export a default main() returning Shape3D.

PREFERRED pattern (with params for live sliders):
\`\`\`typescript
import { drawRoundedRectangle } from "replicad";

export const params = { width: 80, height: 50, depth: 30 };

export default function main({ width, height, depth }: typeof params) {
  return drawRoundedRectangle(width, height, 5).sketchOnPlane("XY").extrude(depth);
}
\`\`\`

Multi-part assemblies:
\`\`\`typescript
return [
  { shape: base, name: "base", color: "#8899aa" },
  { shape: bolt, name: "bolt", color: "#aa8855" },
];
\`\`\`

Flow: Drawing (2D) → Sketch (on plane) → Shape3D (extrude/revolve/loft/sweep)

Coordinate system (units: millimeters):
  X = right, Y = forward (into the screen from the default iso view), Z = up.
\`\`\`
        Z (up)
        |
        |
        +------ X (right)
       /
      /
     Y (forward, away from camera)
\`\`\`
Planes and their extrude directions:
- "XY" — horizontal plane (top-down view). .extrude(d) goes +Z (up).
- "XZ" — vertical plane, faces the camera in "front" view. .extrude(d) goes +Y (away from camera).
- "YZ" — vertical plane, faces the camera in "right" view. .extrude(d) goes +X.
Prefix "-" flips the plane's normal, so extrude reverses: "-XY" extrudes in -Z (down),
"-XZ" in -Y, "-YZ" in -X. Use this when cutting a hole downward through a base, or any
time you want the solid to grow opposite the default direction.

draw* vs sketch* — they look alike but return different things:
- drawCircle/drawRectangle/drawRoundedRectangle/drawEllipse/drawPolysides/drawText/draw()
    return a Drawing (2D, not placed). You MUST call .sketchOnPlane() before extruding.
    e.g. drawCircle(10).sketchOnPlane("XY").extrude(5)
- sketchCircle/sketchRectangle return a Sketch already placed via its config arg.
    Do NOT chain .sketchOnPlane() — it's already a Sketch. Go straight to extrude/revolve.
    e.g. sketchCircle(10, { plane: "XY" }).extrude(5)

Optional material for mass reporting:
  export const material = { density: 7.85, name: "steel" };  // g/cm³
Common densities (g/cm³): steel 7.85, aluminum 2.70, brass 8.50, ABS 1.04,
PLA 1.24, nylon 1.15, wood (pine) 0.50. When material is exported, get_render_status
returns mass alongside volume.

AI workflow: create_shape → get_render_status → render_preview (if visual check needed)

Categories: drawing, sketching, solids, booleans, modifications, transforms, finders, export, examples, stdlib`,
    drawing: `# Drawing API (2D Shapes)

All draw* functions return a **Drawing** — a 2D shape NOT yet placed on a plane.
You MUST call .sketchOnPlane("XY"|"XZ"|"YZ", origin?) before extruding/revolving.
(If you want a one-liner already placed on a plane, use sketchCircle/sketchRectangle
from the sketching category instead.)

## Factory Functions
- draw(origin?) → DrawingPen (freeform builder)
- drawRectangle(width, height) → Drawing
- drawRoundedRectangle(width, height, radius) → Drawing
- drawCircle(radius) → Drawing
- drawEllipse(xRadius, yRadius) → Drawing
- drawPolysides(radius, numSides) → Drawing
- drawText(text, { fontSize?, fontFamily? }) → Drawing

## DrawingPen Methods (chainable)
Lines: .lineTo([x,y]), .line(dx,dy), .vLine(d), .hLine(d), .polarLine(d, angle)
Arcs: .sagittaArcTo([x,y], sagitta), .tangentArcTo([x,y]), .threePointsArcTo([x,y], [mx,my])
Curves: .cubicBezierCurveTo([x,y], [cp1x,cp1y], [cp2x,cp2y]), .smoothSplineTo([x,y])
Close: .close(), .closeWithMirror(), .done()

## 2D Operations
.fuse(other), .cut(other), .intersect(other)
.offset(distance), .translate(dx,dy), .rotate(angle), .mirror(axis)`,
    sketching: `# Sketching (2D → 3D-ready)

A Sketch is a 2D shape placed on a plane — the input to extrude/revolve/loft/sweep.

Two ways to get one:
  1. From a Drawing (the draw* family): drawCircle(10).sketchOnPlane("XY", [0,0,0])
  2. Directly, via a sketch* convenience:  sketchCircle(10, { plane: "XY" })

The sketch* functions ALREADY return a Sketch — do NOT chain .sketchOnPlane() onto them.
sketchCircle(r).sketchOnPlane(...) throws at runtime.

Methods:
- drawing.sketchOnPlane(plane?, origin?) → Sketch
    plane: "XY" | "XZ" | "YZ" (prefix "-" to flip normal, e.g. "-XY")
    origin: [x, y, z] — offsets the sketch along the plane normal, e.g. [0,0,20]
- drawing.sketchOnFace(face, scaleMode?) → Sketch
- sketchRectangle(w, h, config?) → Sketch
- sketchCircle(r, config?) → Sketch

Plane config for sketch*: { plane: "XY"|"XZ"|"YZ", origin: [x,y,z] }

Plane orientation — what \`origin\` actually means:
The \`origin\` arg is NOT a 2D offset within the sketch plane — it is a full 3D point
that shifts the plane along its own normal. \`sketchOnPlane("XY", [0,0,20])\` places the
sketch on XY raised 20 mm in +Z. For "XZ" the normal is +Y (so [0,20,0] shifts 20 mm
forward); for "YZ" the normal is +X. To translate within the plane, use \`drawing.translate(dx, dy)\` before \`sketchOnPlane\`, not the origin arg.

## Composition Patterns

All draw* factories return an origin-centered Drawing — most "constraint" questions
(center, edge-align, symmetry, radial patterns) reduce to plain 2D translate/cut.

Center one shape inside another — both are origin-centered, so a cut just works:
\`\`\`typescript
const base = drawRectangle(80, 50);
const hole = drawCircle(5);
const plate = base.cut(hole).sketchOnPlane("XY").extrude(10);
\`\`\`

Corner-relative placement — translate a pre-centered drawing by (halfW - inset, halfH - inset):
\`\`\`typescript
// 4mm bolt hole 5mm in from the +X/+Y corner of an 80x50 plate.
const hole = drawCircle(2).translate(80 / 2 - 5, 50 / 2 - 5);
\`\`\`

Symmetry via 2D mirror — \`closeWithMirror\` reflects the pen path across the X-axis and closes:
\`\`\`typescript
const halfProfile = draw().hLine(20).vLine(10).hLine(-15).closeWithMirror();
\`\`\`

N-fold radial patterning (bolt circles, cooling fins) — build the pattern in 2D, extrude once:
\`\`\`typescript
let plate = drawRectangle(100, 100);
for (let i = 0; i < 6; i++) {
  const angle = (i / 6) * 2 * Math.PI;
  const bolt = drawCircle(3).translate(40 * Math.cos(angle), 40 * Math.sin(angle));
  plate = plate.cut(bolt);
}
const part = plate.sketchOnPlane("XY").extrude(5);
\`\`\`

Sketch a feature on a raised plane — the \`origin\` arg of \`sketchOnPlane\` is a 3D point
that shifts the plane along its normal (see note above). A boss on top of a base:
\`\`\`typescript
const baseH = 10;
const boss = drawCircle(8).sketchOnPlane("XY", [0, 0, baseH]).extrude(5);
\`\`\``,
    solids: `# 3D Solid Operations

sketch.extrude(distance, config?) → Shape3D
sketch.revolve(axis?, config?) → Shape3D
sketch.loftWith(otherSketches, config?) → Shape3D
sketch.sweepSketch(profileFn, config?) → Shape3D

makeCylinder(radius, height, location?, direction?) → Shape3D
makeSphere(radius) → Shape3D
makeBox(corner1, corner2) → Shape3D
makeEllipsoid(rx, ry, rz) → Solid

For positioning tricks (centering, corner-relative, radial patterns) see "Composition Patterns" in the sketching category.`,
    booleans: `# Boolean Operations

shape.fuse(other) — union
shape.cut(tool) — subtraction
shape.intersect(other) — intersection

PREFER 2D booleans over 3D intersect — drawing.fuse/cut is far more robust.

## Patterned Features

For repeated features (N cooling fins, bolt-circle holes, ribs, teeth): combine
everything at the **Drawing (2D)** level with drawing.fuse/cut in a loop, THEN do
a single .sketchOnPlane().extrude() (or .revolve()) at the end. Each 3D fuse/cut
forces OCCT to rebuild the full solid topology, so N 3D ops cost O(N) solid
rebuilds. N 2D ops are cheap planar operations and a single extrude is one solid
build — often 10×+ faster, and far more robust on dense patterns. Only drop to
3D booleans when the features truly differ along the extrude axis (e.g. varying
heights or offset planes). See the "Cooling Fins" example in the examples category.`,
    modifications: `# Shape Modifications

shape.fillet(radius, finder?) → Shape3D
shape.chamfer(distance, finder?) → Shape3D
shape.shell({ thickness, filter }) → Shape3D
shape.draft(angle, faceFinder, neutralPlane?)

Apply fillets BEFORE boolean cuts. Use small radii (0.3-0.5mm) on complex geometry.`,
    transforms: `# Transformations

shape.translate(x, y, z), .translateX/Y/Z(d)
shape.rotate(angleDeg, position?, direction?)
shape.mirror(plane?, origin?)
shape.scale(factor, center?)  — uniform only

For non-uniform, use makeEllipsoid(rx, ry, rz) or draw directly in 2D.`,
    finders: `# Finders (selecting faces/edges)

EdgeFinder picks edges for fillet/chamfer; FaceFinder picks faces for shell/draft.
Pass a lambda \`e => e.method()\` (or \`f => f.method()\`) to the modification call — it receives a fresh finder.

## Common recipes

Vertical (Z-aligned) edges — outer corners of a vertical extrude:
\`shape.fillet(2, e => e.inDirection("Z"))\`

Top face of a part of height h — for shell or draft:
\`shape.shell({ thickness: 1, filter: f => f.inPlane("XY", h) })\`

All circular edges (hole rims, cylinder caps):
\`shape.fillet(0.5, e => e.ofCurveType("CIRCLE"))\`

Circular edges of a specific radius r — \`ofLength\` matches circumference for circles (2*PI*r):
\`shape.fillet(0.3, e => e.ofCurveType("CIRCLE").ofLength(2 * Math.PI * r))\`

Edge at a specific corner (pick one vertex to round):
\`shape.fillet(3, e => e.containsPoint([x, y, z]))\`

All edges at Z=10 — e.g. top rim of a cylinder:
\`shape.fillet(1, e => e.inPlane("XY", 10))\`

Horizontal edges on the top face — combine with \`.and\`:
\`shape.fillet(1, e => e.inPlane("XY", h).and(e2 => e2.ofLength(edgeLen)))\`

All edges except the top — invert with \`.not\`:
\`shape.fillet(1, e => e.not(e2 => e2.inPlane("XY", h)))\`

Edges aligned with X or Y — either/or with \`.or\`:
\`shape.chamfer(0.5, e => e.inDirection("X").or(e2 => e2.inDirection("Y")))\`

Outer vertical edges only — exclude vertical edges created by internal boolean cuts
(filter Z-aligned edges to those whose length matches the full extrude height):
\`shape.fillet(1, e => e.inDirection("Z").and(e2 => e2.ofLength(height)))\`

Top rim of a cylinder / any circular top edge at Z=height:
\`shape.fillet(0.5, e => e.inPlane("XY", height).and(e2 => e2.ofCurveType("CIRCLE")))\`

Bolt-hole rims — circular edges whose circumference matches a given hole radius \`r\`:
\`shape.fillet(0.3, e => e.ofCurveType("CIRCLE").ofLength(2 * Math.PI * r))\`

Fillet everything EXCEPT the top opening (e.g. a shelled enclosure with an open top):
\`shape.fillet(1, e => e.not(e2 => e2.inPlane("XY", height)))\`

## Method reference

EdgeFinder + FaceFinder:
.inDirection(dir)                  — "X" | "Y" | "Z" | [x,y,z]
.inPlane(plane, origin?)           — "XY" | "XZ" | "YZ", optional offset
.parallelTo(plane)                 — plane name or a face
.containsPoint([x,y,z])
.atDistance(d, point?)
.atAngleWith(dir, angle?)
.and(fn), .or(fn), .not(fn)        — compose predicates

EdgeFinder only:
.ofLength(len)                     — length, or circumference for CIRCLE
.ofCurveType("CIRCLE" | "LINE" | "BSPLINE" | "BEZIER" | ...)

FaceFinder only:
.ofSurfaceType("PLANE" | "CYLINDER" | "SPHERE" | ...)

## Debugging

Before applying a fillet/chamfer, verify the selection:
- \`highlightFinder(shape, new EdgeFinder().inDirection("Z"))\` — highlights matched edges inline.
- Or call the \`preview_finder\` MCP tool to render a screenshot with the matched edges/faces highlighted. Use it whenever a finder might be ambiguous — much cheaper than a failed fillet on complex geometry.`,
    export: `# Export

export_shape tool:
- format: "step" (CAD/CNC) or "stl" (3D printing)
- outputPath: optional, auto-derived from source file name
- filePath: optional, defaults to last executed
- partName: optional — for multi-part assemblies (\`return [{ shape, name, color }, ...]\`),
    export ONLY the named component instead of the whole assembly.
- openIn: optional — launch in PrusaSlicer/Cura/Bambu/Orca/FreeCAD/Fusion

## Choosing format for assemblies

- **3D printing (STL)**: export each printable component SEPARATELY with \`partName\` —
    they almost always need different orientations on the build plate, and STL has no
    concept of named components anyway. One STL per part.
- **CAD / CNC (STEP)**: export the full assembly WITHOUT \`partName\`. STEP preserves
    the named components as a single structured file — that's what downstream CAD/CAM
    tools expect.

Example — pulling one part from a multi-part assembly for printing:
\`\`\`
export_shape({ filePath: "assembly.shape.ts", format: "stl", partName: "bolt" })
// → writes assembly.bolt.stl
\`\`\`

Runs fully in-process, no VSCode needed.`,
    examples: `# Example Shape Scripts

## Box with Hole and Fillets
\`\`\`typescript
import { drawRectangle, sketchCircle } from "replicad";
export default function main() {
  // drawRectangle returns a Drawing — must sketchOnPlane before extruding.
  let shape = drawRectangle(60, 40).sketchOnPlane("XY").extrude(20);
  shape = shape.fillet(2);
  // sketchCircle returns a Sketch directly (plane is passed via config).
  // Do NOT chain .sketchOnPlane() — it's already a Sketch.
  const hole = sketchCircle(8, { plane: "XY" }).extrude(20);
  return shape.cut(hole);
}
\`\`\`

## Cooling Fins (Patterned Feature)
Combine all N fins into the 2D cross-section first, then extrude once.
Doing this with N 3D .fuse() calls on an extruded cylinder is much slower —
OCCT rebuilds the solid topology on every call.
\`\`\`typescript
import { drawCircle, drawRectangle } from "replicad";

export const params = { finCount: 20, finThickness: 2, baseR: 15, finR: 30, height: 40 };

export default function main({ finCount, finThickness, baseR, finR, height }: typeof params) {
  let profile = drawCircle(baseR);
  for (let i = 0; i < finCount; i++) {
    const angle = (i / finCount) * 360;
    const fin = drawRectangle(finR * 2, finThickness).rotate(angle);
    profile = profile.fuse(fin); // cheap 2D boolean
  }
  return profile.sketchOnPlane("XY").extrude(height); // single solid build
}
\`\`\``,
    stdlib: `# ShapeItUp stdlib (\`import from "shapeitup"\`)

Mechanical / 3D-printing helpers layered on top of Replicad. Every function
returns a Replicad Shape3D (or Drawing, where noted), so results mix with any
other Replicad code. Dimensions come from ISO/DIN tables — don't hardcode.

\`\`\`typescript
import { holes, screws, nuts, washers, inserts, bearings, extrusions, patterns, printHints, fromBack, shape3d, part, faceAt, shaftAt, boreAt, mate, assemble, stackOnZ, entries, cylinder } from "shapeitup";
\`\`\`

**Convention for cut-tool shapes** (holes, bearing seats, insert pockets):
axis +Z, top of the tool at Z = 0, tool extends into -Z. Users translate the
tool to the target location and cut from their part:

\`\`\`typescript
plate.cut(holes.counterbore("M3", { plateThickness: 4 }).translate(10, 10, 4))
\`\`\`

**Convention for positive shapes** (screws, nuts, washers, bearings bodies):
top face at Z = 0, shaft/body extends into -Z. Colors left to the caller.

**Back-face cuts** — wrap a cut tool in \`fromBack(tool)\` to flip it so it
extends into +Z from Z=0 instead. Use for features that open on the bottom
face of a plate (heat-set inserts, access ports, etc):

\`\`\`typescript
plate.cut(fromBack(inserts.pocket("M3")).translate(x, y, 0))
\`\`\`

**Shape3D type-narrowing** — replicad's \`.extrude()\` returns a wide union
(\`Shell | Solid | …\`) that lacks \`.cut()\` / \`.fuse()\`. Wrap with
\`shape3d(...)\` to narrow, instead of writing \`as Shape3D\` everywhere:

\`\`\`typescript
const plate = shape3d(drawRectangle(60, 40).sketchOnPlane("XY").extrude(5));
plate.cut(hole);  // OK
\`\`\`

---

## holes — cut-tool shapes

\`\`\`typescript
holes.through(size, { depth?, fit? })                     // clearance hole ("M3" or raw mm)
holes.counterbore(spec, { plateThickness, fit? })          // socket-head pocket + shaft
holes.countersink(spec, { plateThickness, fit? })          // 90° flat-head flare + shaft
holes.tapped(size, { depth })                              // tap-drill sized (metal taps or skip — use inserts.pocket for FDM)
holes.teardrop(size, { depth, axis? })                     // horizontal hole, FDM-printable
holes.keyhole({ largeD, smallD, slot, depth })             // hang-on-screw mount
holes.slot({ length, width, depth })                       // elongated hole
\`\`\`

\`fit\` is a FitStyle: "press" | "slip" | "clearance" (default) | "loose".
\`size\` for through/teardrop accepts \`MetricSize\` strings ("M3") OR a raw diameter in mm.
\`spec\` for counterbore/countersink is a screw designator ("M3" — length ignored).

---

## screws / nuts / washers / inserts — positive shapes

\`\`\`typescript
screws.socketHead("M3x10")     // ISO 4762 cap screw, full shape with hex recess
screws.buttonHead("M4x8")      // ISO 7380 — head is a simple cylinder in v1 (no dome)
screws.flatHead("M5x12")       // ISO 10642 countersunk — head is a revolved cone
nuts.hex("M3")                 // DIN 934 hex nut
washers.flat("M3")             // DIN 125 flat washer
inserts.heatSet("M3")          // brass heat-set insert BODY (for visualization)
inserts.pocket("M3")           // CUT-TOOL for the pocket — interference-fit sized
\`\`\`

For 3D printing: use \`inserts.pocket\` in the printed part + \`screws.socketHead\` as the
fastener. Don't try to print threaded holes — they're unreliable at small sizes.

---

## bearings — seat cutters + bearing bodies

\`\`\`typescript
bearings.seat("608", { throughHole?, depth? })   // press-fit pocket, stepped shoulder by default
bearings.body("608")                              // ring-shape for visualization
bearings.linearSeat("LM8UU")                      // straight-bore linear-bearing pocket
bearings.linearBody("LM8UU")                      // linear-bearing outer shell
\`\`\`

Ball bearings: 623, 624, 625, 626, 608 (skate — most common), 6000, 6001, 6002.
Linear bearings: LM4UU, LM6UU, LM8UU, LM10UU, LM12UU.

\`bearings.seat\` uses \`FIT.press\` (slight interference) to grip the bearing. Default
is a stepped pocket with the bearing resting on a 3 mm shoulder; pass
\`{ throughHole: true }\` for a straight cylinder.

---

## patterns — placement arrays + single-call apply

\`\`\`typescript
patterns.polar(n, radius, { startAngle?, axis?: "X"|"Y"|"Z", orientOutward? })
patterns.grid(nx, ny, dx, dy?)                       // centered on origin
patterns.linear(n, [dx, dy, dz])                     // N copies along a vector

patterns.spread(makeShape, placements)               // fuse N copies (positive shape)
patterns.cutAt(target, makeTool, placements)         // cut N copies (cut-tool shape)
patterns.applyPlacement(shape, placement)            // low-level: apply one
\`\`\`

**Important**: \`spread\` and \`cutAt\` take a **factory** (\`() => Shape3D\`), not
a shape. Replicad shares OCCT handles across \`.translate()\`/\`.rotate()\` calls —
reusing one shape across multiple cuts invalidates earlier copies ("this
object has been deleted"). The factory guarantees a fresh handle per placement.

Generators return \`Placement[]\` — plain data (\`{ translate, rotate?, axis? }\`)
you can map, filter, or combine manually. Common uses:

\`\`\`typescript
// Bolt circle — 6 × M4 counterbored on a 40mm PCD
flange = patterns.cutAt(
  flange,
  () => holes.counterbore("M4", { plateThickness: 5 }).translate(0, 0, 5),
  patterns.polar(6, 20),
);

// PCB standoffs — 2×2 grid of M3 heat-set pockets
plate = patterns.cutAt(
  plate,
  () => inserts.pocket("M3").translate(0, 0, thickness),
  patterns.grid(2, 2, 50, 40),
);
\`\`\`

---

## extrusions — T-slot aluminum profiles

\`\`\`typescript
extrusions.tSlot("2020", 200)         // 200 mm length of 2020 profile (extrudes +Z)
extrusions.tSlotProfile("2020")       // 2D Drawing of the cross-section
extrusions.tSlotChannel("2020", 200)  // OUTER-envelope cut-tool for sliding-bracket fits
\`\`\`

Profiles: "2020", "3030", "4040". **v1 simplification**: the profile is a
quad-slot square (one rectangular slot per side) with a center hole — no
internal T-cavity. Good for visualization + mounting reference; not
STEP-accurate for manufacturing.

---

## Parts + joints — declarative assembly

For multi-part assemblies where bodies must mate face-to-face, use the
joints API: every part is built at its local origin, declares named
joints, and \`assemble()\` positions them via a mate graph.

\`\`\`typescript
const motor = part({
  shape: motorBody.fuse(shaft),
  name: "motor", color: "#2b2b2b",
  joints: {
    mountFace: faceAt(MOTOR_HEIGHT),                 // +Z face
    shaftTip:  shaftAt(MOTOR_HEIGHT + 24, 5),        // +Z shaft tip, Ø5
  },
});

const positioned = assemble(
  [motor, plate, coupler, leadscrew],
  [
    mate(motor.joints.mountFace,      plate.joints.motorFace),
    mate(motor.joints.shaftTip,       coupler.joints.motorEnd),
    mate(coupler.joints.leadscrewEnd, leadscrew.joints.bottom, { gap: 0.2 }),
  ],
);
return entries(positioned);
\`\`\`

**Joint shortcuts** — encode the "axis points outward" convention so you
don't have to pick +Z vs -Z manually:

| Helper | Role | Default axis |
|---|---|---|
| \`faceAt(z)\` | \`"face"\` | \`"+Z"\` |
| \`shaftAt(z, diameter)\` | \`"male"\` | \`"+Z"\` |
| \`boreAt(z, diameter)\` | \`"female"\` | \`"-Z"\` |

Pass \`{ axis: "-Z" }\` (or any other) to override the default.

**\`mate()\` pre-flight**: throws if male/female roles are incompatible, if
face/face is mixed with male/female, or if matched diameters differ by
> 0.01mm. Catches wrong-size bolts + misaligned conventions at declaration
time, before a silent interference.

**\`assemble(parts, mates)\`** picks \`parts[0]\` as the fixed root, BFS-walks
the mate graph, returns the parts in their final positions.
\`entries(positioned)\` converts to the \`{shape, name, color}[]\` return format.

**Simple coaxial stacks** don't need joint declarations — \`stackOnZ(parts, { gap? })\`
positions via bounding-box math and requires no joints.

**\`cylinder({...})\`** — orientation-explicit alternative to replicad's
\`makeCylinder\`. Takes named \`{ top | bottom, length, diameter, direction? }\`
so the anchor is unambiguous.

**Insertion mates** — when a part must nest INSIDE another (press-fit bearing
in a pocket, dowel in a blind hole), declare the moving joint at the FAR
end of the overlap region with axis pointing OUTWARD. With \`gap=0\`,
\`mate()\` puts the two joint origins at the same place; the bulk of the
moving part then extends BEHIND the joint into the host:

\`\`\`typescript
const bearing = part({
  shape: bearings.body("608"), name: "bearing", color: "#c0c4c8",
  joints: {
    pocketSeat: faceAt(BEARING_WIDTH, { axis: "-Z" }),   // top of bearing, axis back out of pocket
  },
});
const plate = part({
  shape: plateWithPocket, name: "plate", color: "#8899aa",
  joints: { pocketMouth: faceAt(PLATE_THICKNESS) },      // mouth at top face, axis +Z
});
// Bearing body ends up occupying Z ∈ [mouth - width, mouth] — nested in the pocket.
mate(plate.joints.pocketMouth, bearing.joints.pocketSeat);
\`\`\`

**Debugging joint positions** — two helpers for "where did this joint land?":

\`\`\`typescript
console.log(debugJoints(positioned));   // text dump of every joint → world pos + axis
return highlightJoints(positioned);     // viewer: renders parts + pink spheres at each joint
\`\`\`

\`highlightJoints\` is the fastest way to diagnose a misaligned mate.

See \`examples/stdlib/leadscrew-assembly.shape.ts\` for a full NEMA17 →
coupler → leadscrew assembly using this API.

---

## printHints — FDM print-cleanliness helpers

\`\`\`typescript
printHints.elephantFootChamfer(shape, 0.4)       // chamfer bottom edges (default 0.4 mm)
printHints.overhangChamfer(shape, 45)            // best-effort overhang chamfer (warn on fail)
printHints.firstLayerPad(shape, { padding?, thickness? })  // thin adhesion pad (manual brim)
\`\`\`

\`overhangChamfer\` is a v1 stub — returns the shape unchanged with a
\`console.warn\` on complex geometry. For known-good cases (simple brackets,
plates) it cuts a reasonable chamfer.

---

## Complete worked example

\`\`\`typescript
import { drawRoundedRectangle, type Shape3D } from "replicad";
import { holes, inserts, screws } from "shapeitup";

export const params = { width: 60, depth: 40, thickness: 5 };

export default function main({ width, depth, thickness }: typeof params) {
  const plate = drawRoundedRectangle(width, depth, 3)
    .sketchOnPlane("XY")
    .extrude(thickness) as Shape3D;

  // 4 corner counterbored M3 mounting holes.
  const inset = 6;
  const positions: [number, number][] = [
    [-width/2 + inset, -depth/2 + inset],
    [ width/2 - inset, -depth/2 + inset],
    [-width/2 + inset,  depth/2 - inset],
    [ width/2 - inset,  depth/2 - inset],
  ];
  let body = plate;
  for (const [x, y] of positions) {
    const cb = holes.counterbore("M3", { plateThickness: thickness }).translate(x, y, thickness);
    body = body.cut(cb);
  }
  return body;
}
\`\`\``,
  };
  return refs[category] || refs.overview;
}

// --- Keyword search over the API reference ---------------------------------

// Full category list kept in sync with the z.enum above. We can't introspect
// `getApiReference.refs` from out here, so we re-enumerate. If you add a
// category, add it here too.
const API_REFERENCE_CATEGORIES = [
  "overview", "drawing", "sketching", "solids", "booleans",
  "modifications", "transforms", "finders", "export", "examples", "stdlib",
] as const;

const SEARCH_STOPWORDS = new Set([
  "how", "to", "do", "a", "an", "the", "in", "with", "for", "of", "on",
  "and", "or", "is", "are", "be", "can", "i", "my", "it", "this", "that",
]);

function tokenizeSearch(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^\w]+/g, ""))
    .filter((t) => t.length >= 2 && !SEARCH_STOPWORDS.has(t));
}

interface RefSection {
  category: string;
  heading: string;
  body: string; // heading + body combined (what we display)
}

/**
 * Split a category body into sections. Each section is the top `# Title` block
 * plus any subsequent `## Subheading` blocks. If the body has no `##` headers,
 * the whole body is one section.
 */
function splitIntoSections(category: string, body: string): RefSection[] {
  const lines = body.split(/\r?\n/);
  const sections: RefSection[] = [];
  let currentHeading = category;
  let currentLines: string[] = [];

  const flush = () => {
    // Drop leading/trailing blank lines.
    while (currentLines.length && currentLines[0].trim() === "") currentLines.shift();
    while (currentLines.length && currentLines[currentLines.length - 1].trim() === "") currentLines.pop();
    if (currentLines.length === 0) return;
    sections.push({
      category,
      heading: currentHeading,
      body: currentLines.join("\n"),
    });
  };

  for (const line of lines) {
    const m = line.match(/^(#{1,3})\s+(.*)$/);
    if (m) {
      // New heading — flush the previous section.
      flush();
      currentHeading = m[2].trim();
      currentLines = [line];
    } else {
      currentLines.push(line);
    }
  }
  flush();

  // Fallback: if we somehow produced nothing (body was empty of headers),
  // use a single-section blob split on double-newlines would over-fragment
  // code blocks, so just return the whole body.
  if (sections.length === 0 && body.trim().length > 0) {
    sections.push({ category, heading: category, body });
  }
  return sections;
}

// Lazily-built cache of all sections, keyed by category.
let _sectionCache: Map<string, RefSection[]> | null = null;
function getAllSections(): Map<string, RefSection[]> {
  if (_sectionCache) return _sectionCache;
  const cache = new Map<string, RefSection[]>();
  for (const cat of API_REFERENCE_CATEGORIES) {
    cache.set(cat, splitIntoSections(cat, getApiReference(cat)));
  }
  _sectionCache = cache;
  return cache;
}

function scoreSection(section: RefSection, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const headingLower = section.heading.toLowerCase();
  const bodyLower = section.body.toLowerCase();
  let score = 0;
  for (const tok of tokens) {
    // Count occurrences in body (includes heading line). Heading matches get a 3x boost on top.
    const bodyMatches = bodyLower.split(tok).length - 1;
    if (bodyMatches > 0) score += bodyMatches;
    if (headingLower.includes(tok)) score += 3;
  }
  return score;
}

function searchApiReference(query: string, scope?: string): string {
  const tokens = tokenizeSearch(query);
  const cache = getAllSections();
  const categoriesToSearch = scope ? [scope] : [...API_REFERENCE_CATEGORIES];
  const categoryList = API_REFERENCE_CATEGORIES.join(", ");

  if (tokens.length === 0) {
    return `No searchable keywords in "${query}" (all terms were stopwords or too short). Available categories: ${categoryList}. Try a more specific term.`;
  }

  const scored: Array<{ section: RefSection; score: number }> = [];
  for (const cat of categoriesToSearch) {
    const sections = cache.get(cat);
    if (!sections) continue;
    for (const section of sections) {
      const score = scoreSection(section, tokens);
      if (score > 0) scored.push({ section, score });
    }
  }

  if (scored.length === 0) {
    return `No matches for "${query}". Available categories: ${categoryList}. Try broader terms or call without \`search\` to see a category.`;
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 5);

  const lines: string[] = [];
  lines.push(`Search results for "${query}"${scope ? ` in category ${scope}` : ""} — top ${top.length} of ${scored.length} match${scored.length === 1 ? "" : "es"}:`);
  lines.push("");
  top.forEach((hit, i) => {
    lines.push(`[${i + 1}] ${hit.section.category} › ${hit.section.heading} (score: ${hit.score})`);
    lines.push(hit.section.body);
    lines.push("");
  });
  return lines.join("\n").trimEnd();
}
