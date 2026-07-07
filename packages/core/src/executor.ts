import type { ParamDef } from "@shapeitup/shared";
import { pushRuntimeWarning } from "./stdlib/warnings";
import { MATERIAL_PRESETS, resolveMaterial } from "./tessellate";

/**
 * Extract `export const params = {...}` names from source code without
 * executing the script. Falls back to [] if the declaration is absent
 * or uses a form the regex can't parse (complex computed values, etc.).
 * This is intentionally loose — callers use it only to report "did the
 * user's script declare X?" and are fine with occasional false-empties.
 *
 * Used by the MCP `tune_params` tool so that when a render fails (e.g. a
 * WASM crash leaves `status.currentParams` unset), the status file still
 * carries the declared keys and the agent's "Declared: ..." warning line
 * stays useful instead of collapsing to "Declared: (none)".
 */
export function extractParamsStatic(sourceCode: string): string[] {
  // Locate `export const params = {` and capture the brace-balanced body.
  // The previous implementation used `\{([^}]*)\}` which stopped at the
  // first `}` — that lost every key after a nested object literal AND, more
  // commonly, every key sitting on a line AFTER a `//` line comment because
  // the comment-aware anchoring in the pair regex wasn't reached (the pair
  // regex's `\s*` doesn't skip over `//…\n` or `/*…*/`). We now:
  //   1. Extract the balanced body by brace-counting (handles nested
  //      objects without extra branches).
  //   2. Strip line + block comments from the body before running the pair
  //      regex — ensures a preceding `,` anchor is followed by whitespace,
  //      not comment text.
  const headRe = /export\s+const\s+params\s*=\s*\{/;
  const head = sourceCode.match(headRe);
  if (!head || head.index === undefined) return [];
  const startBrace = head.index + head[0].length; // index AFTER the opening `{`
  let depth = 1;
  let i = startBrace;
  while (i < sourceCode.length && depth > 0) {
    const c = sourceCode[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    i++;
  }
  if (depth !== 0) return []; // unbalanced — bail rather than guess
  const rawBody = sourceCode.slice(startBrace, i - 1);

  // Strip `/* ... */` (non-greedy, spans newlines) and `// ... EOL` comments
  // so a line-comment between two real keys doesn't break the pair anchor.
  // Doing a textual strip is safe here because we only care about TOP-LEVEL
  // keys — we don't need to preserve string-literal contents that happen to
  // contain `//` (string scanning would be nice-to-have but overkill for
  // parameter declarations).
  const body = rawBody
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

  const keys: string[] = [];
  // Match key: value pairs — key is a plain identifier or quoted string.
  // Anchor on either start-of-body or a preceding `,` / `{` so we don't
  // mistake an inner object literal's field for a top-level key.
  //
  // Two trailing forms accepted:
  //   1. `key:` — the classic `key: value` form (including quoted keys).
  //   2. `key,` / `key}` / `key` at end-of-body — ES2015 shorthand
  //      (`{ length, width }`) where the identifier IS the key.
  //
  // Depth tracking in the scan skips keys inside nested braces — otherwise
  // `{ a: 1, opts: { b: 2 }, c: 3 }` would surface `b` as a top-level key.
  const pairPattern =
    /(?:^|[,{])\s*(?:"([^"]+)"|'([^']+)'|(\w+))\s*(?::|(?=\s*[,}])|\s*$)/g;
  let m: RegExpExecArray | null;
  while ((m = pairPattern.exec(body)) !== null) {
    const name = m[1] || m[2] || m[3];
    if (!name) continue;
    // Count `{` / `}` up to AND INCLUDING the anchor character (the `{`
    // that triggered a nested-object match lives at m.index when the
    // anchor class matched `{`). Keys inside a nested object land with
    // nestedDepth > 0 and are skipped.
    const upToAnchor = body.slice(0, m.index + 1);
    let nestedDepth = 0;
    for (const c of upToAnchor) {
      if (c === "{") nestedDepth++;
      else if (c === "}") nestedDepth--;
    }
    if (nestedDepth <= 0) keys.push(name);
  }
  return keys;
}

/**
 * Extract `export const config = { strict: true, meshQuality: "preview" }`
 * from source without executing the script. Parallels
 * {@link extractParamsStatic} — same source-shape assumptions (esbuild ESM
 * output or hand-written TS), same loose regex that falls through to `{}`
 * when the declaration is absent or the value is too complex (spreads,
 * computed keys).
 *
 * Recognised keys:
 *   - `strict` (boolean) — opt-in promotion of silent-success warnings to
 *     thrown errors.
 *   - `meshQuality` (`"preview"` | `"final"`) — override tessellation
 *     quality for single-part scripts. Overrides the core's auto-degrade
 *     heuristic (which only kicks in past 15 parts or 50k projected
 *     triangles) so users with a single sweep-heavy part can opt into the
 *     coarse mesh for faster iteration.
 *   - `localFrame` (boolean) — this file defines an INTERMEDIATE part
 *     authored in its own local frame (e.g. a `needle.shape.ts` imported by
 *     an assembly) rather than a top-level design. Suppresses the
 *     "extends below z=0" rotation-direction hint, which is routine noise
 *     on such parts because they live in their local frame and are
 *     positioned at assembly time.
 *
 * Other keys are extracted but ignored — space left so later issues can add
 * flags without changing the extractor's signature.
 */
export function extractConfigStatic(
  sourceCode: string,
): { strict?: boolean; meshQuality?: "preview" | "final"; localFrame?: boolean } {
  const match = sourceCode.match(/export\s+const\s+config\s*=\s*\{([^}]*)\}/s);
  if (!match) return {};
  const body = match[1];
  // Boolean-pair pattern matches `key: true|false`. Handles quoted keys
  // (`"strict": true`) and trailing commas.
  const boolPairPattern =
    /(?:^|[,{])\s*(?:"([^"]+)"|'([^']+)'|(\w+))\s*:\s*(true|false)\b/g;
  // String-pair pattern matches `key: "value"` (or `'value'`) — restricted
  // to meshQuality's enum values so we don't accidentally pick up material
  // names or other future string keys.
  const stringPairPattern =
    /(?:^|[,{])\s*(?:"([^"]+)"|'([^']+)'|(\w+))\s*:\s*["'](preview|final)["']/g;
  const config: { strict?: boolean; meshQuality?: "preview" | "final"; localFrame?: boolean } = {};
  let m: RegExpExecArray | null;
  while ((m = boolPairPattern.exec(body)) !== null) {
    const name = m[1] || m[2] || m[3];
    const value = m[4] === "true";
    if (name === "strict") config.strict = value;
    else if (name === "localFrame") config.localFrame = value;
  }
  while ((m = stringPairPattern.exec(body)) !== null) {
    const name = m[1] || m[2] || m[3];
    const value = m[4] as "preview" | "final";
    if (name === "meshQuality") config.meshQuality = value;
  }
  return config;
}

