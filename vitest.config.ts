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
  test: {
    /**
     * 20 s, up from vitest's 5 s default.
     *
     * A dozen tests in this repo drive real OpenCascade through WASM — export
     * a 3MF, split an assembly into one STEP per part, preview a fillet. Their
     * honest cost is 1.5-6 s, so 5 s was never a limit chosen for them; it was
     * the default, and it left a margin thin enough that they failed whenever
     * the machine was busy. They were failing at load averages of 40-74 while
     * passing in 1.3 s in isolation, which is a flaky suite rather than a slow
     * one — and the noise trains you to ignore red.
     *
     * 20 s is still a real ceiling: a genuinely hung test fails, it does not
     * hang the run.
     */
    testTimeout: 20_000,
  },
  resolve: {
    alias: {
      vscode: resolve(__dirname, "packages/extension/src/testing/vscode-stub.ts"),
    },
  },
});
