/**
 * Unit tests for the stub-installer helpers used on extension activation.
 *
 * These exercise the pure-fs paths without VSCode. The real activation code
 * gates on `vscode.workspace.findFiles` for `.shape.ts` before calling
 * installStub, so here we simulate a pre-built extension typings tree and a
 * user workspace under tmp directories.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  installStub,
  workspaceHasReplicadDependency,
  ensureMinimalTsconfig,
} from "./workspace-types";

function makeTypings(root: string, name: string, indexBody: string) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.d.ts"), indexBody);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name, version: "0.0.0-bundled", types: "./index.d.ts" }) + "\n"
  );
  return dir;
}

describe("workspaceHasReplicadDependency", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "shapeitup-test-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns false when no package.json exists", () => {
    expect(workspaceHasReplicadDependency(tmp)).toBe(false);
  });

  it("returns false when package.json has no replicad entry", () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ dependencies: { lodash: "^4.0.0" } })
    );
    expect(workspaceHasReplicadDependency(tmp)).toBe(false);
  });

  it("returns true when replicad is a runtime dependency", () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ dependencies: { replicad: "^0.23.0" } })
    );
    expect(workspaceHasReplicadDependency(tmp)).toBe(true);
  });

  it("returns true when replicad is a dev dependency", () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ devDependencies: { replicad: "^0.23.0" } })
    );
    expect(workspaceHasReplicadDependency(tmp)).toBe(true);
  });

  it("returns false on malformed package.json", () => {
    writeFileSync(join(tmp, "package.json"), "{ not json");
    expect(workspaceHasReplicadDependency(tmp)).toBe(false);
  });
});

describe("installStub", () => {
  let tmp: string;
  let typingsRoot: string;
  let wsRoot: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "shapeitup-test-"));
    typingsRoot = join(tmp, "typings");
    wsRoot = join(tmp, "workspace");
    mkdirSync(typingsRoot, { recursive: true });
    mkdirSync(wsRoot, { recursive: true });
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("writes stub files into <ws>/node_modules/<name>/", () => {
    const src = makeTypings(typingsRoot, "shapeitup", "export declare const x: number;\n");
    const written = installStub(wsRoot, "shapeitup", src);
    expect(written).toBe(true);

    const dest = join(wsRoot, "node_modules", "shapeitup");
    expect(existsSync(join(dest, "index.d.ts"))).toBe(true);
    expect(existsSync(join(dest, "package.json"))).toBe(true);

    const pkg = JSON.parse(readFileSync(join(dest, "package.json"), "utf-8"));
    expect(pkg.name).toBe("shapeitup");
    expect(pkg.version).toContain("bundled");
  });

  it("is idempotent: second call with identical content returns false", () => {
    const src = makeTypings(typingsRoot, "shapeitup", "export declare const x: number;\n");
    expect(installStub(wsRoot, "shapeitup", src)).toBe(true);
    expect(installStub(wsRoot, "shapeitup", src)).toBe(false);
  });

  it("rewrites when the source index.d.ts size changes", () => {
    const src = makeTypings(typingsRoot, "shapeitup", "export declare const x: number;\n");
    expect(installStub(wsRoot, "shapeitup", src)).toBe(true);

    // Change source size by adding content.
    writeFileSync(join(src, "index.d.ts"), "export declare const x: number;\nexport declare const y: string;\n");
    expect(installStub(wsRoot, "shapeitup", src)).toBe(true);

    const dest = join(wsRoot, "node_modules", "shapeitup", "index.d.ts");
    expect(readFileSync(dest, "utf-8")).toContain("y: string");
  });

  it("skips (returns false) when destination looks like a real install (no bundled marker)", () => {
    const src = makeTypings(typingsRoot, "shapeitup", "export declare const x: number;\n");

    // Simulate a pre-existing real install with matching size but non-bundled version.
    const dest = join(wsRoot, "node_modules", "shapeitup");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "index.d.ts"), "export declare const x: number;\n");
    writeFileSync(
      join(dest, "package.json"),
      JSON.stringify({ name: "shapeitup", version: "1.0.0" })
    );

    // Size matches + no "bundled" marker → skip.
    expect(installStub(wsRoot, "shapeitup", src)).toBe(false);
    const pkg = JSON.parse(readFileSync(join(dest, "package.json"), "utf-8"));
    expect(pkg.version).toBe("1.0.0");
  });

  it("copies nested directories (e.g. shapeitup/stdlib/*.d.ts)", () => {
    const src = makeTypings(typingsRoot, "shapeitup", "export * from \"./stdlib/index\";\n");
    mkdirSync(join(src, "stdlib"), { recursive: true });
    writeFileSync(join(src, "stdlib", "index.d.ts"), "export declare const holes: any;\n");

    expect(installStub(wsRoot, "shapeitup", src)).toBe(true);
    const destStdlib = join(wsRoot, "node_modules", "shapeitup", "stdlib", "index.d.ts");
    expect(existsSync(destStdlib)).toBe(true);
    expect(readFileSync(destStdlib, "utf-8")).toContain("holes: any");
  });
});

describe("ensureMinimalTsconfig", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "shapeitup-test-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("creates tsconfig.json when none exists", () => {
    expect(ensureMinimalTsconfig(tmp)).toBe(true);
    const cfg = JSON.parse(readFileSync(join(tmp, "tsconfig.json"), "utf-8"));
    expect(cfg.include).toEqual(["**/*.shape.ts"]);
    expect(cfg.compilerOptions.moduleResolution).toBe("bundler");
  });

  it("leaves existing tsconfig.json alone", () => {
    const existing = JSON.stringify({ extends: "./custom.json" });
    writeFileSync(join(tmp, "tsconfig.json"), existing);
    expect(ensureMinimalTsconfig(tmp)).toBe(false);
    expect(readFileSync(join(tmp, "tsconfig.json"), "utf-8")).toBe(existing);
  });
});
