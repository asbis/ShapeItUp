import type { ParamDef } from "@shapeitup/shared";

/**
 * Execute a user .shape.ts script (already transpiled/bundled to JS).
 *
 * Scripts can export a `params` object for slider support:
 *   export const params = { width: 50, height: 30, radius: 5 };
 *   export default function main({ width, height, radius }) { ... }
 *
 * Or use default function params (auto-detected):
 *   export default function main(width = 50, height = 30) { ... }
 */
export function executeScript(
  js: string,
  replicadExports: Record<string, any>,
  paramOverrides?: Record<string, number>
): { result: any; params: ParamDef[] } {
  // Rewrite: import { X, Y } from "replicad" → const { X, Y } = __replicad__;
  // ESM uses "as" for renaming, JS destructuring uses ":"
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
    /export\s+default\s+function\s+(\w+)/g,
    "function $1"
  );

  code = code.replace(
    /export\s+default\s+function\s*\(/g,
    "const __default__ = function("
  );

  // Remove export blocks but capture `export const params = ...`
  // We need to extract params before removing exports
  let paramsCode = "";
  code = code.replace(
    /export\s+const\s+params\s*=\s*(\{[^}]+\})\s*;?/g,
    (_, obj) => {
      paramsCode = obj;
      return `const params = ${obj};`;
    }
  );

  code = code.replace(/export\s*\{[^}]*\}\s*;?/g, "");
  code = code.replace(/export\s+/g, "");

  // Build the execution wrapper
  const wrapped = `
    return (function(__replicad__, __paramOverrides__) {
      ${code}

      // Collect params
      var __params__ = typeof params !== "undefined" ? params : {};

      // Apply overrides
      if (__paramOverrides__) {
        for (var k in __paramOverrides__) {
          if (k in __params__) __params__[k] = __paramOverrides__[k];
        }
      }

      // Call main
      var __result__;
      if (typeof main === "function") {
        // If main takes an argument, pass params object
        if (main.length > 0) {
          __result__ = main(__params__);
        } else {
          __result__ = main();
        }
      } else if (typeof __default__ === "function") {
        if (__default__.length > 0) {
          __result__ = __default__(__params__);
        } else {
          __result__ = __default__();
        }
      } else {
        throw new Error("Script must export a default function named 'main'");
      }

      return { result: __result__, params: __params__ };
    })(__replicadExports__, __paramOverrides__);
  `;

  const fn = new Function("__replicadExports__", "__paramOverrides__", wrapped);
  const { result, params } = fn(replicadExports, paramOverrides || null);

  // Convert params object to ParamDef array
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

  return { result, params: paramDefs };
}
