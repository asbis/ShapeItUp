/**
 * Tests for the VS Code host's face-operation writer, against the same stubbed
 * `vscode` module the parameter-commit tests use.
 *
 * The decision logic — which selector, which expression — lives in
 * `@shapeitup/shared`'s face-edit and has its own tests. What is specific to
 * this host, and tested here, is that the resulting DOCUMENT is right: an
 * operation can produce two edits (the wrap and an added import), and applying
 * them in the wrong order silently corrupts the file.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { __reset, __addDoc, __state } from "./testing/vscode-stub.js";
import { ViewerProvider } from "./viewer-provider.js";

const FILE = "/w/plate.shape.ts";
const SRC = `import { drawRoundedRectangle } from "replicad";

export const params = { width: 80, thickness: 6 };

export default function main({ width, thickness }: typeof params) {
  return drawRoundedRectangle(width, 60, 4).sketchOnPlane().extrude(thickness);
}
`;

function makeProvider(file: string | undefined) {
  const lines: string[] = [];
  const output = { appendLine: (l: string) => lines.push(l), show: () => {} };
  const provider: any = new ViewerProvider({} as any, output as any);
  provider.lastExecutedFile = file;
  return { provider, lines };
}

/** The top face of a 6 mm plate: planar, +Z, sitting at Z = thickness. */
const TOP_FACE = {
  kind: "PLANE",
  center: [0, 0, 6] as [number, number, number],
  normal: [0, 0, 1] as [number, number, number],
};

const request = (over: Record<string, unknown> = {}) => ({
  type: "face-op" as const,
  requestId: 1,
  op: "extrude" as const,
  partName: null,
  face: TOP_FACE,
  distance: 5,
  ...over,
});

