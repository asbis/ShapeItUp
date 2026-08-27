import * as path from "node:path";
import * as esbuild from "esbuild";
import { shapeBundleOptions } from "@shapeitup/shared";

/**
 * Bundle a `.shape.ts` entry with the native esbuild binary.
 *
 * Used by the standalone CLI. The MCP server injects its own `esbuild-wasm`
 * bundler instead (it already carries one, and a native binary can't be
 * bundled into the published npm package) — both share `shapeBundleOptions`
 * so the two flavours can't drift.
 */
export async function bundleShapeFile(entry: string): Promise<string> {
  const abs = path.resolve(entry).split(path.sep).join("/");
  const dir = path.dirname(abs);
  const result = await esbuild.build(
    shapeBundleOptions(abs, dir, path.join) as esbuild.BuildOptions & { write: false },
  );
  return result.outputFiles![0].text;
}
