import { describe, it, expect } from "vitest";
import * as threads from "./threads";
import { bolts } from "./fasteners";

// ---------------------------------------------------------------------------
// These tests pin the public API surface of the threads module and verify
// profile math. They intentionally do NOT invoke the OCCT/Manifold kernels
// (WASM init is too slow for unit tests and the kernel is already covered by
// downstream integration tests). The contract we pin here is: the named
// fuse-safe mesh exports exist and have the expected arity — so a user
// writing `threads.fuseThreaded(head, "M8", …)` fails at runtime with a
// real geometry error, not a `TypeError: threads.fuseThreaded is not a
// function` regression.
// ---------------------------------------------------------------------------

describe("threads — API surface (Compound-returning functions)", () => {
  it("exports `metric` (fuse-UNSAFE Compound form)", () => {
    expect(typeof threads.metric).toBe("function");
    // (size, length, opts=) → 2 required, 1 optional.
    expect(threads.metric.length).toBe(2);
  });

  it("exports `leadscrew` (fuse-UNSAFE Compound form)", () => {
    expect(typeof threads.leadscrew).toBe("function");
    expect(threads.leadscrew.length).toBe(2);
  });

  it("exports `external` + `internal` low-level builders", () => {
    expect(typeof threads.external).toBe("function");
    expect(typeof threads.internal).toBe("function");
  });
});

describe("threads — API surface (Mesh / fuse-safe additions)", () => {
  it("exports `metricMesh` with the same arity as `metric`", () => {
    expect(typeof threads.metricMesh).toBe("function");
    expect(threads.metricMesh.length).toBe(threads.metric.length);
  });

  it("exports `leadscrewMesh` with the same arity as `leadscrew`", () => {
    expect(typeof threads.leadscrewMesh).toBe("function");
    expect(threads.leadscrewMesh.length).toBe(threads.leadscrew.length);
  });

  it("exports `fuseThreaded` (into, size, length, position, opts=)", () => {
    expect(typeof threads.fuseThreaded).toBe("function");
    // 4 required positional params, 1 optional → Function.length = 4.
    expect(threads.fuseThreaded.length).toBe(4);
  });

  it("preserves `tapInto` (fuse-safe internal-thread cutter)", () => {
    expect(typeof threads.tapInto).toBe("function");
  });

  it("exports `tapIntoTrap` (trapezoidal sibling of `tapInto`)", () => {
    expect(typeof threads.tapIntoTrap).toBe("function");
    // (plate, designation, depth, position) → 4 required params.
    expect(threads.tapIntoTrap.length).toBe(4);
  });

  it("tapIntoTrap has arity parity with tapInto (caller interchangeability)", () => {
    // Both are `(plate, sizeOrDesignation, depth, position, opts?=) → MeshShape`.
    // Function.length counts required params only — tapInto has an optional
    // opts arg so its .length is also 4.
    expect(threads.tapIntoTrap.length).toBe(threads.tapInto.length);
  });
});

describe("threads — profile math (pure, kernel-free)", () => {
  it("metricProfile is ISO 68 V-thread: depth = 5H/8 at pitch=1", () => {
    const p = threads.metricProfile(1.0);
    // 5H/8 with H = P·√3/2 = √3/2·P → depth ≈ 0.5413·P.
    expect(p.depth).toBeCloseTo(0.5413, 4);
    expect(p.baseWidth).toBe(1.0);
    expect(p.crestWidth).toBeCloseTo(0.125, 4);
  });

  it("trapezoidalProfile is deeper (0.5·P) with ~0.366·P crest", () => {
    const p = threads.trapezoidalProfile(2.0);
    expect(p.depth).toBeCloseTo(1.0, 4);
    expect(p.baseWidth).toBe(2.0);
    expect(p.crestWidth).toBeCloseTo(0.732, 3);
  });
});

