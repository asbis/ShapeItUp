import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from "fs";
import { join, resolve, basename } from "path";
// Note: no esbuild dependency — this server must be fully self-contained
import { homedir } from "os";

// Path where the extension stores command files for IPC
const GLOBAL_STORAGE = join(
  homedir(),
  process.platform === "win32"
    ? "AppData/Roaming/Code/User/globalStorage/shapeitup.shapeitup-vscode"
    : ".config/Code/User/globalStorage/shapeitup.shapeitup-vscode"
);

function sendExtensionCommand(command: string, params: Record<string, any> = {}): boolean {
  try {
    mkdirSync(GLOBAL_STORAGE, { recursive: true });
    const cmdFile = join(GLOBAL_STORAGE, "mcp-command.json");
    writeFileSync(cmdFile, JSON.stringify({ command, ...params }));
    return true;
  } catch {
    return false;
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

export function registerTools(server: McpServer) {
  server.tool(
    "create_shape",
    "Create a new .shape.ts CAD script file",
    {
      name: z.string().describe("File name without extension (e.g., 'bracket')"),
      code: z.string().describe("TypeScript source code using Replicad API"),
      directory: z
        .string()
        .optional()
        .describe("Directory to create the file in (defaults to cwd)"),
    },
    async ({ name, code, directory }) => {
      const dir = directory || process.cwd();
      const filePath = join(dir, `${name}.shape.ts`);
      writeFileSync(filePath, code, "utf-8");
      return {
        content: [
          {
            type: "text" as const,
            text: `Created ${filePath}`,
          },
        ],
      };
    }
  );

  server.tool(
    "modify_shape",
    "Overwrite an existing .shape.ts file with new code",
    {
      filePath: z.string().describe("Path to the .shape.ts file"),
      code: z.string().describe("New TypeScript source code"),
    },
    async ({ filePath, code }) => {
      const resolved = resolve(filePath);
      if (!existsSync(resolved)) {
        return {
          content: [{ type: "text" as const, text: `File not found: ${resolved}` }],
          isError: true,
        };
      }
      writeFileSync(resolved, code, "utf-8");
      return {
        content: [{ type: "text" as const, text: `Updated ${resolved}` }],
      };
    }
  );

  server.tool(
    "read_shape",
    "Read the contents of a .shape.ts file",
    {
      filePath: z.string().describe("Path to the .shape.ts file"),
    },
    async ({ filePath }) => {
      const resolved = resolve(filePath);
      if (!existsSync(resolved)) {
        return {
          content: [{ type: "text" as const, text: `File not found: ${resolved}` }],
          isError: true,
        };
      }
      const content = readFileSync(resolved, "utf-8");
      return {
        content: [{ type: "text" as const, text: content }],
      };
    }
  );

  server.tool(
    "list_shapes",
    "Find all .shape.ts files in a directory",
    {
      directory: z
        .string()
        .optional()
        .describe("Directory to search (defaults to cwd)"),
    },
    async ({ directory }) => {
      const dir = resolve(directory || process.cwd());
      const files = findShapeFiles(dir);
      return {
        content: [
          {
            type: "text" as const,
            text:
              files.length > 0
                ? files.join("\n")
                : "No .shape.ts files found",
          },
        ],
      };
    }
  );

  server.tool(
    "validate_script",
    "Check if a .shape.ts script has valid TypeScript syntax (does not execute it)",
    {
      code: z.string().describe("TypeScript source code to validate"),
    },
    async ({ code }) => {
      try {
        // Strip type annotations for basic syntax validation
        // (full TS validation would need esbuild which can't be bundled)
        const stripped = code
          .replace(/:\s*typeof\s+\w+/g, "")
          .replace(/:\s*\w+(\[\])?/g, "")
          .replace(/import\s+type\s+/g, "// ")
          .replace(/as\s+\w+/g, "");
        new Function(stripped);
        return {
          content: [{ type: "text" as const, text: "Script syntax looks valid" }],
        };
      } catch (e: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Syntax error: ${e.message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_api_reference",
    "Get Replicad API reference for a specific category",
    {
      category: z
        .enum([
          "overview",
          "drawing",
          "sketching",
          "solids",
          "booleans",
          "modifications",
          "transforms",
          "finders",
          "export",
          "examples",
        ])
        .optional()
        .describe("API category (defaults to overview)"),
    },
    async ({ category }) => {
      const ref = getApiReference(category || "overview");
      return {
        content: [{ type: "text" as const, text: ref }],
      };
    }
  );

  // --- AI Review Tools ---

  server.tool(
    "render_preview",
    "Capture a screenshot of the current 3D preview. Returns the file path to a PNG image you can read to verify the shape looks correct. Switches to high-contrast AI render mode with dimensions automatically.",
    {
      showDimensions: z.boolean().optional().describe("Show dimension overlay (default: true)"),
      renderMode: z.enum(["ai", "dark"]).optional().describe("Render mode: 'ai' for high-contrast light background (default), 'dark' for user's dark mode"),
    },
    async ({ showDimensions, renderMode }) => {
      // Send a single combined command to avoid file watcher race conditions
      sendExtensionCommand("render-preview", {
        renderMode: renderMode || "ai",
        showDimensions: showDimensions !== false,
      });

      // Wait for the extension to process all steps and save the screenshot
      await new Promise((r) => setTimeout(r, 3000));

      const result = readExtensionResult();
      const screenshotPath = result?.screenshotPath;

      if (screenshotPath && existsSync(screenshotPath)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Screenshot saved to: ${screenshotPath}\nUse the Read tool to view this image and verify the shape is correct.`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: "Could not capture screenshot. Make sure the ShapeItUp viewer is open in VSCode and a shape is loaded.",
          },
        ],
        isError: true,
      };
    }
  );

  server.tool(
    "set_render_mode",
    "Switch the 3D viewer between dark mode (user) and AI mode (high-contrast light background with vivid colors, better for AI analysis)",
    {
      mode: z.enum(["ai", "dark"]).describe("'ai' for high-contrast light mode, 'dark' for normal dark mode"),
    },
    async ({ mode }) => {
      const ok = sendExtensionCommand("set-render-mode", { mode });
      return {
        content: [{ type: "text" as const, text: ok ? `Render mode set to: ${mode}` : "Failed to send command" }],
        isError: !ok,
      };
    }
  );

  server.tool(
    "toggle_dimensions",
    "Show or hide dimension measurements (bounding box X/Y/Z) on the 3D preview. Useful for verifying sizes are correct.",
    {
      show: z.boolean().describe("true to show dimensions, false to hide"),
    },
    async ({ show }) => {
      const ok = sendExtensionCommand("toggle-dimensions", { show });
      return {
        content: [{ type: "text" as const, text: ok ? `Dimensions: ${show ? "visible" : "hidden"}` : "Failed to send command" }],
        isError: !ok,
      };
    }
  );

  server.tool(
    "get_render_status",
    "Get the result of the last shape render — shows whether it succeeded or failed, with error messages and render stats. Call this after creating or modifying a .shape.ts file to check if it rendered correctly.",
    {},
    async () => {
      const statusFile = join(GLOBAL_STORAGE, "shapeitup-status.json");
      if (!existsSync(statusFile)) {
        return {
          content: [{ type: "text" as const, text: "No render status available. Make sure a .shape.ts file is open in VS Code and the ShapeItUp viewer is active." }],
        };
      }

      try {
        const status = JSON.parse(readFileSync(statusFile, "utf-8"));
        if (status.success) {
          const parts = status.partNames?.length
            ? `\nParts: ${status.partNames.join(", ")}`
            : "";
          return {
            content: [{
              type: "text" as const,
              text: `Render SUCCESS\nStats: ${status.stats}${parts}\nTime: ${status.timestamp}`,
            }],
          };
        } else {
          return {
            content: [{
              type: "text" as const,
              text: `Render FAILED\nError: ${status.error}\nFile: ${status.fileName || "unknown"}\nTime: ${status.timestamp}`,
            }],
            isError: true,
          };
        }
      } catch {
        return {
          content: [{ type: "text" as const, text: "Could not read render status." }],
          isError: true,
        };
      }
    }
  );
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
  } catch {
    // Permission errors etc
  }
  return results;
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

Simple pattern (no sliders):
\`\`\`typescript
import { drawRectangle } from "replicad";
export default function main() {
  return drawRectangle(50, 30).sketchOnPlane("XY").extrude(10);
}
\`\`\`

Multi-part assemblies:
\`\`\`typescript
return [
  { shape: base, name: "base", color: "#8899aa" },
  { shape: bolt, name: "bolt", color: "#aa8855" },
];
\`\`\`

Multi-file imports:
\`\`\`typescript
import { makeBolt } from "./bolt.shape";
\`\`\`

Flow: Drawing (2D) → Sketch (on plane) → Shape3D (extrude/revolve/loft/sweep)
Coordinates: millimeters, X=right, Y=forward, Z=up
Planes: "XY" (top), "XZ" (front), "YZ" (right)

AI workflow: create_shape → render_preview → Read PNG → verify → modify if needed
Use render_preview to self-check your work. It shows dimensions automatically.

Categories: drawing, sketching, solids, booleans, modifications, transforms, finders, export, examples`,

    drawing: `# Drawing API (2D Shapes)

## Factory Functions
- draw(origin?) → DrawingPen (freeform builder)
- drawRectangle(width, height) → Drawing
- drawRoundedRectangle(width, height, radius) → Drawing
- drawCircle(radius) → Drawing
- drawEllipse(majorR, minorR) → Drawing
- drawPolysides(radius, numSides) → Drawing
- drawText(text, { fontSize?, fontFamily? }) → Drawing

## DrawingPen Methods (chainable)
Lines: .lineTo([x,y]), .line(dx,dy), .vLine(d), .hLine(d), .polarLine(d, angle)
Arcs: .sagittaArcTo([x,y], sagitta), .tangentArcTo([x,y]), .threePointsArcTo([x,y], [mx,my])
Curves: .cubicBezierCurveTo([x,y], [cp1x,cp1y], [cp2x,cp2y]), .smoothSplineTo([x,y])
Close: .close() (closed shape), .closeWithMirror(), .done() (open wire)

## 2D Operations
.fuse(other), .cut(other), .intersect(other)
.offset(distance), .translate(dx,dy), .rotate(angle), .mirror(axis)`,

    sketching: `# Sketching (2D → 3D-ready)

## Place a Drawing on a Plane
drawing.sketchOnPlane(plane?, origin?) → Sketch
drawing.sketchOnFace(face, scaleMode?) → Sketch

## Convenience Sketchers
sketchRectangle(w, h, config?) → Sketch
sketchCircle(r, config?) → Sketch

## Sketcher Class (3D pen)
new Sketcher(plane?, origin?) → (same methods as DrawingPen, but in 3D)
  .lineTo([x,y,z]), .line(dx,dy,dz), etc.
  .close() → Sketch ready for extrude/revolve

## Plane Config
{ plane: "XY"|"XZ"|"YZ", origin: [x,y,z] }
Or: "XY", "XZ", "YZ", "-XY", "-XZ", "-YZ"`,

    solids: `# 3D Solid Operations

## From Sketch
sketch.extrude(distance, config?) → Shape3D
  config: { extrusionDirection?, twistAngle? }
sketch.revolve(axis?, config?) → Shape3D
  config: { origin?, angle? } (default 360°)
sketch.loftWith(otherSketch, config?) → Shape3D
  config: { ruled? }
sketch.sweepSketch(profileFn, config?) → Shape3D

## Primitive Solids
makeCylinder(radius, height, location?, direction?) → Shape3D
makeSphere(radius) → Shape3D
makeBox(corner1, corner2) → Shape3D
  e.g. makeBox([0,0,0], [10,20,30])`,

    booleans: `# Boolean Operations

shape.fuse(other) → Shape3D          (union)
shape.cut(tool) → Shape3D            (subtraction)
shape.intersect(other) → Shape3D     (intersection)

Works on both 2D (Drawing) and 3D (Shape3D).
For 2D: fuse2D, cut2D, intersect2D`,

    modifications: `# Shape Modifications

## Fillet (round edges)
shape.fillet(radius, finder?) → Shape3D
  finder: (edge) => edge.inDirection("Z")  (filter which edges)
  Or: number applies to all edges

## Chamfer
shape.chamfer(distance, finder?) → Shape3D

## Shell (hollow out)
shape.shell({ thickness, filter }) → Shape3D
  filter: face finder to remove (e.g., top face)
  e.g. shape.shell({ thickness: 2, filter: f => f.inPlane("XY", 10) })

## Draft (taper walls)
shape.draft(angle, faceFinder, neutralPlane?)`,

    transforms: `# Transformations

shape.translate(x, y, z) → Shape3D
shape.translateX(d), .translateY(d), .translateZ(d)
shape.rotate(angleDeg, position?, direction?) → Shape3D
shape.mirror(plane?, origin?) → Shape3D
shape.scale(factor, center?) → Shape3D

All return new shapes (immutable).`,

    finders: `# Finders (selecting faces/edges)

## EdgeFinder
shape.fillet(2, e => e.inDirection("Z"))
  .inDirection(dir)         edges along a direction
  .ofLength(l)              edges of specific length
  .ofCurveType("CIRCLE")    circular edges
  .parallelTo(plane)
  .inPlane(plane, origin?)
  .atDistance(d, point?)
  .containsPoint(pt)

## FaceFinder
shape.shell({ thickness: 2, filter: f => f.inPlane("XY", 10) })
  .inPlane(plane, origin?)
  .parallelTo(plane)
  .ofSurfaceType("PLANE"|"CYLINDER"|"CONE"|"SPHERE")
  .containsPoint(pt)
  .atDistance(d, pt?)

## Combinators
.and(finder), .or(finder), .not(finder)`,

    export: `# Export

Shapes are exported via the VSCode extension:
- Ctrl+Shift+P → "ShapeItUp: Export as STEP"
- Ctrl+Shift+P → "ShapeItUp: Export as STL"

In scripts, just return the shape from main().
The extension handles STEP/STL export from the rendered shape.

Supported formats: STEP (.step), STL (.stl)
STEP preserves exact B-Rep geometry (best for CNC/manufacturing).
STL is mesh-based (best for 3D printing).`,

    examples: `# Example Shape Scripts

## Box with Hole and Fillets
\`\`\`typescript
import { drawRectangle, sketchCircle } from "replicad";

export default function main() {
  const box = drawRectangle(60, 40).sketchOnPlane("XY").extrude(20);
  const hole = sketchCircle(8, { plane: "XY" }).extrude(20);
  return box.cut(hole).fillet(2);
}
\`\`\`

## L-Bracket with Mounting Holes
\`\`\`typescript
import { draw, makeCylinder } from "replicad";

export default function main() {
  const profile = draw()
    .hLine(60).vLine(5).hLine(-55)
    .vLine(35).hLine(-5).close();

  let bracket = profile.sketchOnPlane("XZ").extrude(30);

  // Mounting holes
  const hole1 = makeCylinder(3, 30, [45, 0, 2.5], [0, 1, 0]);
  const hole2 = makeCylinder(3, 30, [15, 0, 2.5], [0, 1, 0]);
  const hole3 = makeCylinder(3, 30, [2.5, 0, 25], [0, 1, 0]);

  bracket = bracket.cut(hole1).cut(hole2).cut(hole3);
  return bracket.fillet(2, e => e.inDirection("Y"));
}
\`\`\`

## Cylinder with Flange
\`\`\`typescript
import { sketchCircle, drawCircle } from "replicad";

export default function main() {
  const base = sketchCircle(30).extrude(5);
  const tube = sketchCircle(15).extrude(40).translateZ(5);
  const innerHole = sketchCircle(12).extrude(45);
  return base.fuse(tube).cut(innerHole).fillet(3);
}
\`\`\`

## Enclosure with Lid
\`\`\`typescript
import { drawRoundedRectangle } from "replicad";

export default function main() {
  const outer = drawRoundedRectangle(80, 50, 5).sketchOnPlane("XY").extrude(30);
  const inner = drawRoundedRectangle(76, 46, 3)
    .sketchOnPlane("XY", [0, 0, 2])
    .extrude(30);
  return outer.cut(inner);
}
\`\`\``,
  };

  return refs[category] || refs.overview;
}
