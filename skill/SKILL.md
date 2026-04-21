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
  - Already rendered and only tuning a number (no code change) → `modify_shape({ filePath, params: {...} })` — params-only call re-runs with new values without rewriting the file. Reach for this BEFORE considering a fresh `create_shape` / full `modify_shape({ code })`.
  - Need visual check → `render_preview` (returns PNG path; Read the file to see it)
  - Need dims/volume/mass only → use the stats already in the `create_shape`/`modify_shape` response (or `get_render_status`). No screenshot needed.
  - Exploring a parameter range (target volume, fit tolerance, bbox) → `tune_params` (ephemeral overrides, doesn't touch the file) until happy, then `modify_shape` with the winning value
  - Multi-part assembly → `check_collisions` to confirm parts don't overlap unintentionally
  - Trying a variant without touching the file → `preview_shape` (one-shot snippet, deleted after run; pass `workingDir` if the snippet uses local `./foo.shape` imports)
  - Ready to ship → `export_shape` (STEP for CAD/CAM, STL per part for 3D-print)
- Render failed
  - TRUST the `Hint:` line in the error response — it's a one-shot pattern-matched suggestion (fillet-too-large, revolve axis in profile, loft-consumed sketch, etc.). Apply it first before deeper debugging.
  - Also check `warnings[]` in the status — non-fatal lints fire even on success.
  - `validate_syntax({ code })` catches common pitfalls (sketch-mischain, missing `.sketchOnPlane`, unclosed pen, non-uniform scale, oversized fillet, booleans-in-loop) without executing.
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
| `modify_shape` | Overwrite existing `.shape.ts` and execute. **Params-only form** (`{ filePath, params }` with no `code`) re-renders with new param values without rewriting the file — preferred for "tune one number" on an already-rendered shape. | `filePath`, `code?`, `params?` |
| `read_shape` | Read file contents | `filePath` |
| `open_shape` | Execute an existing file, bring up in viewer | `filePath` |
| `delete_shape` | Delete a `.shape.ts` file | `filePath` |
| `list_shapes` | Find all `.shape.ts` files | `directory?`, `recursive?` |
| `validate_syntax` | Syntax + 6 semantic lints (no execution) | `code` |
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

### Prefer the axis-explicit stdlib primitives

**Before reaching for `drawRectangle(w, h).sketchOnPlane(plane).extrude(d)`**, check whether one of these does the job. They take a world axis directly and remove every plane-orientation footgun below.

| Instead of | Use |
|------------|-----|
| `makeCylinder(r, h, loc, dir)` or `drawCircle(r).sketchOnPlane(...).extrude(h)` | `cylinder({ bottom, length, diameter, direction: "+Y" })` — base/top explicit, axis named |
| `makeBox([x0,y0,z0], [x1,y1,z1])` | `box({ from: [x0,y0,z0], to: [x1,y1,z1] })` — validates `to > from` on every axis |
| `drawRectangle(w, h).sketchOnPlane("XZ").extrude(d)` (surprise-direction) | `prism({ profile: drawRectangle(w, h), along: "+Y", length: d })` — lands in the half-space you named |

`box` / `prism` / `cylinder` all live in `shapeitup` — use them whenever the geometry is axis-aligned. Reach for raw `sketchOnPlane(...).extrude(...)` only for non-rectangular / revolved / lofted profiles.

### If you really need sketchOnPlane, memorize the extrude direction

Replicad's native extrude grows in a different world direction per plane — the #1 first-time mistake:

```
XY → extrudes +Z (up)
XZ → extrudes -Y (toward camera)
YZ → extrudes +X
```

No exceptions, no flags, no "it depends". To flip direction, use the reverse-named plane (`YX` → -Z, `ZX` → +Y, `ZY` → -X) or pass a negative extrude depth (`.extrude(-L)`). `sketchOnPlane("XZ", [0, 0, 20])`'s origin offset is in WORLD coordinates, so the `[0, 0, 20]` raises along world Z, NOT along the XZ plane's local axis.

Or skip all that and use `prism({ along: "+Y", length: 20 })` — same shape, no sign puzzle.

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

> **`holes.*` axis is NOT pen direction.**
> `axis: "+Y"` on `holes.slot({...})` means **the slot opens on the +Y face** and penetrates toward -Y. It's the same semantic as `holes.through(..., axis: "+Y")`.
> Pen axis mapping above governs 2D sketch → plane; hole axis governs which face the cut opens on.

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

Mark mockup / reference parts with `analyze: false` to suppress printability and minFeature warnings for geometry you won't fabricate (motors, pre-bought tubes, collision-check stand-ins):

```typescript
return [
  { shape: housing,     name: "housing",    color: "#8899aa" },
  { shape: servoMockup, name: "servo",      color: "#333", analyze: false },
];
```

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
| `drawRoundedRectangle(w, h, r)` | Rounded rectangle. `r` is either a uniform number or `{ rx, ry }` for elliptical corners. Per-corner radii (`{ tl, tr, bl, br }`) are NOT supported — if you need per-corner rounding, build the outline with `draw()` + `sagittaArcTo` instead. Examples: `drawRoundedRectangle(80, 50, 5)` (uniform 5 mm) or `drawRoundedRectangle(80, 50, { rx: 8, ry: 3 })` (wider horizontal fillets). |
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
- If it still fails: reduce radius, select fewer edges, move the fillet earlier in the pipeline, or run `validate_syntax` — it flags radii above half the smallest observed dimension.

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

**Rule of thumb: each `.shape.ts` file's `default export main()` is treated as the render entrypoint only for the file you're currently opening. To compose parts from another `.shape.ts`, always export and import a NAMED factory (e.g., `export function makeSolenoidBankParts(...)`), not the default.**

### Importing between shape files

`main()` is only invoked when a file is the top-level shape — it's NOT imported. Export named factory functions for reuse. If you see `No matching export in "x.shape.ts" for import "makeX"`, you're trying to import something that's only reachable via `main()`'s return value.

Library `.shape.ts` modules should export **named factories** (`export function makeBolt(p) { ... }`) — never import `main` from another file (the executor strips that export before bundling; the import will fail).

**Sharing parameters across files.** Importing `{ params }` from a sibling is supported but fragile: both files end up in one esbuild bundle, and `tune_params` slider overrides only mutate the entry file's own `params` — imported ones stay at their declared defaults. Prefer the factory-with-default-params pattern, where the child consumes its own `params` via a default argument and the entry just calls the factory with no argument:

```typescript
// needle.shape.ts
export const params = { length: 17, width: 3 };
export function makeNeedle(p = params) {
  return drawRectangle(p.length, p.width).sketchOnPlane("XY").extrude(1);
}

// assembly.shape.ts — no explicit params arg; makeNeedle uses its own.
import { makeNeedle } from "./needle.shape";
export const params = { scale: 1 };
export default function main() { return makeNeedle(); }
```

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

### `composeAssembly` — parametric multi-file assemblies

When two files each export their own parametric `main()` + `params` (e.g. a pinch-valve's `body.shape.ts` and `cam.shape.ts`), `composeAssembly` merges both `params` dicts into one and dispatches slider overrides to the right child. No hand-typed params, no overlap ambiguity — duplicate keys throw at load time, naming both sides.

```typescript
// body.shape.ts
export const params = { bodyWidth: 80, bodyBore: 12 };
export default function main(p = params) { /* ... */ }

// cam.shape.ts
export const params = { camRadius: 10, camOffset: 2 };
export default function main(p = params) { /* ... */ }

// assembly.shape.ts
import { composeAssembly } from "shapeitup";
import * as body from "./body.shape";
import * as cam  from "./cam.shape";
const assembly = composeAssembly({
  parts: [
    { main: body.default, params: body.params },
    { main: cam.default,  params: cam.params,
      transform: (p) => ({ ...p, shape: p.shape.translate(0, 0, 20), name: "cam" }) },
  ],
});
export const params = assembly.params;
export default assembly.main;
```

The `transform` hook clones the shape before running (Replicad's translate/rotate consume the input), so it's safe to pose children without breaking caching. Each child still returns `Shape3D` or `{ shape, name, color, ... }`; composeAssembly flattens both into the top-level array.

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

**Cut-tool orientation convention** — every hole/seat/pocket helper returns a Shape3D with axis +Z, top at Z=0, extending into -Z. The ergonomic shortcut is to hand the tool factory to `patterns.cutTop` (infers plate-top Z from the plate's bbox, wraps the translate + cut into one call):

```typescript
plate = patterns.cutTop(plate, () => holes.counterbore("M3", { plateThickness: t }), [10, 10])
```

Low-level fallback (when `patterns.cutTop` can't be used — e.g. the plate's bbox isn't readable): build + translate + cut by hand.

```typescript
plate.cut(holes.counterbore("M3", { plateThickness: t }).translate(10, 10, t))
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

### Axis-aware cut tools (prefer over manual `.rotate(90, ...)`)

Every cut-tool helper below takes an optional `axis: "+X" | "-X" | "+Y" | "-Y" | "+Z" | "-Z"` naming the face the hole **opens on** (the body penetrates in the opposite direction). Reach for `axis:` before rotating a `+Z` tool by hand — the rotation math is already correct.

**"Opens on" axis mnemonic** — for each axis, the drill enters from that side and the hole body extends in the opposite direction:

| axis | drill enters from | body penetrates toward |
|------|-------------------|------------------------|
| `"+Z"` | top (+Z) face | −Z |
| `"-Z"` | bottom (−Z) face | +Z |
| `"+X"` | +X face | −X |
| `"-X"` | −X face | +X |
| `"+Y"` | +Y face | −Y |
| `"-Y"` | −Y face | +Y |

- `holes.through` / `holes.clearance` / `holes.counterbore` / `holes.countersink` / `holes.tapped` / `holes.threaded` — all 6 axes
- `holes.throughAt` / `holes.tappedAt` / `holes.counterboreAt` — **preferred single-call form** (`(plate, size, { at: [x,y,z], ... })`) — auto-handles plate-top translation and warns when `at[2]` drifts off the top face
- `holes.teardrop` — horizontal only (`+X` / `+Y` — intended for FDM-printable sideways holes)
- `holes.keyhole` / `holes.slot` — all 6 axes
- `inserts.pocket("M3", { axis })` — heat-set insert pocket
- `motors.nema17_mountPlate({ thickness, axis })` / `nema23_mountPlate` / `nema14_mountPlate` — full 4-hole pattern + shaft bore + optional boss (see below)
- `cylinder({ direction: "+Y" })` / `rod({...})` — positive cylinder, same axis union

For 3D-shape positioning (not cuts): `box({ from, to })`, `prism({ profile, along, length })` — see the Plane-orientation cheat sheet above.

### holes — cut tools

```typescript
holes.through("M3", { depth?, fit?, axis? })              // clearance hole; or raw number for plain cylinder
holes.clearance("M3", { depth?, fit?, axis? })            // alias of `through` — same signature, common engineering term
holes.counterbore("M3", { plateThickness, fit?, axis? })  // socket-head pocket + shaft
holes.countersink("M4", { plateThickness, fit?, axis? })  // 90° flat-head flare + shaft
holes.tapped("M3", { depth, axis? })                      // tap-drill sized
holes.threaded("M3", { depth, axis? })                    // FDM: threaded hole — screw self-taps into tap-drill hole (preferred over modeled threads at M2–M5)
holes.teardrop("M3", { depth, axis?: "+X" | "+Y" })       // FDM-printable horizontal hole (own +X/+Y axis set)
holes.keyhole({ largeD, smallD, slot, depth, axis? })     // hang-on-screw mount
holes.slot({ length, width, depth, axis? })               // elongated adjustment slot

// Preferred single-call wrappers — translate + cut in one line, with a
// top-face Z sanity check that emits a runtime warning when `at[2]` isn't
// near the plate's top bbox face (the #1 silent "cut removed nothing" cause).
holes.throughAt(plate, "M3", { at: [x, y, topZ], depth?, fit?, axis? })
holes.tappedAt(plate, "M3",  { at: [x, y, topZ], depth, axis? })
holes.counterboreAt(plate, "M3", { at: [x, y, topZ], plateThickness, fit?, axis? })
```

### Patterns — placements on any plane

```typescript
patterns.grid(3, 4, 10)                  // 3×4, centered on origin — no `centered` flag needed
patterns.linear(5, [10, 0, 0])           // origin-anchored: (0..4)*step
patterns.linear(5, [10, 0, 0], { centered: true })  // symmetric about origin: [-20, -10, 0, 10, 20]
patterns.polar(6, 25)                    // 6 on a 25 mm circle (XY plane by default)

// Remap any XY-plane pattern onto YZ or XZ — for vent grids on side walls etc.
patterns.onPlane(patterns.grid(5, 3, 6, 6), "YZ")
// grid cells were (x, y, 0); after onPlane("YZ") they become (0, x, y).
```

`grid` is already centered. `linear` now takes `{ centered: true }` for the same behaviour when you want a run straddling the origin.

### Motors — assembly Part vs. mount-plate cut tool

```typescript
// Full motor body with shaft + mount-face joints — use when you want the
// motor visible in the assembly or need to mate a coupler to its shaftTip.
const m = motors.nema17();
mate(m.joints.mountFace, bracket.joints.motorSeat);

// Just cut the 4-hole bolt pattern + shaft bore + optional boss recess
// through a plate — use when the motor itself is out of scope.
bracket = bracket.cut(
  motors.nema17_mountPlate({ thickness: 5, boss: true })
);
// Sideways mount — axis: "+Y" opens the cut on the +Y face, body into -Y:
wall = wall.cut(
  motors.nema17_mountPlate({ thickness: 6, axis: "+Y", center: [0, 6, 20] })
);
```

Full parameter tables for every stdlib namespace are available via `get_api_reference({ category: "stdlib" })`. One-line index of namespaces:

- `holes` — clearance/tapped/threaded/counterbore/countersink/teardrop/keyhole/slot hole patterns
- `screws` / `bolts` — M2–M12 metric fasteners (cosmetic vs. threaded); `bolts.*Mesh` for fuse-safe variants
- `washers` / `inserts` — DIN 125 washers; heat-set insert bodies + pocket cut-tools
- `bearings` — ball-bearing and linear-bearing seats + visualization bodies
- `extrusions` — T-slot aluminum profiles (2020/3030/4040)
- `patterns` — polar/grid/linear placement arrays; `spread`, `cutAt`, `cutTop`, `cutBottom` helpers
- `printHints` — `elephantFootChamfer`, `overhangChamfer`, `firstLayerPad`, `flatForPrint`, `layoutOnBed`
- `pins` — `pin`, `pivot`, `teeBar` (shafts and hinge axles)
- `cradles` — `cradle` (ball cup) and `band_post` (rubber-band anchor)
- `standards.SPORTS_BALLS` — ITF tennis, pingpong, golf, baseball, soccer diameters
- `part` / `faceAt` / `shaftAt` / `boreAt` / `mate` / `assemble` / `entries` — declarative joint-based assembly
- `symmetricPair` — mirror a Part across a plane to get a matched left/right pair
- `subassembly` — compose Parts of Parts; `stackOnZ` for simple coaxial stacks
- `motors` / `couplers` — NEMA14/17/23 motor + flexible coupler Part builders with joints
- `threads` — helical metric + trapezoidal threads (`metric`, `metricMesh`, `tapInto`, `leadscrew`, …)
- `cylinder` / `rod` — orientation-explicit cylinder with named top/bottom anchor
- `box` — corner-to-corner axis-aligned block; `prism` — drawing extruded along a named axis (preferred over `sketchOnPlane().extrude()` for axis-aligned parts)
- `shape3d` / `fromBack` / `seatedOnPlate` / `debugJoints` / `highlightJoints` — utilities