describe("threads — leadscrew designation validation (pure)", () => {
  it("throws a readable error for an unknown designation", () => {
    // Hits `resolveLeadscrewSpec` before any OCCT call, so this is kernel-free.
    expect(() => threads.leadscrewMesh("TR999x42", 50)).toThrow(
      /Unknown trapezoidal leadscrew "TR999x42"/,
    );
    expect(() => threads.leadscrew("TR999x42", 50)).toThrow(
      /Unknown trapezoidal leadscrew "TR999x42"/,
    );
  });
});

describe("threads — metric size validation (pure)", () => {
  // Before assertSupportedSize was added, unsupported sizes fell through to
  // `METRIC_COARSE_PITCH[size]` which returned `undefined`, later crashing
  // deep inside OCCT (e.g. `.toFixed()` on undefined) with an opaque error.
  // These tests pin the friendly-error contract at each entry point.
  it("metric('M38') throws a readable error mentioning the bad size", () => {
    expect(() => threads.metric("M38" as any, 10)).toThrow(/M38/);
  });
  it("metricMesh('M38') throws a readable error mentioning the bad size", () => {
    expect(() => threads.metricMesh("M38" as any, 10)).toThrow(/M38/);
  });
  it("tapHole('M38') throws a readable error mentioning the bad size", () => {
    expect(() => threads.tapHole("M38" as any, 10)).toThrow(/M38/);
  });
  it("fuseThreaded(…, 'M38') throws before touching OCCT", () => {
    const fakeInto: any = { meshShape: () => ({ fuse: () => ({}) }) };
    expect(() => threads.fuseThreaded(fakeInto, "M38" as any, 10, [0, 0, 0])).toThrow(
      /M38/,
    );
  });
  it("tapInto(…, 'M38') throws before touching OCCT", () => {
    const fakePlate: any = {
      meshShape: () => ({ translate: () => ({}), cut: () => ({}), fuse: () => ({}) }),
    };
    expect(() => threads.tapInto(fakePlate, "M38" as any, 10, [0, 0, 0])).toThrow(
      /M38/,
    );
  });
});

// ---------------------------------------------------------------------------
// tapInto / tapIntoTrap — chaining regression (Bug #1)
//
// A CAD engineer hit:
//   plate = threads.tapInto(plate, "M6", 15, p1);  // OK: Shape3D → MeshShape
//   plate = threads.tapInto(plate, "M6", 15, p2);  // CRASH: "plate.meshShape is not a function"
//
// Root cause: both helpers call `plate.meshShape()` to coerce the plate to a
// Manifold mesh. Second call hits a MeshShape — which doesn't have that
// method — and throws TypeError before any kernel work. The fix routes the
// plate arg through `asMeshShape(plate)` so MeshShape passes through
// untouched.
//
// These tests pin the contract at the shim layer: we mock a Shape3D-looking
// plate (has `meshShape()`) and a MeshShape-looking one (does not), and
// assert that tapInto / tapIntoTrap don't throw a TypeError on either input.
// They intentionally short-circuit inside our mock before any OCCT/Manifold
// call, so nothing here needs a real WASM kernel.
// ---------------------------------------------------------------------------