/**
 * Statically extracts `export const expectedContacts = [["a","b"], ...]` from a
 * shape-file source. Used by `check_collisions` to auto-merge shape-authored
 * acceptance rules into the user's `acceptedPairs` argument. Tolerates glob
 * patterns (`*`) — downstream matcher handles them.
 *
 * Returns `[]` if the export is absent, malformed, or empty.
 */
export function extractExpectedContactsStatic(src: string): Array<[string, string]> {
  // Greedy outer capture: the payload contains nested `[...]` pair literals,
  // so a lazy `[\s\S]*?` would stop at the first inner `]` and miss every
  // pair after the first. Greedy `[\s\S]*` together with the trailing `\]`
  // extends to the LAST `]` in the file — fine because the pair-matcher
  // below ignores non-pair noise (closing braces, semicolons, etc.).
  const m = src.match(/export\s+const\s+expectedContacts\s*=\s*\[([\s\S]*)\]\s*;?/);
  if (!m) return [];
  const pairs: Array<[string, string]> = [];
  const pairRe = /\[\s*["']([^"']+)["']\s*,\s*["']([^"']+)["']\s*\]/g;
  let p: RegExpExecArray | null;
  while ((p = pairRe.exec(m[1])) !== null) pairs.push([p[1], p[2]]);
  return pairs;
}