describe("ViewerProvider.commitFaceOp", () => {
  beforeEach(() => __reset());

  it("wraps the returned shape and binds the offset to the parameter", () => {
    const doc = __addDoc(FILE, SRC, { visible: true });
    const { provider } = makeProvider(FILE);

    return provider.commitFaceOp(request()).then((r: any) => {
      expect(r).toMatchObject({ type: "face-op-result", requestId: 1, ok: true });
      expect(doc.text).toContain(
        'return extrudeFace(drawRoundedRectangle(width, 60, 4).sketchOnPlane().extrude(thickness), (f) => f.inPlane("XY", thickness), 5);',
      );
    });
  });

  it("adds the import, and applies both edits without corrupting either", async () => {
    // The wrap sits far below the import, so applying ascending would shift
    // the wrap's offsets by the inserted line's length and land it mid-token.
    const doc = __addDoc(FILE, SRC, { visible: true });
    const { provider } = makeProvider(FILE);

    const r = await provider.commitFaceOp(request());

    expect(r.addedImport).toBe(true);
    expect(doc.text).toContain('import { extrudeFace } from "shapeitup";');
    expect(doc.text).toContain("return extrudeFace(drawRoundedRectangle(");
    // The original import survived intact.
    expect(doc.text).toContain('import { drawRoundedRectangle } from "replicad";');
    // And the file still parses as the same declaration it started as.
    expect(doc.text).toContain("export const params = { width: 80, thickness: 6 };");
  });

  it("composes with unsaved edits rather than clobbering them", async () => {
    const dirty = SRC.replace("export const params", "// mid-edit\nexport const params");
    const doc = __addDoc(FILE, dirty, { visible: true });
    const { provider } = makeProvider(FILE);

    await provider.commitFaceOp(request());

    expect(doc.text).toContain("// mid-edit");
    expect(doc.text).toContain("extrudeFace(");
  });

  it("leaves a visible document dirty and saves an invisible one", async () => {
    const visible = __addDoc(FILE, SRC, { visible: true });
    const { provider } = makeProvider(FILE);
    await provider.commitFaceOp(request());
    expect(visible.saveCount).toBe(0);

    __reset();
    const hidden = __addDoc(FILE, SRC, { visible: false });
    const p2 = makeProvider(FILE);
    await p2.provider.commitFaceOp(request());
    expect(hidden.saveCount).toBe(1);
  });

  it("declines a face no selector can name, and writes nothing", async () => {
    const doc = __addDoc(FILE, SRC, { visible: true });
    const { provider } = makeProvider(FILE);

    // A 45-degree fillet face: planar, but parallel to no standard plane.
    const r = await provider.commitFaceOp(
      request({ face: { kind: "PLANE", center: [0, -28, 4], normal: [0, -0.707, 0.707] } }),
    );

    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not parallel to a standard plane/);
    expect(doc.text).toBe(SRC);
  });

  it("declines a curved face", async () => {
    __addDoc(FILE, SRC, { visible: true });
    const { provider } = makeProvider(FILE);
    const r = await provider.commitFaceOp(
      request({ face: { kind: "CYLINDRE", center: [6, 0, 3], normal: [1, 0, 0] } }),
    );
    expect(r.reason).toMatch(/only planar faces/);
  });

  it("declines a part name the file does not contain", async () => {
    const doc = __addDoc(FILE, SRC, { visible: true });
    const { provider } = makeProvider(FILE);
    const r = await provider.commitFaceOp(request({ partName: "flange" }));
    expect(r).toMatchObject({ ok: false });
    expect(r.reason).toMatch(/could not find this part/);
    expect(doc.text).toBe(SRC);
  });

  it("writes filletFace and chamferFace, each with its own import", async () => {
    for (const [op, fn] of [["fillet", "filletFace"], ["chamfer", "chamferFace"]] as const) {
      __reset();
      const doc = __addDoc(FILE, SRC, { visible: true });
      const { provider } = makeProvider(FILE);
      const r = await provider.commitFaceOp(request({ op, distance: 2 }));
      expect(r.ok).toBe(true);
      expect(doc.text).toContain(`import { ${fn} } from "shapeitup";`);
      expect(doc.text).toContain(
        `return ${fn}(drawRoundedRectangle(width, 60, 4).sketchOnPlane().extrude(thickness), (f) => f.inPlane("XY", thickness), 2);`,
      );
    }
  });

  it("declines a negative radius but allows a negative extrude", async () => {
    __addDoc(FILE, SRC, { visible: true });
    const { provider } = makeProvider(FILE);
    for (const op of ["fillet", "chamfer"] as const) {
      const r = await provider.commitFaceOp(request({ op, distance: -2 }));
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/must be positive/);
    }
    expect((await provider.commitFaceOp(request({ distance: -2 }))).ok).toBe(true);
  });

  it("declines a zero distance", async () => {
    __addDoc(FILE, SRC, { visible: true });
    const { provider } = makeProvider(FILE);
    for (const op of ["extrude", "fillet", "chamfer"] as const) {
      const r = await provider.commitFaceOp(request({ op, distance: 0 }));
      expect(r.reason).toMatch(/non-zero/);
    }
  });

  it("echoes the request id so a stale reply is identifiable", async () => {
    __addDoc(FILE, SRC, { visible: true });
    const { provider } = makeProvider(FILE);
    const r = await provider.commitFaceOp(request({ requestId: 77 }));
    expect(r.requestId).toBe(77);
  });

  it("surfaces an editor that refuses the edit", async () => {
    const doc = __addDoc(FILE, SRC, { visible: true });
    __state.applyEditSucceeds = false;
    const { provider } = makeProvider(FILE);

    const r = await provider.commitFaceOp(request());
    expect(r).toMatchObject({ ok: false, reason: "the editor rejected the edit" });
    expect(doc.text).toBe(SRC);
  });

  it("declines when no file is open", async () => {
    const { provider } = makeProvider(undefined);
    expect(await provider.commitFaceOp(request())).toMatchObject({
      ok: false,
      reason: "no file open",
    });
  });
});
