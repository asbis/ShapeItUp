import { BUNDLE_EXTERNALS } from "./messages.js";

/**
 * The synthetic wrapper that makes a `.shape.ts` file's exports observable.
 *
 * Importing the user's file through a stdin wrapper — rather than making it
 * the esbuild entry point — is load-bearing. As the entry, esbuild conflates
 * the stdin contents with the module it is asked to `import * from`, tree-shakes
 * the user's code out, and hands back `undefined` for BOTH `default` and
 * `params`. The namespace import gives esbuild a dedicated binding that can't
 * be renamed out from under us.
 *
 * `material` / `config` / `sim` route through the same sentinel-gated globals
 * so a bundled CHILD's `export const material` can't leak onto the assembly
 * via the executor's ambient `typeof material` lookup (wrong BOM mass).
 */
export function buildSyntheticShapeEntry(absPath: string): string {
  const entryImportPath = absPath.replace(/\\/g, "/");
  return (
    `import * as __shapeitup_entry__ from ${JSON.stringify(entryImportPath)};\n` +
    `try { globalThis.__SHAPEITUP_ENTRY_MAIN__ = __shapeitup_entry__.default; } catch (e) {}\n` +
    `try { globalThis.__SHAPEITUP_ENTRY_PARAMS__ = __shapeitup_entry__.params; } catch (e) {}\n` +
    `try { globalThis.__SHAPEITUP_ENTRY_MATERIAL__ = __shapeitup_entry__.material; } catch (e) {}\n` +
    `try { globalThis.__SHAPEITUP_ENTRY_CONFIG__ = __shapeitup_entry__.config; } catch (e) {}\n` +
    `try { globalThis.__SHAPEITUP_ENTRY_SIM__ = __shapeitup_entry__.sim; } catch (e) {}\n` +
    `try { globalThis.__SHAPEITUP_ENTRY_SENTINEL__ = true; } catch (e) {}\n` +
    `export default __shapeitup_entry__.default;\n` +
    `export const params = __shapeitup_entry__.params;\n` +
    `export const material = __shapeitup_entry__.material;\n` +
    `export const config = __shapeitup_entry__.config;\n` +
    `export const sim = __shapeitup_entry__.sim;\n`
  );
}

/**
 * esbuild options every `.shape.ts` bundler must agree on, whatever esbuild
 * flavour it runs (native in `@shapeitup/serve`, `esbuild-wasm` in the MCP
 * engine and the VSCode extension host).
 *
 * The externals list, the `.shape.ts` loader mapping and `resolveExtensions`
 * all have to match across processes: a script that bundles in one and fails
 * in another is exactly the drift `BUNDLE_EXTERNALS` documents.
 *
 * Returned as a plain object rather than a typed `BuildOptions` so this module
 * stays dependency-free — `@shapeitup/shared` must not pull in esbuild.
 */
export function shapeBundleOptions(absPath: string, dirname: string, join: (a: string, b: string) => string) {
  return {
    stdin: {
      contents: buildSyntheticShapeEntry(absPath),
      resolveDir: dirname,
      // MUST differ from `absPath` — see buildSyntheticShapeEntry.
      sourcefile: join(dirname, "__shapeitup_wrapper__.ts"),
      loader: "ts" as const,
    },
    bundle: true,
    write: false,
    format: "esm" as const,
    target: "es2022",
    external: [...BUNDLE_EXTERNALS],
    platform: "neutral" as const,
    absWorkingDir: dirname,
    // esbuild dispatches on the FULL extension, so `.shape.ts` needs an
    // explicit loader; `.shape` covers the form used throughout the skill docs.
    loader: { ".shape.ts": "ts" as const, ".shape": "ts" as const },
    // Defaults first so existing resolution is unchanged; the `.shape`
    // fallbacks let `import { makeBed } from "./needle-bed"` find
    // `needle-bed.shape.ts`.
    resolveExtensions: [".tsx", ".ts", ".jsx", ".js", ".shape.ts", ".shape", ".css", ".json"],
    sourcemap: "inline" as const,
    logLevel: "silent" as const,
  };
}