/**
 * Phase A of script execution: rewrite user imports/exports so the bundled JS
 * can run inside a `new Function(...)` wrapper.
 *
 * Callers (both the VSCode extension and the MCP engine) always run the user
 * script through esbuild first, so the input to this transform is canonical
 * esbuild ESM output: top-level `var`/`function` declarations with a single
 * trailing `export { main as default, ... }` block. That narrows the surface
 * area to three rewrites:
 *   - `import { x } from "replicad"`      → `const { x } = __replicad__;`
 *   - `import { x as y } from "replicad"` → `const { x: y } = __replicad__;`
 *   - `import * as r from "replicad"`     → `const r = __replicad__;`
 *   - `import r from "replicad"`          → `const r = __replicad__.default || __replicad__;`
 *   - same four forms for the `"shapeitup"` stdlib
 *   - trailing `export { ... };` block    → stripped
 */
export function rewriteImports(js: string): string {
  let code = js;

  code = code.replace(
    /import\s*\{([^}]+)\}\s*from\s*["']replicad["']\s*;?/g,
    (_, imports) => {
      const fixed = imports.replace(/(\w+)\s+as\s+(\w+)/g, "$1: $2");
      return `const {${fixed}} = __replicad__;`;
    }
  );

  code = code.replace(
    /import\s*\*\s*as\s+(\w+)\s+from\s*["']replicad["']\s*;?/g,
    (_, name) => `const ${name} = __replicad__;`
  );

  code = code.replace(
    /import\s+(\w+)\s+from\s*["']replicad["']\s*;?/g,
    (_, name) => `const ${name} = __replicad__.default || __replicad__;`
  );

  code = code.replace(
    /import\s*\{([^}]+)\}\s*from\s*["']shapeitup["']\s*;?/g,
    (_, imports) => {
      const fixed = imports.replace(/(\w+)\s+as\s+(\w+)/g, "$1: $2");
      return `const {${fixed}} = __shapeitup__;`;
    }
  );

  code = code.replace(
    /import\s*\*\s*as\s+(\w+)\s+from\s*["']shapeitup["']\s*;?/g,
    (_, name) => `const ${name} = __shapeitup__;`
  );

  code = code.replace(
    /import\s+(\w+)\s+from\s*["']shapeitup["']\s*;?/g,
    (_, name) => `const ${name} = __shapeitup__.default || __shapeitup__;`
  );

  code = code.replace(/export\s*\{[^}]*\}\s*;?/g, "");

  // Esbuild ESM output inserts a `__require` shim for any leftover `require(...)`
  // calls (typically introduced when the user or a transitively-imported file
  // uses CJS `const x = require("replicad")` instead of an ESM `import`). That
  // shim throws "Dynamic require of X is not supported" at runtime because
  // `require` isn't defined in our `new Function(...)` sandbox. Rewrite the two
  // module names we DO provide through the sandbox globals, so CJS-shaped user
  // code works without an extra build-time step.
  code = code.replace(
    /__require\s*\(\s*["']replicad["']\s*\)/g,
    "__replicad__",
  );
  code = code.replace(
    /__require\s*\(\s*["']shapeitup["']\s*\)/g,
    "__shapeitup__",
  );

  return code;
}

/**
 * Execute a user .shape.ts script (already transpiled/bundled to JS).
 *
 * Scripts can export a `params` object for slider support:
 *   export const params = { width: 50, height: 30, radius: 5 };
 *   export default function main({ width, height, radius }) { ... }
 *
 * By the time the JS reaches this function, esbuild has rewritten those
 * forms to `var params = {...}` + a trailing `export { main as default, params }`
 * block — the shape `rewriteImports` expects.
 */
export function executeScript(
  js: string,
  replicadExports: Record<string, any>,
  shapeitupExports: Record<string, any>,
  paramOverrides?: Record<string, number | boolean | string>,
  /**
   * Absolute path (or file:// URL) of the user's entry `.shape.ts` file.
   *
   * When provided, a `//# sourceURL=...` V8 pragma is emitted at the top of
   * the `new Function(...)` source. Combined with the inline sourcemap the
   * runtime bundler now embeds (`sourcemap: "inline"`), this makes stack
   * traces resolve to `bracket.shape.ts:12:14` instead of the useless
   * `Object.<anonymous>:48:52`. V8 reads the `sourceURL` directive first,
   * then walks the inline sourcemap automatically — no extra dependencies.
   *
   * Callers that can't plumb the filename through (tests, direct users of
   * `executeScript`) can omit this argument. If `js` contains a leading
   * `//# sourceURL=` magic comment, we extract the URL from there as a
   * graceful fallback — this is the path the VSCode extension and MCP
   * engine use, since they can't add a parameter to `core.execute()`.
   */
  fileName?: string,
): {
  result: any;
  params: ParamDef[];
  material?: { density: number; name?: string };
  config?: { strict?: boolean; meshQuality?: "preview" | "final" };
  /** Raw `export const sim = {...}` authoring block, passed through unvalidated. */
  sim?: unknown;
} {
  // Graceful fallback: callers that go through `core.execute()` can't extend
  // that signature (owned by another agent), so they prepend a
  // `//# sourceURL=file:///...` comment to the bundled JS instead. Extract
  // it here so we can move it to the final wrapper's top — V8 honours the
  // directive anywhere in the script body, but putting it ABOVE the IIFE
  // gives the clearest attribution for unhandled-error stack frames.
  let resolvedSourceURL: string | undefined = fileName;
  let jsForRewrite = js;
  if (!resolvedSourceURL) {
    const leadingMatch = jsForRewrite.match(/^\/\/#\s*sourceURL=(\S+)\s*\r?\n/);
    if (leadingMatch) {
      resolvedSourceURL = leadingMatch[1];
      jsForRewrite = jsForRewrite.slice(leadingMatch[0].length);
    }
  }

  // Normalise a bare absolute path to a `file:///` URL. Pass a URL through
  // unchanged — the extension host already hands us one. On Windows this
  // turns `C:\Users\x\part.shape.ts` into `file:///C:/Users/x/part.shape.ts`.
  let sourceURLDirective = "";
  if (resolvedSourceURL) {
    const url = /^[a-z]+:\/\//i.test(resolvedSourceURL)
      ? resolvedSourceURL
      : `file:///${resolvedSourceURL.replace(/\\/g, "/").replace(/^\/+/, "")}`;
    sourceURLDirective = `//# sourceURL=${url}\n`;
  }

  const code = rewriteImports(jsForRewrite);

  // Multi-file .shape.ts bundles: the `__SHAPEITUP_ENTRY_MAIN__` /
  // `__SHAPEITUP_ENTRY_PARAMS__` globals (set by the esbuild footer in both
  // the extension host and the MCP engine at bundle time) resolve the entry's
  // `main`/`params` regardless of how esbuild renames the imported modules'
  // bindings. No runtime warning is needed — the previous advisory scan fired
  // on the skill-docs-recommended "export default main alongside named
  // factory" pattern, i.e. it punished correct usage.

  const wrapped = `
    return (function(__replicad__, __shapeitup__, __paramOverrides__) {
      function highlightFinder(__shape__, __finder__, __opts__) {
        __opts__ = __opts__ || {};
        var matches = __finder__.find(__shape__);
        var highlightColor = __opts__.color || "#ff3366";
        var shapeColor = __opts__.shapeColor || null;
        if (!matches || matches.length === 0) {
          return [{ shape: __shape__, name: "shape (0 matches)", color: shapeColor }];
        }
        var radius = __opts__.radius;
        if (!radius) {
          try {
            var bb = __shape__.boundingBox;
            var w = bb.width != null ? bb.width : (bb.max && bb.min ? bb.max[0] - bb.min[0] : 10);
            var h = bb.height != null ? bb.height : (bb.max && bb.min ? bb.max[1] - bb.min[1] : 10);
            var d = bb.depth != null ? bb.depth : (bb.max && bb.min ? bb.max[2] - bb.min[2] : 10);
            radius = Math.max(w, h, d, 10) * 0.025;
          } catch (e) { radius = 1; }
        }
        var markers = [];
        for (var i = 0; i < matches.length; i++) {
          var m = matches[i];
          var pt;
          try {
            if (typeof m.pointAt === "function") pt = m.pointAt(0.5);
            else if (m.center) pt = m.center;
            else pt = { x: 0, y: 0, z: 0 };
          } catch (e) { pt = { x: 0, y: 0, z: 0 }; }
          var px = pt.x != null ? pt.x : (Array.isArray(pt) ? pt[0] : 0);
          var py = pt.y != null ? pt.y : (Array.isArray(pt) ? pt[1] : 0);
          var pz = pt.z != null ? pt.z : (Array.isArray(pt) ? pt[2] : 0);
          var sphere = __replicad__.makeSphere(radius).translate(px, py, pz);
          markers.push(sphere);
        }
        var compound = __replicad__.compoundShapes(markers);
        return [
          { shape: __shape__, name: "shape", color: shapeColor },
          { shape: compound, name: matches.length + " matches", color: highlightColor },
        ];
      }

      ${code}

      // Prefer the canonical entry markers when present — but only when the
      // synthetic-wrapper sentinel flag is set in this same bundle. Both
      // bundling call sites (viewer-provider.ts + engine.ts) wrap the entry
      // in a synthetic stdin module that namespace-imports the user's file
      // and stamps __SHAPEITUP_ENTRY_MAIN__ / __SHAPEITUP_ENTRY_PARAMS__ /
      // __SHAPEITUP_ENTRY_SENTINEL__ onto globalThis. The sentinel gate
      // protects against two failure modes:
      //   1. A stale marker left by a prior execution in a long-lived
      //      process (MCP engine) leaking into a new script.
      //   2. A hypothetical future bundler dropping the wrapper but
      //      leaving the reader path — we must NOT pick up whatever
      //      happens to live at that key.
      //
      // All three globals are cleared immediately after reading so the next
      // execution starts from a clean slate even if its own wrapper fails
      // to set them for some reason.
      var __entrySentinel__ = (typeof globalThis !== "undefined" && globalThis.__SHAPEITUP_ENTRY_SENTINEL__ === true);
      var __entryMain__ = __entrySentinel__
        ? (typeof globalThis !== "undefined" ? globalThis.__SHAPEITUP_ENTRY_MAIN__ : undefined)
        : undefined;
      var __entryParams__ = __entrySentinel__
        ? (typeof globalThis !== "undefined" ? globalThis.__SHAPEITUP_ENTRY_PARAMS__ : undefined)
        : undefined;
      // Material/config flow through the same gate so a bundled child's
      // top-level material const can't leak onto the assembly. Captured so we
      // can distinguish "entry declared none" (undefined) from "no synthetic
      // wrapper" (fall back to the ambient lookup below).
      var __entryMaterial__ = __entrySentinel__
        ? (typeof globalThis !== "undefined" ? globalThis.__SHAPEITUP_ENTRY_MATERIAL__ : undefined)
        : undefined;
      var __entryConfig__ = __entrySentinel__
        ? (typeof globalThis !== "undefined" ? globalThis.__SHAPEITUP_ENTRY_CONFIG__ : undefined)
        : undefined;
      // Simulation block (export const sim) flows through the same entry-marker
      // gate so a bundled child's sim const can't leak onto the top-level
      // assembly.
      var __entrySim__ = __entrySentinel__
        ? (typeof globalThis !== "undefined" ? globalThis.__SHAPEITUP_ENTRY_SIM__ : undefined)
        : undefined;
      try {
        if (typeof globalThis !== "undefined") {
          globalThis.__SHAPEITUP_ENTRY_MAIN__ = undefined;
          globalThis.__SHAPEITUP_ENTRY_PARAMS__ = undefined;
          globalThis.__SHAPEITUP_ENTRY_MATERIAL__ = undefined;
          globalThis.__SHAPEITUP_ENTRY_CONFIG__ = undefined;
          globalThis.__SHAPEITUP_ENTRY_SIM__ = undefined;
          globalThis.__SHAPEITUP_ENTRY_SENTINEL__ = undefined;
        }
      } catch (e) {}

      var __resolvedMain__ = (typeof __entryMain__ === "function")
        ? __entryMain__
        : (typeof main !== "undefined" ? main : undefined);
      var __resolvedParams__ = (__entryParams__ && typeof __entryParams__ === "object")
        ? __entryParams__
        : (typeof params !== "undefined" ? params : {});

      var __params__ = __resolvedParams__ || {};

      if (__paramOverrides__) {
        for (var k in __paramOverrides__) {
          if (k in __params__) __params__[k] = __paramOverrides__[k];
        }
      }

      var __result__;
      if (typeof __resolvedMain__ === "function") {
        if (__resolvedMain__.length > 0) {
          __result__ = __resolvedMain__(__params__);
        } else {
          __result__ = __resolvedMain__();
        }
      } else {
        throw new Error("Script must export a default function named 'main'");
      }

      // Under the synthetic wrapper, the entry marker is authoritative (even
      // when undefined) — this is what stops a bundled child's material const
      // from leaking onto the assembly. Without the wrapper (single-file
      // ambient path), fall back to the in-scope material / config binding.
      var __material__ = __entrySentinel__
        ? __entryMaterial__
        : (typeof material !== "undefined" ? material : undefined);
      var __config__ = __entrySentinel__
        ? __entryConfig__
        : (typeof config !== "undefined" ? config : undefined);
      var __sim__ = __entrySentinel__
        ? __entrySim__
        : (typeof sim !== "undefined" ? sim : undefined);

      return { result: __result__, params: __params__, material: __material__, config: __config__, sim: __sim__ };
    })(__replicadExports__, __shapeitupExports__, __paramOverrides__);
  `;

  // Prepend the V8 `sourceURL` pragma so stack traces from user code are
  // attributed to `file:///.../bracket.shape.ts` instead of
  // `Object.<anonymous>`. The inline sourcemap that the runtime bundlers
  // (viewer-provider.ts, mcp-server engine.ts) now embed handles the
  // column/line resolution back to the original `.shape.ts`.
  //
  // Caveat: `new Function()` synthesises its own wrapper (`function anonymous
  // (__replicadExports__, ...) { <wrapped> }`), which pushes the user's code
  // down by ~2 lines in the raw frame. Esbuild's sourcemap is computed
  // against the original `.shape.ts`, not the wrapped output, so when V8
  // rewrites the frame through the sourcemap the offset disappears. If you
  // ever see "off by one line" in a stack trace, this is where to look.
  const wrappedWithSource = sourceURLDirective + wrapped;

  const fn = new Function(
    "__replicadExports__",
    "__shapeitupExports__",
    "__paramOverrides__",
    wrappedWithSource
  );
  const { result, params, material: rawMaterial, config: rawConfig, sim: rawSim } = fn(
    replicadExports,
    shapeitupExports,
    paramOverrides || null
  );

  // Resolve the script-level `export const material = ...` via the shared
  // resolver (also used per-part inside `normalizeParts`). Unknown strings
  // emit a runtime warning so a typo is visible instead of silently losing
  // mass data; malformed objects (NaN density, missing density, etc.) are
  // dropped silently so downstream code can treat `material` as
  // "present ⇒ usable".
  const matRes = resolveMaterial(rawMaterial);
  let material: { density: number; name?: string } | undefined;
  if (matRes.ok) {
    material = matRes.material;
  } else if (matRes.reason === "unknown-preset") {
    pushRuntimeWarning(
      `Unknown material preset '${matRes.given}'. Known presets: ${Object.keys(MATERIAL_PRESETS).join(", ")}. Use { density: number } for custom densities.`,
    );
  }

  const paramDefs: ParamDef[] = Object.entries(params).map(([name, value]) => {
    const v = value as number;
    return {
      name,
      value: v,
      min: v > 0 ? 0 : v * 3,
      max: v > 0 ? v * 3 : 0,
      step: Math.abs(v) >= 10 ? 1 : 0.1,
    };
  });

  // Feature #3: surface an `export const config` only when it's shaped
  // like the expected flag bag. Unknown / malformed values are dropped
  // silently so the user gets default (non-strict) behaviour instead of
  // a confusing crash. `strict` must be a literal `true` to opt in —
  // truthy non-booleans (e.g. `"yes"`, `1`) don't count. `meshQuality`
  // must be the exact string `"preview"` or `"final"` — any other value
  // (numbers, unrelated strings, objects) is dropped so the core's
  // auto-degrade heuristic still runs.
  let config: { strict?: boolean; meshQuality?: "preview" | "final" } | undefined;
  if (rawConfig && typeof rawConfig === "object") {
    const next: { strict?: boolean; meshQuality?: "preview" | "final" } = {};
    if (rawConfig.strict === true) next.strict = true;
    if (rawConfig.meshQuality === "preview" || rawConfig.meshQuality === "final") {
      next.meshQuality = rawConfig.meshQuality;
    }
    if (Object.keys(next).length > 0) config = next;
  }

  // Pass the `sim` block through only when it's a plain object — the viewer/MCP
  // validate its shape (via @shapeitup/sim's isSimSpecInput) before using it.
  const sim =
    rawSim && typeof rawSim === "object" && !Array.isArray(rawSim) ? rawSim : undefined;

  return { result, params: paramDefs, material, config, sim };
}
