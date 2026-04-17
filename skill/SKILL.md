---
name: shapeitup
description: Create and modify 3D CAD models using Replicad TypeScript API in ShapeItUp
globs: ["**/*.shape.ts"]
---

# ShapeItUp — Replicad CAD Scripting Reference

This skill gives you breadth: what to call, when, how. For depth (full signatures, more examples) call `get_api_reference({ category, search?, signaturesOnly? })`.

## Contents

- [AI Workflow (decision tree)](#ai-workflow)
- [Available MCP Tools](#available-mcp-tools)
- [Top Best Practices](#top-best-practices)
- [File Convention](#file-convention)
- [Core Concepts](#core-concepts)
- [draw\* vs sketch\*](#draw-vs-sketch)
- [Drawing API (2D)](#drawing-api-2d)
- [Sketching (2D → 3D-ready)](#sketching-2d--3d-ready)
- [3D Solid Operations](#3d-solid-operations)
- [Boolean Operations](#boolean-operations)
- [Organic / Sculptural Shapes](#organic--sculptural-shapes)
- [Shape Modifications](#shape-modifications)
- [Transformations](#transformations)
- [Finders](#finders)
- [Memory Management](#memory-management)
- [Multi-File & Assemblies](#multi-file--assemblies)
- [Export Decision Table](#export-decision-table)
- [Complete Examples](#complete-examples)

---

## AI Workflow

Start with `create_shape` (or `modify_shape`) — the status from that call tells you whether the render succeeded and returns every stat you need. Branch based on what came back:

- Render succeeded
  - Need visual check → `render_preview` (returns PNG path; Read the file to see it)
  - Need dims/volume/mass only → use the stats already in the `create_shape`/`modify_shape` response (or `get_render_status`). No screenshot needed.
  - Exploring a parameter range (target volume, fit tolerance, bbox) → `tune_params` (ephemeral overrides, doesn't touch the file) until happy, then `modify_shape` with the winning value
  - Multi-part assembly → `check_collisions` to confirm parts don't overlap unintentionally
  - Trying a variant without touching the file → `preview_shape` (one-shot snippet, deleted after run; pass `workingDir` if the snippet uses local `./foo.shape` imports)
  - Ready to ship → `export_shape` (STEP for CAD/CAM, STL per part for 3D-print)
- Render failed
  - TRUST the `Hint:` line in the error response — it's a one-shot pattern-matched suggestion (fillet-too-large, revolve axis in profile, loft-consumed sketch, etc.). Apply it first before deeper debugging.
  - Also check `warnings[]` in the status — non-fatal lints fire even on success.
  - `validate_script({ code })` catches common pitfalls (sketch-mischain, missing `.sketchOnPlane`, unclosed pen, non-uniform scale, oversized fillet, booleans-in-loop) without executing.
- About to fillet / chamfer / shell with a complex finder expression
  - `preview_finder({ filePath, finder })` first — it reports how many edges/faces matched and paints pink spheres in the viewer. Saves guessing.
- Need API depth
  - `get_api_reference({ search: "sweep" })` — searches across all categories.
  - `get_api_reference({ category: "finders", signaturesOnly: true })` — compact dump.
- Sandbox can't read `shapeitup-previews/` (gitignored path)
  - `get_preview` returns the latest PNG as inline base64 in the tool response.

---

## Available MCP Tools

All 19 tools. Dense reference — use this table to find the right tool fast.

| Tool | Purpose | Key args |
|------|---------|----------|
| `create_shape` | Create new `.shape.ts` and execute | `name`, `code`, `directory?`, `overwrite?` |
| `modify_shape` | Overwrite existing `.shape.ts` and execute | `filePath`, `code` |
| `read_shape` | Read file contents | `filePath` |
| `open_shape` | Execute an existing file, bring up in viewer | `filePath` |
| `delete_shape` | Delete a `.shape.ts` file | `filePath` |
| `list_shapes` | Find all `.shape.ts` files | `directory?`, `recursive?` |
| `validate_script` | Syntax + 6 semantic lints (no execution) | `code` |
| `preview_shape` | Execute a snippet WITHOUT writing to workspace | `code`, `workingDir?`, `captureScreenshot?`, `focusPart?`, `hideParts?` |
| `tune_params` | Re-run with ephemeral param overrides, file untouched | `filePath`, `params`, `captureScreenshot?` |
| `get_render_status` | Last run's stats (volume, area, CoM, bbox, mass, per-part) | — |
| `render_preview` | PNG screenshot of current shape | `filePath?`, `cameraAngle?`, `renderMode?`, `showDimensions?`, `showAxes?`, `width?`, `height?`, `timeoutMs?`, `finder?`, `partName?`, `partIndex?`, `focusPart?`, `hideParts?` |
| `get_preview` | Return latest PNG as inline base64 (no Read needed) | `filePath?`, `cameraAngle?` |
| `set_render_mode` | Switch live viewer ai/dark (UI only) | `mode` |
| `toggle_dimensions` | Show/hide dims on live viewer (UI only) | `show?` |
| `preview_finder` | Count + locate edge/face matches; pink-sphere preview in viewer | `filePath`, `finder`, `partName?`, `partIndex?` |
| `check_collisions` | Pairwise part intersection test on assemblies | `filePath`, `tolerance?` |
| `export_shape` | Export to STEP or STL; optional single-part | `format`, `filePath?`, `outputPath?`, `partName?`, `openIn?` |
| `list_installed_apps` | Detect PrusaSlicer/Cura/FreeCAD/Fusion360/etc. | — |
| `get_api_reference` | Replicad docs; omit category to list; `search` to grep | `category?`, `search?`, `signaturesOnly?` |

---

## Top Best Practices

1. **Always `export const params = { ... }`** so the user gets live sliders and `tune_params` works.
2. **Add `export const material = { density, name }`** (g/cm³) — `get_render_status` then returns mass per part. Common densities: steel 7.85, aluminum 2.70, brass 8.40, ABS 1.05, PLA 1.24, PETG 1.27, wood ~0.7, water 1.0.
3. **Use `tune_params` to scan values** before committing with `modify_shape` — binary-search fit tolerance, target volume, target mass without touching the file.
4. **Trust the `Hint:` line** on render failures — it's operation-specific and usually correct.
5. **Preview finders before applying them** — `preview_finder({ filePath, finder })` catches zero-match or over-match selections before a fillet/chamfer/shell crashes.
6. **Apply fillets BEFORE boolean cuts.** Cuts fragment edges into tiny segments that OCCT can't fillet. See [Fillet safety](#fillet-safety).
7. **Prefer 2D booleans over 3D** — `drawing.fuse / cut / intersect` then a single `.extrude()` is far more robust than many 3D booleans.

---

## File Convention

Every shape file uses `.shape.ts` and exports a default `main()` that returns a `Shape3D` (or an array of `{ shape, name, color }`).

### With parameters (preferred)

```typescript
import { drawRoundedRectangle } from "replicad";

export const params = { width: 80, height: 50, depth: 30, wall: 2, cornerRadius: 5 };
export const material = { density: 7.85, name: "steel" }; // g/cm³

export default function main({ width, height, depth, wall, cornerRadius }: typeof params) {
  const outer = drawRoundedRectangle(width, height, cornerRadius)
    .sketchOnPlane("XY").extrude(depth);
  const inner = drawRoundedRectangle(width - wall*2, height - wall*2, cornerRadius - wall)
    .sketchOnPlane("XY", [0, 0, wall]).extrude(depth);
  return outer.cut(inner);
}
```

### Minimal (no params)

```typescript
import { drawRectangle } from "replicad";
export default function main() {
  return drawRectangle(50, 30).sketchOnPlane("XY").extrude(10);
}
```

### Multi-part assembly

```typescript
return [
  { shape: base,   name: "base",   color: "#8899aa" },
  { shape: bolt,   name: "bolt",   color: "#aa8855" },
];
```

Each part gets its own color in the viewer and becomes a named component in STEP files. Per-part stats (volume, surface area, CoM, bbox, mass) are returned by `get_render_status`.

---

## Core Concepts

- **Flow**: Drawing (2D) → Sketch (placed on a plane) → Shape3D (extruded/revolved/lofted/swept).
- **Units**: millimeters.
- **Axes**: X right, Y forward, Z up.
- **Planes**: `"XY"` (top), `"XZ"` (front), `"YZ"` (right). Prefix with `-` to flip normal.
- **`sketchOnPlane(plane, origin?)` origin semantics**: `origin` is an offset in WORLD coordinates, NOT plane-local. `sketchOnPlane("XY", [0, 0, 20])` raises the sketch to Z=20. `sketchOnPlane("XZ", [10, 0, 0])` shifts it along world X.

---

## draw\* vs sketch\*

Pitfall at the top: **`sketch*` functions already return a Sketch — do NOT chain `.sketchOnPlane()` on them.**

| Family | Returns | Next step |
|--------|---------|-----------|
| `drawCircle`, `drawRectangle`, `drawRoundedRectangle`, `drawEllipse`, `drawPolysides`, `drawText`, `draw()` | Drawing (2D, no plane yet) | `.sketchOnPlane(plane, origin?)` then `.extrude()` / `.revolve()` |
| `sketchCircle`, `sketchRectangle` | Sketch (already on a plane via `config`) | Directly `.extrude()` / `.revolve()` |

Use `draw*` when you need 2D ops first (`.fuse`, `.cut`, `.offset`). Use `sketch*` for a one-liner primitive on a plane.

---

## Drawing API (2D)

Signatures only — full reference: `get_api_reference({ category: "drawing" })`.

| Function | Description |
|----------|-------------|
| `draw(origin?)` | Freeform 2D pen-builder (returns DrawingPen) |
| `drawRectangle(w, h)` | Rectangle centered at origin |
| `drawRoundedRectangle(w, h, r)` | Rounded rectangle |
| `drawCircle(r)` | Circle |
| `drawEllipse(majorR, minorR)` | Ellipse (majorR along X) |
| `drawPolysides(radius, nSides)` | Regular polygon |
| `drawText(text, config?)` | Text outline |

**DrawingPen** (pitfall: a pen chain MUST end with `.close()`, `.closeWithMirror()`, or `.done()` before `.sketchOnPlane()` / `.extrude()`): lines (`lineTo`, `line`, `vLine`, `hLine`, `polarLine`), arcs (`sagittaArcTo`, `tangentArcTo`, `threePointsArcTo`), curves (`cubicBezierCurveTo`, `smoothSplineTo`), closing (`close`, `closeWithMirror`, `done`).

**2D booleans** (prefer over 3D): `drawing.fuse(other)`, `.cut(other)`, `.intersect(other)`, `.offset(d)`, `.translate(dx,dy)`, `.rotate(deg)`, `.mirror(axis)`.

---

## Sketching (2D → 3D-ready)

```typescript
drawRectangle(50, 30).sketchOnPlane("XY");              // on top
drawCircle(10).sketchOnPlane("XY", [0, 0, 20]);         // raised to Z=20 (world coords)
sketchCircle(10, { plane: "XY" });                       // one-liner; already a Sketch
new Sketcher("XZ").hLine(20).vLine(10).hLine(-20).close(); // freeform
```

---

## 3D Solid Operations

Pitfall at the top: **`loftWith` CONSUMES its input sketches.** If you need a profile after lofting, recreate it fresh — don't reuse the variable.

### From a sketch

| Method | Notes |
|--------|-------|
| `sketch.extrude(distance, { extrusionDirection?, twistAngle? })` | Linear |
| `sketch.revolve(axis?, { origin?, angle? })` | Angle in **degrees**, not radians |
| `sketch.loftWith(otherSketches, { ruled?, startPoint?, endPoint? })` | Profiles with similar topology (same segment counts) loft cleanly |
| `sketch.sweepSketch((plane, origin) => Sketch, { frenet?, transitionMode? })` | Sweep along an open-wire path; set `frenet: true` for 3D curves |

### Primitive solids

```typescript
makeCylinder(radius, height, location?, direction?)
makeSphere(radius)
makeBox([0,0,0], [10,20,30])
makeEllipsoid(rx, ry, rz)   // independent semi-axes — use this instead of non-uniform scale
```

### Sweep example

```typescript
import { draw, sketchCircle } from "replicad";
export default function main() {
  const path = draw()
    .cubicBezierCurveTo([0, 40], [20, 10], [-10, 30])
    .done()                // open wire for sweeps — .done(), not .close()
    .sketchOnPlane("XZ");
  return path.sweepSketch((plane, origin) => sketchCircle(3, { plane, origin }), { frenet: true });
}
```

---

## Boolean Operations

```typescript
shape.fuse(other)        // union
shape.cut(tool)          // subtraction
shape.intersect(other)   // intersection — FRAGILE on curved solids
```

- `fuse` and `cut` are reliable on most geometry.
- `intersect` on two complex curved solids (bezier extrusions, spline surfaces) may return empty or wrong geometry silently. Prefer 2D `drawing.intersect` when possible.
- If 3D `intersect` fails, use the **mold-cut workaround** — see [Organic Shapes](#organic--sculptural-shapes).
- Booleans inside a `for` loop are slow. Combine in 2D first (one `drawing.fuse` chain), then a single `.extrude()`.

---

## Organic / Sculptural Shapes

For curved / organic geometry (animals, figurines, ergonomic grips): **do NOT extrude-then-fillet a complex bezier profile.** Extruding makes a flat slab; filleting complex geometry crashes OCCT.

Approaches in order of reliability:

**1. Sweep a cross-section along a path** (best for tube-like forms)

```typescript
const spine = draw()
  .cubicBezierCurveTo([0, 40], [15, 10], [-5, 30])
  .cubicBezierCurveTo([5, 60], [10, 45], [5, 55])
  .done()
  .sketchOnPlane("XZ");
return spine.sweepSketch((plane, origin) => sketchCircle(5, { plane, origin }), { frenet: true });
```

**2. Loft between cross-sections** (best for shapes varying in cross-section)

```typescript
const bottom = drawCircle(15).sketchOnPlane("XY");
const middle = drawEllipse(20, 12).sketchOnPlane("XY", [0, 0, 20]);
const top    = drawCircle(8).sketchOnPlane("XY", [0, 0, 40]);
return bottom.loftWith([middle, top], { ruled: false });
```

**3. Revolve a profile** (rotationally symmetric)

```typescript
const profile = draw().vLine(30).smoothSplineTo([10, 20]).smoothSplineTo([5, 10]).smoothSplineTo([8, 0]).close();
return profile.sketchOnPlane("XZ").revolve();
```

**4. Mold-cut workaround** (when 3D `intersect()` fails on curves)

```typescript
// Build an "inverse mold" around the target volume, then cut it from the raw shape.
const mold = makeBox([-50,-50,-50], [50,50,50]).cut(makeEllipsoid(25, 15, 30));
const shaped = rawShape.cut(mold);  // removes everything outside the ellipsoid
```

**Avoid**: extruding a bezier then trying to fillet flat faces; `intersect()` between two complex curved solids; non-uniform `.scale()` (doesn't exist — scale takes one number).

---

## Shape Modifications

<a id="fillet-safety"></a>
**Fillet safety (read before calling fillet on anything non-trivial):**
- Apply fillets BEFORE boolean cuts. Cuts create tiny edge fragments that crash OCCT.
- Use a filter when you can: `.fillet(r, e => e.inDirection("Z"))` beats all-edges.
- Keep radii small on complex geometry (0.3–0.5 mm).
- Wrap in try/catch so the whole script doesn't die: `try { shape = shape.fillet(0.5); } catch { /* skip */ }`.
- If it still fails: reduce radius, select fewer edges, move the fillet earlier in the pipeline, or run `validate_script` — it flags radii above half the smallest observed dimension.

```typescript
shape.fillet(2)                                    // all edges
shape.fillet(2, e => e.inDirection("Z"))           // filtered
shape.chamfer(1, e => e.inPlane("XY", 0))          // similar API
shape.shell({ thickness: 2, filter: f => f.inPlane("XY", height) })
shape.draft(angleDeg, faceFinder, neutralPlane?)
```

---

## Transformations

All return a new shape.

```typescript
shape.translate(x, y, z)
shape.translateX(d) / translateY(d) / translateZ(d)
shape.rotate(angleDeg, position?, direction?)
shape.mirror(plane?, origin?)
shape.scale(factor, center?)   // UNIFORM only — one number
```

`scale()` is uniform-only (OpenCascade constraint — no `scaleNonUniform` exists). To stretch non-uniformly:
- Parameterize the dimensions (`drawRectangle(W, H)` with W and H as separate params, then use `tune_params`).
- Work in 2D first (Drawings are planar — X/Y transforms happen before extrude; Z comes from extrude distance).
- Use `makeEllipsoid(rx, ry, rz)` for ellipsoidal bodies (three independent semi-axes).
- For organic stretching, loft between differently-sized ellipse profiles at different heights.

---

## Finders

Signatures only — full reference: `get_api_reference({ category: "finders" })`. Run `preview_finder` BEFORE applying a fillet/chamfer/shell you're not sure of.

### EdgeFinder (for fillet / chamfer)

```typescript
e => e.inDirection("Z")             // edges along Z
e => e.inPlane("XY", offset?)       // edges in a plane
e => e.ofLength(20)                 // exact length
e => e.ofCurveType("CIRCLE")
e => e.parallelTo("XY")
e => e.containsPoint([x, y, z])
e => e.atDistance(d, point?)
```

### FaceFinder (for shell / draft)

```typescript
f => f.inPlane("XY", 10)
f => f.parallelTo("XZ")
f => f.ofSurfaceType("PLANE")
f => f.containsPoint([x, y, z])
```

### Combining

```typescript
e.inDirection("Z").and(e2 => e2.atDistance(5, [0,0,0]))
e.inDirection("X").or(e2 => e2.inDirection("Y"))
e.not(e2 => e2.inPlane("XY"))
```

### `highlightFinder` (injected into every script, no import)

```typescript
import { drawRoundedRectangle, EdgeFinder } from "replicad";
export default function main() {
  const box = drawRoundedRectangle(80, 50, 5).sketchOnPlane("XY").extrude(20);
  // Preview: pink spheres on matched edges.
  return highlightFinder(box, new EdgeFinder().inDirection("Z"));
  // Swap for the real op once the selection looks right:
  // return box.fillet(3, e => e.inDirection("Z"));
}
```

Options: `{ color?, shapeColor?, radius? }`. Works with both EdgeFinder and FaceFinder. Prefer the `preview_finder` MCP tool when you don't want to edit the file.

---

## Memory Management

For scripts with many intermediate shapes:

```typescript
import { localGC } from "replicad";
export default function main() {
  const [r, gc] = localGC();
  const base = r(drawRectangle(100, 60).sketchOnPlane("XY").extrude(10));
  // ... many ops, wrap intermediates with r() ...
  const result = base.fillet(2);
  gc();
  return result;
}
```

---

## Multi-File & Assemblies

### Importing between shape files

`main()` is only invoked when a file is the top-level shape — it's NOT imported. Export named factory functions for reuse. If you see `No matching export in "x.shape.ts" for import "makeX"`, you're trying to import something that's only reachable via `main()`'s return value.

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
export default function main() {
  return [makeBolt(8, 20).translate(10, 0, 0), makeBolt(8, 20).translate(-10, 0, 0)];
}
```

### `main()` return types

- Single shape: `return shape;`
- Array (auto-colored): `return [shape1, shape2];`
- Array with metadata: `return [{ shape, name, color }, ...];`

### Assemblies: check for collisions

For multi-part designs where parts should fit together without overlapping, call `check_collisions({ filePath })` — pairwise intersection test with AABB prefilter.

### `preview_shape` with local imports

`preview_shape` runs a snippet without writing it to the workspace. By default the temp file lives in isolated globalStorage — `./foo.shape` imports won't resolve. Pass `workingDir: "."` (or the workspace root absolute path) to make the snippet's relative imports work.

---

## Export Decision Table

`export_shape` signature: `{ format, filePath?, outputPath?, partName?, openIn? }`.

| Format | `partName`? | Use for |
|--------|-------------|---------|
| `"step"` | omit | CAD/CAM workflow — STEP preserves all named components in one structured file (send the whole assembly to FreeCAD/Fusion360) |
| `"stl"` | per part | 3D printing — one STL per printable part, each oriented independently on the build plate (STL can't carry multi-part structure) |
| `"stl"` | omit | Single-part print, or a pre-merged assembly where all parts share orientation |

Example — enclosure with case/lid/bracket for 3D printing:

```text
export_shape({ filePath: "enclosure.shape.ts", format: "stl", partName: "case" })
export_shape({ filePath: "enclosure.shape.ts", format: "stl", partName: "lid" })
export_shape({ filePath: "enclosure.shape.ts", format: "stl", partName: "bracket" })
// → enclosure.case.stl, enclosure.lid.stl, enclosure.bracket.stl
```

`openIn` launches the export in a detected app (`prusaslicer`, `cura`, `bambustudio`, `orcaslicer`, `freecad`, `fusion360`). Call `list_installed_apps` first to see what's available on the user's machine.

---

## Complete Examples

### Box with center hole and fillets

```typescript
import { drawRectangle, sketchCircle } from "replicad";
export default function main() {
  let box = drawRectangle(60, 40).sketchOnPlane("XY").extrude(20);
  box = box.fillet(2);                   // BEFORE cutting
  const hole = sketchCircle(8).extrude(20);
  return box.cut(hole);
}
```

### L-bracket with mounting holes

```typescript
import { draw, makeCylinder } from "replicad";
export default function main() {
  const profile = draw().hLine(60).vLine(5).hLine(-55).vLine(35).hLine(-5).close();
  let bracket = profile.sketchOnPlane("XZ").extrude(30);
  const h1 = makeCylinder(3, 30, [45, 0, 2.5], [0, 1, 0]);
  const h2 = makeCylinder(3, 30, [15, 0, 2.5], [0, 1, 0]);
  const h3 = makeCylinder(3, 30, [2.5, 0, 25], [0, 1, 0]);
  bracket = bracket.cut(h1).cut(h2).cut(h3);
  return bracket.fillet(2, e => e.inDirection("Y"));
}
```

### Flanged cylinder (bottle shape)

```typescript
import { sketchCircle } from "replicad";
export default function main() {
  const base = sketchCircle(30).extrude(5);
  const body = sketchCircle(15).extrude(50).translateZ(5);
  let shape = base.fuse(body).fillet(3);  // fillet BEFORE cutting interior
  const interior = sketchCircle(12).extrude(52);
  return shape.cut(interior);
}
```

### Enclosure shell

```typescript
import { drawRoundedRectangle } from "replicad";
export default function main() {
  const outer = drawRoundedRectangle(80, 50, 5).sketchOnPlane("XY").extrude(30);
  const inner = drawRoundedRectangle(76, 46, 3).sketchOnPlane("XY", [0, 0, 2]).extrude(30);
  return outer.cut(inner);
}
```

### Organic vase (loft between profiles)

```typescript
import { drawCircle, drawEllipse } from "replicad";
export const params = { baseR: 20, midR: 25, neckR: 10, topR: 12, height: 60 };
export default function main({ baseR, midR, neckR, topR, height }: typeof params) {
  const base  = drawCircle(baseR).sketchOnPlane("XY");
  const belly = drawEllipse(midR, midR * 0.8).sketchOnPlane("XY", [0, 0, height * 0.4]);
  const neck  = drawCircle(neckR).sketchOnPlane("XY", [0, 0, height * 0.75]);
  const top   = drawCircle(topR).sketchOnPlane("XY", [0, 0, height]);
  return base.loftWith([belly, neck, top], { ruled: false })
    .shell({ thickness: 2, filter: (f: any) => f.inPlane("XY", height) });
}
```

### Swept tube (sweep along bezier)

```typescript
import { draw, sketchCircle } from "replicad";
export const params = { radius: 4, height: 50 };
export default function main({ radius, height }: typeof params) {
  const path = draw()
    .cubicBezierCurveTo([15, height * 0.5], [0, height * 0.2], [20, height * 0.3])
    .cubicBezierCurveTo([0, height], [-10, height * 0.7], [0, height * 0.9])
    .done()
    .sketchOnPlane("XZ");
  return path.sweepSketch((plane, origin) => sketchCircle(radius, { plane, origin }), { frenet: true });
}
```

### Wheel with spoke slots

```typescript
import { sketchCircle, drawRectangle } from "replicad";
export default function main() {
  const disc = sketchCircle(40).extrude(8);
  const hub  = sketchCircle(10).extrude(15);
  const axleHole = sketchCircle(5).extrude(15);
  let wheel = disc.fuse(hub).cut(axleHole);
  for (let i = 0; i < 6; i++) {
    const angle = (i * 60 * Math.PI) / 180;
    const slot = drawRectangle(12, 5)
      .sketchOnPlane("XY")
      .extrude(8)
      .translate(Math.cos(angle) * 25, Math.sin(angle) * 25, 0)
      .rotate(i * 60, [0, 0, 0], [0, 0, 1]);
    wheel = wheel.cut(slot);
  }
  return wheel.fillet(1);
}
```

---

## ShapeItUp stdlib — `import from "shapeitup"`

Mechanical / 3D-printing helpers layered on top of Replicad. **Use these instead of re-deriving standards dimensions by hand** — you'll get correct ISO/DIN sizes, consistent orientation, and FDM-tuned fits on the first try.

```typescript
import { holes, screws, nuts, washers, inserts, bearings, extrusions, printHints } from "shapeitup";
```

**Cut-tool orientation convention** — every hole/seat/pocket helper returns a Shape3D with axis +Z, top at Z=0, extending into -Z. Translate it to the target location, then `.cut()`:

```typescript
plate.cut(holes.counterbore("M3", { plateThickness: 4 }).translate(10, 10, 4))
// Note: Z = plate_thickness, so the pocket's top aligns with the plate's top face.
```

**Positive-shape convention** (screws, nuts, bearings bodies) — top at Z=0, body/shaft extends into -Z.

**Back-face cuts** — wrap a cut tool in `fromBack()` to flip it so it opens upward from Z=0. Useful for heat-set insert pockets / through-features on the bottom face of a plate whose underside sits at Z=0:

```typescript
import { inserts, fromBack } from "shapeitup";
plate.cut(fromBack(inserts.pocket("M3")).translate(x, y, 0))
```

**Shape3D type-narrowing** — replicad's `.extrude()` returns an overly-wide union. Wrap the chain in `shape3d()` instead of sprinkling `as Shape3D`:

```typescript
import { shape3d } from "shapeitup";
const plate = shape3d(drawRectangle(60, 40).sketchOnPlane("XY").extrude(5));
plate.cut(hole);  // OK
```

### holes — cut tools

```typescript
holes.through("M3", { depth?, fit? })                     // clearance hole; or raw number for plain cylinder
holes.counterbore("M3", { plateThickness, fit? })         // socket-head pocket + shaft
holes.countersink("M4", { plateThickness, fit? })         // 90° flat-head flare + shaft
holes.tapped("M3", { depth })                             // tap-drill sized
holes.teardrop("M3", { depth, axis?: "X" | "Y" })         // FDM-printable horizontal hole
holes.keyhole({ largeD, smallD, slot, depth })            // hang-on-screw mount
holes.slot({ length, width, depth })                      // elongated adjustment slot
```

`fit`: `"press" | "slip" | "clearance"` (default) `| "loose"`. For FDM, `clearance` is usually right.

### screws / nuts / washers / inserts — positive shapes

```typescript
screws.socketHead("M3x10")    // ISO 4762
screws.buttonHead("M4x8")     // ISO 7380 (head is a plain cylinder in v1)
screws.flatHead("M5x12")      // ISO 10642 — revolved cone head
nuts.hex("M3")                // DIN 934
washers.flat("M3")            // DIN 125
inserts.heatSet("M3")         // brass body — for visualization
inserts.pocket("M3")          // CUT-TOOL for the printed part's insert pocket
```

**For 3D printing**: print with `inserts.pocket`, melt in a brass heat-set insert, use `screws.socketHead` as the fastener. Don't model threaded holes — printed threads are unreliable.

### bearings — seats + visualizations

```typescript
bearings.seat("608", { throughHole?, depth? })   // press-fit ball-bearing pocket
bearings.body("608")                              // ring-shape for visualization
bearings.linearSeat("LM8UU")                      // linear-bearing pocket
bearings.linearBody("LM8UU")                      // linear-bearing outer shell
```

Ball: `623`, `624`, `625`, `626`, `608` (skate — most common), `6000`, `6001`, `6002`. Linear: `LM4UU`, `LM6UU`, `LM8UU`, `LM10UU`, `LM12UU`.

### extrusions — T-slot aluminum profiles

```typescript
extrusions.tSlot("2020", 200)         // 200mm length, extrudes +Z
extrusions.tSlotProfile("2020")       // 2D Drawing (cross-section)
extrusions.tSlotChannel("2020", 200)  // outer-envelope cut-tool (sliding bracket fits)
```

Profiles: `"2020"`, `"3030"`, `"4040"`. **v1 simplification**: quad-slot square with center hole, no internal T-cavity.

### patterns — arrays of placements + single-call apply

```typescript
patterns.polar(6, 20, { startAngle?: number, axis?: "X"|"Y"|"Z", orientOutward?: boolean })
patterns.grid(3, 4, 10, 15)                          // nx, ny, dx, dy? (default dy = dx)
patterns.linear(5, [10, 0, 0])                       // n, step vector

patterns.spread(makeShape, placements)               // fuse N copies (positive shape)
patterns.cutAt(target, makeTool, placements)         // subtract N copies (cut tool)
patterns.applyPlacement(shape, placement)            // low-level: apply a single placement
```

**Important:** `spread` and `cutAt` take a **factory** (`() => Shape3D`), not a shape. Replicad shares OCCT handles across `.translate()`/`.rotate()` calls — reusing one shape across multiple cuts invalidates earlier copies ("this object has been deleted"). The factory guarantees a fresh handle per placement.

Generators return `Placement[]` — plain data (`{ translate, rotate?, axis? }`) so you can filter, map, or combine them manually.

**Common patterns**:

```typescript
// Bolt circle: 6 × M4 counterbored on a 40mm PCD
flange = patterns.cutAt(
  flange,
  () => holes.counterbore("M4", { plateThickness: 5 }).translate(0, 0, 5),
  patterns.polar(6, 20),
);

// PCB standoffs: 2×2 grid of M3 heat-set pockets
plate = patterns.cutAt(
  plate,
  () => inserts.pocket("M3").translate(0, 0, thickness),
  patterns.grid(2, 2, 50, 40),
);

// Motor-mount corners: 4 holes at the corners of a rectangle
plate = patterns.cutAt(
  plate,
  () => holes.through("M3"),
  patterns.grid(2, 2, width - 2*inset, depth - 2*inset),
);
```

### printHints — FDM print-cleanliness

```typescript
printHints.elephantFootChamfer(shape, 0.4)     // chamfer bottom edges (default 0.4mm)
printHints.overhangChamfer(shape, 45)          // best-effort; warns + returns unchanged on complex geometry
printHints.firstLayerPad(shape, { padding?, thickness? })  // thin adhesion pad
```

### Worked example — plate with counterbored M3 mounting holes

```typescript
import { drawRoundedRectangle, type Shape3D } from "replicad";
import { holes } from "shapeitup";

export const params = { width: 60, depth: 40, thickness: 5 };

export default function main({ width, depth, thickness }: typeof params) {
  let plate = drawRoundedRectangle(width, depth, 3)
    .sketchOnPlane("XY").extrude(thickness) as Shape3D;

  const inset = 6;
  for (const [x, y] of [
    [-width/2 + inset, -depth/2 + inset],
    [ width/2 - inset, -depth/2 + inset],
    [-width/2 + inset,  depth/2 - inset],
    [ width/2 - inset,  depth/2 - inset],
  ] as [number, number][]) {
    const cb = holes.counterbore("M3", { plateThickness: thickness }).translate(x, y, thickness);
    plate = plate.cut(cb);
  }
  return plate;
}
```

See `examples/stdlib/` for more worked patterns: `mounting-plate`, `heatset-enclosure`, `teardrop-bracket`, `screw-gallery`, `bearing-block`, `extrusion-length`, `linear-rail-carriage`.
