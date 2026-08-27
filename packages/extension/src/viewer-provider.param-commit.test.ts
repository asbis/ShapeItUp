/**
 * Tests for the VS Code host's slider writeback.
 *
 * These exercise the REAL `ViewerProvider.commitParam` against a stubbed
 * `vscode` module (aliased in vitest.config.ts), rather than a copied double.
 * The stub actually splices text on `applyEdit`, so the assertions are on the
 * resulting document — which is the property that matters.
 *
 * The decision logic lives in `computeParamEdit` and is covered by its own 40
 * tests. What is specific to this host, and tested here, is the editor
 * behaviour around it: composing with an unsaved buffer, and the rule about
 * which documents get saved.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __reset, __addDoc, __state } from "./testing/vscode-stub.js";
import { ViewerProvider } from "./viewer-provider.js";

const FILE = "/w/bracket.shape.ts";
const SRC = `export const params = { width: 80, depth: 50 };

export default function main({ width, depth }: typeof params) {
  return { width, depth };
}
`;

/**
 * A provider with just enough around it to reach commitParam.
 * `file` is required — passing `undefined` to a defaulted parameter would
 * silently restore the default and make the "no file open" case unreachable.
 */
function makeProvider(file: string | undefined) {
  const lines: string[] = [];
  const output = { appendLine: (l: string) => lines.push(l), show: () => {} };
  const provider: any = new ViewerProvider({} as any, output as any);
  provider.lastExecutedFile = file;
  // commitParams posts the result to the webview; commitParam does not touch it,
  // and these tests call commitParam directly.
  return { provider, lines };
}

const commit = (p: any, name: string, value: number) => p.commitParam(name, value);

describe("ViewerProvider.commitParam", () => {
  beforeEach(() => __reset());

  it("writes the value through a workspace edit", async () => {
    const doc = __addDoc(FILE, SRC, { visible: true });
    const { provider } = makeProvider(FILE);

    const r = await commit(provider, "depth", 65);

    expect(r).toEqual({
      type: "param-commit-result",
      name: "depth",
      value: 65,
      ok: true,
      // No sidecar next to this path, so nothing to retire.
      clearedSidecar: false,
    });
    expect(doc.text).toBe(SRC.replace("depth: 50", "depth: 65"));
  });

  it("composes with unsaved edits instead of clobbering them", async () => {
    // The user renamed a param and added a comment but has not saved. A writer
    // that went to disk would overwrite both; editing the document must not.
    const dirty = SRC.replace(
      "export const params = { width: 80, depth: 50 };",
      "// work in progress\nexport const params = { width: 80, depth: 50, extra: 1 };",
    );
    const doc = __addDoc(FILE, dirty, { visible: true });
    const { provider } = makeProvider(FILE);

    await commit(provider, "depth", 65);

    expect(doc.text).toContain("// work in progress");
    expect(doc.text).toContain("extra: 1");
    expect(doc.text).toContain("depth: 65");
  });

  it("leaves a visible document dirty for the user to save", async () => {
    const doc = __addDoc(FILE, SRC, { visible: true });
    const { provider, lines } = makeProvider(FILE);

    await commit(provider, "width", 90);

    expect(doc.saveCount).toBe(0);
    expect(doc.isDirty).toBe(true);
    expect(lines.join("\n")).toContain("unsaved — yours to save");
  });

  it("saves a document nobody can see", async () => {
    // Nothing in the UI would offer to save it, so leaving it dirty would strand
    // the change behind a close prompt for a file the user never opened.
    const doc = __addDoc(FILE, SRC, { visible: false });
    const { provider, lines } = makeProvider(FILE);

    await commit(provider, "width", 90);

    expect(doc.saveCount).toBe(1);
    expect(doc.isDirty).toBe(false);
    expect(lines.join("\n")).toContain("(saved)");
  });

  it("reports an unchanged value as success without editing", async () => {
    const doc = __addDoc(FILE, SRC, { visible: true });
    const { provider } = makeProvider(FILE);

    const r = await commit(provider, "width", 80);

    expect(r.ok).toBe(true);
    expect(r.reason).toBeUndefined();
    expect(doc.text).toBe(SRC);
    expect(doc.isDirty).toBe(false);
  });

  it("declines a computed value and leaves the expression alone", async () => {
    const src = `export const params = { wall: 3, inner: 40 - 2 * wall };`;
    const doc = __addDoc(FILE, src, { visible: true });
    const { provider } = makeProvider(FILE);

    const r = await commit(provider, "inner", 30);

    expect(r).toMatchObject({ ok: false, reason: "not-a-numeric-literal" });
    expect(doc.text).toBe(src);
  });

  it("retires the sidecar pin for the parameter it just committed", async () => {
    // clearSidecarParam touches the real filesystem, so this one needs a real
    // directory — the stubbed editor only fakes the document.
    const dir = mkdtempSync(join(tmpdir(), "commit-sidecar-"));
    const file = join(dir, "bracket.shape.ts");
    writeFileSync(
      join(dir, ".shapeitup-params.json"),
      JSON.stringify({ "bracket.shape.ts": { depth: 999, width: 111 } }),
    );
    __addDoc(file, SRC, { visible: true });
    const { provider } = makeProvider(file);

    const r = await commit(provider, "depth", 65);

    expect(r).toMatchObject({ ok: true, clearedSidecar: true });
    // Only the committed parameter loses its pin.
    expect(JSON.parse(readFileSync(join(dir, ".shapeitup-params.json"), "utf-8"))).toEqual({
      "bracket.shape.ts": { width: 111 },
    });
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports clearedSidecar false when nothing was pinned", async () => {
    const dir = mkdtempSync(join(tmpdir(), "commit-nosidecar-"));
    const file = join(dir, "bracket.shape.ts");
    __addDoc(file, SRC, { visible: true });
    const { provider } = makeProvider(file);

    const r = await commit(provider, "depth", 65);

    expect(r).toMatchObject({ ok: true, clearedSidecar: false });
    expect(existsSync(join(dir, ".shapeitup-params.json"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("declines when no file is open", async () => {
    const { provider } = makeProvider(undefined);
    expect(await commit(provider, "width", 5)).toMatchObject({
      ok: false,
      reason: "no file open",
    });
  });

  it("surfaces an editor that refuses the edit", async () => {
    const doc = __addDoc(FILE, SRC, { visible: true });
    __state.applyEditSucceeds = false;
    const { provider } = makeProvider(FILE);

    expect(await commit(provider, "width", 90)).toMatchObject({
      ok: false,
      reason: "the editor rejected the edit",
    });
    expect(doc.text).toBe(SRC);
  });

  it("reports a failed save on an invisible document", async () => {
    __addDoc(FILE, SRC, { visible: false });
    __state.saveThrows = "EACCES: permission denied";
    const { provider } = makeProvider(FILE);

    const r = await commit(provider, "width", 90);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("edit applied but save failed");
    expect(r.reason).toContain("EACCES");
  });

  it("surfaces an unopenable file rather than throwing", async () => {
    __state.openThrows = "ENOENT: no such file";
    const { provider } = makeProvider(FILE);

    const r = await commit(provider, "width", 90);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("could not open");
  });
});