describe("threads.tapInto / tapIntoTrap — plate chaining (Bug #1)", () => {
  /**
   * Before the fix, a second tapInto() call on an already-meshed plate threw
   * `TypeError: plate.meshShape is not a function` BEFORE any OCCT call —
   * a synchronous property-access failure at line `plate.meshShape({...})`.
   *
   * We cannot complete the kernel work in a unit test (no OCCT), but we CAN
   * assert at the boundary: the error thrown must NOT be the "meshShape is
   * not a function" TypeError. Once execution gets past `asMeshShape`, it
   * will fail at `makeCylinder(...)` with `opencascade has not been loaded`
   * — a load-error we accept in unit tests (real kernel is covered by
   * integration). That delta ("plate.meshShape is not a function" →
   * "opencascade has not been loaded") is exactly the fix.
   *
   * These assertions are asymmetric: `fakeShape3D` has a `.meshShape()` that
   * returns a mesh-ish object (so first-call path works AND we can verify
   * the method was invoked); `fakeMeshShape` has NO `.meshShape` method (so
   * if the helper still calls it, we'd see the regressed TypeError).
   */
  const TYPE_ERROR_RE = /meshShape is not a function/;

  function fakeMeshShape(): any {
    // Minimal MeshShape surface: has `translate` / `cut` / `fuse` so the
    // downstream chain COULD run against it, but no `meshShape()` method —
    // that's the point. We never reach those methods because makeCylinder
    // fails first in a no-OCCT test environment.
    const mesh: any = {
      translate: () => mesh,
      cut: () => mesh,
      fuse: () => mesh,
    };
    return mesh;
  }
  function fakeShape3D(onMeshShape?: () => void): any {
    return {
      meshShape: (_opts?: any) => {
        onMeshShape?.();
        return fakeMeshShape();
      },
    };
  }

  it("tapInto: Shape3D plate — invokes .meshShape internally (first-call path)", () => {
    let calls = 0;
    const plate = fakeShape3D(() => calls++);
    // Any throw here must not be the "meshShape is not a function" TypeError;
    // the makeCylinder() call inside tapInto will throw before we finish,
    // and that's fine — we're pinning the coercion-step behavior only.
    try {
      threads.tapInto(plate, "M6", 15, [-12, 0, 25]);
    } catch (e: any) {
      expect(String(e?.message ?? e)).not.toMatch(TYPE_ERROR_RE);
    }
    expect(calls).toBe(1);
  });

  it("tapInto: MeshShape plate — does NOT throw 'meshShape is not a function' (the bug)", () => {
    const plate = fakeMeshShape();
    expect(plate.meshShape).toBeUndefined();
    try {
      threads.tapInto(plate, "M6", 15, [12, 0, 25]);
      // Getting here means no throw at all, which is also fine — the
      // coercion step succeeded. (Won't happen in practice without OCCT,
      // but the contract is "doesn't throw TypeError on MeshShape input".)
    } catch (e: any) {
      expect(String(e?.message ?? e)).not.toMatch(TYPE_ERROR_RE);
    }
  });

  it("tapIntoTrap: Shape3D plate — invokes .meshShape internally", () => {
    let calls = 0;
    const plate = fakeShape3D(() => calls++);
    try {
      threads.tapIntoTrap(plate, "TR8x8", 16, [0, 0, 16]);
    } catch (e: any) {
      expect(String(e?.message ?? e)).not.toMatch(TYPE_ERROR_RE);
    }
    expect(calls).toBe(1);
  });

  it("tapIntoTrap: MeshShape plate — does NOT throw 'meshShape is not a function'", () => {
    const plate = fakeMeshShape();
    expect(plate.meshShape).toBeUndefined();
    try {
      threads.tapIntoTrap(plate, "TR8x8", 16, [0, 0, 16]);
    } catch (e: any) {
      expect(String(e?.message ?? e)).not.toMatch(TYPE_ERROR_RE);
    }
  });
});

describe("bolts — mesh variants are exported (fuse-safe)", () => {
  it("exports `bolts.socketMesh`, `buttonMesh`, `hexMesh`, `flatMesh`", () => {
    expect(typeof bolts.socketMesh).toBe("function");
    expect(typeof bolts.buttonMesh).toBe("function");
    expect(typeof bolts.hexMesh).toBe("function");
    expect(typeof bolts.flatMesh).toBe("function");
  });

  it("preserves the existing Compound-returning factories", () => {
    // We keep the old API working; only ADD the mesh variants.
    expect(typeof bolts.socket).toBe("function");
    expect(typeof bolts.button).toBe("function");
    expect(typeof bolts.hex).toBe("function");
    expect(typeof bolts.flat).toBe("function");
    expect(typeof bolts.nut).toBe("function");
  });
});
