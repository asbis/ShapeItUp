---
name: shapeitup
description: Create and modify 3D CAD models using Replicad TypeScript API in ShapeItUp
globs: ["**/*.shape.ts"]
---

# ShapeItUp — Replicad CAD Scripting Reference

## AI Workflow

When creating or modifying shapes, follow this workflow:
1. Create/modify the `.shape.ts` file using the Replicad API below
2. Call `get_render_status` to check if it rendered successfully or has errors
3. If there are errors, fix the code and repeat from step 1
4. Call `render_preview` to capture a screenshot for visual verification
5. Use the Read tool on the returned PNG path to verify the shape looks correct
6. If dimensions are wrong or the shape looks off, modify and repeat

### Available MCP Tools

**File operations:**
- `create_shape` — create a new `.shape.ts` file with given code
- `modify_shape` — overwrite an existing shape file
- `read_shape` — read shape file contents
- `list_shapes` — find all `.shape.ts` files in a directory
- `validate_script` — check TypeScript syntax without executing

**Visual review:**
- `get_render_status` — check if the last render succeeded or failed (returns error messages). Call this after every create/modify.
- `render_preview` — capture a PNG screenshot (auto-enables AI render mode + dimensions). Returns file path to Read.
- `set_render_mode` — switch between `"ai"` (white bg, vivid colors) and `"dark"` (user's dark mode)
- `toggle_dimensions` — show/hide X/Y/Z bounding box measurements on the 3D view

**Export:**
- `get_api_reference` — get Replicad API docs by category

### Best Practices for AI
- Always use `export const params = { ... }` so the user gets live sliders in the viewer
- After creating a shape, call `render_preview` and Read the PNG to self-check
- If dimensions look wrong, check the code and fix — common mistakes: wrong extrude direction, missing translateZ, swapped width/height
- Use named parts with colors for assemblies: `return [{ shape, name: "base", color: "#8899aa" }]`

## File Convention

Every shape file uses the `.shape.ts` extension and exports a default `main()` function that returns a Shape3D (or array of Shape3D).

### Basic (no parameters)
```typescript
import { drawRectangle } from "replicad";

export default function main() {
  return drawRectangle(50, 30).sketchOnPlane("XY").extrude(10);
}
```

### With Parameters (PREFERRED — gives user live sliders)
```typescript
import { drawRoundedRectangle, sketchCircle } from "replicad";

export const params = {
  width: 80,
  height: 50,
  depth: 30,
  wall: 2,
  cornerRadius: 5,
};

export default function main({ width, height, depth, wall, cornerRadius }: typeof params) {
  const outer = drawRoundedRectangle(width, height, cornerRadius)
    .sketchOnPlane("XY").extrude(depth);
  const inner = drawRoundedRectangle(width - wall*2, height - wall*2, cornerRadius - wall)
    .sketchOnPlane("XY", [0, 0, wall]).extrude(depth);
  return outer.cut(inner);
}
```

The `params` object is auto-detected by the viewer and generates slider controls. Always prefer this pattern so users can interactively adjust dimensions.

## Core Concepts

- **Flow**: Drawing (2D) → Sketch (placed on a plane) → Shape3D (extruded/revolved/lofted/swept)
- **Units**: All dimensions in millimeters
- **Coordinate system**: X = right, Y = forward, Z = up
- **Planes**: `"XY"` (top), `"XZ"` (front), `"YZ"` (right). Prefix with `-` to flip normal.

---

## Drawing API (2D Shapes)

### Factory Functions
| Function | Returns | Description |
|----------|---------|-------------|
| `draw(origin?)` | DrawingPen | Freeform 2D path builder |
| `drawRectangle(w, h)` | Drawing | Rectangle centered at origin |
| `drawRoundedRectangle(w, h, r)` | Drawing | Rounded rectangle |
| `drawCircle(radius)` | Drawing | Circle centered at origin |
| `drawEllipse(majorR, minorR)` | Drawing | Ellipse |
| `drawPolysides(radius, numSides)` | Drawing | Regular polygon |
| `drawText(text, config?)` | Drawing | Text outline |

### DrawingPen Methods (all chainable)
**Lines:**
- `.lineTo([x, y])` — absolute line
- `.line(dx, dy)` — relative line
- `.vLine(d)` — vertical line
- `.hLine(d)` — horizontal line
- `.polarLine(distance, angleDeg)` — line at angle

**Arcs:**
- `.sagittaArcTo([x, y], sagitta)` — arc with bulge
- `.tangentArcTo([x, y])` — arc tangent to previous segment
- `.threePointsArcTo([x, y], [mx, my])` — arc through 3 points

**Curves:**
- `.cubicBezierCurveTo([x, y], [cp1x, cp1y], [cp2x, cp2y])`
- `.smoothSplineTo([x, y], config?)`

**Closing:**
- `.close()` — close shape (required for extrusion)
- `.closeWithMirror()` — close by mirroring the path
- `.done()` — open wire (no close)

### 2D Boolean Operations
- `drawing.fuse(other)` — union
- `drawing.cut(other)` — subtraction
- `drawing.intersect(other)` — intersection
- `drawing.offset(distance)` — offset/inset
- `drawing.translate(dx, dy)`, `.rotate(angleDeg)`, `.mirror(axis)`

---

## Sketching (2D → 3D-ready)

### Placing Drawings on Planes
```typescript
const sketch = drawRectangle(50, 30).sketchOnPlane("XY");
const sketch2 = drawCircle(10).sketchOnPlane("XY", [0, 0, 20]); // at height Z=20
```

### Convenience Functions
- `sketchRectangle(w, h, config?)` — sketch directly (no drawing step)
- `sketchCircle(r, config?)` — sketch directly

### Sketcher Class (3D freeform)
```typescript
const sketch = new Sketcher("XZ")
  .hLine(20).vLine(10).hLine(-20).close();
```

---

## 3D Solid Operations

### From Sketch
| Method | Description |
|--------|-------------|
| `sketch.extrude(distance, config?)` | Linear extrusion |
| `sketch.revolve(axis?, config?)` | Revolution (default 360°) |
| `sketch.loftWith(otherSketch, config?)` | Loft between profiles |
| `sketch.sweepSketch(profileFn, config?)` | Sweep along path |

**Extrude config**: `{ extrusionDirection?: [x,y,z], twistAngle?: number }`
**Revolve config**: `{ origin?: [x,y,z], angle?: number }`

### Primitive Solids
```typescript
makeCylinder(radius, height, location?, direction?)
makeSphere(radius)
makeBox(corner1, corner2)  // e.g., makeBox([0,0,0], [10,20,30])
```

---

## Boolean Operations

```typescript
shape.fuse(other)       // union
shape.cut(tool)         // subtraction
shape.intersect(other)  // intersection
```

---

## Shape Modifications

### Fillet (round edges)
```typescript
shape.fillet(radius)                              // all edges
shape.fillet(radius, e => e.inDirection("Z"))     // filtered edges
```

### Chamfer
```typescript
shape.chamfer(distance)
shape.chamfer(distance, e => e.inDirection("Z"))
```

### Shell (hollow out)
```typescript
shape.shell({ thickness: 2, filter: f => f.inPlane("XY", height) })
```

### Draft (taper walls)
```typescript
shape.draft(angleDeg, faceFinder, neutralPlane?)

### Fillet/Chamfer Best Practices
- Apply fillets BEFORE boolean cuts when possible
- Avoid `.fillet(r, e => e.inPlane("XY", z))` after many boolean cuts — tiny edges crash OpenCascade
- Prefer `.fillet(r, e => e.inDirection("Z"))` for outer vertical edges only
- Use small radii (0.3-0.5mm) on complex geometry
- Wrap fillets in try/catch: `try { shape = shape.fillet(0.5); } catch { /* skip */ }`
- If fillet crashes: reduce radius, fillet fewer edges, or fillet before cutting holes
```

---

## Transformations (all return new shape)

```typescript
shape.translate(x, y, z)
shape.translateX(d)  /  .translateY(d)  /  .translateZ(d)
shape.rotate(angleDeg, position?, direction?)
shape.mirror(plane?, origin?)
shape.scale(factor, center?)
```

---

## Finders (selecting edges/faces for fillet, chamfer, shell)

### EdgeFinder (for fillet/chamfer)
```typescript
shape.fillet(2, e => e.inDirection("Z"))        // edges along Z
shape.fillet(2, e => e.inPlane("XY"))           // edges in XY plane
shape.fillet(2, e => e.ofLength(20))            // edges of length 20
shape.fillet(2, e => e.ofCurveType("CIRCLE"))   // circular edges
shape.fillet(2, e => e.parallelTo("XY"))
shape.fillet(2, e => e.containsPoint([x,y,z]))
shape.fillet(2, e => e.atDistance(d, point?))
```

### FaceFinder (for shell, draft)
```typescript
shape.shell({ thickness: 2, filter: f => f.inPlane("XY", 10) })
shape.shell({ thickness: 2, filter: f => f.parallelTo("XZ") })
shape.shell({ thickness: 2, filter: f => f.ofSurfaceType("PLANE") })
shape.shell({ thickness: 2, filter: f => f.containsPoint([x,y,z]) })
```

### Combining Finders
```typescript
e => e.inDirection("Z").and(e2 => e2.atDistance(5, [0,0,0]))
e => e.inDirection("X").or(e2 => e2.inDirection("Y"))
e => e.not(e2 => e2.inPlane("XY"))
```

---

## Memory Management

For complex scripts with many intermediate shapes:
```typescript
import { localGC } from "replicad";

export default function main() {
  const [r, gc] = localGC();
  const base = r(drawRectangle(100, 60).sketchOnPlane("XY").extrude(10));
  // ... many operations using r() to register intermediates ...
  const result = base.fillet(2);
  gc(); // clean up registered intermediates
  return result;
}
```

---

## Multi-File & Assemblies

### Importing from other files
Shape files can export reusable functions and import them in other files:

```typescript
// bolt.shape.ts — reusable part
import { sketchCircle, drawPolysides } from "replicad";

export function makeBolt(diameter = 8, length = 30) {
  const head = drawPolysides(diameter * 0.9, 6).sketchOnPlane("XY").extrude(5);
  const shaft = sketchCircle(diameter / 2).extrude(length).translateZ(-length);
  return head.fuse(shaft);
}

export default function main() { return makeBolt(); }
```

```typescript
// assembly.shape.ts — imports the bolt
import { makeBolt } from "./bolt.shape";

export default function main() {
  const bolt1 = makeBolt(8, 20).translate(10, 0, 0);
  const bolt2 = makeBolt(8, 20).translate(-10, 0, 0);
  return [bolt1, bolt2]; // renders both
}
```

### Returning multiple parts
`main()` can return:
- **Single shape**: `return shape;`
- **Array of shapes**: `return [shape1, shape2];` (auto-colored)
- **Array with metadata**: `return [{ shape, name: "base", color: "#8899aa" }, ...]`

Each part gets its own color in the viewer and is exported as a named component in STEP files.

---

## Complete Examples

### Box with Center Hole and Fillets
```typescript
import { drawRectangle, sketchCircle } from "replicad";

export default function main() {
  const box = drawRectangle(60, 40).sketchOnPlane("XY").extrude(20);
  const hole = sketchCircle(8).extrude(20);
  return box.cut(hole).fillet(2);
}
```

### L-Bracket with Mounting Holes
```typescript
import { draw, makeCylinder } from "replicad";

export default function main() {
  const profile = draw()
    .hLine(60).vLine(5).hLine(-55).vLine(35).hLine(-5).close();
  let bracket = profile.sketchOnPlane("XZ").extrude(30);
  const h1 = makeCylinder(3, 30, [45, 0, 2.5], [0, 1, 0]);
  const h2 = makeCylinder(3, 30, [15, 0, 2.5], [0, 1, 0]);
  const h3 = makeCylinder(3, 30, [2.5, 0, 25], [0, 1, 0]);
  bracket = bracket.cut(h1).cut(h2).cut(h3);
  return bracket.fillet(2, e => e.inDirection("Y"));
}
```

### Flanged Cylinder (Bottle Shape)
```typescript
import { sketchCircle } from "replicad";

export default function main() {
  const base = sketchCircle(30).extrude(5);
  const body = sketchCircle(15).extrude(50).translateZ(5);
  const interior = sketchCircle(12).extrude(52);
  return base.fuse(body).cut(interior).fillet(3);
}
```

### Enclosure Shell
```typescript
import { drawRoundedRectangle } from "replicad";

export default function main() {
  const outer = drawRoundedRectangle(80, 50, 5).sketchOnPlane("XY").extrude(30);
  const inner = drawRoundedRectangle(76, 46, 3)
    .sketchOnPlane("XY", [0, 0, 2]).extrude(30);
  return outer.cut(inner);
}
```

### Wheel / Disc with Spokes
```typescript
import { sketchCircle, drawRectangle } from "replicad";

export default function main() {
  const disc = sketchCircle(40).extrude(8);
  const hub = sketchCircle(10).extrude(15);
  const axleHole = sketchCircle(5).extrude(15);

  let wheel = disc.fuse(hub).cut(axleHole);

  // Cut 6 rectangular slots as "spokes"
  for (let i = 0; i < 6; i++) {
    const angle = (i * 60 * Math.PI) / 180;
    const cx = Math.cos(angle) * 25;
    const cy = Math.sin(angle) * 25;
    const slot = drawRectangle(12, 5)
      .sketchOnPlane("XY")
      .extrude(8)
      .translate(cx, cy, 0)
      .rotate(i * 60, [0, 0, 0], [0, 0, 1]);
    wheel = wheel.cut(slot);
  }

  return wheel.fillet(1);
}
```
