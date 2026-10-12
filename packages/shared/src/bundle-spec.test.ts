import { describe, expect, it } from "vitest";
import { buildSyntheticShapeEntry, isOptionalReexportWarning } from "./bundle-spec.js";

// esbuild's text for an import the wrapper makes that the user's file doesn't
// satisfy, e.g. `export const sim = __shapeitup_entry__.sim;`.
const warning = (name: string) =>
  `Import "${name}" will always be undefined because there is no matching export in "bracket.shape.ts"`;

describe("isOptionalReexportWarning", () => {
  it("covers every optional name the synthetic wrapper re-exports", () => {
    const wrapper = buildSyntheticShapeEntry("/tmp/bracket.shape.ts");
    const names = [...wrapper.matchAll(/^export const (\w+) =/gm)].map((m) => m[1]);
    expect(names).toContain("sim");
    for (const name of names) {
      expect(isOptionalReexportWarning(warning(name)), name).toBe(true);
    }
  });

  it("keeps the same warning for a user's own missing import", () => {
    expect(isOptionalReexportWarning(warning("bracketWidth"))).toBe(false);
    expect(isOptionalReexportWarning(warning("simulate"))).toBe(false);
  });
});
