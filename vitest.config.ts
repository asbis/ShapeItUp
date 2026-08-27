import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

/**
 * First vitest config in the repo — added only to alias `vscode`.
 *
 * The extension host imports `vscode`, a module that exists only inside a
 * running VS Code, so extension code could not be imported under vitest at all.
 * The workaround until now was to copy methods under test verbatim into a
 * "double" (see viewer-provider.pending-render.test.ts, which carries a standing
 * warning to keep the copy in sync). Aliasing the module lets tests exercise the
 * real implementation instead.
 *
 * Test discovery is deliberately left at the default so this change cannot move
 * which tests run.
 */
export default defineConfig({
  resolve: {
    alias: {
      vscode: resolve(__dirname, "packages/extension/src/testing/vscode-stub.ts"),
    },
  },
});
