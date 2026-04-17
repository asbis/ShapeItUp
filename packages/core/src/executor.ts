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
  shapeitupExports: Record<string, any>,
  paramOverrides?: Record<string, number>
): { result: any; params: ParamDef[]; material?: { density: number; name?: string } } {
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

  // ShapeItUp stdlib: `import { holes, screws } from "shapeitup"` →
  // destructure from the injected __shapeitup__ object. Same three forms as
  // the replicad rewriter above (named, namespace, default).
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

  code = code.replace(
    /export\s+default\s+function\s+(\w+)/g,
    "function $1"
  );

  code = code.replace(
    /export\s+default\s+function\s*\(/g,
    "const __default__ = function("
  );

  let paramsCode = "";
  code = code.replace(
    /export\s+const\s+params\s*=\s*(\{[^}]+\})\s*;?/g,
    (_, obj) => {
      paramsCode = obj;
      return `const params = ${obj};`;
    }
  );

  code = code.replace(
    /export\s+const\s+material\s*=\s*(\{[^}]+\})\s*;?/g,
    (_, obj) => `const material = ${obj};`
  );

  code = code.replace(/export\s*\{[^}]*\}\s*;?/g, "");
  code = code.replace(/export\s+/g, "");

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

      var __params__ = typeof params !== "undefined" ? params : {};

      if (__paramOverrides__) {
        for (var k in __paramOverrides__) {
          if (k in __params__) __params__[k] = __paramOverrides__[k];
        }
      }

      var __result__;
      if (typeof main === "function") {
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

      var __material__ = typeof material !== "undefined" ? material : undefined;

      return { result: __result__, params: __params__, material: __material__ };
    })(__replicadExports__, __shapeitupExports__, __paramOverrides__);
  `;

  const fn = new Function(
    "__replicadExports__",
    "__shapeitupExports__",
    "__paramOverrides__",
    wrapped
  );
  const { result, params, material: rawMaterial } = fn(
    replicadExports,
    shapeitupExports,
    paramOverrides || null
  );

  // Validate: only surface a material object when density is strictly a
  // finite positive number. Strings, 0, negatives, NaN all get dropped so
  // downstream code can treat `material` as "present ⇒ usable".
  let material: { density: number; name?: string } | undefined;
  if (
    rawMaterial &&
    typeof rawMaterial === "object" &&
    typeof rawMaterial.density === "number" &&
    Number.isFinite(rawMaterial.density) &&
    rawMaterial.density > 0
  ) {
    material = { density: rawMaterial.density };
    if (typeof rawMaterial.name === "string" && rawMaterial.name.length > 0) {
      material.name = rawMaterial.name;
    }
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

  return { result, params: paramDefs, material };
}
