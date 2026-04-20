// Assembly module C — the entry file.
//
// Imports named factories from A and B to build a 2-part assembly. Before
// the multi-file entry-disambiguation fix, the fact that A and B each had
// their own `export default function main` caused esbuild to inline all of
// them into the bundle; the executor's ambient-lookup for `main` then
// picked the last-declared bundled main (usually an imported one), so the
// render silently produced one part instead of two. The canonical
// `__SHAPEITUP_ENTRY_MAIN__` marker injected via esbuild's footer now
// guarantees this assembly's `main` wins.
//
// Expected render: 2 parts ("partA" box + "partB" cylinder).
import { makePartA } from "./A.shape";
import { makePartB } from "./B.shape";

export const params = {
  scale: 1,
};

export default function main() {
  const a = makePartA();
  const b = makePartB();
  return [
    { shape: a, name: "partA", color: "#8899aa" },
    { shape: b, name: "partB", color: "#aa8855" },
  ];
}
