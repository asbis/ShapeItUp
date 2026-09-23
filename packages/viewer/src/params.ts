/**
 * Pure helpers for the Parameters panel, kept out of index.ts so they can be
 * tested without a DOM or a worker.
 *
 * A parameter is not always a number. The stdlib takes string designators
 * (`bearing: "608"`, `size: "M4"`) and the executor passes them through as
 * overrides, so a shape declaring one is perfectly valid. The panel's field is
 * a number field, though — wheel nudges, arrow steps, `param-changed`
 * writeback through `computeParamEdit` — so only numbers get one. Anything else
 * is shown read-only: you can see what the model was built with, and edit it
 * in the file.
 */
import type { ParamDef, ParamValue } from "@shapeitup/shared";

/** Whether the panel gives this parameter an adjustable field. */
export function isNumericParam(p: Pick<ParamDef, "value">): p is { value: number } {
  return typeof p.value === "number" && Number.isFinite(p.value);
}

/**
 * Text for a parameter's value. Numbers are compact and never scientific —
 * nobody wants `1e-7` in a dimension. Strings are quoted, as in the file, so
 * `"608"` does not read as the number 608.
 */
export function formatParamValue(v: ParamValue): string {
  if (typeof v === "number") {
    if (Number.isInteger(v)) return String(v);
    return String(Number(v.toFixed(4)));
  }
  if (typeof v === "string") return JSON.stringify(v);
  return String(v);
}

/** Wheel / arrow increment for a numeric parameter. */
export function paramStep(p: ParamDef & { value: number }): number {
  return p.step ?? (Math.abs(p.value) >= 10 ? 1 : 0.1);
}

/**
 * Whether the panel can update its existing rows in place, rather than
 * rebuilding. Same names in the same order is not enough: a parameter that
 * changed kind (`size: 4` edited to `size: "M4"`) needs a different control.
 */
export function paramLayoutMatches(a: ParamDef[], b: ParamDef[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((p, i) => p.name === b[i]!.name && isNumericParam(p) === isNumericParam(b[i]!));
}

/**
 * The numeric subset of what the file declares, for selector synthesis — a
 * generated selector can only reference a parameter by matching a number.
 */
export function numericDeclaredValues(params: ParamDef[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of params) {
    const v = p.declared ?? p.value;
    if (typeof v === "number" && Number.isFinite(v)) out[p.name] = v;
  }
  return out;
}
