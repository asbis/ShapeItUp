<p align="center">
  <img src="https://raw.githubusercontent.com/asbis/ShapeItUp/master/logo.png" alt="ShapeItUp" width="400">
</p>

<p align="center">
  <strong>Scripted CAD for VS Code</strong> — write TypeScript, see 3D, export to STEP/STL.
</p>

<p align="center">
  <a href="https://github.com/asbis/ShapeItUp/blob/master/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
</p>

---

ShapeItUp is a VS Code extension that turns TypeScript files into 3D CAD models using the [Replicad](https://replicad.xyz) library (OpenCascade WASM). It includes an MCP server so AI assistants like Claude Code can create, modify, and visually verify CAD models.

## Features

- **Script-based CAD** -- write `.shape.ts` files using TypeScript + Replicad API
- **Live 3D preview** -- auto-renders when you save or switch files
- **Parameter sliders** -- export a `params` object and get interactive sliders
- **Multi-file assemblies** -- import parts from other files, render with per-part colors
- **STEP + STL export** -- manufacturing-ready output from toolbar buttons
- **Section view** -- clip plane to inspect internal geometry
- **Click-to-measure** -- click two points to measure distance
- **Dimension overlay** -- bounding box X/Y/Z measurements
- **AI integration** -- MCP server with tools for Claude Code to create and verify shapes

## Quick Start

### Install from source

```bash
git clone https://github.com/asbis/ShapeItUp.git
cd ShapeItUp
pnpm install
pnpm build
```

Then press **F5** in VS Code to launch the Extension Development Host.

### Your first shape

Create a file called `my-part.shape.ts`:

```typescript
import { drawRectangle, sketchCircle } from "replicad";

export default function main() {
  const box = drawRectangle(60, 40).sketchOnPlane("XY").extrude(20);
  const hole = sketchCircle(8).extrude(20);
  return box.cut(hole).fillet(2);
}
```

The 3D preview appears automatically in the side panel.

### With parameter sliders

```typescript
import { drawRoundedRectangle } from "replicad";

export const params = {
  width: 80,
  height: 50,
  depth: 30,
  wall: 2,
};

export default function main({ width, height, depth, wall }: typeof params) {
  const outer = drawRoundedRectangle(width, height, 5).sketchOnPlane("XY").extrude(depth);
  const inner = drawRoundedRectangle(width - wall*2, height - wall*2, 3)
    .sketchOnPlane("XY", [0, 0, wall]).extrude(depth);
  return outer.cut(inner);
}
```

Sliders appear in the side panel -- drag them to adjust dimensions live.

### Multi-file assemblies

```typescript
// bolt.shape.ts
import { sketchCircle, drawPolysides } from "replicad";

export function makeBolt(diameter = 8, length = 30) {
  const head = drawPolysides(diameter * 0.9, 6).sketchOnPlane("XY").extrude(5);
  const shaft = sketchCircle(diameter / 2).extrude(length).translateZ(-length);
  return head.fuse(shaft);
}

export default function main() { return makeBolt(); }
```

```typescript
// assembly.shape.ts
import { makeBolt } from "./bolt.shape";
import { makePlate } from "./plate.shape";

export default function main() {
  return [
    { shape: makePlate(), name: "plate", color: "#8899aa" },
    { shape: makeBolt().translate(20, 10, 5), name: "bolt", color: "#aa8855" },
  ];
}
```

## Viewer Controls

| Button | Action |
|--------|--------|
| **Fit** | Reset camera to fit model |
| **Edges** / **Wire** | Toggle edge lines / wireframe |
| **Dims** | Show bounding box dimensions |
| **Section** | Cross-section clip plane |
| **Measure** | Click two points to measure distance |
| **Join** / **Cut** / **Intersect** | Combine two bodies |
| **Move** / **Rotate** | Position a body with a drag handle |
| **Export** | STEP, STL, 3MF |

**Navigation:** Left-click drag = orbit, Right-click drag = pan, Scroll = zoom

**ViewCube:** The cube in the bottom-right corner turns with the model. Click a
face for the orthogonal view, an edge for the 45° between two, a corner for an
isometric — drag it to orbit, or press the house to go home. Keys `1`–`7` do the
six sides and the iso.

**Parts panel:** Click the hamburger menu to toggle. Expand a body for its
volume, surface area and centre of mass; the eye shows and hides it.

## Editing in the viewport

The viewer is a way of writing the file, not a second source of truth. Every
direct-manipulation command produces a code edit you can read, review and undo —
nothing is stored in hidden state, and the `.shape.ts` stays the only
description of the model.

- **Click a face** (or a single edge) to arm **Extrude**, **Fillet** or
  **Chamfer**, then drag the arrow to size it. The model updates live as you
  drag; blue shows material being added, red material being removed.
- The selectors that get written are **parameterised where the geometry proves
  which parameter it is** — `inPlane("XY", thickness)`, not `inPlane("XY", 8)` —
  so the feature survives you moving a slider. Where it can't prove one, it says
  so instead of writing something brittle.
- **Fillet and chamfer limits are measured against OpenCascade**, not guessed,
  so dragging cannot land on a radius the kernel refuses.
- **Join / Cut / Intersect** two bodies, with a per-tool warning when one of
  them does not actually touch the target.
- **Move / Rotate** a body with a Fusion-style triad, with **Copy** to leave the
  original in place. Rotation pivots are written as expressions
  (`shape.boundingBox.center`), never as frozen coordinates.

Nothing is written until you press **Apply**.

## AI Integration (Claude Code)

ShapeItUp includes an MCP server that gives Claude Code tools to create and verify CAD models.

### Setup

Add to your `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "shapeitup": {
      "command": "node",
      "args": ["/path/to/ShapeItUp/packages/mcp-server/dist/index.js"]
    }
  }
}
```

Copy the skill file for API reference:

```bash
cp skill/SKILL.md ~/.claude/commands/shapeitup.md
```

### MCP Tools

| Tool | Description |
|------|-------------|
| `create_shape` | Create a new `.shape.ts` file |
| `modify_shape` | Update an existing shape file |
| `read_shape` | Read shape file contents |
| `list_shapes` | Find all `.shape.ts` files |
| `validate_script` | Check TypeScript syntax |
| `render_preview` | Capture screenshot with dimensions (AI self-review) |
| `set_render_mode` | Switch between dark and high-contrast AI mode |
| `toggle_dimensions` | Show/hide dimension overlay |
| `get_api_reference` | Get Replicad API docs by category |

### Prompting Guide

The `/shapeitup` skill loads the full Replicad API reference. Use it when asking Claude to create shapes.

**Good prompts:**

```
/shapeitup
Create an enclosure for a Raspberry Pi 4. It should be 90x65x30mm with 2mm walls,
rounded corners, 4 screw holes in the corners, and cutouts for USB-C, micro HDMI,
and the GPIO header.
```

```
/shapeitup
Make a parametric L-bracket. I need parameters for width, height, thickness,
and hole diameter. Add 3 mounting holes.
```

```
Create a bolt.shape.ts with a hex head bolt generator function,
then create assembly.shape.ts that uses 4 bolts on a mounting plate.
```

**Tips for better results:**
- Specify dimensions in millimeters
- Mention wall thickness for enclosures
- Ask for `export const params = {...}` to get sliders
- Ask Claude to use `render_preview` to verify its work
- For assemblies, ask for named colored parts

## Architecture

```
Extension Host (Node.js)     Webview (Browser)           Web Worker (Browser)
+-------------------+        +------------------+        +------------------+
| File watcher      | -----> | Three.js viewer  | -----> | OCCT WASM        |
| esbuild bundler   |        | Orbit controls   |        | Replicad         |
| Export to disk    | <----- | Edge rendering   | <----- | Script execution |
| MCP bridge        |        | Params sliders   |        | Tessellation     |
+-------------------+        +------------------+        +------------------+
```

- **Replicad** -- TypeScript CAD library wrapping OpenCascade (OCCT) compiled to WASM
- **Three.js** -- 3D rendering in a VS Code webview
- **esbuild** -- bundles `.shape.ts` files with local imports resolved
- **MCP SDK** -- stdio-based MCP server for AI tool integration

## File Formats

| Format | Use Case |
|--------|----------|
| **STEP** (.step) | CNC machining, injection molding -- exact B-Rep geometry |
| **STL** (.stl) | 3D printing -- triangle mesh |

## Requirements

- **VS Code** 1.95+
- **Node.js** 18+ (for building)
- **pnpm** (for package management)

## Development

```bash
pnpm install
pnpm dev          # watch mode -- rebuilds on changes
# Press F5 to launch Extension Development Host
```

## Project Structure

```
ShapeItUp/
  packages/
    extension/    -- VS Code extension host
    viewer/       -- Three.js 3D viewer (webview)
    worker/       -- OCCT WASM + Replicad (web worker)
    mcp-server/   -- Claude Code MCP server
    shared/       -- Shared types and messages
  examples/       -- Example .shape.ts files
  skill/          -- Claude Code skill (API reference)
```

## License

MIT
