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
- [Plane orientation (read this first)](#plane-orientation-read-this-first)
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

All 20 tools. Dense reference — use this table to find the right tool fast.

| Tool | Purpose | Key args |
|------|---------|----------|
| `setup_shape_project` | Bootstrap a folder with `.shape.ts` type stubs + tsconfig. **You usually don't need to call this — `create_shape` auto-bootstraps on first write.** Call explicitly only when editor import errors persist in a brand-new folder. Never runs `npm install` — replicad/OCCT are bundled inside the MCP server itself. | `directory` |
| `create_shape` | Create new `.shape.ts` and execute (auto-bootstraps types on first write) | `name`, `code`, `directory?`, `overwrite?` |
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

## Plane orientation (read this first)

The single most common first-time mistake in this library — wrong extrude direction. Memorize:

```
XY → extrudes +Z (up)
XZ → extrudes -Y (toward camera)
YZ → extrudes +X
```

No exceptions, no flags, no "it depends". To flip direction, use the reverse-named plane (`YX` → -Z, `ZX` → +Y, `ZY` → -X) or pass a negative extrude depth (`.extrude(-L)`). `sketchOnPlane("XZ", [0, 0, 20])`'s origin offset is in WORLD coordinates, so the `[0, 0, 20]` raises along world Z, NOT along the XZ plane's local axis.

### Pen axis mapping (`draw().hLine` / `.vLine`, `Sketcher`)

The 2D pen's horizontal axis (`hLine`, right movement) and vertical axis (`vLine`, up movement) map to different world axes depending on the plane. Read this table before sketching on anything other than XY.

```
Plane    pen h → world    pen v → world    extrudes
XY       +X               +Y               +Z
YX       +Y               +X               -Z
XZ       +X               +Z               -Y
ZX       +Z               +X               +Y
YZ       +Y               +Z               +X
ZY       +Z               +Y               -X
```

Concrete footgun: `draw().hLine(60).sketchOnPlane("ZX")` moves the pen 60 mm along **world Z**, not world X. If you expected `hLine` to walk along world X, you want plane `"XZ"` (where pen h → +X).

---

## Top Best Practices

1. **Always `export const params = { ... }`** so the user gets live sliders and `tune_params` works.
2. **Add `export const material = "PLA"`** (or any preset name) so `get_render_status` returns mass per part. Named presets: `"PLA"` (1.24), `"ABS"` (1.04), `"PETG"` (1.27), `"Nylon"` (1.15), `"Aluminum"` (2.70), `"Steel"` (7.85), `"Stainless"` (8.00), `"Brass"` (8.47), `"Titanium"` (4.50), `"Copper"` (8.96), `"Wood"` (0.60). Densities in g/cm³. For custom materials: `export const material = { density: 1.5, name: "custom" }`.
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
export const material = "Steel"; // or { density: 7.85, name: "custom" }

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
- **Planes**: see [Plane orientation](#plane-orientation-read-this-first) at the top of this doc — `"XY"` extrudes +Z, `"XZ"` extrudes **-Y** (toward camera), `"YZ"` extrudes +X. Reverse-named planes (`"YX"` / `"ZX"` / `"ZY"`) or a negative extrude depth flip the direction.
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
new Sketcher("XZ").hLine(20).vLine(10).hLine(-20).close(); // freeform; on XZ, hLine → world X, vLine → world Z (see Pen axis mapping)
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
shape.shell(2, f => f.inPlane("XY", height))       // positional form — callback OK
shape.shell({ thickness: 2, filter: new FaceFinder().inPlane("XY", height) })
shape.draft(angleDeg, faceFinder, neutralPlane?)
```

> `shell`'s callback form ONLY works positionally. The config-object form's `filter` must be a `FaceFinder` *instance* — passing a lambda there throws `filter.find is not a function`.

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

### Debugging finders when the script fails before the finder

If the script crashes at the very op you're trying to fix — say a fillet throws "no edge selected":

```typescript
// part.shape.ts — crashes: nothing matches this filter
return shape.fillet(3, e => e.inDirection("Y").containsPoint([4, 0, 4]));
```

then `preview_finder({ filePath })` can't help — the file blows up before the finder target exists. Pass an **inline `code` snippet** instead, with the failing op commented out so the shape renders up to the point you want to inspect:

```ts
preview_finder({
  code: `
    import { drawRectangle, EdgeFinder } from "replicad";
    export default function main() {
      const shape = drawRectangle(10, 10).sketchOnPlane("XY").extrude(8);
      // shape.fillet(3, e => e.inDirection("Y").containsPoint([4, 0, 4]));
      return shape;
    }
  `,
  finder: 'new EdgeFinder().inDirection("Y").containsPoint([4, 0, 4])',
});
```

The finder paints pink spheres at each match. Zero spheres means the filter didn't select anything — iterate on the predicate (loosen `containsPoint`, drop `inDirection`, try `ofLength`) until the count looks right, then re-enable the real fillet. Avoids re-running the whole CAD chain on every selector tweak.

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
    .shell(2, (f: any) => f.inPlane("XY", height));
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
import { holes, screws, bolts, washers, inserts, bearings, extrusions, printHints } from "shapeitup";
```

**Cut-tool orientation convention** — every hole/seat/pocket helper returns a Shape3D with axis +Z, top at Z=0, extending into -Z. Translate it to the target location, then `.cut()`:

```typescript
plate.cut(holes.counterbore("M3", { plateThickness: 4 }).translate(10, 10, 4))
// Note: Z = plate_thickness, so the pocket's top aligns with the plate's top face.
```

**Positive-shape convention** (screws, nuts, bearing bodies — where "nut" is `screws.nut`/`bolts.nut`, not a separate `nuts.*` namespace) — top at Z=0, body/shaft extends into -Z.

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
holes.through("M3", { depth?, fit?, axis? })              // clearance hole; or raw number for plain cylinder
holes.clearance("M3", { depth?, fit?, axis? })            // alias of `through` — same signature, common engineering term
holes.counterbore("M3", { plateThickness, fit?, axis? })  // socket-head pocket + shaft
holes.countersink("M4", { plateThickness, fit?, axis? })  // 90° flat-head flare + shaft
holes.tapped("M3", { depth, axis? })                      // tap-drill sized
holes.teardrop("M3", { depth, axis?: "+X" | "+Y" })       // FDM-printable horizontal hole (own +X/+Y axis set)
holes.keyhole({ largeD, smallD, slot, depth, axis? })     // hang-on-screw mount
holes.slot({ length, width, depth, axis? })               // elongated adjustment slot
```

`fit`: `"press" | "slip" | "clearance"` (default) `| "loose"`. For FDM, `clearance` is usually right.

Supported metric sizes: `M2`, `M2.5`, `M3`, `M4`, `M5`, `M6`, `M8`, `M10`, `M12`. (Not every table covers every size — button/flat-head start at M3; heat-set inserts stop at M5. Unknown sizes throw a readable `Unknown metric size` error listing what the table supports.)

**String vs. raw diameter are NOT equivalent.** `holes.through("M4", …)` applies an ISO 273 clearance fit (~4.5mm for the default `"clearance"` fit style); `holes.through(4, …)` cuts a literal 4mm hole. Common nominal sizes (3, 4, 5, 6, 8, 10, 12) are easily confused — prefer the string form unless you specifically need a raw dimension. The stdlib emits a runtime warning when a raw integer matches a nominal size; pass a non-integer (e.g. `4.0001`) to suppress the warning when the literal diameter is intentional.

`axis` (default `"+Z"`): one of `"+Z"` | `"-Z"` | `"+X"` | `"-X"` | `"+Y"` | `"-Y"`. **Axis names the face the hole OPENS ON** — the body penetrates in the OPPOSITE direction (into the material). So `axis: "+X"` means the hole's mouth sits on the part's +X face, and the cutter body extends in -X. Teardrop uses its own `"+X"`/`"+Y"` axis set (legacy `"X"`/`"Y"` still accepted) — its convention is different (see teardrop docstring).

Per-axis cutter geometry in the tool's local frame (before `.translate(...)`):

| `axis` | opening at | body spans | drill points |
|--------|------------|-----------|--------------|
| `"+Z"` (default) | Z = 0 | Z ∈ [-depth, 0] | -Z |
| `"-Z"`           | Z = 0 | Z ∈ [0, depth]  | +Z |
| `"+X"`           | X = 0 | X ∈ [-depth, 0] | -X |
| `"-X"`           | X = 0 | X ∈ [0, depth]  | +X |
| `"+Y"`           | Y = 0 | Y ∈ [-depth, 0] | -Y |
| `"-Y"`           | Y = 0 | Y ∈ [0, depth]  | +Y |

**Drilling into walls**: translate to the face you want the hole to ENTER through, then pick the axis of that face.

```typescript
// Vertical wall whose material occupies X ∈ [0, 5]. Drill a hole through it
// from the +X side: translate to X=5 (the wall's +X face), pick axis "+X".
wall.cut(holes.through("M5", { depth: 10, axis: "+X" }).translate(5, y, z))
//                                          ^^^ opens on +X face, body penetrates -X into wall

// Counterbore pocket on the +Y face of a flange at Y=thickness:
flange.cut(holes.counterbore("M4", { plateThickness: t, axis: "+Y" }).translate(x, t, z))

// Sideways adjustment slot: slot opens on the wall's +X face, pocket goes -X.
wall.cut(holes.slot({ length: 20, width: 5, depth: 4, axis: "+X" }).translate(5, y, z))
```

**Common mistake (pre-fix behavior)**: translating to the origin-side face (e.g. `translate(0, y, z)` with `axis: "+X"`) used to "work" because the body extended into +X. It now extends into -X and lands OUTSIDE the wall — you'll see the "cut produced no material removal" warning. Fix: translate to the wall's +X face coordinate, not X=0.

**Z-convention — every hole tool spans `Z ∈ [-depth, 0]`**: the hole's top (entry) face sits AT `Z=0` and the body extends DOWNWARD into `-Z`. To cut from the top of a plate whose upper face is at `Z = plateTop`, translate by `plateTop`:

```typescript
plate.cut(holes.through("M3", { depth: 10 }).translate(x, y, plateTop))
plate.cut(holes.counterbore("M3", { plateThickness: t }).translate(x, y, t))
```

Forgetting the Z translate leaves the cutter BELOW the plate and the boolean silently removes nothing. If you see a `patterns.cutAt` or `.cut()` "no material removal" warning, double-check the `.translate(0, 0, Z)` places the cutter INTO the plate, not above or below it. For cuts opening on the bottom face of a plate, wrap with `fromBack(...)` to flip the cutter into `+Z` — then translate to the bottom-face Z (usually 0).

### screws / bolts / washers / inserts — positive shapes

Two parallel namespaces for fasteners, same method names. Pick by intent:

- `screws.*` — **cosmetic**: plain cylinder shafts, B-Rep, fast, composable with any Shape3D operation. Use for layouts and assemblies.
- `bolts.*`  — **threaded**: real helical geometry. Use for STEP export and 3D-print previews. External fasteners return `Shape3D` (Compound, **not fuse-safe** — see note below); `bolts.nut` returns `MeshShape` (internal threads need the Manifold mesh kernel). Every external-bolt factory has a `*Mesh` twin that returns a fuse-safe `MeshShape`.

```typescript
screws.socket("M3x10")       // ISO 4762 cap screw, plain shaft
screws.button("M4x8")        // ISO 7380 button-head
screws.flat("M5x12")         // ISO 10642 countersunk
screws.hex("M6x20")          // ISO 4017 hex bolt, plain shaft
screws.nut("M3")             // DIN 934 hex nut, clean bore

bolts.socket("M3x10")        // threaded Compound — STEP-friendly, NOT fuse-safe
bolts.button("M4x8")
bolts.flat("M5x12")
bolts.hex("M6x20")
bolts.nut("M3")              // MeshShape — see note below

bolts.socketMesh("M3x10")    // threaded MeshShape — fuse-safe, use for bolt.fuse/cut
bolts.buttonMesh("M4x8")
bolts.flatMesh("M5x12")
bolts.hexMesh("M6x20")

washers.flat("M3")           // DIN 125 (no threads possible)
inserts.heatSet("M3")        // brass body — for visualization
inserts.pocket("M3")         // CUT-TOOL for the printed part's insert pocket
```

**Mixing mesh and B-Rep**: `bolts.nut(...)` is a MeshShape — you can't `plate.cut(nut)` directly if `plate` is Shape3D. Convert the plate first: `plate.meshShape({ tolerance: 0.01 }).cut(bolts.nut("M3"))`.

**For 3D printing**: print with `inserts.pocket`, melt in a brass heat-set insert, use `screws.socket` as the fastener. Modeled threads work but print badly under M5 — prefer heat-set inserts for small sizes.

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
patterns.cutTop(plate, makeTool, [x, y])             // single cut at the plate's top face
patterns.cutBottom(plate, makeTool, [x, y])          // single cut at the plate's bottom face
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

**`cutTop` / `cutBottom` — single-cut shorthand for plate-face features.** Infers the plate's top or bottom face Z from its bounding box, then translates the tool there. ONLY handles positioning — the tool's own depth (e.g. `counterbore`'s `plateThickness`) still lives in the factory:

```typescript
// Before (thickness t appears twice — easy to drift):
plate.cut(holes.counterbore("M3", { plateThickness: t }).translate(x, y, t))

// After:
plate = patterns.cutTop(plate, () => holes.counterbore("M3", { plateThickness: t }), [x, y]);

// Bottom-face heat-set pocket:
plate = patterns.cutBottom(plate, () => inserts.pocket("M3"), [x, y]);
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

## Parts + Joints — declarative assembly

For multi-part assemblies where bodies must mate face-to-face (motors onto plates, couplers onto shafts, bearings into pockets), the stdlib provides a joint-based assembly API. **Every part is built at its local origin**, declares named joints describing where it connects to other parts, and `assemble()` positions everything.

```typescript
import { part, faceAt, shaftAt, boreAt, mate, assemble, entries, cylinder } from "shapeitup";

const motor = part({
  shape: motorBody.fuse(shaft),
  name: "motor", color: "#2b2b2b",
  joints: {
    mountFace: faceAt(MOTOR_HEIGHT),                              // +Z face, role "face"
    shaftTip:  shaftAt(MOTOR_HEIGHT + 24, 5),                     // +Z shaft tip, Ø5, role "male"
  },
});

const plate = part({
  shape: plateShape,
  name: "plate", color: "#8899aa",
  joints: {
    motorFace: faceAt(0, { axis: "-Z" }),                         // bottom face
  },
});

const coupler = part({
  shape: couplerShape,
  name: "coupler", color: "#b5651d",
  joints: {
    motorEnd:     boreAt(COUPLER_MOTOR_BORE_DEPTH, 5),             // default axis -Z
    leadscrewEnd: boreAt(COUPLER_LENGTH, 8, { axis: "+Z" }),
  },
});

const positioned = assemble([motor, plate, coupler], [
  mate(motor.joints.mountFace,      plate.joints.motorFace),
  mate(motor.joints.shaftTip,       coupler.joints.motorEnd),
  mate(coupler.joints.leadscrewEnd, leadscrew.joints.bottom, { gap: 0.2 }),
]);

return entries(positioned);
```

### Joint shortcut helpers

All three accept `{ axis?, xy? }`. They encode the **"axis points outward from the part"** convention so you don't have to reason about +Z vs -Z per joint.

| Helper | Role | Default axis | Use for |
|---|---|---|---|
| `faceAt(z)` | `"face"` | `"+Z"` | Flat mounting faces |
| `shaftAt(z, d)` | `"male"` | `"+Z"` | Shaft tips, studs, protrusions |
| `boreAt(z, d)` | `"female"` | `"-Z"` | Bore mouths, pocket openings |

### mate() with pre-flight validation

`mate(a, b, { gap? })` throws at declaration time if:
- `a.role` and `b.role` are incompatible (male/female pair, face/face pair — no other combos)
- `a.diameter` and `b.diameter` differ by > 0.01mm

Catches wrong-size bolts + misaligned conventions before you render anything. `gap` adds axial clearance along the joint axis.

### assemble() — BFS graph resolver

`assemble(parts, mates)` picks `parts[0]` as the fixed root and walks the mate graph, positioning each reachable part. Unreachable parts are returned unchanged with a console.warn. `entries(positioned)` converts the result to the `{ shape, name, color }[]` format `main()` returns.

### When NOT to use joints

For simple coaxial stacks (4 cylinders pancaked on each other), `stackOnZ([parts], { gap? })` is a zero-ceremony alternative — it positions each part's bounding-box bottom on the previous part's top via pure geometry. No joint declarations needed. Use joints when you need role/diameter checking, non-Z axes, or want to expose named mating points for reuse.

### cylinder() — orientation-explicit alternative to makeCylinder

`makeCylinder(r, h, [base], [dir])` from replicad anchors at the base. The stdlib's `cylinder({ top?, bottom?, length, diameter, direction? })` wrapper matches the stdlib cut-tool convention (top-at-Z=0 style) and takes named args so the anchor is unambiguous.

```typescript
cylinder({ bottom: [0, 0, 0], length: 24, diameter: 5 })         // base at origin, extends +Z
cylinder({ top: [0, 0, 0], length: 10, diameter: 3 })            // top at origin, extends -Z
cylinder({ bottom: [0,0,0], length: 50, diameter: 8, direction: "+Y" })  // along +Y
```

See `examples/stdlib/leadscrew-assembly.shape.ts` for a full NEMA17 → coupler → leadscrew demo.

### Insertion mates — when a part nests INSIDE another

`mate()` positions parts so the moving part's joint origin lands at the fixed joint's origin (plus `gap`). For standard face-to-face stacks this is correct. When a part must **overlap** with the host (press-fit bearing in a pocket, dowel in a blind hole), declare the moving joint at the FAR END of the overlap region with axis pointing OUTWARD:

```typescript
// Bearing body — the part overlaps with a pocket cut into the plate. Build
// the bearing at origin with Z ∈ [0, bearingWidth]. The joint that mates
// with the pocket sits at the bearing's TOP, axis pointing back OUT of the
// pocket (same direction as the pocket mouth's outward axis).
const bearing = part({
  shape: bearings.body("608"),
  name: "bearing", color: "#c0c4c8",
  joints: {
    // bearing's "top" at z=width, axis -Z (opposite the pocket's +Z outward).
    pocketSeat: faceAt(BEARING_WIDTH, { axis: "-Z" }),
  },
});

// Plate's pocket joint — at the mouth, axis +Z (opens upward out of plate).
const plate = part({
  shape: plateWithPocket,
  name: "plate", color: "#8899aa",
  joints: {
    pocketMouth: faceAt(PLATE_THICKNESS),   // top face, +Z axis
  },
});

// Mate: bearing slides INTO the pocket. With gap=0, the bearing's top lands
// exactly at the pocket mouth, so the bearing body occupies Z ∈ [mouth - width, mouth].
mate(plate.joints.pocketMouth, bearing.joints.pocketSeat);
```

The mental model: `mate()` puts the two joint ORIGINS at the same place. If you want the moving part's bulk to extend BEHIND the fixed joint (into the host), put the moving joint at the FAR end of the bulk. If you want it to extend AHEAD, put the joint at the NEAR end.

### Debugging joint positions

Two helpers for answering "where did this joint actually end up after `assemble()`?":

```typescript
import { debugJoints, highlightJoints } from "shapeitup";

// 1. Text dump — use for numeric verification or logging
console.log(debugJoints(positioned));
//   motor.shaftTip   pos (0.00, 0.00, 64.00)  axis (0.00, 0.00, 1.00)
//   plate.motorFace  pos (0.00, 0.00, 40.00)  axis (0.00, 0.00, -1.00)

// 2. Visual markers — returns a parts array with a sphere at every joint
return highlightJoints(positioned);   // use as main()'s return value
```

`highlightJoints` is the fastest way to diagnose a misaligned mate — render the assembly and see where joints land as pink spheres, with part names in the parts panel.

### Standard part builders

Common mechanical parts ship as pre-assembled `Part` builders with joints ready to mate. Skip the manual body+shaft+joint declaration boilerplate:

```typescript
import { motors, couplers } from "shapeitup";

const motor   = motors.nema17();                 // Part with mountFace + shaftTip joints
const coupler = couplers.flexible();             // default 5mm→8mm bores

// Dimensions you'd otherwise hardcode live in standards.NEMA17 etc.
patterns.grid(2, 2, standards.NEMA17.boltPitch, standards.NEMA17.boltPitch);
```

Motor layout convention — body at local Z=[0, HEIGHT], shaft on top (Z=[HEIGHT, HEIGHT+SHAFT_LENGTH]), mountFace at bottom (axis "-Z"). Fits the "motor sits atop a plate with shaft extending up" case natively. For the inverse (motor hangs below a plate, shaft through a pilot hole), rotate: `motors.nema17().rotate(180, "+X")`.

| Builder | Size | Joints |
|---|---|---|
| `motors.nema17(opts?)` | 42×42×40 body, Ø5 shaft | `mountFace` (-Z), `shaftTip` (+Z, Ø5) |
| `motors.nema23(opts?)` | 56.4×56.4×56 body, Ø6.35 shaft | same pattern |
| `motors.nema14(opts?)` | 35×35×28 body, Ø5 shaft | same pattern |
| `couplers.flexible(opts?)` | Ø20 × 25, 5↔8 bores (defaults) | `motorEnd` (-Z, Ø motorBore), `leadscrewEnd` (+Z, Ø leadscrewBore) |

All opts accept overrides for name, color, and dimensions. For non-standard coupler bores: `couplers.flexible({ motorBore: 6.35, leadscrewBore: 10 })`.

See `examples/stdlib/linear-actuator.shape.ts` for a 7-part assembly using these builders (motor + coupler + custom end-caps + extrusion + bearing).

### Subassemblies — compose Parts of Parts

For larger machines, collapse groups of parts into a reusable module with its own promoted joints. `subassembly({...})` returns a Part that behaves like any other Part but renders as all of its children:

```typescript
import { subassembly, entries } from "shapeitup";

const driveHead = subassembly({
  parts: [motorCap, motor, coupler, leadscrew],
  mates: [
    mate(motorCap.joints.motorFace,   motor.joints.mountFace),
    mate(motor.joints.shaftTip,       coupler.joints.motorEnd),
    mate(coupler.joints.leadscrewEnd, leadscrew.joints.bottom, { gap: 0.2 }),
  ],
  name: "drive-head",
  promote: { extrusionFace: motorCap.joints.extrusionFace },  // one joint exposed
});

// driveHead is a Part — mate it like anything else
const positioned = assemble([extrusion, driveHead, bearingBlock], [
  mate(extrusion.joints.topFace,    driveHead.joints.extrusionFace),
  mate(extrusion.joints.bottomFace, bearingBlock.joints.extrusionFace),
]);

return entries(positioned);   // auto-flattens — every child comes out with its own color
```

**Why it matters at scale.** The top-level mate graph in the example above has 2 mates instead of 6 — and each subassembly is independently testable + refactorable. Swap the NEMA 17 for a NEMA 23 by changing ONE line inside `makeDriveHead()`, and nothing downstream cares. Subassemblies compose recursively (a subassembly can be a child of another subassembly).

**Promoted joints** capture the child joint's position + axis + role/diameter in the subassembly's local frame. They're the *only* joints visible on the subassembly's boundary — internal joints stay private to the module.

See `examples/stdlib/linear-actuator-subassembled.shape.ts` for a side-by-side with the flat version.

### threads — helical metric + trapezoidal

Real helical threads via OCCT sweep. Mostly useful for STEP export to machine shops, large printable threads (M8+, jar lids, leadscrews), and visual fidelity in renders. Small threads (M2–M5) **don't survive FDM printing reliably** — use `inserts.pocket` + heat-set inserts instead.

**Compound vs. Mesh form — pick one deliberately.** `threads.metric` and `threads.leadscrew` return a *Compound* (root cylinder + un-fused per-turn loops). That's fast and appropriate for **multi-part STEP export** where the thread renders as its own named part. It is **not fuse-safe**: OCCT's B-Rep boolean cannot merge the per-turn loops with another solid and produces non-manifold seams — `head.fuse(threads.metric(...))` will fail BRepCheck. Any time you want to combine a thread with another solid, use the `*Mesh` variants below — they route the boolean through the Manifold kernel (O(n log n), sub-second on WASM).

```typescript
import { threads } from "shapeitup";

// Compound form — STEP-export-friendly, NOT fuse-safe:
threads.metric("M5", 20);                          // ISO coarse pitch (0.8mm)
threads.metric("M5", 20, { pitch: "fine" });       // ISO fine pitch (0.5mm)
threads.metric("M6", 30, { pitch: 1.5 });           // custom pitch

// Mesh form — fuse-safe (MeshShape). Use this for "build a bolt" workflows:
threads.metricMesh("M8", 30);                      // same signature as .metric
threads.fuseThreaded(head, "M8", 30, [0, 0, -30]); // head can be Shape3D or MeshShape

threads.tapHole("M5", 8);                           // CUT-TOOL for a tapped hole
plate.cut(threads.tapHole("M5", 8).translate(x, y, plateTop));

// Modeled internal threads — real helical ridges, returns fuse-safe MeshShape:
threads.tapInto(plate, "M5", 8, [x, y, plateTop]);                 // metric
threads.tapIntoTrap(plate, "TR8x8", 16, [x, y, plateTop]);         // trapezoidal (leadscrew nuts)

// Chaining multiple taps on one plate — tapInto/tapIntoTrap both accept a
// Shape3D OR an already-meshed MeshShape, so second-and-later calls work:
let plate = drawRoundedRectangle(50, 25, 2).sketchOnPlane("XY").extrude(25);
plate = threads.tapInto(plate, "M6", 15, [-12, 0, 25]);   // Shape3D → MeshShape
plate = threads.tapInto(plate, "M6", 15, [ 12, 0, 25]);   // MeshShape → MeshShape
return plate;
// Note: the output is a MeshShape (Manifold mesh), not a B-Rep. Any
// subsequent .fuse / .cut must be Manifold-compatible (MeshShape-to-MeshShape).

threads.leadscrew("TR8x8", 150);                    // Compound (not fuse-safe)
threads.leadscrewMesh("TR8x8", 150);                // MeshShape (fuse-safe)
```

Low-level access for non-standard sizes:

```typescript
threads.external({ diameter: 10, pitch: 1.25, length: 30, profile: threads.metricProfile(1.25), starts: 1 });
threads.internal({ diameter: 8.5, pitch: 1.25, length: 10 });
```

**Cost warning**: a 20mm M3 thread adds ~3000 triangles. For "looks threaded" needs, a plain `cylinder()` is 20× cheaper. Mesh-form threads are sub-second to build but can't be re-combined with B-Rep booleans — once you pick `*Mesh`, downstream ops must be MeshShape-native.
